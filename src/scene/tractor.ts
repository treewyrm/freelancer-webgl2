/**
 * A tractor's lines, as the game draws them: `FCliTractorBeam` (`src/freelancer/Client/
 * cli_tractor_beam.cpp`, `BuildGeometry`), each arm a jittered beam of camera-facing quads from the
 * tractor to its loot, and once its tip is in the loot, five arcs of sparks off it
 * (`Win3DDrawFuzzyLine`, `Win3DDrawFuzzyArc` in `win3d_immediate.cpp`). Where the arms are, and what
 * they hold, is the host's, each frame. Pure, no GL.
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import { classifySphere, type Camera } from './camera.js'
import type { Draw } from './frame.js'
import { immediateDraw, type ImmediateBatch } from './immediate.js'
import type { Random } from './lightning.js'
import type { Fog } from './nebula.js'
import { unitByte } from './retail.js'

const f = Math.fround

/** What retail hardcodes, and a mod can patch. */
export interface TractorLimits {
  /** The most arms drawn, counting only those holding loot (`JG 0xa`, `0x512e5f`). */
  arms: number
  /** The beam's segment length, and so its quads' (`0x40a00000`). */
  width: number
  /** How far each point strays, by the segment length (`0x3e4ccccd`). */
  jitter: number
  /** The loot's radius, by its physical radius: where the beam stops (`DAT_005cf100`). */
  lootScale: number
  /** The most the beam's end strays in `+x` and `+y` (`0x3f000000`). */
  endJitter: number
  /** Arcs off a loot the tip is in (`0x513227`). */
  sparks: number
  /** An arc's segment length. */
  sparkWidth: number
  /** The arcs' cone, at a tip a whole radius in (`DAT_005db708`, 0.8π). */
  sparkSpread: number
  /** How far back along the beam from the loot's centre the arcs turn about (`DAT_005d3e08`). */
  sparkPullBack: number
  /** A beam quad's length and width past its segment (`DAT_005c9804`). */
  lineQuad: number
  /** An arc quad's (`DAT_005c9800`). */
  arcQuad: number
}

export const RETAIL_TRACTOR_LIMITS: Readonly<TractorLimits> = {
  arms: 11,
  width: 5,
  jitter: f(0.2),
  lootScale: 0.2,
  endJitter: 0.5,
  sparks: 5,
  sparkWidth: 1,
  sparkSpread: 2.5132741928100586,
  sparkPullBack: f(0.3),
  lineQuad: 1.25,
  arcQuad: f(1.2),
}

/** One arm holding loot, as `TractorArm` has it this frame. An arm with none is left out. */
export interface TractorArm {
  /** `GetTipPos`: how far the arm has reached. */
  tip: Vector3
  /** The loot's place (`CObject +0x2c`). */
  loot: Vector3
  /** Its physical radius (`get_physical_radius_r`). */
  radius: number
}

/**
 * A working tractor this frame (`IsFunctioning`); the host leaves out one that isn't. Its `color`
 * and `maxLength` are its `[Tractor]`'s `color` and `max_length`, as written.
 */
export interface TractorBeam {
  /** `CETractor::GetSourcePos`. */
  source: Vector3
  maxLength: number
  /** 0 to 255, as written: each is truncated to a byte (`FCliTractor::ReadUnknown`). */
  color: Vector3
  /** In the tractor's own order. */
  arms: readonly TractorArm[]
}

export interface TractorView {
  camera: Camera
  aspect: number
  view: Matrix4
  /** `rand()`. Retail's is the game's one stream, so a picture's jitter can't match, only its kind. */
  random?: Random
  limits?: Partial<TractorLimits>
}

const BYTE_TO_UNIT = f(1 / 255)
const RAND_UNIT = f(1 / 32767)

// `Win3DColor3f`: by 255, truncated, then held to a byte.
const byte = unitByte

// `CliTractorBeamInit` (`FUN_00512be0`): the bytes `ReadUnknown` kept, over 255 as a float.
export const colorBytes = ({ x, y, z }: Vector3): [number, number, number, number] => {
  const unit = (value: number) => byte(f((Math.trunc(value) & 0xff) * BYTE_TO_UNIT))

  return [unit(z), unit(y), unit(x), 0xff]
}

export type V = [number, number, number]

const sub = (a: V, b: V): V => [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])]
const add = (a: V, b: V): V => [f(a[0] + b[0]), f(a[1] + b[1]), f(a[2] + b[2])]
const scale = (a: V, by: number): V => [f(a[0] * by), f(a[1] * by), f(a[2] * by)]
const length = ([x, y, z]: V) => Math.sqrt(y * y + z * z + x * x)
const rescale = (a: V, wanted: number): V => scale(a, wanted / length(a))
const cross = (d: V, e: V): V => [
  f(e[2] * d[1] - e[1] * d[2]),
  f(d[2] * e[0] - e[2] * d[0]),
  f(e[1] * d[0] - d[1] * e[0]),
]
const vector = ({ x, y, z }: Vector3): V => [x, y, z]

// Common's `RandomVector`: a cube's point pushed out to the sphere, no rejection.
const randomVector = (random: Random, radius: number): V => {
  const x = f(random() - 0x3fff)
  const y = f(random() - 0x3fff)
  const z = random() - 0x3fff
  const by = radius / Math.sqrt(z * z + y * y + x * x)

  return [f(x * by), f(y * by), f(by * z)]
}

/** The quads' batches and the colour they share, built into. */
interface Lines {
  batches: ImmediateBatch[]
  color: readonly number[]
  eye: V
}

const emptyBatch = (): ImmediateBatch => ({ vertices: [], colors: [], indices: [], count: 0 })

// Past this a draw's 16-bit indices run out: a long beam goes on in another draw.
const MOST_VERTICES = 0x10000

const QUAD_UVS = [0, 0, 1, 0, 1, 1, 0, 1]

/**
 * One segment's quad corners, in `FuzzyEmitQuad`'s order: its length along, by
 * `(next - cur) × (eye - cur)` across, turned to the eye, each by `quadScale` past it. The beam's
 * is half as wide as long (`narrow`); an arc's is square.
 */
export const segmentCorners = (
  cur: V,
  next: V,
  eye: V,
  quadScale: number,
  narrow: boolean,
): [V, V, V, V] => {
  const side = cross(sub(next, cur), sub(eye, cur))
  const mid = add(cur, scale(sub(next, cur), 0.5))
  const half = length(sub(mid, cur))
  const along = scale(sub(cur, mid), quadScale)
  const across = scale(rescale(side, f(narrow ? half * 0.5 : half)), quadScale)

  return [add(mid, along), add(mid, across), sub(mid, along), sub(mid, across)]
}

// `FuzzyEmitQuad`: one quad, the whole texture over it. A point gone NaN, as an arc of half a turn
// has no axis, leaves the quad to D3D, which draws nothing for it: none is built.
const quad = (lines: Lines, corners: readonly V[]) => {
  if (!corners.every((corner) => corner.every(Number.isFinite))) return

  let batch = lines.batches.at(-1)!
  if (batch.count + 4 > MOST_VERTICES) lines.batches.push((batch = emptyBatch()))

  const first = batch.count

  corners.forEach((corner, at) => {
    batch.vertices.push(...corner, QUAD_UVS[at * 2]!, QUAD_UVS[at * 2 + 1]!)
    batch.colors.push(...lines.color)
  })
  batch.count += 4
  batch.indices.push(first, first + 1, first + 2, first, first + 2, first + 3)
}

const segment = (lines: Lines, cur: V, next: V, quadScale: number, narrow: boolean) =>
  quad(lines, segmentCorners(cur, next, lines.eye, quadScale, narrow))

// `Win3DDrawFuzzyLine` (`FUN_00423be0`), textured: `floor(length / width) + 1` segments, each inner
// point jittered by `jitter × width`, the last the end itself.
const fuzzyLine = (
  lines: Lines,
  random: Random,
  start: V,
  end: V,
  width: number,
  { jitter, lineQuad }: TractorLimits,
) => {
  const dir = sub(end, start)
  const reach = length(dir)
  const count = Math.floor(reach / width) + 1
  const unit = rescale(dir, f(f(reach) / count))
  const stray = f(jitter * width)
  let cur = start

  for (let at = 1; at <= count; at++) {
    const next = at === count ? end : add(add(start, scale(unit, at)), randomVector(random, stray))

    segment(lines, cur, next, lineQuad, true)
    cur = next
  }
}

// `Win3DDrawFuzzyArc` (`FUN_004231f0`), textured: from `start` about `centre` toward `end`, on the
// sphere through `start`, in chords of about `width`. Nothing if either end is on the centre.
const fuzzyArc = (
  lines: Lines,
  random: Random,
  start: V,
  end: V,
  centre: V,
  width: number,
  { jitter, arcQuad }: TractorLimits,
) => {
  const from = sub(start, centre)
  const reachExt = length(from)
  const radius = f(reachExt)

  if (reachExt < 0.001) return

  const toEndRaw = sub(end, centre)
  if (length(toEndRaw) < 0.001) return

  const stray = f(jitter * width)
  const toEnd = rescale(toEndRaw, radius)
  const radiusSq = f(radius * radius)
  const cosineExt = (toEnd[2] * from[2] + toEnd[1] * from[1] + toEnd[0] * from[0]) / radiusSq
  let cosine = f(cosineExt)

  if (cosineExt < -1) cosine = -1
  else if (cosine > 1) cosine = 1

  const angle = f(Math.acos(cosine))
  // A chord of `width` on this radius subtends `acos(1 - width² / 2r²)`; the arc is cut into that many.
  let chord = f(1 - (width * width) / (radiusSq + radiusSq))

  if (chord < -1) chord = -1
  else if (chord > 1) chord = 1

  const count = Math.floor(angle / Math.acos(chord)) + 1
  const step = f(angle / count)
  const axis = cross(from, toEnd)
  const axisLength = length(axis)
  const unitAxis: V = [axis[0] / axisLength, axis[1] / axisLength, axis[2] / axisLength]
  let cur = start

  for (let at = 1; at <= count; at++) {
    const next =
      at === count
        ? add(centre, toEnd)
        : add(add(centre, rotate(from, unitAxis, at * step)), randomVector(random, stray))

    segment(lines, cur, next, arcQuad, false)
    cur = next
  }
}

/**
 * The quaternion's turn of `v` by `angle` about a unit `axis`, as Rodrigues gives it: from `start`
 * toward the end about `start × end`, as `tractor_reach` captures an arc of two chords.
 */
export const rotate = (v: V, [kx, ky, kz]: V, angle: number): V => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const dot = (kx * v[0] + ky * v[1] + kz * v[2]) * (1 - c)

  return [
    f(v[0] * c + (ky * v[2] - kz * v[1]) * s + kx * dot),
    f(v[1] * c + (kz * v[0] - kx * v[2]) * s + ky * dot),
    f(v[2] * c + (kx * v[1] - ky * v[0]) * s + kz * dot),
  ]
}

/**
 * `LookMatrixYup` (`Common/common_csys.cpp`), as its three columns: the third is `-direction`
 * normalised, the second an up beside it from `(-x, 0, z)` of that, the first their cross.
 */
export const lookMatrixYup = ([x, y, z]: V): [V, V, V] => {
  const lengthSq = x * x + y * y + z * z
  const inverse = -1 / Math.sqrt(lengthSq)
  const look: V = lengthSq > 1e-4 ? [f(inverse * x), f(inverse * y), f(inverse * z)] : [0, 0, -1]
  const [lx, ly, lz] = look
  const straight = Math.abs(lx) < 1e-4 && Math.abs(lz) < 1e-4
  const refX = straight ? 0 : -lx
  const refZ = straight ? 1 : lz
  const upX = f(refX * ly - lz * 0)
  const upY = f(refZ * lz - refX * lx)
  const upZ = f(lx * 0 - ly * refZ)
  const upInverse = f(1 / Math.sqrt(upZ * upZ + upY * upY + upX * upX))
  const ux = upX * upInverse
  const uy = upY * upInverse
  const uz = f(upZ * upInverse)

  return [
    [f(lz * uy - uz * ly), f(uz * lx - ux * lz), f(ly * ux - uy * lx)],
    [f(ux), f(uy), uz],
    look,
  ]
}

// One arm (`0x512e8b` to `0x51335c`): the beam to its tip, held to the loot's shell, its end strayed;
// then past the shell, arcs from that end about a point just short of the loot's centre.
const arm = (
  lines: Lines,
  random: Random,
  source: V,
  { tip: tipAt, loot: lootAt, radius: physical }: TractorArm,
  limits: TractorLimits,
) => {
  const tip = vector(tipAt)
  const loot = vector(lootAt)
  const toTip = sub(tip, source)
  const tipDistance = f(length(toTip))
  const tipDir = scale(toTip, 1 / tipDistance)
  const toLoot = sub(loot, source)
  const lootDistance = f(length(toLoot))
  const radius = f(physical * limits.lootScale)
  const reach = f(lootDistance - radius)
  const excess = f(tipDistance - reach)
  let end: V = tip

  if (excess > 0) {
    const lootLength = length(toLoot)
    const shell = lootLength !== 0 ? scale(toLoot, reach / lootLength) : toLoot

    end = add(shell, source)
  }

  const strayY = f(random() * limits.endJitter * RAND_UNIT)
  const strayX = random() * limits.endJitter * RAND_UNIT

  end = [f(end[0] + strayX), f(end[1] + strayY), end[2]]
  fuzzyLine(lines, random, source, end, limits.width, limits)
  if (!(excess > 0)) return

  const spread = f((excess / radius) * limits.sparkSpread)
  const [column0, column1, column2] = lookMatrixYup(toLoot)
  const centre = sub(loot, scale(tipDir, limits.sparkPullBack))
  const sinSpread = Math.sin(spread)
  const cosSpread = f(Math.cos(spread))

  for (let at = 0; at < limits.sparks; at++) {
    const theta = random() * f(2 * Math.PI) * RAND_UNIT
    // A point on the cone of half-angle `spread` about the loot-to-source axis, then taken to world by
    // `lookMatrixYup`'s columns.
    const cone: V = [f(Math.cos(theta) * sinSpread), f(Math.sin(theta) * sinSpread), cosSpread]
    const turned: V = [0, 1, 2].map((row) =>
      f(column0[row]! * cone[0] + column1[row]! * cone[1] + column2[row]! * cone[2]),
    ) as V

    fuzzyArc(lines, random, end, add(turned, centre), centre, limits.sparkWidth, limits)
  }
}

const DEFAULT_RANDOM: Random = () => Math.floor(Math.random() * 0x8000)

/**
 * `EFT_TRACTORBEAM`'s bucket of the effects' walk (`SpaceEffectsDrawFrame`, after the shots' and
 * before their flush): each tractor whose sphere of `maxLength` about its source the camera sees
 * (`EffectInCameraView`). Every quad is one immediate draw in retail (`FuzzyEmitQuad`); added, with
 * no depth writes, as one they come to the same picture. `line`'s frame 0 times the tractor's colour,
 * unlit, unculled, in the effects' fog (`0x512e4a`). Unseen it runs on, as its type is
 * `EXIST_OFFSCREEN`, and it has nothing to run.
 */
export const tractorDraws = (
  tractors: readonly TractorBeam[],
  texture: Texture,
  { camera, aspect, view, random = DEFAULT_RANDOM, limits: given = {} }: TractorView,
  fog?: Fog,
): Draw[] => {
  const limits = { ...RETAIL_TRACTOR_LIMITS, ...given }
  const eye = vector(camera.position)
  const draws: Draw[] = []

  for (const { source, maxLength, color, arms } of tractors) {
    const at = Matrix4.transformPoint(source, view)
    if (classifySphere(at, f(maxLength), camera, aspect) < 3) continue

    const lines: Lines = { batches: [emptyBatch()], color: colorBytes(color), eye }
    for (const held of arms.slice(0, limits.arms)) arm(lines, random, vector(source), held, limits)

    for (const batch of lines.batches) {
      const draw = immediateDraw('line', batch, texture, fog)
      if (draw) draws.push(draw)
    }
  }

  return draws
}
