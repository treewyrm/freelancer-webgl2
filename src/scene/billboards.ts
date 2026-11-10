/**
 * An asteroid field's `[AsteroidBillboards]`: flat rocks scattered in a sphere ahead of the camera,
 * each a triangle facing it, beyond the field's cubes. `BillboardEnsureRocks` (`FUN_0054de10`) and
 * `BillboardDraw` (`FUN_0054e900`) with its lighting (`FUN_0054e130`) and emission (`FUN_0054f9f0`),
 * in `src/freelancer/Client/asteroid_billboard.cpp` and `cli_asteroid.cpp`. Each rock's size, flips
 * and place are the game's `rand()`, so a run matches retail in kind. Pure, no GL.
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
import { outsideSquared, type CubeExclusion } from './asteroids.js'
import type { Camera } from './camera.js'
import type { Draw, SceneLight } from './frame.js'
import type { Random } from './lightning.js'
import type { Fog } from './nebula.js'
import { immersion, type Zone } from './nebula.js'
import type { TextureShape } from './ring.js'

const f = Math.fround

/** An `[AsteroidBillboards]` section, over the field's constructor defaults. The host reads it. */
export interface BillboardSettings {
  /** `shape`. None draws nothing. */
  shape?: TextureShape
  /** `count`, truncated, 100 when absent. */
  count?: number
  /**
   * `size`, ordered least first: a rock is between the two. When absent the constructor's 500 then
   * 100, unordered, so rocks run from 500 down to 100.
   */
  size?: readonly [number, number]
  /** `start_dist`, 1500 when absent: how far ahead the rocks begin. */
  startDistance?: number
  /** `fade_dist_percent`, held to [0, 1], 0.3 when absent: how much of the sphere fades. */
  fadePercent?: number
  /** `ambient_intensity`, 1 when absent. */
  ambientIntensity?: number
  /** `color_shift`, 1 each when absent. */
  colorShift?: Vector3
}

/** What a field gives its billboards. */
export interface BillboardField {
  zone: Zone
  edgeFraction?: number
  /** `fill_dist`, truncated, and the `Asteroids` option's reach, `(1 - d) · 0.65 + d`. */
  fillDistance: number
  detailScale?: number
  cubeSize: number
  /** The field's colours: `diffuse_color` and `ambient_color` over 255. */
  diffuse: Vector3
  ambient: Vector3
  /** Its exclusion zones; with none, retail has no manager, and every rock stands. */
  exclusions?: readonly CubeExclusion[]
}

/** What the frame lights the billboards with at the camera, after the field's ambient pass. */
export interface BillboardLighting {
  /** `D3DRS_AMBIENT` as the pass left it: whole bytes, 0 to 1. */
  ambient: Vector3
  /** Up to four directional lights there, each the way it shines (`directionalLightsAt`). */
  lights: readonly SceneLight[]
  /** The `LIGHTING` option: off, the rocks are the tinted diffuse. On when absent. */
  lit?: boolean
  /** What the ambient pass left on: the field's nebula's fog, with `contains_fog_zone`. */
  fog?: Fog
}

interface Rock {
  position: Vector3
  half: number
  alpha: number
  visible: boolean
  flipU: boolean
  flipV: boolean
  swap: boolean
  negate: boolean
  /** Its index over the count: rocks past a zone's density are left out. */
  phase: number
}

const RAND_UNIT = 3.0517578125e-5
const TWO_PI = 6.2831854820251465
// `DAT_005e0b00`: 35°, as a float.
const TAN = Math.tan(0.6108652353286743)

// XYZ, D3DCOLOR and one UV set: FVF 0x142, 24 bytes.
const FORMAT = setMapCount(VertexFormat.Position | VertexFormat.Diffuse, 1)
const STRIDE = 24
const BLACK: Vector3 = { x: 0, y: 0, z: 0 }

/** `random_inside_sphere` (`0x631db20`). */
const insideSphere = (random: Random, radius: number): Vector3 => {
  const scaled = f(Math.pow(random() * RAND_UNIT, 1 / 3) * radius)
  const cos = random() * RAND_UNIT * 2 - 1
  const sin = f(Math.sin(Math.acos(cos)) * scaled)
  const phi = random() * RAND_UNIT * TWO_PI
  return { x: f(Math.sin(phi) * sin), y: f(f(cos) * scaled), z: f(Math.cos(phi) * sin) }
}

/** `random_on_unit_sphere` (`0x631da50`). */
export const onSphere = (random: Random): Vector3 => {
  const u1 = f(random() * RAND_UNIT)
  const u2 = f(random() * RAND_UNIT)
  const cos = Math.min(Math.max(f(u1 + u1 - 1), -1), 1)
  const theta = Math.acos(cos)
  const phi = u2 * TWO_PI
  const sin = Math.sin(theta)
  return { x: f(Math.sin(phi) * sin), y: f(Math.cos(theta)), z: f(Math.cos(phi) * sin) }
}

// The inlined reciprocal square root of `FUN_0054e900`, one Newton step, left unrounded.
const inverseRoot = (squared: number): number => {
  const floats = new Float32Array([squared])
  const bits = new Int32Array(floats.buffer)
  bits[0] = 0x5f3759df - (bits[0]! >> 1)
  const y = floats[0]!
  return (1.5 - y * y * squared * 0.5) * y
}

const clampOne = ({ x, y, z }: Vector3): Vector3 => ({
  x: x < 1 ? x : 1,
  y: y < 1 ? y : 1,
  z: z < 1 ? z : 1,
})

// The colour `FUN_0054f9f0` packs: each times 255, truncated, alpha unmasked, the rest a byte.
const bytesOf = (alpha: number, { x, y, z }: Vector3): number[] => [
  Math.trunc(z * 255) & 0xff,
  Math.trunc(y * 255) & 0xff,
  Math.trunc(x * 255) & 0xff,
  Math.trunc(alpha * 255) & 0xff,
]

export class AsteroidBillboards {
  readonly settings: BillboardSettings
  readonly field: BillboardField
  readonly random: Random
  #rocks: Rock[] = []
  /** `Float00`: the rocks' sphere. */
  readonly radius: number
  /** `Float04`: how far ahead its centre is. */
  readonly ahead: number
  /** `Float2C`: how much of it fades, short of the centre's depth. */
  readonly fade: number
  /** `Float40` and `Float44`: nearer than the first a rock fades, gone by the second. */
  readonly nearFade: readonly [number, number]
  /** `DensityScale`: with no zone's density, rocks past it are left out. */
  readonly density: number
  /** Each exclusion zone's `billboard_count` over the count. */
  readonly #densities: readonly (number | undefined)[]
  readonly #diffuse: Vector3
  readonly #ambient: Vector3
  /** Kept between frames, as `Up` is on the block. */
  #up: Vector3 = { x: 0, y: 1, z: 0 }

  constructor(
    settings: BillboardSettings,
    field: BillboardField,
    {
      random = () => Math.floor(Math.random() * 0x8000),
      detail = 1,
    }: { random?: Random; detail?: number } = {},
  ) {
    this.settings = settings
    this.field = field
    this.random = random

    // `BillboardSetQuality`: the count and the start scaled by detail.
    const qualityA = f((1 - detail) * 0.25 + detail)
    const square = detail * detail
    const qualityB = f((1 - square) * 0.75 + square)

    // Load raises the count to the largest exclusion zone's, and each zone's count over that.
    const exclusions = field.exclusions ?? []
    let count = Math.trunc(settings.count ?? 100)
    let density = 1
    const counts = exclusions.map(({ billboardCount }) =>
      billboardCount === undefined ? undefined : Math.trunc(billboardCount),
    )
    if (exclusions.length) {
      const most = Math.max(
        -1,
        ...counts.map((value) => (value !== undefined && value > 0 ? value : -1)),
      )
      const used = Math.max(count, most)
      density = f(count / used)
      count = used
    }
    this.density = density
    const inverse = f(1 / count)
    this.#densities = counts.map((value) =>
      value !== undefined && value > 0 ? f(value * inverse) : value,
    )

    const [low, high] = settings.size ?? [500, 100]
    const range = f(high - low)
    const rockCount = Math.trunc(count * qualityA)
    const step = f(1 / rockCount)
    const coin = () => random() * RAND_UNIT > 0.5
    for (let index = 0; index < rockCount; index++) {
      const half = f((random() * range * RAND_UNIT + low) * 0.5)
      this.#rocks.push({
        position: BLACK,
        half,
        alpha: 1,
        visible: true,
        flipU: coin(),
        flipV: coin(),
        swap: coin(),
        negate: coin(),
        phase: f(index * step),
      })
    }

    const start = settings.startDistance ?? 1500
    const percent = Math.min(Math.max(settings.fadePercent ?? 0.3, 0), 1)
    if (start > 0) {
      const a = qualityB * start
      const r = (a * TAN) / (1 - TAN)
      this.radius = f(r)
      this.ahead = f(r + a)
      this.fade = f(r * f(percent))
    } else {
      this.radius = 2500
      this.ahead = 4000
      this.fade = 700
    }

    // `BillboardSetFadePlanes`: from the cubes' reach to a cube and a quarter past it.
    const fill = f(Math.trunc(field.fillDistance) * (field.detailScale ?? 1))
    const far = f(field.cubeSize * 1.25 + fill)
    this.nearFade = fill < far ? [far, fill] : [fill, far]

    // `BillboardApplyTints`.
    const shift = settings.colorShift ?? { x: 1, y: 1, z: 1 }
    this.#diffuse = clampOne({
      x: f(shift.x * field.diffuse.x),
      y: f(shift.y * field.diffuse.y),
      z: f(shift.z * field.diffuse.z),
    })
    this.#ambient = clampOne(field.ambient)
  }

  get rocks(): readonly Readonly<Rock>[] {
    return this.#rocks
  }

  /**
   * `BillboardNearCamera` (`FUN_0054e040`): whether the camera is within the sphere's reach, a
   * quarter past it, of the field's surface.
   */
  near(eye: Vector3): boolean {
    const { zone } = this.field
    const margin = f((this.ahead + this.radius) * 1.25)
    const d = {
      x: f(eye.x - zone.position.x),
      y: f(eye.y - zone.position.y),
      z: f(eye.z - zone.position.z),
    }
    const reach = zone.radius + margin
    const squared = d.x * d.x + d.z * d.z + d.y * d.y
    if (squared > reach * reach) return false
    const distance = f(Math.sqrt(f(squared)))
    const inverse = 1 / distance
    const along = zone.radiusAlong({
      x: f(d.x * inverse),
      y: f(d.y * inverse),
      z: f(d.z * inverse),
    })
    return distance - along <= margin
  }

  /**
   * `is_billboard_excluded` over the zones nearest the camera first: a zone excluding billboards
   * that holds the point leaves it out; else the first with a count holding it gives its density.
   */
  #excluded(order: readonly number[], point: Vector3): { out: boolean; density?: number } {
    const exclusions = this.field.exclusions ?? []
    let density: number | undefined
    for (const at of order) {
      const exclusion = exclusions[at]!
      const inside = immersion(exclusion.zone, exclusion.edgeFraction ?? 0, point) !== 0
      if (exclusion.excludeBillboards) {
        if (inside) return { out: true }
        continue
      }
      const value = this.#densities[at]
      if (density !== undefined || !(value !== undefined && value > 0)) continue
      if (inside) density = value
    }
    return { out: false, ...(density !== undefined && { density }) }
  }

  /** Whether a rock placed at its position stands: in the field, and not excluded or thinned. */
  #stands(rock: Rock, order: readonly number[] | undefined): boolean {
    const { zone, edgeFraction = 0 } = this.field
    if (immersion(zone, edgeFraction, rock.position) === 0) return false
    if (!order) return true
    const { out, density } = this.#excluded(order, rock.position)
    if (out) return false
    return !(rock.phase > (density !== undefined && density > 0 ? density : this.density))
  }

  /**
   * `BillboardDraw`: the rocks placed afresh in the sphere on a cut, or those that left it on its
   * surface; faded toward its edge, more narrowly past its centre, and near the cubes' reach.
   * Opaque rocks draw first, `ALPHAREF` 128 and no blending, then the faded ones blended with no
   * depth writes, `ALPHAREF` 5. Each a triangle facing the camera, its base on the right or the up,
   * lit at its corners from the camera's light. Nothing when the camera is far from the field.
   */
  draw(camera: Camera, lighting: BillboardLighting, cut = false): Draw[] {
    const shape = this.settings.shape
    const eye = camera.position
    if (!this.near(eye)) return []
    const { forward, right, up, centre } = this.#axes(camera)
    this.#up = up

    const colours = this.#colours(lighting, forward, right, up)
    if (!shape) return []

    const radiusSquared = this.radius * this.radius
    const exclusions = this.field.exclusions ?? []
    const order = exclusions.length
      ? exclusions
          .map((exclusion, at) => ({ at, key: outsideSquared(exclusion, eye) }))
          .sort((a, b) => a.key - b.key)
          .map(({ at }) => at)
      : undefined
    const { random } = this
    const away = (rock: Rock) => {
      const dx = rock.position.x - centre.x
      const dy = rock.position.y - centre.y
      const dz = rock.position.z - centre.z
      return dx * dx + dz * dz + dy * dy
    }

    for (const rock of this.#rocks) {
      let squared: number
      if (cut) {
        const offset = insideSphere(random, this.radius)
        rock.position = {
          x: f(centre.x + offset.x),
          y: f(centre.y + offset.y),
          z: f(centre.z + offset.z),
        }
        rock.visible = this.#stands(rock, order)
        if (!rock.visible) continue
        squared = away(rock)
      } else {
        squared = away(rock)
        if (squared > radiusSquared + 10) {
          // Back on the sphere's surface, unseen this frame.
          const on = onSphere(random)
          rock.position = {
            x: f(this.radius * on.x + centre.x),
            y: f(this.radius * on.y + centre.y),
            z: f(f(this.radius * on.z) + centre.z),
          }
          rock.alpha = 0
          rock.visible = this.#stands(rock, order)
          continue
        }
      }
      if (!rock.visible) continue

      rock.alpha = this.#fade(rock.position, squared, eye, forward)
    }

    const first = this.#rocks[0]
    const emit = (rocks: Rock[]) => {
      const vertices = new Uint8Array(rocks.length * 3 * STRIDE)
      const floats = new Float32Array(vertices.buffer)
      rocks.forEach((rock, at) => {
        const size = f(rock.half + rock.half)
        const r = { x: f(right.x * size), y: f(right.y * size), z: f(right.z * size) }
        const u = { x: f(up.x * size), y: f(up.y * size), z: f(up.z * size) }
        // The base's UVs by its flips.
        const corner = Number(rock.flipU) + Number(rock.flipV) * 2
        const [u0, v0, u1, v1] =
          corner === 0
            ? [0, 0, 1, 0]
            : corner === 1
              ? [1, 0, 1, 1]
              : corner === 2
                ? [1, 1, 0, 1]
                : [0, 1, 0, 0]
        const a = rock.swap ? r : u
        let b = rock.swap ? u : r
        if (rock.negate) b = { x: -b.x, y: -b.y, z: -b.z }
        const p = rock.position
        // Retail picks the corner colour by rock 0's U flip and this rock's V flip.
        const pick = Number(first!.flipU) + Number(rock.flipV) * 2
        const cornerColour = colours.corners[pick]!
        const triangle: [Vector3, [number, number], Vector3][] = [
          [{ x: f(p.x - a.x), y: f(p.y - a.y), z: f(p.z - a.z) }, [u0!, v0!], cornerColour],
          [{ x: f(a.x + p.x), y: f(a.y + p.y), z: f(a.z + p.z) }, [u1!, v1!], cornerColour],
          [{ x: f(b.x + p.x), y: f(b.y + p.y), z: f(b.z + p.z) }, [0.5, 0.5], colours.centre],
        ]
        triangle.forEach(([position, uv, colour], k) => {
          const index = at * 3 + k
          floats.set([position.x, position.y, position.z], (index * STRIDE) / 4)
          vertices.set(bytesOf(rock.alpha, colour), index * STRIDE + 12)
          floats.set(uv, (index * STRIDE + 16) / 4)
        })
      })
      return vertices
    }
    const opaque = this.#rocks.filter(
      (rock) => rock.visible && rock.alpha >= 1 && rock.alpha >= f(0.02),
    )
    const faded = this.#rocks.filter(
      (rock) => rock.visible && rock.alpha < 1 && rock.alpha > f(0.02),
    )
    const draws: Draw[] = []
    if (opaque.length)
      draws.push(this.#drawOf(emit(opaque), opaque.length * 3, false, shape, lighting.fog))
    if (faded.length)
      draws.push(this.#drawOf(emit(faded), faded.length * 3, true, shape, lighting.fog))
    return draws
  }

  /**
   * The look, right and up at `camera`, the kept up turned to square with the look, and the
   * sphere's centre ahead.
   */
  #axes(camera: Camera): { forward: Vector3; right: Vector3; up: Vector3; centre: Vector3 } {
    const eye = camera.position
    const frame = Matrix4.fromRotationTranslation(camera.orientation, eye)
    const look = Matrix4.transformDirection({ x: 0, y: 0, z: -1 }, frame)
    const forward = { x: f(look.x), y: f(look.y), z: f(look.z) }
    const centre = {
      x: f(forward.x * this.ahead + eye.x),
      y: f(forward.y * this.ahead + eye.y),
      z: f(forward.z * this.ahead + eye.z),
    }
    const kept = this.#up
    const cx = forward.y * kept.z - forward.z * kept.y
    const cy = forward.z * kept.x - forward.x * kept.z
    const cz = f(forward.x * kept.y - forward.y * kept.x)
    const rightInverse = f(inverseRoot(f(cx * cx + cz * cz + cy * cy)))
    const right = { x: f(cx * rightInverse), y: f(cy * rightInverse), z: f(cz * rightInverse) }
    const turned = {
      x: f(right.y * forward.z - right.z * forward.y),
      y: f(right.z * forward.x - forward.z * right.x),
      z: f(forward.y * right.x - right.y * forward.x),
    }
    const upInverse = inverseRoot(
      f(turned.x * turned.x + turned.y * turned.y + turned.z * turned.z),
    )
    const up = {
      x: f(upInverse * turned.x),
      y: f(upInverse * turned.y),
      z: f(upInverse * turned.z),
    }
    return { forward, right, up, centre }
  }

  /**
   * A rock's alpha at `point`, `squared` from the sphere's centre: faded toward the sphere's edge,
   * the band narrowing with depth past its centre, then in front of the cubes' reach. Under 0.02
   * it isn't drawn; retail skips the near fade then, which only lowers it.
   */
  #fade(point: Vector3, squared: number, eye: Vector3, forward: Vector3): number {
    const radiusSquared = this.radius * this.radius
    const percent = f(Math.min(Math.max(this.settings.fadePercent ?? 0.3, 0), 1))
    const [nearHigh, nearLow] = this.nearFade
    const depth = f(
      (point.x - eye.x) * forward.x + (point.z - eye.z) * forward.z + (point.y - eye.y) * forward.y,
    )
    let alpha: number
    if (depth > this.ahead) {
      const t = Math.min(1 - (this.radius - (depth - this.ahead)) / this.radius, 1)
      const band = ((1 - percent) * t * 0.5 + percent) * this.radius
      const bandSquared = band * band
      alpha = squared > radiusSquared - bandSquared ? f((radiusSquared - squared) / bandSquared) : 1
    } else {
      const fadeSquared = this.fade * this.fade
      alpha = squared > radiusSquared - fadeSquared ? f((radiusSquared - squared) / fadeSquared) : 1
    }
    if (alpha < f(0.02) || depth >= nearHigh) return alpha
    return depth < nearLow ? 0 : f(((depth - nearLow) / (nearHigh - nearLow)) * alpha)
  }

  /** The alpha a rock at `point` draws with, seen from `camera`. */
  alphaAt(camera: Camera, point: Vector3): number {
    const { forward, centre } = this.#axes(camera)
    const dx = point.x - centre.x
    const dy = point.y - centre.y
    const dz = point.z - centre.z
    return this.#fade(point, dx * dx + dz * dz + dy * dy, camera.position, forward)
  }

  /**
   * The rocks' colours seen from `camera`: a corner's toward the right, the left, the up and the
   * down, and the centre's.
   */
  coloursAt(camera: Camera, lighting: BillboardLighting): { corners: Vector3[]; centre: Vector3 } {
    const { forward, right, up } = this.#axes(camera)
    return this.#colours(lighting, forward, right, up)
  }

  /**
   * `FUN_0054e130`: the ambient the pass left, times `ambient_intensity`, the tinted ambient and
   * `color_shift`, then each directional light by how it falls on four directions a step off the
   * look, toward each side and up and down, and the look itself; each held to 1.
   */
  #colours(
    { ambient, lights, lit = true }: BillboardLighting,
    forward: Vector3,
    right: Vector3,
    up: Vector3,
  ): { corners: Vector3[]; centre: Vector3 } {
    if (!lit) return { corners: [0, 1, 2, 3].map(() => this.#diffuse), centre: this.#diffuse }
    const scale = f(f(this.settings.ambientIntensity ?? 1) * f(1 / 255))
    const shift = this.settings.colorShift ?? { x: 1, y: 1, z: 1 }
    const tint = this.#ambient
    const base = {
      x: f(f(f(Math.round(ambient.x * 255) * scale) * tint.x) * f(shift.x)),
      y: f(f(f(Math.round(ambient.y * 255) * scale) * tint.y) * f(shift.y)),
      z: f(f(f(Math.round(ambient.z * 255) * scale) * tint.z) * f(shift.z)),
    }
    const sides = [
      right,
      { x: -right.x, y: -right.y, z: -right.z },
      up,
      { x: -up.x, y: -up.y, z: -up.z },
      BLACK,
    ]
    const outputs = sides.map(() => ({ ...base }))
    for (const light of lights.slice(0, 4)) {
      const colour = {
        x: f(light.color.x * this.#diffuse.x),
        y: f(light.color.y * this.#diffuse.y),
        z: f(light.color.z * this.#diffuse.z),
      }
      sides.forEach((side, at) => {
        let d = { x: f(forward.x + side.x), y: f(forward.y + side.y), z: f(forward.z + side.z) }
        const inverse = 1 / Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z)
        d = { x: f(inverse * d.x), y: f(inverse * d.y), z: f(inverse * d.z) }
        const dot = d.z * light.direction.z + d.y * light.direction.y + d.x * light.direction.x
        const weight = dot < -0.5 ? 0 : f((dot + 0.5) / 1.5)
        const out = outputs[at]!
        out.x = f(out.x + f(colour.x * weight))
        out.y = f(out.y + f(colour.y * weight))
        out.z = f(out.z + f(colour.z * weight))
      })
    }
    const clamped = outputs.map(clampOne)
    return { corners: clamped.slice(0, 4), centre: clamped[4]! }
  }

  #drawOf(
    vertices: Uint8Array,
    count: number,
    blended: boolean,
    shape: TextureShape,
    fog?: Fog,
  ): Draw {
    const mesh: VMeshData = {
      name: 'asteroid billboards',
      version: 1,
      primitive: Primitive.TriangleList,
      format: FORMAT,
      groups: [
        { materialId: 0, vertexStart: 0, vertexEnd: count - 1, elementCount: count, padding: 0 },
      ],
      indices: Uint16Array.from({ length: count }, (_, at) => at),
      vertices,
    }
    const reference: VMeshRef = {
      meshId: 0,
      vertexStart: 0,
      vertexCount: count,
      indexStart: 0,
      indexCount: count,
      groupStart: 0,
      groupCount: 1,
      boundingBox: { min: BLACK, max: BLACK },
      boundingSphere: { center: BLACK, radius: 0 },
    }
    return {
      mesh,
      reference,
      transient: true,
      byteOffset: 0,
      count,
      world: Matrix4.identity,
      materialName: 'asteroid billboards',
      diffuse: [1, 1, 1, 1],
      ambient: BLACK,
      emissive: BLACK,
      colorVertex: true,
      nomad: false,
      texture: {
        name: shape.texture.name,
        entry: shape.texture,
        sampler: DEFAULT_SAMPLER,
        uvSet: 0,
      },
      cull: 'none',
      depthWrite: !blended,
      depthFunc: 'lequal',
      lightless: true,
      negateNormals: false,
      normalizeNormals: false,
      blend: blended,
      blendMode: 'alpha',
      unlit: true,
      alphaReference: blended ? 5 : 128,
      alphaFunction: 'greater',
      ...(fog && { fog }),
    }
  }
}
