/**
 * A room's blob shadows: `DrawShadowLike` (`FLAppearance.cpp`, `src/flmaterials/`), the `efxshadow`
 * quad that `RoomControlDrawShadow` (`FUN_0044b370`) lays on the floor under a character, a ship or a
 * type-5 prop, just before the object draws. Pure, no GL.
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import { setMapCount, VertexFormat, Primitive, type VMeshData } from '@treewyrm/freelancer/vmesh'
import { DEFAULT_SAMPLER } from '#/texture/texture.js'
import type { Draw } from './frame.js'
import type { Fog } from './nebula.js'

export interface RoomShadow {
  /**
   * A ship's or a type-5 prop's (`DrawFadingShadows`, slot 11): it fades and grows with height, and
   * takes its box. Else a character's (`DrawFixedShadows`, slot 12): a fixed size and darkness, under
   * a point just behind it.
   */
  fading: boolean
  /** `Float1C`, the floor's height: where the quad lies. A prop's is 0. */
  floor: number
  /** The instance's world, whose position it's under and whose Z axis turns it. */
  world: Matrix4
  /**
   * Fading only: the box `IRenderer::GetBounds` gives at 1.0 for the instance's archetype. Which part
   * of a compound answers is unread. Without it, as for an instance with no archetype, the
   * character's small box.
   */
  bounds?: { min: Vector3; max: Vector3 }
}

/** What `DrawShadowLike` hardcodes (`DAT_06704064..90`), and a mod can patch. */
export interface ShadowLimits {
  /** The small box: half its width in X and Z, and what a fixed shadow lifts its quad by. */
  extentX: number
  extentZ: number
  lift: number
  /** How far along its Z axis a fixed shadow sits: behind, as it's negative. */
  offset: number
  /** Above this height over the floor, no shadow; heights are fractions of it. */
  fadeRange: number
  /** A fading quad's scale: `fadeQuad × fade² + scaleBias`. */
  fadeQuad: number
  scaleBias: number
  /** A fading shadow's alpha is this less the fade, a fixed one's `fixedAlpha`; the colour's is its square. */
  fadeAlpha: number
  fixedAlpha: number
}

export const RETAIL_SHADOW_LIMITS: Readonly<ShadowLimits> = {
  extentX: 0.28,
  extentZ: 0.24,
  lift: 0.05,
  offset: -0.1,
  fadeRange: 50,
  fadeQuad: 4,
  scaleBias: 0.8,
  fadeAlpha: 0.8,
  fixedAlpha: 0.6,
}

/** One quad: its corners, each `[x, y, z, u, v]`, and the vertex alpha, of 255. */
export interface ShadowQuad {
  corners: [number, number, number, number, number][]
  alpha: number
}

const f = Math.fround

/**
 * One shadow's quad, and the scale it leaves. `DAT_06704078` is a global that only a fading shadow
 * sets, so a fixed one takes whatever the last fading one left, in this frame or an earlier one.
 */
export const shadowQuad = (
  { fading, floor, world, bounds }: RoomShadow,
  scale: number,
  limits: ShadowLimits = RETAIL_SHADOW_LIMITS,
): { quad?: ShadowQuad; scale: number } => {
  const { z: axis, w: position } = world
  let x = position.x
  let y = position.y
  let z = position.z
  // [max x, min x, max y, min y, max z, min z], as `GetBounds` writes it.
  let extents: number[]

  if (fading && bounds) {
    const { min, max } = bounds

    extents = [max.x, min.x, max.y, min.y, max.z, min.z]
  } else {
    const { extentX, extentZ, lift, offset } = limits

    extents = [f(extentX), f(-extentX), 0, f(lift), f(extentZ), f(-extentZ)]
    x = f(f(f(offset) * axis.x) + x)
    y = f(f(f(offset) * axis.y) + y)
    z = f(f(f(offset) * axis.z) + z)
  }

  // Slot 12's third flag: a fixed quad is lifted.
  const height = fading ? f(floor) : f(floor + extents[3]!)
  let fade = y - height
  if (fade < 0) fade = 0

  const range = f(limits.fadeRange)
  if (fade > range) return { scale }
  fade /= range
  if (fading) scale = f(fade * fade * f(limits.fadeQuad) + limits.scaleBias)

  let alpha = f(limits.fixedAlpha)

  if (fading) {
    alpha = f(limits.fadeAlpha) - fade
    if (alpha < 0) return { scale }
    if (alpha > 1) alpha = 1
  }

  if (!(alpha > 0)) return { scale }

  // Yaw of the instance's Z axis. Corners are centre ± A ± B in XZ, A = (hx, -hy) the width and
  // B = (zy, zx) the depth: perpendicular, both turned by the yaw and scaled.
  const angle = Math.atan2(axis.x, axis.z)
  const sin = Math.sin(angle) * scale
  const cos = Math.cos(angle) * scale
  // Each width is the whole box's, so the quad is twice its size.
  const widthX = extents[0]! - extents[1]!
  const widthZ = f(extents[4]! - extents[5]!)
  const centerX = f(0.5 * widthX + extents[1]! + x)
  const centerZ = f(widthZ * 0.5 + extents[5]! + z)
  const hx = f(widthX * cos)
  const hy = f(widthX * sin)
  const zx = f(widthZ * cos)
  const zy = f(widthZ * sin)
  const left = f(centerX - hx)
  const back = centerZ - hy

  return {
    scale,
    quad: {
      alpha: Math.trunc(alpha * alpha * 255),
      corners: [
        [f(left + zy), height, f(zx + hy + centerZ), 0, 0],
        [f(left - zy), height, f(hy + centerZ - zx), 0, 1],
        [f(hx + centerX - zy), height, f(back - zx), 1, 1],
        [f(zy + hx + centerX), height, f(f(back) + zx), 1, 0],
      ],
    },
  }
}

// XYZ, D3DCOLOR and one UV set: FVF 0x142, 24 bytes.
const FORMAT = setMapCount(VertexFormat.Position | VertexFormat.Diffuse, 1)
const STRIDE = 24
const BLACK: Vector3 = { x: 0, y: 0, z: 0 }
// The expander's `(0, 1, 2)` then `(3, 0, 2)`.
const ORDER = [0, 1, 2, 3, 0, 2]

/**
 * The quad as `DrawShadowLike` states it: lighting off, the texture times white at the quad's alpha,
 * blended, `LEQUAL`, no culling, no depth written, `ZBIAS` 4. The alpha test and fog are the device's
 * as the last object left them; the fog is passed, the test is taken as off: uncaptured.
 */
export const shadowDraw = ({ corners, alpha }: ShadowQuad, texture: Texture, fog?: Fog): Draw => {
  const vertices = new Uint8Array(ORDER.length * STRIDE)
  const floats = new Float32Array(vertices.buffer)

  ORDER.forEach((corner, at) => {
    const [x, y, z, u, v] = corners[corner]!

    floats.set([x, y, z], (at * STRIDE) / 4)
    vertices.set([255, 255, 255, alpha], at * STRIDE + 12)
    floats.set([u, v], (at * STRIDE + 16) / 4)
  })

  const count = ORDER.length
  const mesh: VMeshData = {
    name: 'efxshadow',
    version: 1,
    primitive: Primitive.TriangleList,
    format: FORMAT,
    groups: [
      { materialId: 0, vertexStart: 0, vertexEnd: count - 1, elementCount: count, padding: 0 },
    ],
    indices: Uint16Array.from({ length: count }, (_, at) => at),
    vertices,
  }

  return {
    mesh,
    reference: {
      meshId: 0,
      vertexStart: 0,
      vertexCount: count,
      indexStart: 0,
      indexCount: count,
      groupStart: 0,
      groupCount: 1,
      boundingBox: { min: BLACK, max: BLACK },
      boundingSphere: { center: BLACK, radius: 0 },
    },
    transient: true,
    byteOffset: 0,
    count,
    world: Matrix4.identity,
    materialName: 'efxshadow',
    diffuse: [1, 1, 1, 1],
    ambient: BLACK,
    emissive: BLACK,
    colorVertex: true,
    nomad: false,
    texture: { name: 'efxshadow', entry: texture, sampler: DEFAULT_SAMPLER, uvSet: 0 },
    cull: 'none',
    depthWrite: false,
    depthFunc: 'lequal',
    depthBias: 4,
    lightless: true,
    negateNormals: false,
    normalizeNormals: false,
    blend: true,
    blendMode: 'alpha',
    unlit: true,
    alphaReference: 0,
    alphaFunction: 'always',
    ...(fog && { fog }),
  }
}
