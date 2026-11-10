/**
 * A nebula's exterior: `[Exterior]`'s bits, billboards on rings of latitude about its zone, pulled in
 * from its surface. `NebulaRebuild` (`FUN_00506600`) places them, `NebulaOrientBolts`
 * (`FUN_00507340`) turns each to the camera, and `NebulaDrawBolts` (`FUN_00507ed0`) draws them from
 * `FNebulaEffect::DrawBoltsPass`, in `src/freelancer/Client/cli_nebula.cpp`. Each bit's size, spin
 * and shape come from the game's `rand()`; where they stand doesn't. Pure, no GL.
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import {
  Primitive,
  setMapCount,
  VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import { DEFAULT_SAMPLER } from '#/texture/texture.js'
import { classifySphere, type Camera } from './camera.js'
import type { Draw } from './frame.js'
import type { Random } from './lightning.js'
import { fogOf, type NebulaState, type Zone } from './nebula.js'
import type { TextureShape } from './ring.js'

const f = Math.fround

/** An `[Exterior]` section, over `FNebulaEffect`'s constructor and `Load`'s defaults. */
export interface ExteriorSettings {
  /** `shape`s, at most eight; a name the shapes don't hold is `undefined`. The first's texture is bound. */
  shapes: readonly (TextureShape | undefined)[]
  /** `shape_weights`, one a shape. 1 each when absent. */
  weights?: readonly number[]
  /** `bit_radius`. Retail leaves it uninitialised when absent: the host decides. */
  bitRadius: number
  /** `bit_radius_random_variation`, held to [0, 0.9999]: a bit is 1 ± it of the radius. 0 when absent. */
  radiusVariation?: number
  /** `color` over 255. Retail leaves it uninitialised when absent: the host decides. */
  color: Vector3
  /** `plane_slices`, 1 when absent: how many rings of latitude. */
  planeSlices?: number
  /** `min_bits`, 4 when absent: a ring's bits at the poles' end. */
  minBits?: number
  /** `max_bits`, 8 when absent: a ring's bits at the middle. */
  maxBits?: number
  /**
   * `equator_bias`, 1 when absent: how far the rings spread from the equator toward the poles, 0 to
   * the whole way, 1 none. The constructor's 0 at `+0xd0` is 1 here.
   */
  equatorBias?: number
  /** `move_bit_percent`, 0.75 when absent: how many `bit_radius` a bit is pulled in from the surface. */
  moveBitPercent?: number
  /** `opacity`, 0.75 when absent. */
  opacity?: number
}

/** What the game's `Nebula` option scales (`NebulaRebuild`): `DAT_006132e0` to `DAT_006132e8`. */
export interface ExteriorLimits {
  /** A bit's size at no detail, of its full. */
  leastSize: number
  /** The bits' count at no detail, of their full. */
  leastCount: number
  /** Their opacity at no detail, of its full. */
  leastOpacity: number
  /** Under this detail, no bits (`0x5d5b58`). */
  leastDetail: number
}

export const RETAIL_EXTERIOR_LIMITS: Readonly<ExteriorLimits> = {
  leastSize: f(0.707),
  leastCount: f(0.35),
  leastOpacity: 0.5,
  leastDetail: 0.05,
}

interface Bit {
  /** From the zone's centre. */
  position: Vector3
  radius: number
  shape: TextureShape | undefined
  /** Its up, which `NebulaOrientBolts` keeps square to the camera. */
  axis: Vector3
}

const RAND_UNIT = 3.0517578125e-5
const TWO_PI = 6.2831854820251465
const PI = f(Math.PI)

// XYZ, D3DCOLOR and one UV set: Win3D's FVF 0x142, 24 bytes.
const FORMAT = setMapCount(VertexFormat.Position | VertexFormat.Diffuse, 1)
const STRIDE = 24
const BLACK: Vector3 = { x: 0, y: 0, z: 0 }

// `ScaleClampToByte`: times 255, truncated, held to a byte.
const byte = (value: number): number => Math.min(Math.max(Math.trunc(f(value * 255)), 0), 255)

/**
 * Whether the game blends a texture by its alpha (`FUN_00552420`): DXT1 to DXT5 do, and so does any
 * format with alpha bits. A 24-bit Targa is narrowed to R5G6B5 (M1), so it doesn't.
 */
export const textureHasAlpha = ({ format }: Texture): boolean =>
  format !== 'rgb24_888' && format !== 'rgb16_565' && format !== 'none'

export class NebulaExterior {
  readonly settings: ExteriorSettings
  readonly zone: Zone
  #bits: Bit[] = []
  /** `+0xb8`: the opacity at this detail. */
  #opacity: number
  /** `+0x58`: since the bits last turned to the camera. The constructor's 0.2. */
  #sinceTurned = f(0.2)
  /** `+0x54`: since they were last sorted. The constructor's 10. */
  #sinceSorted = 10
  /** `+0x294` as `Update` last left it, which it reads before working it out again. */
  #lastDepth = 0

  constructor(
    settings: ExteriorSettings,
    zone: Zone,
    {
      random = () => Math.floor(Math.random() * 0x8000),
      detail = 1,
      limits = RETAIL_EXTERIOR_LIMITS,
    }: { random?: Random; detail?: number; limits?: ExteriorLimits } = {},
  ) {
    this.settings = settings
    this.zone = zone
    const opacity = f(settings.opacity ?? 0.75)
    this.#opacity = opacity
    if (detail < limits.leastDetail) return

    const less = 1 - detail
    const ease = 1 - less * less
    const scale = f((limits.leastSize * (1 - ease) + ease) * f(settings.bitRadius))
    const density = f(less * limits.leastCount + detail)
    this.#opacity = f(((1 - ease) * limits.leastOpacity + ease) * opacity)
    const middleCount = Math.trunc((settings.maxBits ?? 8) * density + 0.5)
    const endCount = Math.trunc((settings.minBits ?? 4) * density + 0.5)
    const slices = settings.planeSlices ?? 1
    if (slices <= 0) return

    const weights = settings.shapes.map((_, at) => settings.weights?.[at] ?? 1)
    const sum = weights.reduce((total, weight) => total + weight, 0)
    const normal = weights.map((weight) => f((1 / sum) * weight))

    // A ring's count, from the poles' end to the middle and back.
    const mid = f((slices - 1) * 0.5)
    const inverseMid = f(1 / mid)
    let total = middleCount
    if (slices !== 1) {
      total = 0
      for (let slice = 0; slice < slices; slice++) {
        const w = slice > mid ? 1 - (slice - mid) * inverseMid : slice * inverseMid
        total += Math.floor((1 - w) * endCount + middleCount * w + 0.5)
      }
    }

    // Each bit's size, spin and shape, the two caps' too.
    const variation = Math.min(Math.max(settings.radiusVariation ?? 0, 0), f(0.9999))
    const low = f(1 - variation)
    const high = f(variation + 1)
    for (let index = 0; index < total + 2; index++) {
      const radius = f((random() * RAND_UNIT * (high - low) + low) * scale)
      const angle = random() * RAND_UNIT * TWO_PI
      const axis = { x: f(Math.sin(angle)), y: f(Math.cos(angle)), z: 0 }
      const pick = f(random() * RAND_UNIT)
      let running = 0
      let shape: TextureShape | undefined
      for (let at = 0; at < normal.length; at++) {
        running += normal[at]!
        if (pick < running) {
          shape = settings.shapes[at]
          break
        }
      }
      this.#bits.push({ position: BLACK, radius, shape, axis })
    }

    // The rings of latitude, each turned half a step past the middle.
    const centre = zone.position
    const spread = f(1 - (settings.equatorBias ?? 1))
    const margin = f(settings.moveBitPercent ?? 0.75) * f(settings.bitRadius)
    const place = (index: number, point: Vector3) => {
      const surface = zone.surfacePoint(point)
      const offset = {
        x: f(surface.x - centre.x),
        y: f(surface.y - centre.y),
        z: f(surface.z - centre.z),
      }
      const length = Math.sqrt(offset.z * offset.z + offset.y * offset.y + offset.x * offset.x)
      const shrink = (length - margin) / length
      const bit = this.#bits[index]
      if (bit)
        bit.position = { x: f(shrink * offset.x), y: f(shrink * offset.y), z: f(shrink * offset.z) }
    }
    let index = 0
    let phase = 0
    for (let slice = 0; slice < slices; slice++) {
      let count = middleCount
      if (slices !== 1) {
        const w = slice > mid ? 1 - (slice - mid) / mid : slice / mid
        count = Math.floor((1 - w) * endCount + middleCount * w + 0.5)
        if (slice > mid) phase = f(PI / count)
      }
      const latitude = Math.acos((((slice + 1) / (slices + 1)) * 2 - 1) * spread)
      if (count <= 0) continue
      const cos = f(Math.cos(latitude))
      const sin = Math.sin(latitude)
      const y = f(centre.y + cos)
      for (let bit = 0; bit < count; bit++, index++) {
        const angle = (bit * TWO_PI) / count + phase
        const x = Math.cos(angle) * sin
        const z = f(Math.sin(angle) * sin)
        place(index, { x: f(centre.x + x), y, z: f(centre.z + z) })
      }
    }
    place(index++, { x: centre.x, y: f(centre.y + 1), z: centre.z })
    place(index, { x: centre.x, y: f(centre.y - 1), z: centre.z })
  }

  /** The bits, from the zone's centre, in the order they draw. */
  get bits(): readonly Readonly<Bit>[] {
    return this.#bits
  }

  /**
   * `FNebulaEffect::Update`'s part: unless the camera was all the way in last frame, the bits turn
   * to it once a second, or at once on a cut (`NebulaOrientBolts`). Then the clocks run on.
   */
  update(eye: Vector3, step: number, depth: number, cut = false): void {
    if (this.#lastDepth < 1 && (this.#sinceTurned > 1 || cut)) {
      this.#turn(eye)
      this.#sinceTurned = 0
    }
    this.#lastDepth = depth
    this.#sinceTurned = f(step + this.#sinceTurned)
    this.#sinceSorted = f(step + this.#sinceSorted)
  }

  /** `NebulaOrientBolts`: each bit's up made square to the way to the camera, when it's far off. */
  #turn(eye: Vector3): void {
    const centre = this.zone.position
    const rx = f(eye.x - centre.x)
    const ry = f(eye.y - centre.y)
    const rz = f(eye.z - centre.z)
    for (const bit of this.#bits) {
      const a = rx - bit.position.x
      const b = ry - bit.position.y
      const c = rz - bit.position.z
      const cf = f(c)
      const inverse = f(1 / Math.sqrt(c * cf + b * b + a * a))
      const dx = f(a * inverse)
      const dy = b * inverse
      const dzExt = cf * inverse
      const dz = f(dzExt)
      const o = bit.axis
      if (!(Math.abs(dzExt * o.z + dy * o.y + dx * o.x) > 0.25)) continue
      const cx = dy * o.z - dz * o.y
      const cy = dz * o.x - dx * o.z
      const cz = dx * o.y - dy * o.x
      const czf = f(cz)
      const inverseC = f(1 / Math.sqrt(cz * czf + cy * cy + cx * cx))
      const nx = f(cx * inverseC)
      const ny = cy * inverseC
      const nz = czf * inverseC
      bit.axis = { x: f(ny * dz - nz * dy), y: f(nz * dx - dz * nx), z: f(dy * nx - ny * dx) }
    }
  }

  /**
   * `NebulaDrawBolts` from `DrawBoltsPass`: none once the camera is all the way in, nor when the zone
   * is out of view. Sorted far to near once 1.15 s have passed. Each bit faces the camera about its
   * up, its back half skipped and its edge fading, fading too as the camera comes within its radius,
   * and over the second half of the camera's depth. Unlit, unculled, with no depth test or writes,
   * `ALPHAREF` 4, fogged in the nebula's colour to past its fog's span (`DrawBoltsPass`). `camera` is
   * the 250000 far plane its callers set; `projection` is that.
   */
  draw(
    { nebula, depth, start, fogDistance }: NebulaState,
    camera: Camera,
    view: Matrix4,
    aspect: number,
    projection: Matrix4,
  ): Draw | undefined {
    if (!this.#bits.length || !(depth < 1)) return undefined
    const centre = this.zone.position
    const eye = camera.position
    const inView = Matrix4.transformPoint(centre, view)
    if (classifySphere(inView, this.zone.radius, camera, aspect) < 3) return undefined
    if (this.#sinceSorted > f(1.15)) {
      this.#sort(eye)
      this.#sinceSorted = 0
    }
    const bound = this.settings.shapes[0]
    if (!bound) return undefined
    const alpha = textureHasAlpha(bound.texture)

    let base = this.#opacity
    if (depth > 0.5) base = f((1 - (depth - 0.5 + (depth - 0.5))) * base)
    let tx = f(eye.x - centre.x)
    let ty = f(eye.y - centre.y)
    let tz = f(eye.z - centre.z)
    const toCamera = f(1 / f(Math.sqrt(f(f(tx * tx + tz * tz) + ty * ty))))
    tx = f(tx * toCamera)
    ty = f(ty * toCamera)
    tz = f(tz * toCamera)

    const { color } = this.settings
    const corners: { at: number[]; uv: [number, number]; bytes: number[] }[] = []
    for (const { position: s, radius, shape, axis } of this.#bits) {
      const p = { x: f(centre.x + s.x), y: f(centre.y + s.y), z: f(centre.z + s.z) }
      const v = { x: f(p.x - eye.x), y: f(p.y - eye.y), z: f(p.z - eye.z) }
      const ahead = -Matrix4.transformPoint(p, view).z
      if (ahead <= 0) continue

      // Its offset from the centre against the way to the camera: the back half isn't drawn.
      let a = base
      const inverse = f(1 / f(Math.sqrt(f(f(s.x * s.x + s.z * s.z) + s.y * s.y))))
      const dot = f(f(tx * f(s.x * inverse) + tz * f(s.z * inverse)) + ty * f(s.y * inverse))
      if (dot < 0) continue
      if (dot < 0.05) a = f(dot * base * 20)

      let qx = f(v.y * axis.z - v.z * axis.y)
      let qy = f(v.z * axis.x - v.x * axis.z)
      let qz = f(v.x * axis.y - v.y * axis.x)
      const qs = f(radius / f(Math.sqrt(f(f(qx * qx + qz * qz) + qy * qy))))
      qx = f(qx * qs)
      qy = f(qy * qs)
      qz = f(qz * qs)
      let hx = f(qy * v.z - qz * v.y)
      let hy = f(qz * v.x - v.z * qx)
      let hz = f(v.y * qx - qy * v.x)
      const hs = f(radius / f(Math.sqrt(f(f(hz * hz + hy * hy) + hx * hx))))
      hx = f(hx * hs)
      hy = f(hy * hs)
      hz = f(hz * hs)

      if (ahead < radius) a = f(f(ahead / radius) * a)
      if (a < 0.01 || !shape) continue
      // With alpha, `Color4f`; without, added, `Color3f` of the colour times it.
      const bytes = alpha
        ? [byte(color.z), byte(color.y), byte(color.x), byte(a)]
        : [byte(color.z * a), byte(color.y * a), byte(color.x * a), 255]
      const corner = (q: number, h: number, uv: [number, number]) =>
        corners.push({
          at: [
            f(f(p.x + q * qx) + h * hx),
            f(f(p.y + q * qy) + h * hy),
            f(f(p.z + q * qz) + h * hz),
          ],
          uv,
          bytes,
        })
      corner(1, 1, [shape.u0, shape.v0])
      corner(1, -1, [shape.u1, shape.v0])
      corner(-1, -1, [shape.u1, shape.v1])
      corner(-1, 1, [shape.u0, shape.v1])
    }
    if (!corners.length) return undefined

    const vertices = new Uint8Array(corners.length * STRIDE)
    const floats = new Float32Array(vertices.buffer)
    corners.forEach(({ at, uv, bytes }, index) => {
      floats.set(at, (index * STRIDE) / 4)
      vertices.set(bytes, index * STRIDE + 12)
      floats.set(uv, (index * STRIDE + 16) / 4)
    })
    // `Win3DEnd` makes each quad (0, 1, 2) and (0, 2, 3).
    const indices = new Uint16Array(
      Array.from({ length: corners.length / 4 }, (_, quad) =>
        [0, 1, 2, 0, 2, 3].map((corner) => quad * 4 + corner),
      ).flat(),
    )
    const mesh: VMeshData = {
      name: 'nebula exterior',
      version: 1,
      primitive: Primitive.TriangleList,
      format: FORMAT,
      groups: [
        {
          materialId: 0,
          vertexStart: 0,
          vertexEnd: corners.length - 1,
          elementCount: indices.length,
          padding: 0,
        },
      ],
      indices,
      vertices,
    }
    const reference: VMeshRef = {
      meshId: 0,
      vertexStart: 0,
      vertexCount: corners.length,
      indexStart: 0,
      indexCount: indices.length,
      groupStart: 0,
      groupCount: 1,
      boundingBox: { min: BLACK, max: BLACK },
      boundingSphere: { center: BLACK, radius: 0 },
    }
    // `DrawBoltsPass`: from the fog's start, past its span by twenty times as far as that is out.
    const near = f(nebula.fog.near ?? 0)
    const reach = Math.max(((start - near) * 20) / fogDistance, 0)
    const end = f((reach + 1) * fogDistance + start)
    return {
      mesh,
      reference,
      transient: true,
      byteOffset: 0,
      count: indices.length,
      // In world space, under the camera's own view.
      world: Matrix4.identity,
      projection,
      materialName: 'nebula exterior',
      diffuse: [1, 1, 1, 1],
      ambient: BLACK,
      emissive: BLACK,
      colorVertex: true,
      nomad: false,
      texture: {
        name: bound.texture.name,
        entry: bound.texture,
        sampler: DEFAULT_SAMPLER,
        uvSet: 0,
      },
      cull: 'none',
      depthWrite: false,
      depthFunc: 'always',
      lightless: true,
      negateNormals: false,
      normalizeNormals: false,
      blend: true,
      blendMode: alpha ? 'alpha' : 'add',
      unlit: true,
      alphaReference: 4,
      alphaFunction: 'greater',
      fog: fogOf(start, end, nebula.fog.color),
    }
  }

  /**
   * The bubble sort `NebulaDrawBolts` runs, far to near by distance from the camera: a pair swaps only
   * when the later is farther by more than 10, and a distance is kept for the next pair only just
   * after a swap, as retail has it.
   */
  #sort(eye: Vector3): void {
    const bits = this.#bits
    const centre = this.zone.position
    const distance = ({ position: s }: Bit) => {
      const dx = f(f(centre.x + s.x) - eye.x)
      const dy = f(f(centre.y + s.y) - eye.y)
      const dz = f(f(centre.z + s.z) - eye.z)
      return dx * dx + dy * dy + dz * dz
    }
    let swapped: number
    do {
      swapped = 0
      if (bits.length <= 1) break
      let cached = false
      let previous = 0
      for (let at = 1; at < bits.length; at++) {
        if (!cached) previous = distance(bits[at - 1]!)
        const current = distance(bits[at]!)
        if (!(previous < current)) {
          cached = false
          continue
        }
        if (!(Math.abs(previous - current) > 10)) continue
        swapped++
        ;[bits[at - 1], bits[at]] = [bits[at]!, bits[at - 1]!]
        cached = true
      }
    } while (swapped > 0)
  }
}
