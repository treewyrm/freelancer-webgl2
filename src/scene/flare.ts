/**
 * An equipment light's flare: `CliEquipLight` in `src/freelancer/Client/client_equip_fx.cpp`, which
 * blinks and queues a bulb and a glow as screen quads, and `ScreenQuadEnqueueFlare` in
 * `screen_quad_state.cpp`, which sizes and clips them. Pure, no GL.
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { Camera } from './camera.js'
import type { Random } from './lightning.js'

const f = Math.fround

/** A `[Light]`'s flare keys, as `CliEQLight` holds them. The host reads the INI, `inherit` too. */
export interface FlareLight {
  /** `color` over 255. */
  color: Vector3
  /** `glow_color` over 255. A `color` line copies itself here while this is still black. */
  glowColor: Vector3
  /** `min_color` over 255: the bulb's colour while the blink is dark. */
  minColor: Vector3
  bulbSize: number
  glowSize: number
  /** `avg_delay`: about how long between blinks. None at 0 or less. */
  avgDelay: number
  /** `blink_duration`: how long one lasts, at most `avg_delay`'s draw. */
  blinkDuration: number
  /**
   * `flare_cone` in degrees, as written: past the first from its forward axis the glow is gone, and
   * from the second to the first it fades. None when absent.
   */
  flareCone?: readonly [number, number]
}

/** `FCliEQLight`'s constructor (`0x40a9e0`), what a `[Light]` with no keys has. */
export const RETAIL_FLARE_LIGHT: Readonly<FlareLight> = {
  color: { x: 0, y: 0, z: 0 },
  glowColor: { x: 0, y: 0, z: 0 },
  minColor: { x: 0, y: 0, z: 0 },
  bulbSize: 1,
  glowSize: 1,
  avgDelay: 0,
  blinkDuration: 0.3,
}

// `DAT_005caeec`, `DAT_005da4c0` and `DAT_005da4b8`: a period of 0.9 to 1.1 of `avg_delay`.
const RAND_UNIT = 3.0517578125e-5
const JITTER_SCALE = 0.20000004768371582
const JITTER_BASE = 0.8999999761581421

/**
 * A light's blink: `CliEquipLightInit` (`0x4fda00`) and its tick (`0x4fdd00`). A triangle up to 1 and
 * back over the lit part of each period, dark for the rest; always 1 when it doesn't blink. Each
 * light draws its period and phase from the game's `rand()` as it's made.
 */
export class LightBlink {
  #rate = 0
  #duty = 1
  #phase: number
  brightness = 1

  constructor(
    { avgDelay, blinkDuration }: Pick<FlareLight, 'avgDelay' | 'blinkDuration'>,
    random: Random = () => Math.floor(Math.random() * 0x8000),
  ) {
    const period = (random() * RAND_UNIT * JITTER_SCALE + JITTER_BASE) * f(avgDelay)
    if (period > 0) {
      const rate = 1 / f(period)
      this.#rate = f(rate)
      const lit = f(blinkDuration) > f(period) ? f(period) : f(blinkDuration)
      this.#duty = f(rate * lit)
    }
    this.#phase = f(random() * RAND_UNIT)
  }

  /** Where in its period it is, 0 to 1. */
  get phase(): number {
    return this.#phase
  }

  /** Advances by `step`, which the game holds to 0.1, only on a frame its object drew. */
  tick(step: number): void {
    if (this.#rate === 0) return
    const phase = f(step) * this.#rate + this.#phase
    this.#phase = f(phase >= 1 ? phase - Math.floor(phase) : phase)
    if (this.#phase > this.#duty) {
      this.brightness = 0
      return
    }
    const wave = (2 / this.#duty) * this.#phase
    this.brightness = f(wave > 1 ? 2 - wave : wave)
  }
}

/** A light on a ship or solar: its keys, where its hardpoint is, and its blink. */
export interface SpaceFlare {
  light: FlareLight
  /** The hardpoint's frame in the world. */
  world: Matrix4
  /** Steady at full brightness when absent. */
  blink?: LightBlink
}

/** One quad as the batcher records it (`FScreenQuadRecord`): D3D pixels, depth and `1 / w`. */
export interface ScreenQuad {
  x0: number
  y0: number
  x1: number
  y1: number
  /** `1 - near / -z`, the depth it's tested at. */
  z: number
  rhw: number
  u0: number
  v0: number
  u1: number
  v1: number
  /** `0xAARRGGBB`, alpha always 255. */
  color: number
}

/** A texture frame's rectangle, `GetTextureFrame`'s: `u0`, `v0`, `u1`, `v1`. Whole when absent. */
export type FrameRect = readonly [number, number, number, number]

const WHOLE: FrameRect = [0, 0, 1, 1]

/**
 * `ScreenQuadClip1D` (`0x404670`): an edge pair clipped to [lo, hi], its attribute pair following
 * over `span`. Nothing when it's wholly outside.
 */
const clip = (
  edges: [number, number],
  attributes: [number, number],
  lo: number,
  hi: number,
  span: number,
): boolean => {
  if (edges[1] < lo) return false
  if (edges[0] >= hi) return false
  const below = lo - edges[0]
  if (below > 0) {
    edges[0] = f(below + edges[0])
    attributes[0] = f((attributes[1] - attributes[0]) * (below / span) + attributes[0])
  }
  const above = hi - edges[1]
  if (!(above < 0)) return true
  edges[1] = f(above + edges[1])
  attributes[1] = f((attributes[1] - attributes[0]) * (above / span) + attributes[1])
  return true
}

/** `EnqueueFlareQuad`: one square, unless it's a pixel or less, black, or off the screen. */
const flareQuad = (
  rect: readonly [number, number, number, number],
  frame: FrameRect,
  color: Vector3,
  radiusX: number,
  radiusY: number,
  x: number,
  y: number,
  z: number,
  rhw: number,
): ScreenQuad | undefined => {
  if (!(radiusX > 1)) return undefined
  // `ftol` truncates, and only each component's low byte is kept.
  const [r, g, b] = [color.x, color.y, color.z].map((c) => Math.trunc(c * 255))
  if ((r! + g! + b!) >>> 0 <= 1) return undefined
  const xs: [number, number] = [f(x - radiusX), f(x + radiusX)]
  const ys: [number, number] = [f(y - radiusY), f(y + radiusY)]
  const us: [number, number] = [frame[0], frame[2]]
  const vs: [number, number] = [frame[1], frame[3]]
  if (!clip(xs, us, rect[0], rect[2], radiusX + radiusX)) return undefined
  if (!clip(ys, vs, rect[1], rect[3], radiusY + radiusY)) return undefined
  return {
    x0: xs[0],
    y0: ys[0],
    x1: xs[1],
    y1: ys[1],
    z,
    rhw,
    u0: us[0],
    v0: vs[0],
    u1: us[1],
    v1: vs[1],
    color: (0xff000000 | ((r! & 0xff) << 16) | ((g! & 0xff) << 8) | (b! & 0xff)) >>> 0,
  }
}

// `DAT_005c77f4`, the degrees-to-radians `flare_cone` is read with.
const DEGREES = f(0.017453292)

/** The fast inverse square root, one Newton step (`0x4fde1e`). */
const inverseLength = (squared: number): number => {
  const bits = new Float32Array([squared])
  const view = new Int32Array(bits.buffer)
  view[0] = 0x5f3759df - (view[0]! >> 1)
  const guess = bits[0]!
  return (1.5 - guess * guess * squared * 0.5) * guess
}

/** `CliEquipLightDrawFlare` (`0x4fdda0`): the glow's fade as the light faces away from the camera. */
const fadeOf = ({ flareCone }: FlareLight, world: Matrix4, eye: Vector3): number => {
  if (!flareCone) return 1
  const full = f(Math.cos(flareCone[1] * DEGREES))
  const none = f(Math.cos(flareCone[0] * DEGREES))
  if (!(full > none)) return 1
  const d = [f(world.w.x - eye.x), f(world.w.y - eye.y), f(world.w.z - eye.z)] as const
  const inverse = inverseLength(f(d[2] * d[2] + d[1] * d[1] + d[0] * d[0]))
  const [x, y, z] = d.map((c) => f(c * inverse)) as [number, number, number]
  // The rotation's third column: its forward axis, as `Matrix4` holds columns.
  const dot = f(z * world.z.z + y * world.z.y + x * world.z.x)
  if (dot < none) return 0
  if (dot < full) return f((dot - none) / (full - none))
  return 1
}

export interface FlareView {
  camera: Camera
  /** The camera's view, `viewMatrix(camera)`. */
  view: Matrix4
  /** The projection's, width over height. */
  aspect: number
  /** The viewport, in pixels. */
  width: number
  height: number
  frame?: FrameRect
}

/**
 * A light's bulb then its glow at `world`, the hardpoint's frame (`ScreenQuadEnqueueFlare`,
 * `0x4038f0`): squares of its sizes at its depth, each dropped under a pixel. Nothing behind the
 * camera, though anything nearer than the near plane passes as retail lets it.
 */
export const flareQuads = (
  light: FlareLight,
  world: Matrix4,
  brightness: number,
  { camera, view, aspect, width, height, frame = WHOLE }: FlareView,
): ScreenQuad[] => {
  // The camera's rectangle ends on its last pixel: `space_order`'s quads stand half a pixel up and
  // left of a 1024 by 768 one's centre, at the scale of its full width.
  const rect = [0, 0, width - 1, height - 1] as const
  const cot = 1 / Math.tan((camera.fovh * Math.PI) / 180)
  // Screen y runs down where the view's runs up.
  const scale = { x: (width / 2) * cot, y: -(height / 2) * aspect * cot }
  const fade = fadeOf(light, world, camera.position)
  const { color, glowColor, minColor } = light
  const glow = {
    x: brightness * glowColor.x,
    y: brightness * glowColor.y,
    z: brightness * glowColor.z,
  }
  const bulb = {
    x: f(f(brightness * f(color.x - minColor.x)) + minColor.x),
    y: f(f(brightness * f(color.y - minColor.y)) + minColor.y),
    z: f(brightness * f(color.z - minColor.z) + minColor.z),
  }
  const faded = { x: f(f(glow.x) * fade), y: f(f(glow.y) * fade), z: f(f(glow.z) * fade) }

  const at = Matrix4.transformPoint({ x: world.w.x, y: world.w.y, z: world.w.z }, view)
  const depth = f(f(at.z) - f(at.z) * 0.001)
  if (depth - camera.near >= 0) return []
  const rhw = f(-1 / depth)
  const perX = f(scale.x) * rhw
  const perY = f(scale.y) * rhw
  const bulbX = f(light.bulbSize) * perX
  const glowX = f(perX * f(light.glowSize))
  if (bulbX < 1 && glowX < 1) return []

  const x = f((rect[2] - rect[0]) * 0.5 + f(at.x) * f(scale.x) * rhw + rect[0])
  const y = f((rect[3] - rect[1]) * 0.5 + f(at.y) * f(scale.y) * rhw + rect[1])
  const z = f(1 - camera.near * rhw)
  const quads = [
    flareQuad(rect, frame, bulb, f(bulbX), f(Math.abs(f(light.bulbSize) * perY)), x, y, z, rhw),
    flareQuad(rect, frame, faded, glowX, f(Math.abs(perY * f(light.glowSize))), x, y, z, rhw),
  ]
  return quads.filter((quad) => quad !== undefined)
}
