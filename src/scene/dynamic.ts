/**
 * An asteroid field's `[DynamicAsteroids]`: a few loose rocks on a sphere about a point ahead of the
 * camera, drifting and turning, faded in as they come within it and placed afresh on its surface
 * once they drift out. `CliDynamicAsteroidUpdate` (`FUN_00525c80`), `Place` (`FUN_00525200`) and
 * `CliDynamicAsteroidDraw` (`FUN_005261b0`) in `src/freelancer/Client/cli_asteroid_dynamic.cpp`.
 * Places and motions are the game's `rand()`, so a run matches retail in kind. Pure, no GL.
 */
import { Matrix3, Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import { outsideSquared, type CubeExclusion } from './asteroids.js'
import { onSphere } from './billboards.js'
import type { Camera } from './camera.js'
import type { Random } from './lightning.js'
import { immersion, type Zone } from './nebula.js'

const f = Math.fround

/** A `[DynamicAsteroids]` section, over the manager's constructor (`FUN_005256a0`). The host reads it. */
export interface DynamicSettings {
  /** `count`, truncated, 10 when absent. */
  count?: number
  /**
   * `placement_radius`, 150 when absent. Its spawn point is 0.7 of it ahead, or 75 when absent.
   * Every retail file also has `placement_offset`, which nothing reads.
   */
  placementRadius?: number
  /** `max_velocity`, 50 when absent: the most a rock moves on each axis, a second. */
  maxVelocity?: number
  /** `max_angular_velocity`, 5 when absent: the most it turns about each axis, radians a second. */
  maxAngularVelocity?: number
  /** `color_shift`, 1 each when absent. */
  colorShift?: Vector3
}

/** What a field gives its dynamic asteroids. */
export interface DynamicField {
  /** The section's `zone`, or the field's: the spawn point must be within it. None, anywhere. */
  zone?: Zone
  /** That zone's `edge_fraction`. 0 when absent. */
  edgeFraction?: number
  /** The field's `diffuse_color` and `ambient_color` over 255. */
  diffuse: Vector3
  ambient: Vector3
  /** Its exclusion zones; those with `excludeDynamicAsteroids` keep the spawn point out. */
  exclusions?: readonly CubeExclusion[]
}

/** One rock to draw: its frame and its fade. */
export interface DynamicDraw {
  world: Matrix4
  alpha: number
}

interface Rock {
  position: Vector3
  orientation: Matrix3
  velocity: Vector3
  /** Its angular velocity about its own axes. */
  spin: Vector3
  /** `Alpha` (`+0xb0`): the fade last worked out, never written when it's made. */
  alpha: number
  /** `bPlaced` (`+0xad`): within the sphere since it was last placed. */
  placed: boolean
}

const RAND_UNIT = 3.0517578125e-5
const RAND_TWICE = 6.103515625e-5
// `DAT_005d3e6c` and `DAT_00613858`: the recycle distance and the fade band, over the radius squared.
const FAR = f(1.05)
const FADE = f(0.35)
// `DAT_005d3e44`: a rock at or under this alpha isn't drawn.
const VISIBLE = f(0.005)
// `DAT_005d1494`: how far into its zone the spawn point must be.
const IMMERSED = f(0.001)
/**
 * `set_max_dynamicasteroid_exclusion_distance(100)` at load (`0x521516`), squared: exclusion zones
 * further outside than this from the camera aren't asked.
 */
const EXCLUSION_REACH = 10000

/** A right-handed turn about a unit axis, its columns the turned axes. */
const turn = ({ x, y, z }: Vector3, angle: number): Matrix3 => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const t = 1 - c
  return {
    x: { x: t * x * x + c, y: t * x * y + s * z, z: t * x * z - s * y },
    y: { x: t * x * y - s * z, y: t * y * y + c, z: t * y * z + s * x },
    z: { x: t * x * z + s * y, y: t * y * z - s * x, z: t * z * z + c },
  }
}

const clampOne = ({ x, y, z }: Vector3): Vector3 => ({
  x: x < 1 ? x : 1,
  y: y < 1 ? y : 1,
  z: z < 1 ? z : 1,
})

export class DynamicAsteroids {
  readonly settings: DynamicSettings
  readonly field: DynamicField
  readonly random: Random
  /** `SlotCount`: `count` scaled by the `Asteroids` option, `(1 - d) · 0.5 + d`, rounded. */
  readonly count: number
  /** `PlacementRadius` and `PlacementRadiusInner`. */
  readonly radius: number
  readonly ahead: number
  /** `TintedDiffuse` and `TintedAmbient`: `color_shift` times the field's, held under 1. */
  readonly diffuse: Vector3
  readonly ambient: Vector3
  #rocks: (Rock | undefined)[]

  constructor(
    settings: DynamicSettings,
    field: DynamicField,
    {
      random = () => Math.floor(Math.random() * 0x8000),
      detail = 1,
    }: { random?: Random; detail?: number } = {},
  ) {
    this.settings = settings
    this.field = field
    this.random = random
    // `FUN_00520850` and `CliAsteroidApplyDetail` store the scale as a float.
    const scale = f((1 - detail) * 0.5 + detail)
    this.count = Math.trunc(Math.trunc(settings.count ?? 10) * scale + 0.5)
    this.#rocks = Array.from({ length: this.count }, () => undefined)
    const radius = settings.placementRadius
    this.radius = f(radius ?? 150)
    this.ahead = radius === undefined ? 75 : f(radius * 0.7)
    // `CliDynamicAsteroidApplyParentTints`.
    const shift = settings.colorShift ?? { x: 1, y: 1, z: 1 }
    this.diffuse = clampOne({
      x: f(field.diffuse.x * shift.x),
      y: f(shift.y * field.diffuse.y),
      z: f(shift.z * field.diffuse.z),
    })
    this.ambient = clampOne({
      x: f(shift.x * field.ambient.x),
      y: f(shift.y * field.ambient.y),
      z: f(shift.z * field.ambient.z),
    })
  }

  get rocks(): readonly (Readonly<Rock> | undefined)[] {
    return this.#rocks
  }

  /** `CliDynamicAsteroidUpdate`'s spawn point: `ahead` along the view. */
  centre({ position, orientation }: Camera): Vector3 {
    const back = -this.ahead
    return {
      x: f(f(orientation.z.x * back) + position.x),
      y: f(f(orientation.z.y * back) + position.y),
      z: f(f(orientation.z.z * back) + position.z),
    }
  }

  /** Whether a rock may be placed about this point: in the zone, and in no zone that keeps them out. */
  #allowed(centre: Vector3, eye: Vector3): boolean {
    const { zone, edgeFraction = 0, exclusions = [] } = this.field
    if (zone && !(immersion(zone, edgeFraction, centre) > IMMERSED)) return false
    // `is_dynamic_asteroid_excluded` over the zones nearest the camera first.
    const order = exclusions
      .map((exclusion) => ({ exclusion, key: outsideSquared(exclusion, eye) }))
      .sort((a, b) => a.key - b.key)
    for (const { exclusion, key } of order) {
      if (key > EXCLUSION_REACH) break
      if (
        exclusion.excludeDynamicAsteroids &&
        immersion(exclusion.zone, exclusion.edgeFraction ?? 0, centre) !== 0
      )
        return false
    }
    return true
  }

  /**
   * A rock's fade at a point about the spawn point: 1 within, falling over the outer 0.35 of the
   * radius squared to 0 at 1.05 of it. Past that, none: the rock is placed afresh.
   */
  #fade(centre: Vector3, { x, y, z }: Vector3): number | undefined {
    const squared = this.radius * this.radius
    const far = FAR * squared
    const fade = squared * FADE
    const dx = f(x - centre.x)
    const dy = f(y - centre.y)
    const dz = f(z - centre.z)
    const distance = f(dz * dz + dy * dy + dx * dx)
    if (distance > far) return undefined
    return f(distance > far - fade ? (far - distance) / fade : 1)
  }

  /** The fade of a rock at a point in the world, under this camera. */
  alphaAt(camera: Camera, point: Vector3): number | undefined {
    return this.#fade(this.centre(camera), point)
  }

  /** `Place`: at a point, unturned, with a velocity squared toward the edges and a spin. */
  #place(rock: Rock, position: Vector3): void {
    const { random } = this
    const most = f(this.settings.maxVelocity ?? 50)
    const spin = f(this.settings.maxAngularVelocity ?? 5)
    const axis = () => {
      const value = f(random() * RAND_TWICE - 1)
      const square = f(value * value)
      return f((value > 0 ? square : -square) * most)
    }
    const [vx, vy, vz] = [axis(), axis(), axis()]
    // The first draw turns about Y, the second about X.
    const first = f(random() * RAND_UNIT)
    const second = f(random() * RAND_UNIT * spin)
    const third = f(random() * spin * RAND_TWICE - spin)
    const firstScaled = f(first * spin)
    rock.position = position
    rock.orientation = Matrix3.identity
    rock.velocity = { x: vx, y: vy, z: vz }
    rock.spin = { x: f(second + second - spin), y: f(firstScaled + firstScaled - spin), z: third }
  }

  /**
   * The physics' step between frames: each placed rock moves at its velocity and turns at its spin
   * about its own axes. Retail's is IVP's (`CDynamicAsteroid::init_physics`: mass 1, linear damping
   * 1e-5, no angular damping), which this takes as constant motion. Unchecked: the damping, the
   * precession of a body that isn't round, and collisions, which retail turns on once placed.
   */
  #move(step: number): void {
    if (!(step > 0)) return
    for (const rock of this.#rocks) {
      if (!rock?.placed) continue
      const { position: p, velocity: v, spin: w } = rock
      rock.position = { x: f(p.x + v.x * step), y: f(p.y + v.y * step), z: f(p.z + v.z * step) }
      const rate = Math.hypot(w.x, w.y, w.z)
      if (rate > 0)
        rock.orientation = Matrix3.multiply(
          rock.orientation,
          turn({ x: w.x / rate, y: w.y / rate, z: w.z / rate }, rate * step),
        )
    }
  }

  /**
   * `CliDynamicAsteroidUpdate`, after the physics has moved the rocks by `step` seconds; the order
   * of the two is a guess. A rock inside 1.05 of the sphere is faded over its outer 0.35, by the
   * radius squared. Any other is placed afresh on the sphere, or released if the spawn point is
   * outside the zone, in a zone that excludes them, or `blocked`: the player's ship in a lane.
   */
  update(camera: Camera, step = 0, { blocked = false }: { blocked?: boolean } = {}): void {
    this.#move(step)
    const centre = this.centre(camera)
    const allowed = !blocked && this.#allowed(centre, camera.position)
    for (let index = 0; index < this.count; index++) {
      let rock = this.#rocks[index]
      if (rock?.placed) {
        const alpha = this.#fade(centre, rock.position)
        if (alpha !== undefined) {
          rock.alpha = alpha
          continue
        }
        rock.placed = false
      }
      if (!allowed) {
        this.#rocks[index] = undefined
        continue
      }
      // A new rock's alpha is the heap's: until it's next faded, taken as 0.
      rock ??= {
        position: centre,
        orientation: Matrix3.identity,
        velocity: { x: 0, y: 0, z: 0 },
        spin: { x: 0, y: 0, z: 0 },
        alpha: 0,
        placed: false,
      }
      this.#rocks[index] = rock
      const unit = onSphere(this.random)
      this.#place(rock, {
        x: f(this.radius * unit.x + centre.x),
        y: f(this.radius * unit.y + centre.y),
        z: f(this.radius * unit.z + centre.z),
      })
      rock.placed = true
    }
  }

  /**
   * `CliDynamicAsteroidDraw`'s rocks, in slot order: each above 0.005, at the alpha it was last
   * faded to, which a rock placed this frame kept from before.
   */
  draws(): DynamicDraw[] {
    const draws: DynamicDraw[] = []
    for (const rock of this.#rocks) {
      if (!rock || !(rock.alpha > VISIBLE)) continue
      draws.push({
        world: Matrix4.fromRotationTranslation(rock.orientation, rock.position),
        alpha: rock.alpha,
      })
    }
    return draws
  }
}
