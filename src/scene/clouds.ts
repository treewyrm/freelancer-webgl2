/**
 * `[Clouds]`: puffs about the camera, which a planet ring and a nebula share. `FNebulaClouds` in
 * `src/freelancer/Client/cli_nebula.cpp` (parse, seed, update) and `TexturePanelDrawClouds`
 * (`FUN_00551500`) in `texture_panels.cpp`. Seeded and respawned by the game's `rand()`, so a run
 * matches retail in kind, never puff for puff. Its lightning bolts are a nebula's, not built here.
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
import { viewMatrix, type Camera } from './camera.js'
import type { Draw } from './frame.js'
import type { Random } from './lightning.js'
import type { TextureShape } from './ring.js'
import { insideSphere, inverseRoot, onSphere, RAND_UNIT } from './retail.js'

const f = Math.fround

/** A `[Clouds]` section, over `FUN_00550240`'s defaults. The host reads the INI. */
export interface CloudSettings {
  /** `puff_count`. */
  puffCount: number
  /** `puff_radius`, 50 when absent. */
  puffRadius?: number
  /** `puff_colora` and `puff_colorb` over 255: each puff's colour lies between. B is A when absent. */
  colorA?: Vector3
  colorB?: Vector3
  /** `puff_shape`s, at most eight, one texture between them: the first's is bound for all. */
  shapes: readonly (TextureShape | undefined)[]
  /** `puff_weights`, one a shape. Even when absent. */
  weights?: readonly number[]
  /** `puff_max_alpha`, 0.75 when absent. */
  maxAlpha?: number
  /** `puff_drift`: how fast a puff wanders. 0 when absent. */
  drift?: number
  /** `max_distance`, 1500 when absent: the puffs' sphere is half of it plus a puff's radius. */
  maxDistance?: number
  /** `near_fade_distance`, 50 and 100 when absent: nearer than the first, nothing. */
  nearFade?: readonly [number, number]
  /** `lightning_color` over 255, `lightning_intensity` and its timing: a puff's flash. */
  lightning?: { color: Vector3; intensity?: number; gap: number; duration: number }
  /** `disable_lightning_flash`. */
  disableFlash?: boolean
}

/**
 * How the owner's visibility drives its puffs: past `full` they're opaque, `budget` of it allows all
 * of them, and under `spawn` a puff is placed only where the owner holds it. A nebula's are 0.1, 0.3
 * and 0.3 (`FUN_00550240`); a ring sets its own.
 */
export interface CloudVisibility {
  full: number
  budget: number
  spawn: number
}

export const NEBULA_CLOUD_VISIBILITY: Readonly<CloudVisibility> = {
  full: f(0.1),
  budget: f(0.3),
  spawn: f(0.3),
}

/** `PlanetRing::Load` (`0x50a735`). */
export const RING_CLOUD_VISIBILITY: Readonly<CloudVisibility> = {
  full: 0.5,
  budget: f(0.9),
  spawn: f(1.1),
}

interface Puff {
  position: Vector3
  size: number
  color: Vector3
  shape: number
  velocity: Vector3
  /** The drift's clock, negative while it waits. -1 with no lightning. */
  timer: number
  /** `+0x3c`, how much of the lightning colour it flashes. */
  flash: number
  active: boolean
  hidden: boolean
  /** Its depth in view at the last draw: the order puffs are kept in. */
  depth: number
}

// XYZ, D3DCOLOR and one UV set: FVF 0x142, 24 bytes.
const FORMAT = setMapCount(VertexFormat.Position | VertexFormat.Diffuse, 1)
const STRIDE = 24

const BLACK = { x: 0, y: 0, z: 0 }

export interface CloudDrawOptions {
  /** The camera cut this frame (`+0xbc`): the puffs are placed afresh first. */
  cut?: boolean
  /** How far a point is in what holds the clouds, which a fresh puff must be. */
  holds?: (point: Vector3) => number
  /** How far a point is in an exclusion zone of the owner's: past 0.9, a puff there is hidden. */
  excluded?: (point: Vector3) => number
}

// `DAT_005e0e00`: how deep in an exclusion zone hides a puff.
const EXCLUDED = f(0.9)

export class Clouds {
  readonly settings: CloudSettings
  readonly visibility: CloudVisibility
  readonly random: Random
  #puffs: Puff[] = []
  /** Its sphere's radius (`+0x100`). */
  readonly radius: number
  /** How far past the near fade its sphere stands (`+0xbc`). */
  readonly reach: number
  #fade = 0
  #budget = 0
  #active = 0
  /** `+0xf4`: where its sphere is, ahead of the camera. */
  #centre: Vector3 = BLACK
  /** `+0x6c`: the billboards' up, kept across frames. */
  #up: Vector3

  constructor(
    settings: CloudSettings,
    {
      visibility = NEBULA_CLOUD_VISIBILITY,
      random = () => Math.floor(Math.random() * 0x8000),
      detail = 1,
    }: { visibility?: CloudVisibility; random?: Random; detail?: number } = {},
  ) {
    this.settings = settings
    this.visibility = visibility
    this.random = random

    const n = 1 / Math.SQRT2

    this.#up = { x: f(n), y: f(n), z: 0 }

    const puffRadius = f(settings.puffRadius ?? 50)
    const maxDistance = f(settings.maxDistance ?? 1500)

    this.radius = f(maxDistance * 0.5 + puffRadius)

    // `FUN_00550a94`: how far ahead the sphere goes so the near fade's cone stays inside it.
    const [near] = settings.nearFade ?? [50, 100]

    if (near > 0) {
      const tan = Math.tan(0.6108652551968893)
      const a = f((this.radius * f(0.8)) / tan - near)
      const b = (tan * near + puffRadius * f(1.2)) * 1.25
      let x = b > this.radius ? a : Math.sqrt(this.radius * this.radius - b * b)
      if (x > a) x = a

      const result = x + near - this.radius

      this.reach = result < 0 ? 0 : f(result)
    } else this.reach = 0

    // `CloudsDetailFactors`: fewer, bigger puffs at low detail.
    const a = 1 - detail
    const countScale = f(0.5 * a + detail)
    const ease = 1 - a * a
    const sizeScale = f((1 - ease) * f(0.707) + ease)

    // `FUN_00550b60`: each puff somewhere in its sphere, about the origin until the first update.
    const count = Math.trunc(settings.puffCount * countScale + 0.5)
    const weights = this.#weights()
    const colorA = settings.colorA ?? BLACK
    const colorB = settings.colorB ?? colorA

    for (let index = 0; index < count; index++) {
      const position = insideSphere(random, this.radius)
      const size = f(
        (random() * RAND_UNIT * 0.40000003576278687 + f(0.8)) * f(puffRadius * sizeScale),
      )
      const t = random() * RAND_UNIT
      const color = {
        x: f(f(colorB.x - colorA.x) * t + colorA.x),
        y: f(f(f(colorB.y - colorA.y) * t) + colorA.y),
        z: f(f(f(colorB.z - colorA.z) * t) + colorA.z),
      }
      // Weighted pick by running sum of `weights`; the first draw is the fallback past rounding.
      let shape = Math.trunc((random() * weights.length) / 32768)
      const pick = f(random() * RAND_UNIT)
      let running = 0

      for (let at = 0; at < weights.length; at++) {
        running += weights[at]!

        if (pick < running) {
          shape = at
          break
        }
      }

      const velocity = insideSphere(random, f(settings.drift ?? 0))
      const lightning = settings.lightning
      const timer =
        lightning && lightning.duration > 0
          ? f((-0.800000011920929 - random() * RAND_UNIT * 0.699999988079071) * lightning.gap)
          : -1

      this.#puffs.push({
        position,
        size,
        color,
        shape,
        velocity,
        timer,
        flash: 0,
        active: true,
        hidden: false,
        depth: 0,
      })
    }
  }

  /**
   * `FUN_005513b0`, on a camera cut: as many as the budget allows anywhere in the sphere, the rest
   * hidden, each kept only where `holds` says the owner is, and hidden deep in an exclusion zone.
   */
  #regenerate(holds?: (point: Vector3) => number, excluded?: (point: Vector3) => number): void {
    const { random, settings } = this

    this.#puffs.forEach((puff, index) => {
      if (index >= this.#budget) {
        puff.active = false
        puff.hidden = true
        return
      }

      const sample = insideSphere(random, this.radius)

      puff.position = {
        x: f(this.#centre.x + sample.x),
        y: f(this.#centre.y + sample.y),
        z: f(this.#centre.z + sample.z),
      }
      puff.velocity = insideSphere(random, f(settings.drift ?? 0))

      const inside = holds !== undefined && holds(puff.position) > 0

      puff.active = inside
      puff.hidden = !inside || (excluded !== undefined && excluded(puff.position) > EXCLUDED)
    })
  }

  /** `puff_weights` over their sum, one a shape, even when absent. */
  #weights(): number[] {
    const { shapes, weights = [] } = this.settings
    const raw = shapes.map((_, at) => weights[at] ?? 1)
    const sum = raw.reduce((total, weight) => total + weight, 0)

    return raw.map((weight) => f(weight / sum))
  }

  /** How many are in its sphere, as of the last update. */
  get active(): number {
    return this.#active
  }

  get puffs(): readonly Readonly<Puff>[] {
    return this.#puffs
  }

  /** The first shown puff's flash on the next step, for an editor: retail has no such call. */
  fire(): void {
    const puff = this.#puffs.find(({ active, hidden }) => active && !hidden)

    if (puff) puff.timer = 0
  }

  /**
   * `FUN_00550d40`: the sphere follows the camera; puffs that left it go, and as many as
   * `visibility` allows come back on its surface, where `holds` says the owner is, and drift. One
   * back deep in an exclusion zone counts, hidden.
   */
  update(
    camera: Camera,
    step: number,
    visibility: number,
    holds?: (point: Vector3) => number,
    excluded?: (point: Vector3) => number,
  ): void {
    const { settings, random } = this
    const count = this.#puffs.length

    this.#budget = Math.min(
      Math.max(Math.trunc((visibility / this.visibility.budget) * count), 0),
      count,
    )
    this.#fade =
      visibility > this.visibility.full
        ? 1
        : visibility <= 0
          ? 0
          : visibility / this.visibility.full

    const ahead = f(this.reach + this.radius)
    const cull = f(this.radius * this.radius * f(1.02))
    const frame = Matrix4.fromRotationTranslation(camera.orientation, camera.position)
    const { x, y, z } = Matrix4.transformPoint({ x: 0, y: 0, z: -ahead }, frame)

    this.#centre = { x: f(x), y: f(y), z: f(z) }

    let active = 0

    for (const puff of this.#puffs) {
      if (this.#fade <= 0) {
        puff.active = false
        puff.hidden = true
      }

      if (!puff.active) continue

      const dx = this.#centre.x - puff.position.x
      const dy = this.#centre.y - puff.position.y
      const dz = this.#centre.z - puff.position.z

      if (dz * dz + dy * dy + dx * dx > cull) {
        puff.active = false
        puff.hidden = true
      } else active++
    }

    // Nearest first by the last draw's depth (`DAT_006140b0` 1): a stable sort, as a bubble sort is.
    this.#puffs.sort((a, b) => b.depth - a.depth)

    const lightning = settings.lightning

    for (const puff of this.#puffs) {
      if (!puff.active && active < this.#budget) {
        const on = onSphere(random)
        const position = {
          x: f(this.radius * on.x + this.#centre.x),
          y: f(this.radius * on.y + this.#centre.y),
          z: f(f(this.radius * on.z) + this.#centre.z),
        }

        puff.position = position
        puff.velocity = insideSphere(random, f(settings.drift ?? 0))

        if (visibility >= this.visibility.spawn || (holds && holds(position) > 0)) {
          active++
          puff.active = true
          puff.hidden = excluded !== undefined && excluded(position) > EXCLUDED
        }
      }

      if (!puff.active || puff.hidden) continue

      if (lightning && lightning.duration > 0) {
        const old = puff.timer

        puff.timer = f(step + old)

        if (old >= 0) {
          if (puff.timer > lightning.duration)
            puff.timer = f(
              (-0.800000011920929 - random() * RAND_UNIT * 0.699999988079071) * lightning.gap,
            )
        } else if (puff.timer >= 0) {
          // The drift direction it picks here is read only by a nebula's bolts: its two draws are
          // taken, and the direction isn't kept.
          random()
          random()
        }

        if (puff.timer >= 0) {
          const a = f(random() * RAND_UNIT)

          puff.flash = f(random() * a * RAND_UNIT)
        }
      }

      const p = puff.position

      puff.position = {
        x: f(step * puff.velocity.x + p.x),
        y: f(step * puff.velocity.y + p.y),
        z: f(f(step * puff.velocity.z) + p.z),
      }
    }

    this.#active = active
  }

  /**
   * `TexturePanelDrawClouds`: each puff a square facing the camera, turned to the kept up, faded
   * near the camera and toward its sphere's edge, all in one list of the first shape's texture.
   * Unlit, blended, both sides, no depth writes, the alpha test at 5. Nothing with none active.
   * Its depth function is the main list's, `LEQUAL`, and it draws in view space.
   */
  draw(camera: Camera, { cut = false, holds, excluded }: CloudDrawOptions = {}): Draw | undefined {
    const { settings } = this

    if (cut) this.#regenerate(holds, excluded)

    const first = settings.shapes[0]
    if (this.#active === 0 || !first) return undefined

    const view = viewMatrix(camera)
    const frame = Matrix4.invert(view)

    // The kept up, laid in the plane facing the camera, then into view space.
    const w = Matrix4.transformDirection({ x: 0, y: 0, z: 1 }, frame)
    const n = this.#up
    const c1 = {
      x: f(w.z * n.y - w.y * n.z),
      y: f(w.x * n.z - w.z * n.x),
      z: f(w.y * n.x - w.x * n.y),
    }
    let up = {
      x: f(w.y * c1.z - w.z * c1.y),
      y: f(w.z * c1.x - w.x * c1.z),
      z: f(w.x * c1.y - w.y * c1.x),
    }
    const inverse = inverseRoot(f(up.x * up.x + up.y * up.y + up.z * up.z))

    up = { x: f(inverse * up.x), y: f(inverse * up.y), z: f(inverse * up.z) }
    this.#up = up

    // In view space: `p` is the up's direction on screen and `q` its perpendicular, both unit XY.
    const v = Matrix4.transformDirection(up, view)
    const vi = inverseRoot(f(v.x * v.x + v.y * v.y))
    const p = { x: f(v.x * vi), y: f(v.y * vi), z: 0 }
    let q = { x: p.y, y: -p.x, z: 0 }
    const qi = inverseRoot(f(q.y * q.y + q.z * q.z + q.x * q.x))

    q = { x: f(q.x * qi), y: f(q.y * qi), z: 0 }

    const radiusSquared = f(this.radius * this.radius)
    const inner = f(this.radius * f(0.7))
    const innerSquared = f(inner * inner)
    const ring = f(1 / (radiusSquared - innerSquared))
    const [nearLow, nearHigh] = (settings.nearFade ?? [50, 100]).map(f) as [number, number]
    const nearSpan = f(1 / (nearHigh - nearLow))
    const ahead = f(this.reach + this.radius)
    const threshold = f(ahead * f(0.8))
    const lightning = settings.lightning
    const intensity = lightning?.intensity ?? 1

    const corners: number[] = []
    const colours: number[] = []

    for (const puff of this.#puffs) {
      let alpha = f(f(settings.maxAlpha ?? 0.75) * this.#fade)

      if (!puff.active || puff.hidden) continue

      const at = Matrix4.transformPoint(puff.position, view)
      const depth = -at.z

      puff.depth = f(depth)
      if (depth < nearLow) continue

      // Past `threshold` the alpha ramps linearly in squared distance from the sphere's centre,
      // from 0.7 of its radius to the edge.
      if (depth > threshold) {
        const dx = 0 - at.x
        const dy = 0 - at.y
        const dz = -ahead - at.z
        const squared = dz * dz + dy * dy + dx * dx
        if (squared > radiusSquared) continue
        if (f(squared) > innerSquared) alpha = f((radiusSquared - f(squared)) * alpha * ring)
      }

      if (alpha < 0.02) continue

      let near = alpha

      if (puff.depth <= nearLow) continue
      if (puff.depth < nearHigh) near = f((puff.depth - nearLow) * alpha * nearSpan)
      if (near < 0.02) continue

      let color = puff.color

      if (lightning && !settings.disableFlash && intensity > 0 && puff.timer >= 0) {
        const flash = (c: number) => f(f(c * puff.flash) * intensity)
        const sum = {
          x: f(color.x + flash(lightning.color.x)),
          y: f(color.y + flash(lightning.color.y)),
          z: f(color.z + flash(lightning.color.z)),
        }

        color = { x: Math.min(sum.x, 1), y: Math.min(sum.y, 1), z: Math.min(sum.z, 1) }
      }

      const shape = settings.shapes[puff.shape]
      if (!shape) continue

      // `_ftol` truncates, and only each low byte is kept: B, G, R, A in memory.
      const byte = (value: number) => Math.trunc(value * 255) & 0xff
      const diffuse = [byte(color.z), byte(color.y), byte(color.x), byte(near)]

      // Corners at the centre ± `q` · size ± `p` · size, drawn as triangles c0 c1 c2 and c2 c3 c0.
      const sp = { x: f(p.x * puff.size), y: f(p.y * puff.size) }
      const sq = { x: f(q.x * puff.size), y: f(q.y * puff.size) }
      const z = f(at.z)
      const vx = f(at.x)
      const vy = f(at.y)
      const c0 = [f(f(vx - sq.x) - sp.x), f(f(vy - sq.y) - sp.y), z]
      const c1v = [f(f(vx + sq.x) - sp.x), f(f(vy + sq.y) - sp.y), z]
      const c2 = [f(f(vx + sq.x) + sp.x), f(f(vy + sq.y) + sp.y), z]
      const c3 = [f(f(vx - sq.x) + sp.x), f(f(vy - sq.y) + sp.y), z]
      const uv = [
        [shape.u0, shape.v0],
        [shape.u1, shape.v0],
        [shape.u1, shape.v1],
        [shape.u1, shape.v1],
        [shape.u0, shape.v1],
        [shape.u0, shape.v0],
      ]
      ;[c0, c1v, c2, c2, c3, c0].forEach((corner, k) => {
        corners.push(...corner, ...uv[k]!)
        colours.push(...diffuse)
      })
    }

    const vertexCount = corners.length / 5
    if (vertexCount === 0) return undefined

    const vertices = new Uint8Array(vertexCount * STRIDE)
    const floats = new Float32Array(vertices.buffer)

    for (let at = 0; at < vertexCount; at++) {
      const [x, y, z, u, v] = corners.slice(at * 5, at * 5 + 5)

      floats.set([x!, y!, z!], (at * STRIDE) / 4)
      vertices.set(colours.slice(at * 4, at * 4 + 4), at * STRIDE + 12)
      floats.set([u!, v!], (at * STRIDE + 16) / 4)
    }

    const mesh: VMeshData = {
      name: 'clouds',
      version: 1,
      primitive: Primitive.TriangleList,
      format: FORMAT,
      groups: [
        {
          materialId: 0,
          vertexStart: 0,
          vertexEnd: vertexCount - 1,
          elementCount: vertexCount,
          padding: 0,
        },
      ],
      indices: Uint16Array.from({ length: vertexCount }, (_, at) => at),
      vertices,
    }
    const reference: VMeshRef = {
      meshId: 0,
      vertexStart: 0,
      vertexCount,
      indexStart: 0,
      indexCount: vertexCount,
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
      count: vertexCount,
      // Its corners are in view space: the game draws them under an identity.
      world: frame,
      materialName: 'clouds',
      diffuse: [1, 1, 1, 1],
      ambient: BLACK,
      emissive: BLACK,
      colorVertex: true,
      nomad: false,
      texture: {
        name: first.texture.name,
        entry: first.texture,
        sampler: DEFAULT_SAMPLER,
        uvSet: 0,
      },
      cull: 'none',
      depthWrite: false,
      depthFunc: 'lequal',
      lightless: true,
      negateNormals: false,
      normalizeNormals: false,
      // A texture with alpha blends by it. One without, retail sets `SRCBLEND` twice and leaves
      // `DESTBLEND`: uncaptured, and no retail cloud texture is opaque.
      blend: true,
      blendMode: 'alpha',
      unlit: true,
      alphaReference: 5,
      alphaFunction: 'greater',
    }
  }
}
