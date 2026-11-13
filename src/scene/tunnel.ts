/**
 * A jump gate's tunnel: `FGateTunnel`, in `src/freelancer/Client/gate_tunnel.cpp`. A tube along a
 * random spline, which the player's ship is beamed along while it jumps, drawn as rings of strips
 * around it, fading and narrowing ahead. Nine curves of `num_spline_control_points` each: the path's
 * x, y and z, the radius, a rotation nothing reads, three colour offsets and a brightness, scrolled
 * on as the ship nears the end. Pure, no GL.
 */
import { cubicAt, Matrix4, type CubicSegment, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import {
  Primitive,
  setMapCount,
  VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import { DEFAULT_SAMPLER } from '#/texture/texture.js'
import type { Draw, SceneLight } from './frame.js'
import type { Random } from './lightning.js'
import { clampByte, unitByte } from './retail.js'

const f = Math.fround

// XYZ, D3DCOLOR and one UV set: Win3D's FVF 0x142, 24 bytes.
const FORMAT = setMapCount(VertexFormat.Position | VertexFormat.Diffuse, 1)
const STRIDE = 24
const BLACK: Vector3 = { x: 0, y: 0, z: 0 }

// `DAT_005da778`, a curve's draws onto [0, 1], and `DAT_005caeec`, the light's onto [0, 1).
const RAND_UNIT = f(1 / 32767)
const RAND_HALF_UNIT = f(1 / 32768)
const TWO_PI = f(6.2831855)
// `DAT_005da738`, a double: how far `BuildFrame` looks ahead along the path.
const FRAME_STEP = 5e-6
// `DAT_00613254`, `_58` and `_5c`, with no writer: the scroll's head, tail and pad.
const SCROLL_HEAD = 3
const SCROLL_TAIL = 3
const SCROLL_PAD = 1
const SCROLL = SCROLL_TAIL + SCROLL_PAD + SCROLL_HEAD + 1
// `DAT_00613260`, `_68`, `_6c` and `_70`.
const LIGHT_WEIGHT = 6
const LOOK_AHEAD = f(0.02)
const STEP_GROWTH = f(1.1)
const ALPHA_BIAS = f(0.05)
// `Draw`'s window about the ship, as `EmitLayer`'s float arguments.
const WINDOW_AHEAD = f(0.1)
const WINDOW_BEHIND = f(-0.01)

/** A `[layer]` of a `[gate_tunnel]`, as `GateTunnelIniLoad` (`0x4fe1c0`) reads it. */
export interface TunnelLayer {
  /** `texture`, a shape of `FX/effect_shapes.ini`: its texture's first frame, whole. None if not found. */
  texture?: Texture
  /** `color`, 0 to 1: the bytes as written over 255. */
  color: Vector3
  /**
   * `near_alpha` and `far_alpha`. Retail's files write `near_alpha_factor` and `far_alpha_factor`,
   * which `Freelancer-original.exe` has no string for, so every retail layer fades from 1 to 0.
   */
  nearAlpha: number
  farAlpha: number
  radiusFactor: number
  /** `u_offset` and `v_offset`: where the texture starts, scrolled on by `du` and `dv` a second. */
  uOffset: number
  vOffset: number
  du: number
  dv: number
  vScale: number
}

/** A `[layer]`'s defaults (`0x4fe70c`). */
export const RETAIL_TUNNEL_LAYER: Readonly<TunnelLayer> = {
  color: { x: 0.5, y: 0.5, z: 0.5 },
  nearAlpha: 1,
  farAlpha: 0,
  radiusFactor: 1,
  uOffset: 0,
  vOffset: 0,
  du: f(0.09),
  dv: f(0.07),
  vScale: 10,
}

/**
 * A `[gate_tunnel]`'s keys, as `GateTunnelIniLoad` reads them. `fade_distance`, `near_alpha` and
 * `far_alpha` here are never read.
 */
export interface TunnelSettings {
  writeDepth: boolean
  /** `num_spline_control_points`. Under 2 builds no curves, where retail reads past their ends. */
  controlPoints: number
  /** `x_range`, `y_range` and `z_range`: the path wanders `x` and `y` across, and runs `z` long. */
  range: Vector3
  minRadius: number
  maxRadius: number
  /** What the radius is ahead of the ship, at the window's far end. */
  farRadiusFactor: number
  /** Of the path, a second. */
  minSpeed: number
  maxSpeed: number
  timeToMaxSpeed: number
  /** `num_t_steps`: along the path, the first strip's length 1 / it. */
  tSteps: number
  /** `num_s_steps`: around each ring. */
  sSteps: number
  minRotation: number
  maxRotation: number
  /** `min_rgb` and `max_rgb`, 0 to 1: the colour offsets' range. */
  minRgb: Vector3
  maxRgb: Vector3
  /** Two at most: a third is refused. */
  layers: readonly TunnelLayer[]
}

/** `FGateTunnel`'s constructor (`0x4fee30`). */
export const RETAIL_TUNNEL: Readonly<TunnelSettings> = {
  writeDepth: true,
  controlPoints: 11,
  range: BLACK,
  minRadius: 50,
  maxRadius: 50,
  farRadiusFactor: 1,
  minSpeed: f(3e-5),
  maxSpeed: f(0.06),
  timeToMaxSpeed: 8,
  tSteps: 200,
  sSteps: 12,
  minRotation: f(-Math.PI),
  maxRotation: f(Math.PI),
  minRgb: BLACK,
  maxRgb: BLACK,
  layers: [],
}

/** `SetState`: 0 idle, 1 built for the jump out, 2 in the tunnel, 3 jumping in. */
export type TunnelState = 0 | 1 | 2 | 3

/**
 * `GateTunnelSolveSpline` (`FUN_005018a0`): the natural-end cubic through `y[0..n]`, as
 * `naturalSpline` solves it but rounded to a float at every step.
 */
export const solveSpline = (y: readonly number[], n: number): CubicSegment[] => {
  const gamma = new Array<number>(n + 1).fill(0)
  const delta = new Array<number>(n + 1).fill(0)
  const d = new Array<number>(n + 1).fill(0)

  // Forward sweep of the tridiagonal system for the knot derivatives `d`, then back-substitution;
  // `c0..c3` are each segment's power-basis cubic over t in [0, 1].
  gamma[0] = 0.5
  for (let i = 1; i < n; i++) gamma[i] = f(1 / (4 - gamma[i - 1]!))
  gamma[n] = f(1 / (2 - gamma[n - 1]!))
  delta[0] = f((y[1]! - y[0]!) * gamma[0]! * 3)

  for (let i = 1; i < n; i++)
    delta[i] = f(((y[i + 1]! - y[i - 1]!) * 3 - delta[i - 1]!) * gamma[i]!)

  delta[n] = f(((y[n]! - y[n - 1]!) * 3 - delta[n - 1]!) * gamma[n]!)
  d[n] = delta[n]!
  for (let i = n - 1; i >= 0; i--) d[i] = f(delta[i]! - d[i + 1]! * gamma[i]!)
  return Array.from({ length: n }, (_, i) => ({
    c0: y[i]!,
    c1: d[i]!,
    c2: f((y[i + 1]! - y[i]!) * 3 - (d[i]! + d[i]!) - d[i + 1]!),
    c3: f((y[i]! - y[i + 1]!) * 2 + d[i]! + d[i + 1]!),
  }))
}

/** `FGateTunnelCurve`: control values and their spline, and the range new values are drawn from. */
export class TunnelCurve {
  samples: number[] = []
  segments: CubicSegment[] = []
  minimum = 0
  maximum = 1

  constructor(private readonly random: Random) {}

  // `rand() * DAT_005da778 * (max - min) + min`, kept as a float.
  draw(): number {
    return f(this.random() * RAND_UNIT * (this.maximum - this.minimum) + this.minimum)
  }

  /** `FUN_00501810`: at 1 the last control value; anything else, segment `floor(n t)` at the rest. */
  sample(t: number): number {
    const count = this.segments.length
    if (t === 1) return this.samples[count]!

    const scaled = count * t
    const whole = Math.trunc(scaled)

    return cubicAt(this.segments[whole]!, scaled - whole)
  }

  /** `EmitLayer`'s inlined brightness sample: the same, its fraction rounded to a float. */
  sampleRounded(t: number): number {
    const count = this.segments.length
    if (t === 1) return this.samples[count]!

    const scaled = count * t
    const whole = Math.trunc(scaled)

    return cubicAt(this.segments[whole]!, f(scaled - whole))
  }

  /** `FUN_005012e0`: `count` values drawn from the range, the first `head` and last `tail` 0. */
  randomize(count: number, minimum: number, maximum: number, head: number, tail: number): void {
    this.minimum = minimum
    this.maximum = maximum

    const values = Array.from({ length: count }, () => this.draw())
    for (let i = 0; i < head && i < count; i++) values[i] = 0
    for (let i = Math.max(count - tail, 0); i < count; i++) values[i] = 0
    this.set(values)
  }

  /** `FUN_00501470`: the last `shift` values to the front, the rest drawn afresh. Not under 8. */
  scroll(shift: number): void {
    const count = this.samples.length
    if (shift < 8 || count < 8) return

    const values = this.samples
    for (let i = 0; i < shift; i++) values[i] = values[count - shift + i]!
    for (let i = shift; i < count; i++) values[i] = this.draw()
    this.segments = solveSpline(values, count - 1)
  }

  /** `FUN_00501750`. */
  set(values: readonly number[]): void {
    this.samples = [...values]
    this.segments = solveSpline(this.samples, this.samples.length - 1)
  }
}

/** `BuildFrame` (`FUN_004ffbb0`): the path's frame at `t`, its axes not made unit. */
interface PathFrame {
  left: Vector3
  up: Vector3
  point: Vector3
}

const round = ({ x, y, z }: Vector3): Vector3 => ({ x: f(x), y: f(y), z: f(z) })
const length = ({ x, y, z }: Vector3): number => Math.sqrt(x * x + y * y + z * z)

/** `ScaleClampToByte`: times 255, truncated, held to a byte. */
const byte = unitByte

// `NormalizeInPlace`, over the sum as given.
const normalize = (v: Vector3, squared: number): Vector3 => {
  const inverse = 1 / Math.sqrt(squared)

  return { x: f(inverse * v.x), y: f(inverse * v.y), z: f(inverse * v.z) }
}

/**
 * One loaded `[gate_tunnel]`. The game keeps one of each and hands it to the player's jump
 * (`FJumpShipEffect`, `0x503440`), which places it at the archetype's `jump_out_hp` and drives its state;
 * the host does both. Loading draws its curves, and so does each jump out.
 */
export class GateTunnel {
  /** The gate's `jump_out_hp` in the world: the path runs down its -Z, from 5 out. */
  frame: Matrix4 = Matrix4.identity
  state: TunnelState = 0
  /** Where the ship is along the path, 0 to 1. */
  phase = 0
  /** The ship, as `Update` beams it along the path in states 2 and 3: right, up and back, and where. */
  ship: Matrix4 | undefined

  readonly layers: TunnelLayer[]
  private readonly settings: TunnelSettings
  private readonly random: Random
  private readonly pathX: TunnelCurve
  private readonly pathY: TunnelCurve
  private readonly pathZ: TunnelCurve
  private readonly radius: TunnelCurve
  private readonly rotation: TunnelCurve
  private readonly brightness: TunnelCurve
  private readonly offsetR: TunnelCurve
  private readonly offsetG: TunnelCurve
  private readonly offsetB: TunnelCurve
  private speedClock = 0
  private segment = 0
  private lit: { color: Vector3; direction: Vector3; enabled: boolean } | undefined

  constructor(
    settings: Partial<TunnelSettings> = {},
    { random = () => Math.floor(Math.random() * 0x8000) }: { random?: Random } = {},
  ) {
    this.settings = { ...RETAIL_TUNNEL, ...settings }
    // Each layer's offsets scroll, so it's this tunnel's own.
    this.layers = this.settings.layers.slice(0, 2).map((layer) => ({ ...layer }))
    this.random = random

    const curve = () => new TunnelCurve(random)

    this.pathX = curve()
    this.pathY = curve()
    this.pathZ = curve()
    this.radius = curve()
    this.rotation = curve()
    this.brightness = curve()
    this.offsetR = curve()
    this.offsetG = curve()
    this.offsetB = curve()
    this.build()
  }

  /**
   * The light `EnterState1` makes: directional, mostly down, white, flickering once a draw has
   * switched it on. In the tunnel the player's ship is lit by it alone, over the jump's
   * `jump_ambient` (`FClientShipGameobj::Slot184`, `0x546480`); `EnterState3` releases it, so a ship
   * jumping in has none.
   */
  get light(): SceneLight | undefined {
    if (!this.lit) return undefined

    const { color, direction } = this.lit

    return { color: { x: color.x / 255, y: color.y / 255, z: color.z / 255 }, direction }
  }

  /** `SetState` (`FUN_004ff360`). */
  setState(state: TunnelState): void {
    this.state = state

    if (state === 0) {
      this.segment = 0
      this.phase = 0
      this.speedClock = 0
      this.ship = undefined
    } else if (state === 1) {
      this.speedClock = 0
      this.build()
      this.makeLight()
    } else if (state === 2) this.speedClock = 0
    else this.lit = undefined
  }

  /** `Update` (`FUN_004ff3c0`), each step of the jump's states 2 and 3. */
  update(step: number): void {
    if (this.state === 0) return

    const { controlPoints, minSpeed, maxSpeed, timeToMaxSpeed } = this.settings

    if (this.state === 2 || this.state === 3) {
      const clock = step + this.speedClock

      this.speedClock = f(clock)

      let ratio = clock / timeToMaxSpeed
      if (1 < ratio) ratio = 1

      // Speed ramps linearly from `minSpeed` to `maxSpeed` over `timeToMaxSpeed`; phase is path fraction.
      const phase = (ratio * (maxSpeed - minSpeed) + minSpeed) * step + this.phase

      this.phase = f(phase)
      this.segment = Math.trunc((controlPoints - 1) * phase)

      // Near the path's end every curve scrolls on, and the ship moves back as far.
      const limit = controlPoints - SCROLL_PAD - SCROLL_HEAD - 1

      if (this.segment >= limit) {
        this.pathX.scroll(SCROLL)
        this.pathY.scroll(SCROLL)
        this.rotation.scroll(SCROLL)
        this.radius.scroll(SCROLL)
        this.offsetR.scroll(SCROLL)
        this.offsetG.scroll(SCROLL)
        this.offsetB.scroll(SCROLL)
        this.brightness.scroll(SCROLL)

        // The samples moved back `limit - 3` control points, so the phase does, in 1/segments units.
        const segments = controlPoints - 1

        this.segment = 3
        this.phase = f(this.phase - limit / segments + 3 / segments)
      }

      const here = this.pathPoint(this.phase)
      const ahead = this.pathPoint(f(LOOK_AHEAD + this.phase))
      const dir = round({ x: ahead.x - here.x, y: ahead.y - here.y, z: ahead.z - here.z })
      const inverse = 1 / length(dir)
      const back = { x: -f(dir.x * inverse), y: -f(dir.y * inverse), z: -f(dir.z * inverse) }
      // `N × (0, 1, 0)`, negated, and then `N × R`.
      const right = { x: -f(back.y * 0 - back.z), y: -f(back.z * 0 - back.x * 0), z: -f(back.x) }
      const up = round({
        x: right.z * back.y - right.y * back.z,
        y: back.z * right.x - right.z * back.x,
        z: right.y * back.x - back.y * right.x,
      })

      const axis = (v: Vector3) => {
        const by = 1 / length(v)

        return { x: f(v.x * by), y: f(v.y * by), z: f(v.z * by), w: 0 }
      }

      this.ship = { x: axis(right), y: axis(up), z: axis(back), w: { ...here, w: 1 } }
    }

    // A light a draw switched on flickers, in brightness and about its direction.
    const lit = this.lit

    if (lit?.enabled) {
      const a = f(this.random() * RAND_HALF_UNIT)
      const dim = 1 - this.random() * a * RAND_HALF_UNIT
      // `ScaleVec3` by 255, truncated and held to a byte.
      const scaled = (value: number) => clampByte(f(f(value * dim) * 255))

      lit.color = { x: scaled(f(0.8)), y: scaled(f(0.8)), z: scaled(1) }

      const d = lit.direction
      const weighted = {
        x: f(LIGHT_WEIGHT * d.x),
        y: f(LIGHT_WEIGHT * d.y),
        z: f(LIGHT_WEIGHT * d.z),
      }
      const randZ = this.random() * RAND_HALF_UNIT
      const randY = this.random() * RAND_HALF_UNIT
      const jitterX = this.random() * RAND_HALF_UNIT * 2 - 1
      const jittered = {
        x: f(jitterX + weighted.x),
        y: f(randY * 2 - 1 + weighted.y),
        z: f(f(randZ * 2 - 1) + weighted.z),
      }

      lit.direction = normalize(
        jittered,
        jittered.x * jittered.x + jittered.y * jittered.y + jittered.z * jittered.z,
      )
    }

    for (const layer of this.layers) {
      layer.uOffset = f(step * layer.du + layer.uOffset)
      layer.vOffset = f(step * layer.dv + layer.vOffset)
    }
  }

  /**
   * `Draw` (`FUN_004ffab0`): each layer from 0.1 of the path ahead of the ship to 0.01 behind, one
   * strip around the tube at a time, nearer strips longer by 1.1 each. Unculled and blended, the
   * first layer by alpha and the second `ONE, INVSRCALPHA`, unlit in its vertex colour times the
   * texture, which wraps; depth written as `write_depth_buffer` says. It switches the light on.
   *
   * Depth is tested `LEQUAL`, Win3D's own state, and the alpha test and fog are what the frame left:
   * `GREATER 0` and none, as `jump_hole` captured them.
   */
  draws(): Draw[] {
    if (this.state === 0) return []
    if (this.lit) this.lit.enabled = true

    const draws: Draw[] = []

    this.layers.forEach((layer, index) => this.emitLayer(layer, index, draws))
    return draws
  }

  // The curves, as loading and `EnterState1` build them, in that order of `rand()`.
  private build(): void {
    const {
      controlPoints: count,
      range,
      minRadius,
      maxRadius,
      minRotation,
      maxRotation,
    } = this.settings
    const { minRgb, maxRgb } = this.settings

    if (count < 2) return
    // `RebuildPath(0)`: x with its first three 0, y the same, and z falling away along -Z.
    this.pathX.minimum = f(range.x * -0.5)
    this.pathX.maximum = f(range.x * 0.5)

    const xs = Array.from({ length: count }, () => this.pathX.draw())
    for (let i = 0; i < 3 && i < count; i++) xs[i] = 0
    this.pathX.set(xs)
    this.pathY.randomize(count, f(range.y * -0.5), f(range.y * 0.5), 3, 0)
    this.pathZ.set(Array.from({ length: count }, (_, i) => f(-((i * range.z) / count) - 5)))
    this.radius.randomize(count, minRadius, maxRadius, 0, 0)
    this.rotation.randomize(count, minRotation, maxRotation, 3, 0)
    this.offsetR.randomize(count, minRgb.x, maxRgb.x, 0, 0)
    this.offsetG.randomize(count, minRgb.y, maxRgb.y, 0, 0)
    this.offsetB.randomize(count, minRgb.z, maxRgb.z, 0, 0)
    this.brightness.randomize(count, 0.5, 1, 0, 0)
  }

  // `EnterState1`'s light: white, down, the first draw kept for z.
  private makeLight(): void {
    const randZ = this.random() * RAND_HALF_UNIT
    const x = f(this.random() * RAND_HALF_UNIT * 2 - 1)
    const z = f(randZ * 2 - 1)
    const direction = normalize({ x, y: -5, z }, 25 + z * z + x * x)

    this.lit = { color: { x: 255, y: 255, z: 255 }, direction, enabled: false }
  }

  // `HudTransformPoint` of the path at `t`, sampled z, y, x.
  private pathPoint(t: number): Vector3 {
    const local = {
      x: f(this.pathX.sample(t)),
      y: f(this.pathY.sample(t)),
      z: f(this.pathZ.sample(t)),
    }

    return round(Matrix4.transformPoint(local, this.frame))
  }

  private pathFrame(t: number): PathFrame {
    const aheadSum = t + FRAME_STEP
    const ahead = aheadSum > 1 ? f(t - FRAME_STEP) : f(aheadSum)
    const point = this.pathPoint(t)
    const next = this.pathPoint(ahead)
    const delta = round({ x: next.x - point.x, y: next.y - point.y, z: next.z - point.z })
    const inverse = 1 / length(delta)
    const forward = {
      x: f(-(delta.x * inverse)),
      y: f(-(delta.y * inverse)),
      z: f(-(delta.z * inverse)),
    }
    // `F × (0, 1, 0)`, negated: the left axis, then `F × L`.
    const left = {
      x: -f(forward.y * 0 - forward.z),
      y: -f(forward.z * 0 - forward.x * 0),
      z: -f(forward.x),
    }
    const up = round({
      x: left.z * forward.y - left.y * forward.z,
      y: forward.z * left.x - left.z * forward.x,
      z: left.y * forward.x - forward.y * left.x,
    })

    return { left, up, point }
  }

  // `EmitLayer` (`FUN_004ffe50`), with `num_t_steps` negated as `Draw` has it: from ahead, back.
  private emitLayer(layer: TunnelLayer, index: number, draws: Draw[]): void {
    const { tSteps, sSteps, farRadiusFactor, writeDepth } = this.settings
    let step = f(1 / -tSteps)
    const ringStep = f(1 / sSteps)
    const phase = this.phase
    const clamp = (value: number) => (1 < value ? 1 : 0 > value ? 0 : value)
    const startSum = clamp(WINDOW_AHEAD + phase)
    const start = f(startSum)
    const end = f(clamp(WINDOW_BEHIND + phase))
    const span = f(Math.abs(end - startSum))
    const color = layer.color

    let t = start

    for (;;) {
      if (step > 0 ? !(t < end) : !(t > end)) break

      const grown = STEP_GROWTH * step

      step = f(grown)

      const unclamped = f(t + grown)
      let next = 0 > unclamped ? 0 : unclamped
      if (grown > 0 ? end < next : end > next) next = end

      const fraction = (at: number) => f(clamp(Math.abs(at - phase) / span))

      // Radius lerps to `radius × farRadiusFactor` by how far `at` is from the ship, over the window.
      const size = (at: number) => {
        const radius = this.radius.sample(at) * layer.radiusFactor

        return f((radius * farRadiusFactor - radius) * fraction(at) + radius)
      }

      const size0 = size(t)
      const size1 = size(next)
      const frame0 = this.pathFrame(t)
      const frame1 = this.pathFrame(next)

      // Alpha from far to near, as the step runs backwards, cubed.
      const [from, to] =
        step < 0 ? [layer.farAlpha, layer.nearAlpha] : [layer.nearAlpha, layer.farAlpha]

      const progress = (at: number) => {
        const p = Math.abs(at - start) / span + ALPHA_BIAS

        return p < 1 ? p : 1
      }

      const alphaRange = to - from
      const base0 = f(alphaRange * progress(t) + from)
      const alpha0 = f(base0 * base0 * base0)
      const base1 = progress(next) * f(alphaRange) + from
      const alpha1 = f(base1 * base1 * base1)

      // Blue reads the red offsets, checked in `Freelancer-original.exe` (`0x500543`, `0x5005ce`
      // load `[esi+0x1bc]`): the blue curve is built and never sampled.
      const tint = (at: number, last: boolean) => {
        const r = f(this.offsetR.sample(at))
        const g = f(this.offsetG.sample(at))
        const b = last ? this.offsetR.sample(at) : f(this.offsetR.sample(at))
        const shade = this.brightness.sampleRounded(at)

        return [
          f(f(color.x + r) * shade),
          f(f(color.y + g) * shade),
          f(shade * f(color.z + b)),
        ] as const
      }

      const tint0 = tint(t, false)
      const tint1 = tint(next, true)

      const vertices: number[][] = []
      const colors: number[][] = []

      // A ring vertex: path point + left · r cos + up · r sin.
      const place = ({ left, up, point }: PathFrame, radius: number, cos: number, sin: number) => {
        const x = f(radius * cos)
        const y = f(radius * sin)
        const turned = round({
          x: left.x * x + up.x * y,
          y: left.y * x + up.y * y,
          z: left.z * x + up.z * y,
        })

        return [f(point.x + turned.x), f(point.y + turned.y), f(point.z + turned.z)]
      }

      // Around the ring in turns, a vertex on each end per angle (a strip); `sum <= 1` repeats the
      // first angle at 1 to close it.
      let angle = 0

      for (;;) {
        const radians = angle * TWO_PI
        const cos = Math.cos(radians)
        const sin = Math.sin(radians)
        const u = f(angle + layer.uOffset)

        vertices.push([...place(frame0, size0, cos, sin), u, f(t * layer.vScale + layer.vOffset)])
        colors.push([...tint0, alpha0])
        vertices.push([
          ...place(frame1, size1, cos, sin),
          u,
          f(next * layer.vScale + layer.vOffset),
        ])
        colors.push([...tint1, alpha1])

        const sum = angle + ringStep

        angle = f(sum)
        if (!(sum <= 1)) break
      }

      draws.push(stripDraw(layer, index, vertices, colors, writeDepth))
      t = unclamped
    }
  }
}

// One strip, as `Win3DEnd` issues it: `D3DPT_TRIANGLESTRIP` in the world, under the camera's view.
const stripDraw = (
  layer: TunnelLayer,
  index: number,
  corners: readonly number[][],
  colors: readonly number[][],
  depthWrite: boolean,
): Draw => {
  const vertices = new Uint8Array(corners.length * STRIDE)
  const view = new Float32Array(vertices.buffer)

  corners.forEach(([x, y, z, u, v], at) => {
    const [r, g, b, a] = colors[at]!

    view.set([x!, y!, z!], (at * STRIDE) / 4)
    vertices.set([byte(b!), byte(g!), byte(r!), byte(a!)], at * STRIDE + 12)
    view.set([u!, v!], (at * STRIDE + 16) / 4)
  })

  const mesh: VMeshData = {
    name: 'gate tunnel',
    version: 1,
    primitive: Primitive.TriangleStrip,
    format: FORMAT,
    groups: [
      {
        materialId: 0,
        vertexStart: 0,
        vertexEnd: corners.length - 1,
        elementCount: corners.length,
        padding: 0,
      },
    ],
    indices: Uint16Array.from(corners, (_, at) => at),
    vertices,
  }
  const reference: VMeshRef = {
    meshId: 0,
    vertexStart: 0,
    vertexCount: corners.length,
    indexStart: 0,
    indexCount: corners.length,
    groupStart: 0,
    groupCount: 1,
    boundingBox: { min: BLACK, max: BLACK },
    boundingSphere: { center: BLACK, radius: 0 },
  }
  const { texture } = layer

  return {
    mesh,
    reference,
    transient: true,
    byteOffset: 0,
    count: corners.length,
    world: Matrix4.identity,
    materialName: 'gate tunnel',
    diffuse: [1, 1, 1, 1],
    ambient: BLACK,
    emissive: BLACK,
    colorVertex: true,
    nomad: false,
    // Stage 0's `ADDRESSU` and `ADDRESSV` wrap (`Draw`, `0x4ffb14`).
    ...(texture && {
      texture: { name: texture.name, entry: texture, sampler: DEFAULT_SAMPLER, uvSet: 0 },
    }),
    cull: 'none',
    depthWrite,
    depthFunc: 'lequal',
    lightless: true,
    negateNormals: false,
    normalizeNormals: false,
    blend: true,
    blendMode: index === 0 ? 'alpha' : 'premultiplied',
    unlit: true,
    alphaReference: 0,
    alphaFunction: 'greater',
  }
}
