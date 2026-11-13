/**
 * A planet's ring seen from outside: `PlanetaryRings::PlanetRing`, `src/freelancer/Client/
 * texture_panels.cpp`. A flat band between its zone's two radii, cut into eight pieces that join the
 * space frame's lists like objects. Its `[Clouds]`, seen from inside, aren't built. Pure, no GL.
 */
import { Matrix3, Matrix4, type RingShape, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import {
  Primitive,
  setMapCount,
  VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import { DEFAULT_SAMPLER, type SamplerState } from '#/texture/texture.js'
import type { Clouds } from './clouds.js'
import type { Draw } from './frame.js'

const f = Math.fround

/** A `[Shape]`'s rectangle in its texture, as UVs. */
export interface TextureShape {
  texture: Texture
  u0: number
  v0: number
  u1: number
  v1: number
}

// `DAT_005c99c8`: a hundredth of a pixel in from each edge, so an atlas's neighbours don't bleed.
const UV_INSET = f(0.01)

/**
 * `TexShapeSetRect` (`0x4256c0`): a `[Shape]`'s `x`, `y`, `w` and `h` in `texture`'s pixels. A corner
 * of 1 or less is a fraction of the texture, and so is an extent; a zero extent is all of it.
 */
export const textureShape = (
  texture: Texture,
  { x = 0, y = 0, w = 0, h = 0 }: { x?: number; y?: number; w?: number; h?: number },
): TextureShape => {
  const width = f(texture.width)
  const height = f(texture.height)

  if (x <= 1 && y <= 1) {
    x = f(width * x)
    y = f(height * y)
  }

  if (w === 0 || h === 0) {
    w = width
    h = height
  } else if (w <= 1 && h <= 1) {
    w = f(width * w)
    h = f(height * h)
  }

  const right = f(x + w)
  const bottom = f(y + h)

  return {
    texture,
    u0: f(f(x + UV_INSET) / width),
    v0: f(f(y + UV_INSET) / height),
    u1: f(f(right - UV_INSET) / width),
    v1: f(f(bottom - UV_INSET) / height),
  }
}

/** A ring file's `[Exterior]`, over `PlanetRing::Load`'s defaults. The host reads the INI. */
export interface RingExterior {
  /** `shape`. Without one the ring draws nothing. */
  shape?: TextureShape
  /** `detail_shape`, on the second UV set. */
  detail?: TextureShape
  /** `detail_tile` as written: the detail's V at the inner edge, then its U on odd segments. */
  detailTile?: readonly [number, number]
  /** `color` over 255. Kept from the last ring loaded when absent: black here. */
  color?: Vector3
  /** 1 when absent, and halved without a detail shape. */
  opacity?: number
  /** `num_segments`, 32 when absent. */
  segments?: number
  /** `transition_dist`, 150 when absent: how far past its edges its immersion fades. */
  transitionDistance?: number
}

export interface RingOptions {
  /** `high_detail_textures`: under 0.4 the detail shape is dropped (`0x50ac65`). 1 when absent. */
  highDetailTextures?: number
}

/** A run of segments drawn as one, and the sphere about its vertices that the view tests. */
export interface RingPiece {
  first: number
  last: number
  center: Vector3
  radius: number
  /** Its strip, in world space. */
  mesh: VMeshData
  reference: VMeshRef
}

export interface PlanetRing {
  pieces: RingPiece[]
  shape?: TextureShape
  detail?: TextureShape
  zone: RingShape
  transitionDistance: number
  /** Its `[Clouds]`, which the host makes with `RING_CLOUD_VISIBILITY` and its own `rand()`. */
  clouds?: readonly Clouds[]
}

// `DAT_005c97f8`, the float 2π as a double, and `DAT_005db098`.
const TWO_PI = 6.2831854820251465
const LAST_BIAS = f(1e-4)
const PIECES = 8

// XYZ, D3DCOLOR and two UV sets: FVF 0x242, 32 bytes.
const FORMAT = setMapCount(VertexFormat.Position | VertexFormat.Diffuse, 2)
const STRIDE = 32

/** The zone's frame, as `ZoneToTransform` gives it: `R · v + t`. */
const zoneTransform = ({ center, orientation }: RingShape): Matrix4 =>
  Matrix4.fromRotationTranslation(Matrix3.fromQuaternion(orientation), center)

/**
 * `PlanetRing::Load`'s mesh (`0x50a8d3` on): a vertex at the outer radius and one at the inner for
 * each segment, then eight pieces of them, each with the box's sphere. And `DrawPiece`'s strip for
 * each (`0x50b77e`): the shape's left edge on even segments and its right on odd, its top at the
 * outer radius and its bottom at the inner, in the colour and opacity, all in world space.
 */
export const buildRing = (
  exterior: RingExterior,
  zone: RingShape,
  { highDetailTextures = 1 }: RingOptions = {},
): PlanetRing => {
  const segments = Math.trunc(exterior.segments ?? 32)
  const { shape } = exterior
  const detail = highDetailTextures >= 0.4 ? exterior.detail : undefined
  // `0x50ace5`: with any texture and no detail shape, the opacity is halved.
  const opacity = f(
    (exterior.opacity ?? 1) * (detail === undefined && (shape || exterior.detail) ? 0.5 : 1),
  )
  const transform = zoneTransform(zone)
  const outer = f(zone.radius)
  const inner = f(zone.innerRadius)

  const count = segments * 2
  const positions: Vector3[] = []
  const step = f(TWO_PI / segments)
  let angle = 0

  for (let segment = 0; segment < segments; segment++) {
    const sin = Math.sin(angle)
    const cos = Math.cos(angle)

    const at = (radius: number) => {
      const { x, y, z } = Matrix4.transformPoint(
        { x: f(sin * radius), y: 0, z: f(radius * cos) },
        transform,
      )

      return { x: f(x), y: f(y), z: f(z) }
    }

    positions.push(at(outer), at(inner))
    angle = f(angle + step)
  }

  // Wraps past the last segment back to the first, so the final piece closes the ring.
  const vertex = (index: number) => positions[index >= count ? index - count : index]!

  const color = exterior.color ?? { x: 0, y: 0, z: 0 }
  // `ftol` truncates, and only the low byte is kept.
  const bytes = [color.z, color.y, color.x, opacity].map((c) => Math.trunc(c * 255) & 0xff)
  const [tileV, tileU] = [
    f(exterior.detailTile?.[0] ?? 10),
    Math.trunc(exterior.detailTile?.[1] ?? 2),
  ]

  const span = f(segments / PIECES)
  let end = 0
  let previous = 0
  const pieces: RingPiece[] = []

  for (let index = 0; index < PIECES; index++) {
    // Pieces end at multiples of `segments / 8`, each starting on the last one's end segment.
    end += span

    const first = previous
    const last = Math.trunc(LAST_BIAS + end)

    previous = last

    const corners = Array.from({ length: (last - first + 1) * 2 }, (_, at) =>
      vertex(first * 2 + at),
    )
    const min = { x: Infinity, y: Infinity, z: Infinity }
    const max = { x: -Infinity, y: -Infinity, z: -Infinity }

    for (const point of corners)
      for (const axis of ['x', 'y', 'z'] as const) {
        min[axis] = Math.min(min[axis], point[axis])
        max[axis] = Math.max(max[axis], point[axis])
      }

    const center = {
      x: f((max.x + min.x) * 0.5),
      y: f((max.y + min.y) * 0.5),
      z: f((max.z + min.z) * 0.5),
    }
    const radius = f(Math.hypot(max.x - center.x, max.y - center.y, max.z - center.z))

    const vertices = new Uint8Array(corners.length * STRIDE)
    const floats = new Float32Array(vertices.buffer)

    // Strip order: outer then inner vertex per segment. Per vertex: xyz at byte 0, BGRA at 12, uv0 at
    // 16, uv1 at 24; U flips left/right by segment parity, V top/bottom by outer/inner.
    corners.forEach((point, at) => {
      const segment = first + (at >> 1)
      const odd = (segment & 1) !== 0
      const outerEdge = (at & 1) === 0

      floats.set([point.x, point.y, point.z], (at * STRIDE) / 4)
      vertices.set(bytes, at * STRIDE + 12)
      floats.set(
        [
          odd ? (shape?.u1 ?? 0) : (shape?.u0 ?? 0),
          outerEdge ? (shape?.v0 ?? 0) : (shape?.v1 ?? 0),
          odd ? tileU : 0,
          outerEdge ? 0 : tileV,
        ],
        (at * STRIDE + 16) / 4,
      )
    })

    const mesh: VMeshData = {
      name: `ring piece ${index}`,
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
      boundingBox: { min, max },
      boundingSphere: { center, radius },
    }

    pieces.push({ first, last, center, radius, mesh, reference })
  }

  return {
    pieces,
    zone,
    transitionDistance: f(exterior.transitionDistance ?? 150),
    ...(shape ? { shape } : {}),
    ...(detail ? { detail } : {}),
  }
}

/**
 * `PlanetRing::GetImmersion` (`0x50bd70`): 1 within the band, ramping to 0 over `transition_dist`
 * past its radii and past its height. Retail takes the zone's `size` z as the half height here, so
 * `zone.height` is that value as written.
 */
export const ringImmersion = (
  { zone, transitionDistance }: Pick<PlanetRing, 'zone' | 'transitionDistance'>,
  point: Vector3,
): number => {
  const outer = f(zone.radius)
  const inner = f(zone.innerRadius)
  const half = f(zone.height)
  const outerSquared = f(outer * outer)
  const innerSquared = f(inner * inner)
  const softOuter = f((outer + transitionDistance) * (outer + transitionDistance))
  const softInner = f((inner - transitionDistance) * (inner - transitionDistance))
  const local = Matrix4.transformPoint(point, Matrix4.invert(zoneTransform(zone)))
  const y = Math.abs(local.y)
  let factor = 1

  if (!(y < half)) {
    const ramp = 1 - (y - half) / transitionDistance

    factor = f(ramp)
    if (!(ramp > 0)) return 0
  }

  const radial = local.x * local.x + local.z * local.z
  const radialF = f(radial)

  if (radial > softOuter) return 0
  if (radialF > outerSquared) return ((softOuter - radialF) / (softOuter - outerSquared)) * factor
  if (radialF > innerSquared) return factor
  if (radialF > softInner) return ((radialF - softInner) / (innerSquared - softInner)) * factor
  return 0
}

// `DrawPiece`'s `0x4223d0` and `0x422410` set stage 0's `ADDRESSU` and `ADDRESSV` (13 and 14) to
// clamp, then wrap: the decomp takes them for filters. Stage 1's addressing and both filters are the
// device's as the frame left them: `ring_outside` captures both stages wrapping, linear, mips point.
const RING_SAMPLER: SamplerState = { ...DEFAULT_SAMPLER, wrapU: 'repeat', wrapV: 'repeat' }

const BLACK = { x: 0, y: 0, z: 0 }

/**
 * `DrawPiece` (`0x50b510`): a piece's strip, unlit, in its vertex colour times the shape, the detail
 * doubling it, blended over what's there with `LEQUAL` and no depth writes or culling. Nothing
 * without a shape. Its alpha test and fog are whatever the frame left on: `ring_outside` captures
 * `GREATER 0` and no fog, outside a nebula. In one, the last object's fog may still be on: uncaptured.
 */
export const ringPieceDraw = (ring: PlanetRing, piece: RingPiece): Draw | undefined => {
  const { shape, detail } = ring
  if (!shape) return undefined
  return {
    mesh: piece.mesh,
    reference: piece.reference,
    byteOffset: 0,
    count: piece.reference.indexCount,
    world: Matrix4.identity,
    materialName: 'ring',
    diffuse: [1, 1, 1, 1],
    ambient: BLACK,
    emissive: BLACK,
    colorVertex: true,
    nomad: false,
    texture: { name: shape.texture.name, entry: shape.texture, sampler: RING_SAMPLER, uvSet: 0 },
    ...(detail
      ? {
          second: {
            operation: 'modulate2x' as const,
            texture: {
              name: detail.texture.name,
              entry: detail.texture,
              sampler: RING_SAMPLER,
              uvSet: 1,
            },
          },
        }
      : {}),
    cull: 'none',
    depthWrite: false,
    depthFunc: 'lequal',
    lightless: true,
    negateNormals: false,
    normalizeNormals: false,
    blend: true,
    blendMode: 'alpha',
    unlit: true,
    alphaReference: 0,
    alphaFunction: 'greater',
  }
}
