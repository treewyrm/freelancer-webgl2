/**
 * An asteroid field's `[Band]`: a ring of upright quads about its zone, seen from afar. The ring
 * (`BandBuildExclusionRings`, `FUN_0054c8b0`), each point's fade and facing (`BandUpdate`,
 * `FUN_0054d410`), its lighting, baked once (`BandBakeLighting`, `FUN_0054cfb0`), and a piece's quads
 * (`BandDrawPiece`, `FUN_0054d4e0`), all in `src/freelancer/Client/cli_asteroid.cpp`. Pure, no GL;
 * a band keeps each point's facing between frames, as retail does.
 */
import { Matrix3, Matrix4, type Quat, type Vector3 } from '@treewyrm/freelancer/math'
import {
  Primitive,
  setMapCount,
  VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import { DEFAULT_SAMPLER } from '#/texture/texture.js'
import type { Draw, SceneLight } from './frame.js'
import type { TextureShape } from './ring.js'

const f = Math.fround

/** A `[Band]` as written, over `FUN_0054c580`'s defaults. The host reads the INI. */
export interface BandSettings {
  /** `shape`: only its texture is used. Without one the band draws nothing. */
  shape?: TextureShape
  /** `texture_aspect`, 1 when absent; read times 1.15. */
  textureAspect?: number
  /** `height`, 1000 when absent. */
  height?: number
  /** `offset_dist` takes this from the zone's size; `offset_percent` scales the size by it. */
  offset?: { distance: number } | { percent: number }
  /** `color_shift`, 1 when absent: the field's colours are multiplied by it. */
  colorShift?: Vector3
  /** `fade`'s four distances, in heights: 1500, 2500, 100000 and 130000 when absent. */
  fade?: readonly [number, number, number, number]
  /** `vert_increase`, at least 1: points to a ring's segment, and how often U repeats. */
  vertIncrease?: number
  /** `render_parts`, 1 when absent: the pieces the ring is cut into, at most half its points. */
  renderParts?: number
  /** `cull_mode`: 1 hides the faces turned away, 2 those turned toward. 0 when absent. */
  cullMode?: number
  /** `ambient_intensity`, 1 when absent. */
  ambientIntensity?: number
}

/** What a band takes of its field: the zone's frame and `size` as written, and the field's colours. */
export interface BandField {
  position: Vector3
  orientation: Quat
  /** `size` as written; a sphere's has its radius in X alone. */
  size: Vector3
  /** `diffuse_color` over 255. */
  diffuse: Vector3
  /** `ambient_color` over 255. */
  ambient: Vector3
  /** `ambient_increase`, 0 to 255. */
  ambientIncrease?: Vector3
}

/** One of the pieces the frame lists: a run of the ring's points and the sphere the view tests. */
export interface BandPiece {
  first: number
  last: number
  center: Vector3
  radius: number
}

/** What the bake lights a band with: the system's `[Ambient]` as written, and the lights it found. */
export interface BandLighting {
  ambient: Vector3
  /** How many lights `CollectNearbyLights` found. With none, nothing is baked. */
  found: number
  lights: readonly SceneLight[]
}

// `DAT_006140a4`: how far round the back a light still reaches.
const SOFT = 0.75
// `DAT_005d3e08`, `DAT_005c75e0`, `DAT_005e0a60`: edge-on, a point fades out.
const EDGE_HIDDEN = f(0.3)
const EDGE_FADED = 0.5
const EDGE_SLOPE = 5
// `DAT_005c99c8`: below this a point is transparent.
const LEAST_ALPHA = f(0.01)
const TWO_PI = f(6.28318548)
const PI = f(3.14159274)

// XYZ, D3DCOLOR and one UV set: FVF 0x142, 24 bytes, as Win3D's immediate mode draws.
const FORMAT = setMapCount(VertexFormat.Position | VertexFormat.Diffuse, 1)
const STRIDE = 24

const BLACK: Vector3 = { x: 0, y: 0, z: 0 }
const WHITE: Vector3 = { x: 1, y: 1, z: 1 }

// `ScaleClampToByte`: times 255, truncated, held to a byte.
const byte = (value: number): number => Math.min(Math.max(Math.trunc(f(value * 255)), 0), 255)

// The tint clamp of `FUN_0054d970`: an upper bound only.
const tint = (value: number): number => (value < 1 ? value : 1)

/** `FUN_00422b80`'s even test, which `BandBuildExclusionRings` picks a piece's centre by. */
const even = (n: number): boolean => (n & 1) === 0

export class AsteroidBand {
  readonly settings: BandSettings
  /** Its zone's centre, where it is lit. */
  readonly position: Vector3
  /**
   * `+0x54`: what its alpha is held under. The field's own band keeps 1; an `[ExclusionBand]` takes
   * `nearFieldFraction` each frame.
   */
  private maxAlpha = 1
  /** Each point of the ring, in world space, with its outward normal. */
  readonly points: readonly { position: Vector3; normal: Vector3 }[]
  readonly halfHeight: number
  readonly pieces: readonly BandPiece[]
  /** The squares of the four fade distances, in world units. */
  private readonly fades: readonly [number, number, number, number]
  private readonly diffuse: Vector3
  private readonly ambient: Vector3
  private readonly increase: Vector3
  /** `+0x34` and `+0x38` of each point: its fade, and whether the camera is on its normal's side. */
  private readonly fade: Float32Array
  private readonly facing: Uint8Array
  /** `+0x1c` and `+0x28`: the colour seen from the normal's side, and from behind. */
  private front: Vector3[]
  private back: Vector3[]
  private baked = false

  constructor(settings: BandSettings, field: BandField) {
    this.settings = settings
    this.position = field.position
    const shift = settings.colorShift ?? WHITE
    // `BandApplyTints` and `BandSetAmbientIncrease`, as the field's `[Band]` is read.
    this.diffuse = {
      x: tint(f(shift.x * field.diffuse.x)),
      y: tint(f(shift.y * field.diffuse.y)),
      z: tint(f(shift.z * field.diffuse.z)),
    }
    this.ambient = {
      x: tint(f(shift.x * field.ambient.x)),
      y: tint(f(shift.y * field.ambient.y)),
      z: tint(f(shift.z * field.ambient.z)),
    }
    const raise = field.ambientIncrease ?? BLACK
    this.increase = { x: f(raise.x / 255), y: f(raise.y / 255), z: f(raise.z / 255) }

    const sizeX = f(field.size.x)
    const sizeZ = field.size.z < 0.1 ? sizeX : f(field.size.z)
    const aspect = f((settings.textureAspect ?? 1) * 1.15)
    const height = f(settings.height ?? 1000)
    const vertIncrease = Math.max(Math.trunc(settings.vertIncrease ?? 1), 1)
    const count =
      Math.trunc(f(f(f(f(sizeX + sizeZ) * PI) / f(aspect * height)) + 0.5)) * vertIncrease
    const [inner, near, far, outer] = (settings.fade ?? [1500, 2500, 100000, 130000]).map((d) =>
      f(f(d * height) * f(d * height)),
    ) as [number, number, number, number]
    this.fades = [inner, near, far, outer]
    this.halfHeight = f(height * 0.5)

    const offset = settings.offset ?? { distance: 0 }
    const [radiusX, radiusZ] =
      'distance' in offset
        ? [f(sizeX - offset.distance), f(sizeZ - offset.distance)]
        : [f(sizeX * offset.percent), f(sizeZ * offset.percent)]
    // The zone's frame as `ZoneToTransform` gives a ring's. A tilted band is uncaptured.
    const rotation = Matrix3.fromQuaternion(field.orientation)
    const positions = Array.from({ length: count }, (_, at) => {
      const angle = f(f(at / count) * TWO_PI)
      const local = { x: f(Math.cos(angle) * radiusX), y: 0, z: f(Math.sin(angle) * radiusZ) }
      const turned = Matrix3.transform(local, rotation)
      return {
        x: f(f(turned.x) + field.position.x),
        y: f(f(turned.y) + field.position.y),
        z: f(f(turned.z) + field.position.z),
      }
    })
    // Each point's normal: the average of the two neighbouring chords', each crossed with world up.
    const outward = (from: Vector3, to: Vector3): Vector3 => {
      const dx = f(to.x - from.x)
      const dz = f(to.z - from.z)
      const length = f(Math.sqrt(f(dz * dz + dx * dx)))
      return { x: f(dz / length), y: 0, z: f(-dx / length) }
    }
    this.points = positions.map((position, at) => {
      const previous = positions[(at - 1 + count) % count]!
      const next = positions[(at + 1) % count]!
      const a = outward(position, next)
      const b = outward(previous, position)
      const sum = { x: f(a.x + b.x), z: f(a.z + b.z) }
      const length = Math.sqrt(sum.x * sum.x + sum.z * sum.z)
      return { position, normal: { x: f(sum.x / length), y: 0, z: f(sum.z / length) } }
    })

    // `render_parts`, held to half the points, each a run from where the last ended.
    let parts = Math.max(Math.trunc(settings.renderParts ?? 1), 1)
    if (parts > f(count * 0.5)) parts = Math.trunc(f(count * 0.5))
    const step = f(count / parts)
    let total = 0
    let start = 0
    const pieces: BandPiece[] = []
    for (let index = 0; index < parts && count > 0; index++) {
      total = f(total + step)
      const end = Math.trunc(f(total + f(0.0001)))
      const span = end - start
      let middle = start - Math.trunc(f(span * -0.5))
      if (middle >= count) middle -= count
      const a = positions[middle]!
      // An even run's centre is between its middle point and the next, off by half a segment, as
      // `Freelancer-original.exe` has it (`0x54ce17`..`0x54ce46`). The view tests that sphere.
      const center = even(span)
        ? (() => {
            const b = positions[middle + 1 >= count ? middle + 1 - count : middle + 1]!
            return { x: f(f(a.x + b.x) * 0.5), y: f(f(a.y + b.y) * 0.5), z: f(f(a.z + b.z) * 0.5) }
          })()
        : a
      const reach = (point: Vector3) =>
        f(Math.hypot(f(center.x - point.x), f(center.y - point.y), f(center.z - point.z)))
      const radius = Math.max(
        reach(positions[start >= count ? start - count : start]!),
        reach(positions[end >= count ? end - count : end]!),
      )
      pieces.push({ first: start, last: end, center, radius })
      start = end
    }
    this.pieces = pieces

    this.fade = new Float32Array(count).fill(1)
    this.facing = new Uint8Array(count).fill(1)
    this.front = Array.from({ length: count }, () => WHITE)
    this.back = Array.from({ length: count }, () => ({ x: f(0.2), y: f(0.2), z: f(0.2) }))
  }

  /**
   * `BandUpdate`: each point's fade from the camera, in by `fade`'s first two distances and out by
   * its last two, and edge-on below a |cos| of 0.5. Where it's faded out past the far end, its
   * facing is last frame's. `maxAlpha` is kept for the draw; under 0.001 nothing else is updated.
   */
  update(eye: Vector3, maxAlpha = 1): void {
    this.maxAlpha = maxAlpha
    if (maxAlpha < 0.001) return
    const [inner, near, far, outer] = this.fades
    this.points.forEach(({ position, normal }, at) => {
      const dx = f(eye.x - position.x)
      const dy = f(eye.y - position.y)
      const dz = f(eye.z - position.z)
      const squared = dx * dx + dz * dz + dy * dy
      let fade: number
      let inside = false
      if (squared > near) {
        if (squared < far) fade = 1
        else if (squared > outer) fade = 0
        else fade = f((outer - squared) / (outer - far))
      } else if (squared < inner) {
        fade = 0
        inside = true
      } else fade = f((squared - inner) / (near - inner))
      this.fade[at] = fade
      if (!(fade > 0) && !inside) return
      const inverse = 1 / Math.sqrt(squared)
      const dot = dz * inverse * normal.z + dy * inverse * normal.y + dx * inverse * normal.x
      this.facing[at] = dot > 0 ? 1 : 0
      const edge = f(Math.abs(dot))
      if (edge < EDGE_HIDDEN) this.fade[at] = 0
      else if (edge < EDGE_FADED) this.fade[at] = f(f(f(edge - EDGE_HIDDEN) * fade) * EDGE_SLOPE)
    })
  }

  /** Whether `bake` has run with lights to bake. */
  get isBaked(): boolean {
    return this.baked
  }

  /**
   * `BandBakeLighting`, once: both sides of each point, the ambient plus each light's diffuse by how
   * squarely it falls, softened round the back, and held under 1. The ambient is the system's
   * raised by `ambient_increase`, in the band's ambient tint, times `ambient_intensity`.
   */
  bake({ ambient, found, lights }: BandLighting): void {
    if (found <= 0) return
    const intensity = f(this.settings.ambientIntensity ?? 1)
    const system = (value: number) => f(Math.min(Math.max(Math.trunc(value), 0), 255) * 0.003921569)
    const base = {
      x: f(f(f(system(ambient.x) + this.increase.x) * this.ambient.x) * intensity),
      y: f(f(f(system(ambient.y) + this.increase.y) * this.ambient.y) * intensity),
      z: f(f(f(system(ambient.z) + this.increase.z) * this.ambient.z) * intensity),
    }
    const { diffuse } = this
    // The normal at `+0x10` (`0x54d169`, `[ebx - 4]` from `+0x14`): the decomp reads a float later.
    const sides = this.points.map(({ normal }) => {
      const a = { ...base }
      const b = { ...base }
      for (const { direction, color } of lights) {
        const dot = direction.x * normal.x + direction.y * normal.y + direction.z * normal.z
        if (-SOFT < dot) {
          const t = (SOFT + dot) / (SOFT + 1)
          b.x = f(b.x + color.x * diffuse.x * t)
          b.y = f(b.y + color.y * diffuse.y * t)
          b.z = f(b.z + color.z * diffuse.z * t)
        }
        if (-SOFT < -dot) {
          const t = (SOFT - dot) / (SOFT + 1)
          a.x = f(a.x + color.x * diffuse.x * t)
          a.y = f(a.y + color.y * diffuse.y * t)
          a.z = f(a.z + color.z * diffuse.z * t)
        }
      }
      const hold = ({ x, y, z }: Vector3) => ({
        x: Math.min(x, 1),
        y: Math.min(y, 1),
        z: Math.min(z, 1),
      })
      return { front: hold(a), back: hold(b) }
    })
    this.front = sides.map(({ front }) => front)
    this.back = sides.map(({ back }) => back)
    this.baked = true
  }

  /**
   * `BandDrawPiece`: a quad between each two points of the piece, in two passes, those with either end
   * turned away and then those turned toward; each end in its side's colour and its fade, under
   * the alpha `update` was given, U stepping by `vert_increase`. A quad with both ends transparent is left out, and a
   * piece with none draws nothing. Unlit, blended, both sides, with no depth test or writes.
   */
  pieceDraw(index: number): Draw | undefined {
    const { maxAlpha } = this
    const { shape } = this.settings
    if (!shape || maxAlpha < LEAST_ALPHA) return undefined
    const piece = this.pieces[index] ?? this.pieces[0]
    if (!piece) return undefined
    const count = this.points.length
    const vertIncrease = Math.max(Math.trunc(this.settings.vertIncrease ?? 1), 1)
    const inverse = f(1 / vertIncrease)
    const cull = this.settings.cullMode ?? 0
    const corners: number[] = []
    const colours: number[] = []
    let cursor = 0
    let next = 1
    for (let pass = 0; pass < 2; pass++) {
      if (pass + 1 === cull || piece.first >= piece.last) continue
      for (let at = piece.first; at < piece.last; at++) {
        if (next > vertIncrease) {
          cursor -= vertIncrease
          next -= vertIncrease
        }
        const other = at + 1 >= count ? at + 1 - count : at + 1
        const [facesA, facesB] = [this.facing[at]!, this.facing[other]!]
        const drawn = pass === 0 ? facesA === 0 || facesB === 0 : facesA !== 0 && facesB !== 0
        if (drawn) {
          const end = (point: number, faces: number) => {
            let alpha = this.fade[point]!
            if ((faces === 0 && cull === 1) || (faces !== 0 && cull === 2)) alpha = 0
            return { alpha, color: faces === 0 ? this.back[point]! : this.front[point]! }
          }
          const a = end(at, facesA)
          const b = end(other, facesB)
          if (!(a.alpha < LEAST_ALPHA) || !(b.alpha < LEAST_ALPHA)) {
            const u0 = f(cursor * inverse)
            const u1 = f(next * inverse)
            const half = this.halfHeight
            const pa = this.points[at]!.position
            const pb = this.points[other]!.position
            const colourOf = ({ color }: typeof a, alpha: number) => [
              byte(color.z),
              byte(color.y),
              byte(color.x),
              byte(alpha),
            ]
            const ca = colourOf(a, maxAlpha < a.alpha ? maxAlpha : a.alpha)
            const cb = colourOf(b, maxAlpha < b.alpha ? maxAlpha : b.alpha)
            const top = (p: Vector3) => [p.x, f(p.y + half), p.z]
            const bottom = (p: Vector3) => [p.x, f(p.y - half), p.z]
            for (const [corner, colour, u, v] of [
              [top(pa), ca, u0, 1],
              [bottom(pa), ca, u0, 0],
              [bottom(pb), cb, u1, 0],
              [bottom(pb), cb, u1, 0],
              [top(pb), cb, u1, 1],
              [top(pa), ca, u0, 1],
            ] as const) {
              corners.push(...corner, u, v)
              colours.push(...colour)
            }
          }
        }
        cursor++
        next++
      }
    }
    const vertexCount = corners.length / 5
    if (vertexCount === 0) return undefined

    const vertices = new Uint8Array(vertexCount * STRIDE)
    const floats = new Float32Array(vertices.buffer)
    for (let at = 0; at < vertexCount; at++) {
      floats.set(corners.slice(at * 5, at * 5 + 3), (at * STRIDE) / 4)
      vertices.set(colours.slice(at * 4, at * 4 + 4), at * STRIDE + 12)
      floats.set(corners.slice(at * 5 + 3, at * 5 + 5), (at * STRIDE + 16) / 4)
    }
    const mesh: VMeshData = {
      name: 'band',
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
      boundingBox: { min: piece.center, max: piece.center },
      boundingSphere: { center: piece.center, radius: piece.radius },
    }
    return {
      mesh,
      reference,
      transient: true,
      byteOffset: 0,
      count: vertexCount,
      world: Matrix4.identity,
      materialName: 'band',
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
      depthWrite: false,
      // `FUN_00522850` turns the depth test off and the far plane to 250000 on either list.
      depthFunc: 'always',
      lightless: true,
      negateNormals: false,
      normalizeNormals: false,
      blend: true,
      blendMode: 'alpha',
      unlit: true,
      // `ALPHAREF` 5 around it; the test and its `GREATER` are the frame's, as captured.
      alphaReference: 5,
      alphaFunction: 'greater',
    }
  }
}
