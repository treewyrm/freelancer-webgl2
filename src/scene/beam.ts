/**
 * A gun's shot, as the game draws it: `FBeamEffect` (`src/freelancer/Client/beam_effect.cpp`), a cross
 * of tris along the shot that grows to its length over its first moments and fades once it's over.
 * All of a frame's shots are one additive batch, after the effects (`EffectVertexBatchFlush`). What
 * moves a shot, and what it hits, is the host's. Pure, no GL.
 */
import { Matrix3, Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import type { Camera } from './camera.js'
import {
  RETAIL_EFFECT_TYPES,
  withinSides,
  type EffectType,
  type EffectViewOptions,
} from './effect-view.js'
import type { Draw } from './frame.js'
import { immediateDraw, type ImmediateBatch } from './immediate.js'
import type { Fog } from './nebula.js'

const f = Math.fround

// `EFT_CODE_PROJ_EFFECT`, which `Start` hardcodes (`LAB_004f9600`).
const BEAM_EFFECT_TYPE = 0x2c

/** What retail hardcodes, and a mod can patch. */
export interface BeamLimits {
  /** The shot's sphere, in the view test (`FUN_004f9540`'s `+0x74`). */
  radius: number
  /** Seconds it fades over, once it's over, and the most it can have left (`DAT_006129cc`). */
  fade: number
  /** Added to `core_length` and `tail_length` for how far it travels while it grows (`DAT_005d9e0c`). */
  growthPad: number
}

export const RETAIL_BEAM_LIMITS: Readonly<BeamLimits> = {
  radius: 50,
  fade: f(0.3),
  growthPad: 7.5,
}

/** A `[BeamSpear]` or `[BeamBolt]`, as `FUN_0042e4a0` reads it: colours are 0 to 1, by 1/255 as a float. */
export interface BeamArchetype {
  kind: 'spear' | 'bolt'
  tipColor: Vector3
  tailColor: Vector3
  coreColor: Vector3
  secCoreColor: Vector3
  outerColor: Vector3
  secOuterColor: Vector3
  headBrightness: number
  trailBrightness: number
  tipLength: number
  tailLength: number
  coreLength: number
  coreWidth: number
  secCoreWidth: number
  headWidth: number
  /** The width on a shot's first frame, from outside the cockpit. */
  flashSize: number
  /** `head_texture = ball`: the top half of the head's V, where anything else has the bottom. */
  ballHead: boolean
  /** `trail_texture = thin`: the left of the trail's U, where anything else has the right. */
  thinTrail: boolean
}

/** As written, a colour 0 to 255: the keys `[BeamSpear]` and `[BeamBolt]` use. */
export interface BeamSection {
  kind: BeamArchetype['kind']
  tipColor?: Vector3
  tailColor?: Vector3
  coreColor?: Vector3
  secCoreColor?: Vector3
  outerColor?: Vector3
  secOuterColor?: Vector3
  headBrightness?: number
  trailBrightness?: number
  tipLength?: number
  tailLength?: number
  coreLength?: number
  coreWidth?: number
  secCoreWidth?: number
  headWidth?: number
  flashSize?: number
  headTexture?: string
  trailTexture?: string
}

const BRIGHTNESS_LEAST = f(0.01)
const BYTE_TO_UNIT = f(0.003921569)

// `WriteRgb255`. A key not written keeps `FUN_0042e430`'s default, 1, which no 1/255 scale reached.
const unit = (color: Vector3 | undefined): Vector3 =>
  color
    ? {
        x: f(f(color.x) * BYTE_TO_UNIT),
        y: f(f(color.y) * BYTE_TO_UNIT),
        z: f(f(color.z) * BYTE_TO_UNIT),
      }
    : { x: 1, y: 1, z: 1 }

const brightness = (value: number): number =>
  value < BRIGHTNESS_LEAST ? BRIGHTNESS_LEAST : value > 1 ? 1 : value

/**
 * A section to what's drawn: each key defaults to 1 (`FUN_0042e430`), then `FUN_0042e920` holds the
 * lengths to the widths and each brightness to 0.01 to 1. A bolt's tail is held to `sec_core_width`
 * where a spear's is to `core_width`.
 */
export const beamArchetype = (section: BeamSection): BeamArchetype => {
  const coreWidth = f(section.coreWidth ?? 1)
  const secCoreWidth = f(section.secCoreWidth ?? 1)

  return {
    kind: section.kind,
    tipColor: unit(section.tipColor),
    tailColor: unit(section.tailColor),
    coreColor: unit(section.coreColor),
    secCoreColor: unit(section.secCoreColor),
    outerColor: unit(section.outerColor),
    secOuterColor: unit(section.secOuterColor),
    headBrightness: brightness(f(section.headBrightness ?? 1)),
    trailBrightness: brightness(f(section.trailBrightness ?? 1)),
    tipLength: Math.max(f(section.tipLength ?? 1), coreWidth),
    tailLength: Math.max(
      f(section.tailLength ?? 1),
      section.kind === 'bolt' ? secCoreWidth : coreWidth,
    ),
    coreLength: f(section.coreLength ?? 1),
    coreWidth,
    secCoreWidth,
    headWidth: Math.max(f(section.headWidth ?? 1), coreWidth),
    flashSize: f(section.flashSize ?? 1),
    // Each is compared to five characters, its case kept (`Match5`).
    ballHead: section.headTexture === 'ball',
    thinTrail: section.trailTexture === 'thin',
  }
}

/**
 * `LookMatrix` (`Common/common_csys.cpp`): the turn whose -Z runs along `direction`. The player's guns
 * look along each barrel's aim like this, the shot's own orientation aside (`CliBeamActivateEffects`).
 * Its side is a retail quirk: `(-x, y)` of the negated direction, and `+Y` straight ahead.
 */
export const lookMatrix = ({ x, y, z }: Vector3): Matrix3 => {
  const length = Math.sqrt(x * x + y * y + z * z)
  const inverse = -1 / length
  const lookX = length > 1e-4 ? f(inverse * x) : 1
  const lookY = length > 1e-4 ? f(inverse * y) : 0
  const lookZ = length > 1e-4 ? f(inverse * z) : 0
  const straight = !(Math.abs(lookX) >= 1e-4 || Math.abs(lookY) >= 1e-4)
  const sideX = straight ? 0 : -lookX
  const sideY = straight ? 1 : lookY
  const c0 = f(lookY * 0 - lookZ * sideX)
  const c1 = f(lookZ * sideY - lookX * 0)
  const c2 = f(sideX * lookX - sideY * lookY)
  const scale = f(1 / Math.sqrt(c2 * c2 + c1 * c1 + c0 * c0))
  const c0n = c0 * scale
  const c1n = c1 * scale
  const c2n = f(c2 * scale)

  // Columns: `look × c`, `c` (normalised, from look and the quirky side) and `look`.
  return {
    x: {
      x: f(lookZ * c1n - c2n * lookY),
      y: f(c2n * lookX - lookZ * c0n),
      z: f(c0n * lookY - c1n * lookX),
    },
    y: { x: f(c0n), y: f(c1n), z: c2n },
    z: { x: lookX, y: lookY, z: lookZ },
  }
}

/** Where a shot starts, as `CliBeamActivateEffects` (`0x53f340`) has it. */
export interface BeamStart {
  orientation: Matrix3
  position: Vector3
  /** How fast it leaves, which sets how long it takes to grow to its length. */
  speed: number
  /**
   * The player's own: it looks along each barrel's aim (`lookMatrix`), and a spear's first frame
   * takes `flash_size`. Only then does a spear flash, and never from the cockpit.
   */
  look?: boolean
}

/**
 * One shot, from the frame it's fired to the frame it's gone. Each frame the host places it, and
 * `collectSpaceFrame` ages and draws it.
 *
 * A hit ends it at once (`FClientBeamGameobj::Slot194`): the host stops giving it. A life that runs
 * out `kill`s it: it coasts on and fades, and the host drops it once it's `dead`.
 */
export class BeamEffect {
  readonly archetype: BeamArchetype
  orientation: Matrix3
  position: Vector3
  private readonly limits: BeamLimits
  private readonly look: boolean
  private readonly growth: number
  private age = -1
  private left = -1
  private velocity?: Vector3
  dead = false

  constructor(
    archetype: BeamArchetype,
    { orientation, position, speed, look = false }: BeamStart,
    limits: Partial<BeamLimits> = {},
  ) {
    this.archetype = archetype
    this.orientation = orientation
    this.position = position
    this.limits = { ...RETAIL_BEAM_LIMITS, ...limits }
    this.look = look
    // `FUN_004fc8b0`.
    this.growth = f(
      (f(archetype.coreLength) + f(archetype.tailLength) + this.limits.growthPad) / speed,
    )
  }

  /** Where the shot's object is. A killed shot goes on by itself, and this does nothing. */
  place(orientation: Matrix3, position: Vector3) {
    if (this.velocity) return
    this.orientation = orientation
    this.position = position
  }

  /**
   * Its life ran out (`LAB_004f97a0`): from its object's velocity it coasts, and fades over
   * `limits.fade`, or what it has left of that if killed again.
   */
  kill(velocity: Vector3) {
    this.velocity ??= velocity
    if (this.left < 0 || this.left > this.limits.fade) this.left = this.limits.fade
  }

  /**
   * One frame of the walk (`EffectTypeBucketWalk`), the step held to 0.1 there: its coast, then
   * `UpdateVisibility`, then `TickDraw`, ending with what it builds into `batch`, if it's seen.
   */
  walk(step: number, seen: BeamSeen, batch: BeamBatch) {
    if (this.dead) return

    const { velocity, position } = this

    if (velocity)
      this.position = {
        x: f(position.x + step * velocity.x),
        y: f(position.y + step * velocity.y),
        z: f(position.z + step * velocity.z),
      }

    const fate = seen(this.position, this.limits.radius)

    if (fate === 'die') {
      this.dead = true
      return
    }

    this.age = this.age >= 0 ? f(this.age + step) : 0

    if (this.left > 0) {
      this.left = f(this.left - step)

      if (this.left <= 0) {
        this.dead = true
        return
      }
    }

    if (fate === 'draw') this.build(batch)
  }

  // `LAB_004fa0a0`, past the option: the growth's `t` and the fade's intensity. On a first frame
  // both kinds build a spear, so the flash in `FUN_004fb1e0` is never reached.
  private build(batch: BeamBatch) {
    const { archetype, age, growth, left, limits, look } = this
    const t = age < growth ? f(age / growth) : 1
    const intensity = left > 0 ? f(left / limits.fade) : 1

    if (t === 0 || archetype.kind === 'spear')
      buildSpear(archetype, this, t, intensity, look && t === 0 && !batch.firstPerson, batch)
    else buildBolt(archetype, this, t, intensity, batch)
  }
}

/** The view test's answer for a place and radius. */
export type BeamSeen = (position: Vector3, radius: number) => 'draw' | 'run' | 'die'

/**
 * `LAB_004f9980`, and what the walk does with it: under its type's priority a shot ends, wherever it
 * is, and past the camera or its `pbubble` it runs unseen if `EXIST_OFFSCREEN`, which retail's type
 * is. Its radius is its own, not its type's, and no fog, LOD or cloak is asked of it. Where retail
 * keeps last frame's answer, it's been cleared by that frame's build, so it's taken as unseen.
 */
export const beamView = (
  camera: Camera,
  aspect: number,
  view: Matrix4,
  { effectDetail = 1, effectTypes = [] }: EffectViewOptions = {},
): BeamSeen => {
  const info: EffectType = {
    ...RETAIL_EFFECT_TYPES[BEAM_EFFECT_TYPE]!,
    ...effectTypes[BEAM_EFFECT_TYPE],
  }
  const perf = f(1 - effectDetail)
  const { near, far } = info.pbubble
  const reach = f(f(far - near) * f(1 - perf) + near)
  const unseen = info.existOffscreen ? 'run' : 'die'

  return (position, radius) => {
    if (!(info.priority >= perf)) return 'die'

    const at = Matrix4.transformPoint(position, view)
    const depth = f(-at.z)
    if (!(camera.near < f(depth + radius))) return unseen
    if (!(reach > f(depth - radius))) return unseen
    return withinSides(at, camera, aspect, radius) ? 'draw' : unseen
  }
}

/** A frame's vertices and triangles, as `FUN_0046eab0` and `FUN_004fc9a0` append them. */
export interface BeamBatch extends ImmediateBatch {
  firstPerson: boolean
}

export const beamBatch = (firstPerson = false): BeamBatch => ({
  firstPerson,
  vertices: [],
  colors: [],
  indices: [],
  count: 0,
})

// `ColorByte`: truncated, and only the low byte stored, unclamped.
const lowByte = (value: number): number => Math.trunc(value) & 0xff

const scaled = (scale: number, { x, y, z }: Vector3): readonly [number, number, number] => [
  lowByte(scale * x * 255),
  lowByte(scale * y * 255),
  lowByte(scale * z * 255),
]

const add = (
  batch: BeamBatch,
  { x, y, z }: Vector3,
  [r, g, b]: readonly [number, number, number],
  u: number,
  v: number,
): number => {
  batch.vertices.push(x, y, z, u, v)
  batch.colors.push(b, g, r, 0xff)
  return batch.count++
}

const triangle = (batch: BeamBatch, a: number, b: number, c: number) => {
  batch.indices.push(a, b, c)
}

// `FUN_004fca50`.
const quad = (batch: BeamBatch, a: number, b: number, c: number, d: number) => {
  batch.indices.push(a, b, c, a, c, d)
}

// A local offset to world: the orientation's columns (`x`, `y`, `z`) weighted by it, plus `position`.
const placed = ({ orientation: r, position: t }: Placed, x: number, y: number, z: number) => ({
  x: f(r.x.x * x + r.y.x * y + r.z.x * z + t.x),
  y: f(r.x.y * x + r.y.y * y + r.z.y * z + t.y),
  z: f(r.x.z * x + r.y.z * y + r.z.z * z + t.z),
})

type Placed = Pick<BeamEffect, 'orientation' | 'position'>

const UV_HALF = 0.5
const UV_CORE = 0.75
const UV_MID = 0.25
const UV_THIN = f(0.45)
const UV_WIDE = f(0.55)

const headV = ({ ballHead }: BeamArchetype) =>
  ballHead ? ([0, UV_HALF, 0.25] as const) : ([UV_HALF, 1, 0.75] as const)
const trailV = ({ thinTrail }: BeamArchetype) =>
  thinTrail ? ([0, UV_THIN] as const) : ([UV_WIDE, 1] as const)

// `FUN_004fa270`, a spear, and either kind's first frame: the head's fan, then a double fan out of the
// shot's centre to its ends. `head_texture`'s V and the corner order are as listed, unlike a bolt's.
const buildSpear = (
  arch: BeamArchetype,
  at: Placed,
  t: number,
  intensity: number,
  flash: boolean,
  batch: BeamBatch,
) => {
  const near = flash ? arch.flashSize : arch.coreWidth
  const head = arch.headWidth < near ? near : arch.headWidth
  const end = f(f(arch.tailLength - near) * t + near)
  const start = f(-(f(arch.tipLength - near) * t + near))
  const [v0, v1, vMid] = headV(arch)
  const [u0, u1] = trailV(arch)
  const scale0 = f(intensity * arch.headBrightness)
  const scale1 = f(intensity * arch.trailBrightness)
  const centre = at.position

  const core0 = scaled(scale0, arch.coreColor)
  const outer0 = scaled(scale0, arch.outerColor)
  const i0 = add(batch, centre, core0, UV_CORE, vMid)
  const i1 = add(batch, placed(at, head, 0, 0), outer0, UV_HALF, v0)
  const i2 = add(batch, placed(at, 0, head, 0), outer0, UV_HALF, v1)
  const i3 = add(batch, placed(at, -head, 0, 0), outer0, 1, v1)
  const i4 = add(batch, placed(at, 0, -head, 0), outer0, 1, v0)

  const a0 = add(batch, centre, scaled(scale1, arch.coreColor), 0, u0)
  const a1 = add(batch, placed(at, 0, 0, start), scaled(scale1, arch.tipColor), UV_MID, u1)
  const a2 = add(batch, placed(at, 0, 0, end), scaled(scale1, arch.tailColor), UV_MID, u1)
  const outer1 = scaled(scale1, arch.outerColor)
  const a3 = add(batch, placed(at, near, 0, 0), outer1, UV_MID, u0)
  const a4 = add(batch, placed(at, -near, 0, 0), outer1, UV_MID, u0)
  const a5 = add(batch, placed(at, 0, near, 0), outer1, UV_MID, u0)
  const a6 = add(batch, placed(at, 0, -near, 0), outer1, UV_MID, u0)

  triangle(batch, i0, i1, i2)
  triangle(batch, i0, i3, i2)
  triangle(batch, i0, i3, i4)
  triangle(batch, i0, i1, i4)

  for (const reach of [a1, a2])
    for (const side of [a3, a4, a5, a6]) triangle(batch, a0, reach, side)
}

// `FUN_004fb1e0`, a bolt: the head's fan, a fan back to its tip, a tube to `core_length`, a fan to its
// tail. Its lengths have the core's width off them, held at 0.
const buildBolt = (
  arch: BeamArchetype,
  at: Placed,
  t: number,
  intensity: number,
  batch: BeamBatch,
) => {
  const near = arch.coreWidth
  const head = arch.headWidth < near ? near : arch.headWidth
  const tip = Math.max(f(arch.tipLength - near), 0)
  const tail = Math.max(f(arch.tailLength - near), 0)
  const mid = f(Math.max(arch.coreLength, 0) * t)
  const start = f(-(tip * t + near))
  const end = f(tail * t + near)
  const [v0, v1] = headV(arch)
  const vMid = f((v0 + v1) * 0.5)
  const [u0, u1] = trailV(arch)
  const scale0 = f(intensity * arch.headBrightness)
  const scale1 = f(intensity * arch.trailBrightness)
  const centre = at.position

  const outer0 = scaled(scale0, arch.outerColor)
  const i0 = add(batch, centre, scaled(scale0, arch.coreColor), UV_CORE, vMid)
  const i1 = add(batch, placed(at, head, 0, 0), outer0, UV_HALF, v0)
  const i2 = add(batch, placed(at, 0, head, 0), outer0, 1, v0)
  const i3 = add(batch, placed(at, -head, 0, 0), outer0, 1, v1)
  const i4 = add(batch, placed(at, 0, -head, 0), outer0, UV_HALF, v1)

  const a0 = add(batch, centre, scaled(scale1, arch.coreColor), 0, u1)
  const a1 = add(batch, placed(at, 0, 0, start), scaled(scale1, arch.tipColor), UV_MID, u0)
  const outer1 = scaled(scale1, arch.outerColor)
  const a2 = add(batch, placed(at, near, 0, 0), outer1, UV_MID, u1)
  const b0 = add(batch, placed(at, -near, 0, 0), outer1, UV_MID, u1)
  const b1 = add(batch, placed(at, 0, near, 0), outer1, UV_MID, u1)
  const b2 = add(batch, placed(at, 0, -near, 0), outer1, UV_MID, u1)
  const b3 = add(batch, placed(at, 0, 0, mid), scaled(scale1, arch.secCoreColor), 0, u0)
  const b4 = add(batch, placed(at, 0, 0, f(end + mid)), scaled(scale1, arch.tailColor), UV_MID, u1)
  // `FUN_004fc950`: these are rounded to floats first, where the others' products stay on the FPU.
  const { secOuterColor: secOuter } = arch
  const secOuter1 = [
    lowByte(f(scale1 * secOuter.x) * 255),
    lowByte(f(scale1 * secOuter.y) * 255),
    lowByte(f(scale1 * secOuter.z) * 255),
  ] as const
  const c0 = add(batch, placed(at, near, 0, mid), secOuter1, UV_MID, u0)
  const c1 = add(batch, placed(at, -near, 0, mid), secOuter1, UV_MID, u0)
  const c2 = add(batch, placed(at, 0, near, mid), secOuter1, UV_MID, u0)
  const c3 = add(batch, placed(at, 0, -near, mid), secOuter1, UV_MID, u0)

  triangle(batch, i0, i1, i2)
  triangle(batch, i0, i3, i2)
  triangle(batch, i0, i3, i4)
  triangle(batch, i0, i1, i4)
  for (const ring of [a2, b0, b1, b2]) triangle(batch, a0, a1, ring)
  quad(batch, a0, b3, c0, a2)
  quad(batch, a0, b3, c1, b0)
  quad(batch, a0, b3, c2, b1)
  quad(batch, a0, b3, c3, b2)
  for (const ring of [c0, c1, c2, c3]) triangle(batch, b3, b4, ring)
}

/**
 * `EffectVertexBatchFlush` (`FUN_004f9de0`): every shot of the frame in one draw, at `code_beam`'s
 * first frame, its UVs the whole texture's, under the effects' walk's `LEQUAL` and fog.
 */
export const beamDraw = (batch: BeamBatch, texture: Texture, fog?: Fog): Draw | undefined =>
  immediateDraw('code_beam', batch, texture, fog)
