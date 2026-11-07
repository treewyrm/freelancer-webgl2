/**
 * A sun's `lens_glow` corona and the state behind its flare: `FStarSphere::UpdateIntensity`
 * (`LAB_00511690`), `FStarSphere::Draw` (`LAB_00511ca0`), `FUN_0050da20` and `FUN_0050e6f0` in
 * `src/freelancer/Client/star_sphere.cpp`. Samples about the sun on screen each cast a ray from the
 * camera, which what's big enough on screen blocks; each sample's alpha eases toward whether it's
 * seen, and the corona is drawn in screen pixels from them. Pure, no GL.
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import {
  Primitive,
  setMapCount,
  VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import { DEFAULT_SAMPLER } from '#/texture/texture.js'
import type { Camera } from './camera.js'
import { textureHasAlpha } from './exterior.js'
import type { BlendMode, Draw } from './frame.js'
import type { TextureShape } from './ring.js'
import type { Star } from './star.js'

const f = Math.fround

/** A `[lens_glow]`, over `SunEffectBodyInit`'s defaults (`FUN_0050d300`, `FUN_0050d420`). */
export interface LensGlow {
  /** `shape`. Nothing draws without one, but its samples still block the flare. */
  shape?: TextureShape
  /** `radius_scale`, 2 when absent: the corona's reach, in the star's radii. */
  radiusScale?: number
  /** `inner_color`, at the centre. White when absent. */
  innerColor?: Vector3
  /** `outer_color`, at the rim. White when absent. */
  outerColor?: Vector3
  /** `glow_fade_in_seconds` and `glow_fade_out_seconds`, 0.25 when absent: each sample's easing. */
  fadeIn?: number
  fadeOut?: number
  /** `interior_tween`, 0.5 when absent: where the inner ring stands, centre to rim. */
  interiorTween?: number
  /** `interior_ray_tween`, 1 when absent: where on screen the inner ring's rays are cast from. */
  interiorRayTween?: number
  /** `max_LOD`, truncated, 5 when absent: the most samples, from 0 (one) to 5 (25). */
  maxLod?: number
}

/** What a ray from the camera hits: `PhySys::FindRayCollisions`'s `RayHit`, and its `CObject`. */
export interface RayHit {
  /** What the host calls the object, compared with the sun's own solar and the player's ship. */
  object?: unknown
  /** `CObject::WorldPosition`. */
  position: Vector3
  /** `CObject::Radius`. */
  radius: number
  /** The part hit is a shield's: it never blocks. */
  shield?: boolean
}

/** What the corona asks of the frame. */
export interface CoronaView {
  camera: Camera
  view: Matrix4
  /** The viewport in pixels. */
  width: number
  height: number
  /**
   * `PhySys::FindRayCollisions` from the camera to `to`, at most `limit` hits. None when absent, so
   * nothing blocks.
   */
  rayHits?: (from: Vector3, to: Vector3, limit: number) => readonly RayHit[]
  /** The sun's own solar, which its rays pass through (`0x50c767`). */
  own?: unknown
  /** The player's ship from the cockpit, which they pass through too (`0x50c798`). */
  player?: unknown
  /** The corona's fewest samples, `sunLeastLod`. */
  leastLod: number
  /** `1 - ZoneOcclusion`: the corona's alpha. */
  visibility: number
}

/**
 * The `SunEffect` option, as `PerfOptions.ini` writes it, to the quality `G_SunEffectQuality`:
 * times 1.33333, held to 1 (`LAB_00510bf0`). At 0 or less no corona, spine or flare draws.
 */
export const sunEffectQuality = (option: number): number => f(Math.min(option * 1.33333, 1))

/**
 * The corona's least LOD at a quality: `ftol((1 - Q) · max + 0.5)`. A star is made after the option
 * is applied and before its `max_LOD` is read, so this is of the default 5 (`0x510e9c`); the option
 * changed in a system gives its stars their own `max_LOD`'s instead, which the host can pass.
 */
export const sunLeastLod = (quality: number, maxLod = 5): number =>
  Math.trunc(maxLod * (1 - quality) + 0.5)

interface Slot {
  x: number
  y: number
  u: number
  v: number
  alpha: number
}

/** What `FStarSphere` and its `lens_glow` body keep between frames. */
interface StarState {
  /** `+0x60`: the last update's step. */
  step: number
  /** `+0x64`: the flare's brightness, easing toward what the corona shows. */
  intensity: number
  /** `+0x38`: 1 less how much of the corona showed at the last draw. */
  hidden: number
  /** `+0x34`: eased toward 1 while a zone is between the camera and the sun. */
  zoneOcclusion: number
  /** The centre, then the rim's twelve (`+0x00`), then the inner ring's twelve (`+0x138`). */
  rim: Slot[]
  inner: Slot[]
  /** `+0x258`: each inner quad's diagonal. */
  diagonals: number[]
  /** `+0x2b0`. */
  lod: number
  /** `+0x70`: the sun's depth in view at the last draw, which the flare needs below 0. */
  viewZ: number
  /** `+0x7c`, `+0x80`, `+0x88`: where it was on screen, and its pixel scale, when last projected. */
  x: number
  y: number
  pixelScale: number
}

const states = new WeakMap<Star, StarState>()

/** `SunBodyBakeCorona` (`FUN_0050d930`): the rim on a unit circle, the inner ring tweened in. */
const stateOf = (star: Star): StarState => {
  let state = states.get(star)
  if (state) return state
  const rim: Slot[] = [{ x: 0, y: 0, u: 0.5, v: 0.5, alpha: 1 }]
  for (let at = 1; at < 13; at++) {
    const angle = f((at - 1) * f(0.5235987901687622))
    const c = f(Math.cos(angle))
    const s = f(Math.sin(angle))
    rim.push({ x: c, y: -s, u: f((c + 1) * 0.5), v: f(0.5 - s * 0.5), alpha: 1 })
  }
  const tween = f(star.lensGlow?.interiorTween ?? 0.5)
  const keep = f(1 - tween)
  const centre = rim[0]!
  const inner = rim.slice(1).map((edge) => ({
    x: f(keep * centre.x + tween * edge.x),
    y: f(keep * centre.y + tween * edge.y),
    u: f(keep * centre.u + tween * edge.u),
    v: f(keep * centre.v + tween * edge.v),
    alpha: 1,
  }))
  state = {
    step: 0,
    intensity: 1,
    hidden: 0,
    zoneOcclusion: 0,
    rim,
    inner,
    diagonals: Array.from({ length: 12 }, () => 1),
    lod: 0,
    viewZ: 0,
    x: 0,
    y: 0,
    pixelScale: 0,
  }
  states.set(star, state)
  return state
}

/** `ApproachFloat`: up by one step, down by the other, never past the target. */
const approach = (current: number, target: number, up: number, down: number): number => {
  if (target > current) return f(Math.min(current + up, target))
  if (target < current) return f(Math.max(current - down, target))
  return current
}

/** `ApproachSlotAlpha` and `FUN_00512460`: the approach, held to [0, 1]. */
const ease = (slot: Slot, target: number, up: number, down: number) => {
  slot.alpha = Math.min(Math.max(approach(slot.alpha, target, up, down), 0), 1)
}

/** `CoronaSlotFadeToZero`: a step toward 0, landing on it rather than past. */
const fadeToZero = (slot: Slot, up: number, down: number) => {
  if (0 > slot.alpha) {
    const next = up + slot.alpha
    slot.alpha = f(next)
    if (next > 0) slot.alpha = 0
  } else if (0 < slot.alpha) {
    const next = slot.alpha - down
    slot.alpha = f(next)
    if (next < 0) slot.alpha = 0
  }
  slot.alpha = Math.min(Math.max(slot.alpha, 0), 1)
}

/**
 * `UpdateIntensity`, the solar's own update: the step the next draw eases by, and the flare's
 * brightness toward what the corona last showed. Retail's suns write `intensity_fade_in` 0, which
 * loads as 1e-7, then `zone_occlusion_fade_in`, which lands there too (`0x511381`).
 */
export const updateStar = (star: Star, step: number) => {
  const state = stateOf(star)
  state.step = f(step)
  const { fadeIn = 1, fadeOut = 1 } = star.intensityFade ?? {}
  state.intensity = approach(
    state.intensity,
    f(1 - state.hidden),
    f(state.step / fadeIn),
    f(state.step / fadeOut),
  )
}

/** The flare's brightness, `+0x64`, and how much a zone hides it, `+0x34`. */
export const starIntensity = (star: Star): { intensity: number; zoneOcclusion: number } => {
  const { intensity, zoneOcclusion } = stateOf(star)
  return { intensity, zoneOcclusion }
}

/**
 * The cockpit pass fully inside a field: no draw, only the zone's occlusion at 1
 * (`SpaceEnvFxBeginCockpitPass`, `0x51c99f`).
 */
export const hideStar = (star: Star) => {
  stateOf(star).zoneOcclusion = 1
}

/** `FUN_0050f2a0`: how much of the corona shows, the centre weighted against its rings by LOD. */
const shown = ({ rim, inner, lod }: StarState): number => {
  const centre = rim[0]!.alpha
  if (lod === 0) return centre
  let sum = 0
  for (const { alpha } of rim.slice(1)) sum = f(sum + alpha)
  if (lod < 3) return f(centre * f(0.2) + sum * f(1 / 12) * f(0.8))
  for (const { alpha } of inner) sum = f(sum + alpha)
  return f(centre * f(0.1) + sum * f(1 / 24) * f(0.9))
}

/** The camera's screen, as `SpaceCameraSetViewport` sets it up (`0x40fd87`). */
const screenOf = ({ fovh, near }: Camera, width: number, height: number) => {
  const aspect = f(width / height)
  const halfWidth = f(width * 0.5)
  const halfHeight = height * 0.5
  const tanX = Math.tan(fovh * f(Math.PI / 180))
  const scaleX = f(halfWidth / tanX)
  const scaleY = f(-(halfHeight / f(tanX / aspect)))
  return { centreX: halfWidth, centreY: f(halfHeight), scaleX, scaleY, near }
}

type Screen = ReturnType<typeof screenOf>

/** `FUN_0050c750`: whether something the ray hits covers more than 0.65 of the sun's pixel scale. */
const blocked = (from: Vector3, to: Vector3, pixelScale: number, view: CoronaView): boolean => {
  const { rayHits, own, player, camera } = view
  if (!rayHits) return false
  const threshold = f(pixelScale * f(0.65))
  const perUnit = f(camera.near * f(screenOf(camera, view.width, view.height).scaleX / camera.near))
  for (const hit of rayHits(from, to, 6).slice(0, 6)) {
    if (hit.shield) continue
    if (hit.object !== undefined && (hit.object === own || hit.object === player)) continue
    let z = f(Matrix4.transformPoint(hit.position, view.view).z)
    if (z > f(-0.1)) z = f(-0.1)
    if (perUnit * (-1 / z) * hit.radius > threshold) return true
  }
  return false
}

/** `FUN_0050da20`'s per-sample ray (`Unproject`): through the screen point, as far as the sun. */
const sampleBlocked = (
  screen: Screen,
  view: CoronaView,
  distance: number,
  pixelScale: number,
  x: number,
  y: number,
): boolean => {
  const { camera } = view
  const local = {
    x: f(f(x - screen.centreX) * f(screen.near / screen.scaleX)),
    y: f(f(y - screen.centreY) * f(screen.near / screen.scaleY)),
    z: -screen.near,
  }
  const { x: rx, y: ry, z: rz } = camera.orientation
  const dir = {
    x: f(rx.x * local.x + rx.y * local.y + rx.z * local.z),
    y: f(ry.x * local.x + ry.y * local.y + ry.z * local.z),
    z: f(rz.x * local.x + rz.y * local.y + rz.z * local.z),
  }
  const inverse = 1 / Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z)
  const eye = camera.position
  const reachZ = f(f(dir.z * inverse) * distance)
  const to = {
    x: f(f(dir.x * inverse) * distance + eye.x),
    y: f(f(dir.y * inverse) * distance + eye.y),
    z: f(reachZ + eye.z),
  }
  return blocked(eye, to, pixelScale, view)
}

// `FUN_0050da20`'s sample strides by LOD, inner then outer (`0x50de76`).
const STRIDES: readonly (readonly [number, number])[] = [
  [14, 14],
  [4, 14],
  [2, 14],
  [2, 2],
  [1, 2],
  [1, 1],
]
// `+0x2f8`: pixel scales below which each LOD holds.
const LOD_SCALES = [8, 15, 25, 40, 60]

/** `CoronaBlendPair` (`0x50e541`): 0.7 of the lesser, 0.3 of the greater. */
const blendPair = (own: number, neighbour: number): number =>
  own > neighbour ? f(neighbour * 0.7 + own * 0.3) : f(neighbour * 0.3 + own * 0.7)

/** `FUN_0050da20`: each sample's alpha eased toward whether its ray is clear, then the gaps filled. */
const sample = (
  state: StarState,
  glow: LensGlow,
  sun: Vector3,
  at: { x: number; y: number; pixelScale: number },
  view: CoronaView,
) => {
  const { rim, inner } = state
  const up = f(state.step / f(glow.fadeIn ?? 0.25))
  const down = f(state.step / f(glow.fadeOut ?? 0.25))
  const screen = screenOf(view.camera, view.width, view.height)
  const { width, height } = view
  const { x: sx, y: sy, pixelScale } = at

  let lod = LOD_SCALES.findIndex((scale) => scale > pixelScale)
  if (lod < 0) lod = 5
  lod = lod >= view.leastLod ? lod - view.leastLod : 0
  state.lod = Math.min(lod, Math.trunc(glow.maxLod ?? 5))

  const margin = Math.max(pixelScale * f(glow.radiusScale ?? 2), 50)
  const onScreen = (x: number, y: number) =>
    x > -margin && width + margin > x && y > -margin && height + margin > y
  const eye = view.camera.position
  const dx = sun.x - eye.x
  const dy = sun.y - eye.y
  const dz = sun.z - eye.z
  const distance = f(Math.sqrt(dx * dx + dz * dz + dy * dy))
  const cast = (slot: Slot, x: number, y: number, by: number) => {
    if (!onScreen(x, y)) return ease(slot, by * 0, up, down)
    const clear = sampleBlocked(screen, view, distance, pixelScale, x, y) ? 0 : 1
    ease(slot, f(clear * by), up, down)
  }

  const centre = rim[0]!
  cast(centre, f(pixelScale * centre.x + sx), f(pixelScale * centre.y + sy), 1)
  const [innerStride, outerStride] = STRIDES[state.lod]!
  if (state.lod > 2) {
    const by = f((centre.alpha + 1) * 0.5)
    const spread = f(glow.interiorRayTween ?? 1)
    for (let index = 0; index < 12; index += outerStride) {
      const slot = inner[index]!
      cast(slot, f(pixelScale * slot.x * spread + sx), f(pixelScale * slot.y * spread + sy), by)
    }
  }
  if (state.lod > 0) {
    let by = f((centre.alpha + 1) * 0.5)
    for (let index = 1; index < 13; index += innerStride) {
      const slot = rim[index]!
      // From the third LOD each takes the inner ring's sample before it, and keeps it.
      if (state.lod > 2) by = f((inner[index - 1]!.alpha + 1) * 0.5)
      cast(slot, f(pixelScale * slot.x + sx), f(pixelScale * slot.y + sy), by)
    }
  }
  if (state.lod === 0) {
    for (const slot of rim.slice(1)) slot.alpha = centre.alpha
    return
  }
  // The skipped samples, halfway each pass from their sampled neighbours, the rim wrapping past 12.
  for (let stride = innerStride; stride > 1;) {
    const half = Math.trunc(stride * 0.5)
    for (let index = 1; index < 13; index += stride) {
      const next = index + stride
      const neighbour = rim[next > 12 ? next - 12 : next]!.alpha
      rim[index + half]!.alpha = blendPair(rim[index]!.alpha, neighbour)
    }
    stride = half
  }
  if (state.lod === 2)
    for (let index = 0; index < 12; index += 2)
      inner[index]!.alpha = f((rim[index + 1]!.alpha + centre.alpha) * 0.5)
  if (state.lod <= 2) return
  for (let stride = outerStride; stride > 1;) {
    const half = Math.trunc(stride * 0.5)
    for (let index = 0; index < 12; index += stride) {
      const next = index + stride
      const neighbour = inner[next > 11 ? next - 12 : next]!.alpha
      inner[index + half]!.alpha = blendPair(inner[index]!.alpha, neighbour)
    }
    stride = half
  }
}

// `ScaleClampToByte`: times 255 on the FPU, truncated, held to a byte.
const byte = (value: number): number => Math.min(Math.max(Math.trunc(value * 255), 0), 255)
// XYZ, D3DCOLOR and one UV set: Win3D's FVF 0x142, 24 bytes.
const FORMAT = setMapCount(VertexFormat.Position | VertexFormat.Diffuse, 1)
const STRIDE = 24
const BLACK: Vector3 = { x: 0, y: 0, z: 0 }
const WHITE: Vector3 = { x: 1, y: 1, z: 1 }

/** A Win3D vertex in screen pixels: position, `Win3DColor4f`'s colour and alpha, and UV. */
interface ScreenVertex {
  x: number
  y: number
  u: number
  v: number
  color: Vector3
  alpha: number
}

/**
 * Screen-pixel vertices under `Win3DSetProjection(0, W - 1, H - 1, 0)` with an identity modelview
 * (`0x511f25`, `0x51256b`). Depth is off, so they stand at clip z 0 where retail's ortho puts them
 * on its far edge: the same pixels, never clipped. `Win3DEnd` makes quads (0, 1, 2) and (0, 2, 3).
 */
const screenDraw = (
  name: string,
  primitive: Primitive | 'quads',
  vertices: readonly ScreenVertex[],
  shape: TextureShape,
  blendMode: BlendMode,
  view: { view: Matrix4; width: number; height: number },
): Draw => {
  const bytes = new Uint8Array(vertices.length * STRIDE)
  const floats = new Float32Array(bytes.buffer)
  vertices.forEach(({ x, y, u, v, color, alpha }, index) => {
    floats.set([x, y, 0], (index * STRIDE) / 4)
    bytes.set([byte(color.z), byte(color.y), byte(color.x), byte(alpha)], index * STRIDE + 12)
    floats.set([u, v], (index * STRIDE + 16) / 4)
  })
  const indices =
    primitive === 'quads'
      ? Uint16Array.from({ length: (vertices.length / 4) * 6 }, (_, at) => {
          const quad = Math.trunc(at / 6) * 4
          return quad + [0, 1, 2, 0, 2, 3][at % 6]!
        })
      : Uint16Array.from({ length: vertices.length }, (_, index) => index)
  const count = indices.length
  const mesh: VMeshData = {
    name,
    version: 1,
    primitive: primitive === 'quads' ? Primitive.TriangleList : primitive,
    format: FORMAT,
    groups: [
      {
        materialId: 0,
        vertexStart: 0,
        vertexEnd: vertices.length - 1,
        elementCount: count,
        padding: 0,
      },
    ],
    indices,
    vertices: bytes,
  }
  const reference: VMeshRef = {
    meshId: 0,
    vertexStart: 0,
    vertexCount: vertices.length,
    indexStart: 0,
    indexCount: count,
    groupStart: 0,
    groupCount: 1,
    boundingBox: { min: BLACK, max: BLACK },
    boundingSphere: { center: BLACK, radius: 0 },
  }
  const { width, height } = view
  const projection: Matrix4 = {
    x: { x: 2 / (width - 1), y: 0, z: 0, w: 0 },
    y: { x: 0, y: -2 / (height - 1), z: 0, w: 0 },
    z: { x: 0, y: 0, z: 0, w: 0 },
    w: { x: -1, y: 1, z: 0, w: 1 },
  }
  return {
    mesh,
    reference,
    byteOffset: 0,
    count,
    world: Matrix4.invert(view.view),
    projection,
    materialName: name,
    diffuse: [1, 1, 1, 1],
    ambient: BLACK,
    emissive: BLACK,
    colorVertex: true,
    nomad: false,
    // Frame 0 of the shape's texture (`TexShapeGetGpuHandle`).
    texture: { name: shape.texture.name, entry: shape.texture, sampler: DEFAULT_SAMPLER, uvSet: 0 },
    cull: 'none',
    depthWrite: false,
    depthFunc: 'always',
    lightless: true,
    negateNormals: false,
    normalizeNormals: false,
    blend: true,
    blendMode,
    unlit: true,
    // What the screen quads or the last sun left. Taken as `GREATER 0`. **Uncaptured.**
    alphaReference: 0,
    alphaFunction: 'greater',
  }
}

/** A band's sign: above 0.999, below 0.001, or between (`CoronaAlphaSignBand`). */
const band = (value: number): number => (value > f(0.999) ? 1 : value < f(0.001) ? -1 : 0)

/**
 * `FUN_0050e6f0`: under the third LOD, a fan from the centre round the rim; from it, the band
 * between the inner ring and the rim, each quad split along the diagonal its alphas favour, then a
 * fan from the centre round the inner ring. Each vertex at half its sample's alpha
 * (`CoronaEmitVertex`, `FUN_0050f230`).
 */
const coronaDraws = (
  state: StarState,
  glow: LensGlow,
  at: { x: number; y: number; pixelScale: number },
  view: CoronaView,
): Draw[] => {
  const { shape } = glow
  if (!shape) return []
  const inner = glow.innerColor ?? WHITE
  const outer = glow.outerColor ?? WHITE
  // Set only once a `[lens_glow]` is found (`0x50d6f7`), which a shape needs.
  const tween = f(glow.interiorTween ?? 0.5)
  const keep = f(1 - tween)
  const middle = {
    x: f(keep * inner.x + tween * outer.x),
    y: f(keep * inner.y + tween * outer.y),
    z: f(keep * inner.z + tween * outer.z),
  }
  const scale = f(f(glow.radiusScale ?? 2) * at.pixelScale)
  const emit = (slot: Slot, color: Vector3): ScreenVertex => ({
    x: f(scale * slot.x + at.x),
    y: f(scale * slot.y + at.y),
    u: slot.u,
    v: slot.v,
    color,
    alpha: f(0.5 * slot.alpha * view.visibility),
  })
  // A texture with alpha adds by it, one without adds whole (`0x50e81a`).
  const blendMode: BlendMode = textureHasAlpha(shape.texture) ? 'alphaAdd' : 'add'
  const draw = (primitive: Primitive, vertices: ScreenVertex[]) =>
    screenDraw('corona', primitive, vertices, shape, blendMode, view)
  const { rim, inner: ring, diagonals } = state
  const centre = emit(rim[0]!, inner)
  if (state.lod < 3)
    return [
      draw(Primitive.TriangleFan, [
        centre,
        ...rim.slice(1).map((slot) => emit(slot, outer)),
        emit(rim[1]!, outer),
      ]),
    ]
  const triangles: ScreenVertex[] = []
  for (let index = 0; index < 12; index++) {
    const local = index + 1
    const mid = ring[index]!
    const midA = ring[local <= 11 ? local : local - 12]!
    const rimB = rim[local]!
    const rimC = rim[local + 1 <= 12 ? local + 1 : local + 1 - 12]!
    let first = band(mid.alpha)
    let second = band(midA.alpha)
    if (first === second) {
      first = band(rimB.alpha)
      second = band(rimC.alpha)
    }
    if (first !== second)
      diagonals[index] = first === 1 ? 0 : first === -1 ? 1 : second === 1 ? 1 : 0
    const m = (slot: Slot) => emit(slot, middle)
    const o = (slot: Slot) => emit(slot, outer)
    triangles.push(
      ...(diagonals[index] === 0
        ? [m(midA), m(mid), o(rimB), m(midA), o(rimB), o(rimC)]
        : [m(midA), m(mid), o(rimC), m(mid), o(rimB), o(rimC)]),
    )
  }
  return [
    draw(Primitive.TriangleList, triangles),
    draw(Primitive.TriangleFan, [
      centre,
      ...ring.map((slot) => emit(slot, middle)),
      emit(ring[0]!, middle),
    ]),
  ]
}

/** One `spine`: its length and width in the star's pixel scale, its colours base to tip, alpha. */
export interface StarSpine {
  length: number
  width: number
  innerColor: Vector3
  outerColor: Vector3
  alpha: number
}

/** A `[spines]` (`FUN_0050fba0`), over `FStarSphere`'s defaults. */
export interface StarSpines {
  /** `shape`. Nothing draws without one. */
  shape?: TextureShape
  /** `radius_scale`, 1 when absent: every spine's length and width times it. */
  radiusScale?: number
  /** `min_radius` and `max_radius`, 1 and 1000 when absent: the pixel scale held between. */
  minRadius?: number
  maxRadius?: number
  /** In file order, spread evenly round from the right, anticlockwise on screen. */
  spines: readonly StarSpine[]
}

/** A `bead` of a `[lens_flare]`: how far along, how big, its colour and alpha. */
export interface FlareBead {
  along: number
  size: number
  color: Vector3
  alpha: number
}

/** A `[lens_flare]` (`FUN_0050f3a0`), over `FStarSphere`'s defaults. */
export interface StarLensFlare {
  /** `shape`: its texture, whole. Nothing draws without one. */
  shape?: TextureShape
  /** `min_radius` and `max_radius`, 5 and 800 when absent: the pixel scale held between. */
  minRadius?: number
  maxRadius?: number
  /**
   * Its beads. Retail sorts them by where the heap put them, but they add, so any order gives the
   * same pixels.
   */
  beads: readonly FlareBead[]
}

/** `FUN_00510990`: how much of the corona shows about a spine, by the samples near it. */
const spineShown = ({ rim, inner, lod }: StarState, index: number, count: number): number => {
  const outer = (at: number) => rim[at]!.alpha
  const ring = (at: number) => inner[at]!.alpha
  const wrapOuter = (at: number) => (at > 12 ? at - 12 : at)
  const wrapLow = (at: number) => (at < 0 ? at + 12 : at)
  const wrapHigh = (at: number) => (at > 11 ? at - 12 : at)
  switch (count) {
    case 12: {
      const sum = outer(wrapOuter(index + 1))
      return lod <= 2 ? sum : (sum + ring(index)) / 2
    }
    case 4:
    case 6: {
      // The first spine's base is the centre's sample, as retail indexes it.
      const base = count === 6 ? index * 2 : Math.trunc(index * 3)
      let sum = outer(wrapOuter(base + 1))
      sum = sum + sum + outer(base) + outer(wrapOuter(base + 2))
      if (lod <= 2) return sum / 4
      sum = sum + ring(wrapLow(base - 1)) + ring(base) * 3 + ring(wrapHigh(base + 1))
      return sum / 9
    }
    case 2: {
      const base = Math.trunc(index * 6)
      const minus = base - 1 < 1 ? base - 1 + 12 : base - 1
      const twice = outer(base) + outer(base)
      let sum = outer(minus) + twice
      sum = sum + outer(wrapOuter(base + 1)) * 4
      sum = sum + (outer(wrapOuter(base + 2)) + outer(wrapOuter(base + 2)))
      sum = sum + outer(wrapOuter(base + 2))
      if (lod <= 2) return sum / 10
      sum =
        sum +
        ring(wrapLow(base - 2)) +
        ring(wrapLow(base - 1)) * 3 +
        ring(base) * 6 +
        ring(wrapHigh(base + 1)) * 3 +
        ring(wrapHigh(base + 2))
      return sum / 24
    }
    default:
      return 0
  }
}

// `DAT_0061346c`: how much of a spine's alpha its own corona samples give, against the intensity.
const SPINE_BLEND = f(0.8)

/** A spine's angles: `2π / count` apart from 0, summed as floats (`0x50fe1c`). */
const spineAngles = (count: number): number[] => {
  const step = f(f(f(Math.PI) * 2) / count)
  let angle = 0
  return Array.from({ length: count }, () => {
    const at = angle
    angle = f(angle + step)
    return at
  })
}

/**
 * `FUN_00510160`: each spine three quads out from the sun, base to the inner ring's radius, to the
 * rim's, to its tip, fading in from nothing at the base, added by alpha (`SRCALPHA, ONE`).
 */
const spinesDraw = (
  state: StarState,
  star: Star,
  at: { x: number; y: number; pixelScale: number },
  visibility: number,
  view: CoronaView,
): Draw | undefined => {
  const settings = star.spines
  const shape = settings?.shape
  if (!settings || !shape) return undefined
  const { minRadius = 1, maxRadius = 1000, radiusScale = 1 } = settings
  let scale = at.pixelScale
  if (scale > f(maxRadius)) scale = f(maxRadius)
  else if (scale < f(minRadius)) scale = f(minRadius)
  const glow = star.lensGlow ?? {}
  const tween = f(glow.interiorTween ?? 0.5)
  const bodyScale = f(glow.radiusScale ?? 2)
  const innerR = f(tween * bodyScale * scale)
  const outerR = f(scale * bodyScale * (tween + 1) * 0.5)
  const centreAlpha = state.rim[0]!.alpha
  const { x: sx, y: sy } = at
  const { u0, v0, u1, v1 } = shape
  const count = settings.spines.length
  const angles = spineAngles(count)
  const vertices: ScreenVertex[] = []
  settings.spines.forEach((spine, index) => {
    const cos = f(Math.cos(angles[index]!))
    const sin = f(Math.sin(angles[index]!))
    const length = scale * f(spine.length * f(radiusScale))
    const halfWidth = scale * f(spine.width * f(radiusScale)) * 0.5
    const t0 = f(innerR * (1 / length))
    const t1 = f((1 / length) * outerR)
    // Out along (cos, -sin), across by (sin, cos) · ±half width.
    const point = (across: number, out: number) => ({
      x: f(across * sin + sx + f(cos * out)),
      y: f(across * cos - f(sin * out) + sy),
    })
    const alpha = f(
      ((1 - SPINE_BLEND) * state.intensity + spineShown(state, index, count) * SPINE_BLEND) *
        spine.alpha *
        visibility,
    )
    const uInner = f(t0 * u1 + u0 * (1 - t0))
    const uOuter = f(t1 * u1 + u0 * (1 - t1))
    const lerp = (t: number): Vector3 => ({
      x: f((1 - t) * spine.innerColor.x + t * spine.outerColor.x),
      y: f((1 - t) * spine.innerColor.y + t * spine.outerColor.y),
      z: f((1 - t) * spine.innerColor.z + t * spine.outerColor.z),
    })
    const innerColor = lerp(t0)
    const outerColor = lerp(t1)
    const innerAlpha = f(alpha * centreAlpha)
    const rows = [
      { out: 0, u: u0, color: spine.innerColor, alpha: 0 },
      { out: innerR, u: uInner, color: innerColor, alpha: innerAlpha },
      { out: outerR, u: uOuter, color: outerColor, alpha },
      { out: length, u: u1, color: spine.outerColor, alpha },
    ]
    for (let quad = 0; quad < 3; quad++) {
      const near = rows[quad]!
      const far = rows[quad + 1]!
      const corner = (row: typeof near, across: number, v: number): ScreenVertex => ({
        ...point(across, row.out),
        u: row.u,
        v,
        color: row.color,
        alpha: row.alpha,
      })
      vertices.push(
        corner(near, -halfWidth, v0),
        corner(far, -halfWidth, v0),
        corner(far, halfWidth, v1),
        corner(near, halfWidth, v1),
      )
    }
  })
  if (!vertices.length) return undefined
  return screenDraw('spines', 'quads', vertices, shape, 'alphaAdd', view)
}

/**
 * `FStarSphere::Draw` (`LAB_00511ca0`) after the effects: the zone's occlusion eased toward
 * `zoneBlocked`, what showed of the corona noted for the flare, the sun projected, its samples
 * cast, then its spines and its corona drawn. Nothing past a zone's full occlusion, nor with the sun
 * behind.
 */
export const starCorona = (
  star: Star,
  position: Vector3,
  zoneBlocked: boolean,
  view: Omit<CoronaView, 'visibility'>,
): Draw[] => {
  const state = stateOf(star)
  const glow = star.lensGlow ?? {}
  const { fadeIn = 2, fadeOut = 2 } = star.zoneOcclusionFade ?? {}
  // Toward 1 by the fade-out's step and back by the fade-in's (`0x511cf6`).
  const target = zoneBlocked ? 1 : 0
  if (target > state.zoneOcclusion) {
    const next = state.step / fadeOut + state.zoneOcclusion
    state.zoneOcclusion = next > target ? target : f(next)
  } else if (target < state.zoneOcclusion) {
    const next = state.zoneOcclusion - state.step / fadeIn
    state.zoneOcclusion = next < target ? target : f(next)
  }
  if (!(state.zoneOcclusion < 1)) return []

  const { camera, width, height } = view
  const inView = Matrix4.transformPoint(position, view.view)
  state.viewZ = f(inView.z)
  state.hidden = f(1 - shown(state))

  const all = [...state.rim, ...state.inner]
  const up = f(state.step / f(glow.fadeIn ?? 0.25))
  const down = f(state.step / f(glow.fadeOut ?? 0.25))
  // `Project`: nothing nearer than the near plane.
  const local = { x: f(inView.x), y: f(inView.y), z: f(inView.z) }
  if (!(-camera.near >= local.z)) {
    if (state.hidden < 1) for (const slot of all) ease(slot, 0, up, down)
    return []
  }
  const screen = screenOf(camera, width, height)
  const invZ = -1 / local.z
  state.x = f(local.x * screen.scaleX * invZ + screen.centreX)
  state.y = f(local.y * screen.scaleY * invZ + screen.centreY)
  const depth = Math.max(f(-local.z), f(0.1))
  state.pixelScale = f(
    camera.near * f(screen.scaleX / camera.near) * ((star.radius ?? 1000) / depth),
  )
  const { x, y, pixelScale } = state
  if (local.z >= 0) return []

  const reach = Math.max(f(f(glow.radiusScale ?? 2) * pixelScale * 2), 50)
  const bodyOnScreen = x > -reach && width + reach > x && y > -reach && height + reach > y
  // The longest spine, after `radius_scale`, times the pixel scale (`0x511fe5`).
  const radiusScale = f(star.spines?.radiusScale ?? 1)
  const longest = (star.spines?.spines ?? []).reduce(
    (most, { length }) => (most > f(length * radiusScale) ? most : f(length * radiusScale)),
    0,
  )
  const spineReach = f(longest * pixelScale)
  const spinesOnScreen =
    x > -spineReach && width + spineReach > x && y > -spineReach && height + spineReach > y
  const at = { x, y, pixelScale }
  if (bodyOnScreen) sample(state, glow, position, at, { ...view, visibility: 1 })
  else if (!spinesOnScreen) {
    if (state.hidden < 1) {
      const glowUp = 5 / f(glow.fadeIn ?? 0.25)
      const glowDown = 5 / f(glow.fadeOut ?? 0.25)
      for (const slot of all) fadeToZero(slot, glowUp, glowDown)
    }
    return []
  } else if (state.hidden < 1) for (const slot of all) fadeToZero(slot, up, down)

  const visibility = f(1 - state.zoneOcclusion)
  const draws: Draw[] = []
  if (spinesOnScreen) {
    const spines = spinesDraw(state, star, at, visibility, { ...view, visibility })
    if (spines) draws.push(spines)
  }
  if (bodyOnScreen) draws.push(...coronaDraws(state, glow, at, { ...view, visibility }))
  return draws
}

/**
 * `FStarSphere::DrawFlare` (`LAB_005124f0`), at the cockpit pass's end: the beads along the line
 * from the sun through the screen's middle, at the screen place and pixel scale the last draw left,
 * each a square of the whole texture, added by alpha (`SRCALPHA, ONE`). They fade as the sun nears
 * the middle, brighten with `Intensity`, and go with the zone's occlusion and the sun behind.
 */
export const starFlare = (
  star: Star,
  view: { view: Matrix4; width: number; height: number },
): Draw | undefined => {
  const state = stateOf(star)
  // The pass gives 1 for its step, so this is the zone's visibility (`0x51250a`).
  const visibility = f(1 - state.zoneOcclusion)
  if (!(visibility * state.intensity > 0)) return undefined
  if (!(state.viewZ < 0)) return undefined
  const flare = star.lensFlare
  const shape = flare?.shape
  if (!flare || !shape) return undefined
  const { width, height } = view
  // The viewport's rectangle ends on its last pixel.
  const midX = (width - 1) * 0.5
  const midY = f((height - 1) * 0.5)
  const fadeBy = 1 - state.intensity
  const brightness = 1 - fadeBy * fadeBy
  let scale = state.pixelScale
  if (scale > f(flare.maxRadius ?? 800)) scale = f(flare.maxRadius ?? 800)
  else if (scale < f(flare.minRadius ?? 5)) scale = f(flare.minRadius ?? 5)
  const half = f(scale * brightness * visibility)
  const dx = midX - state.x
  const dy = midY - state.y
  const tenth = (width - 1) * 0.1
  const limit = f(tenth * tenth)
  const squared = dy * dy + dx * dx
  const fade = squared < limit ? f(squared / limit) : 1
  const axisX = f(dx * 3)
  const axisY = f(dy * 3)
  const vertices: ScreenVertex[] = []
  for (const { along, size, color, alpha } of flare.beads) {
    const cx = f(axisX * along + state.x)
    const cy = f(f(axisY * along) + state.y)
    const h = f(half * size)
    const x0 = f(cx - h)
    const x1 = f(cx + h)
    const y0 = f(cy - h)
    const y1 = f(cy + h)
    const a = f(fade * alpha)
    vertices.push(
      { x: x0, y: y0, u: 0, v: 0, color, alpha: a },
      { x: x1, y: y0, u: 1, v: 0, color, alpha: a },
      { x: x1, y: y1, u: 1, v: 1, color, alpha: a },
      { x: x0, y: y1, u: 0, v: 1, color, alpha: a },
    )
  }
  if (!vertices.length) return undefined
  return screenDraw('lens flare', 'quads', vertices, shape, 'alphaAdd', view)
}
