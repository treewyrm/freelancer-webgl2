/**
 * A sun: a solar's `star`, a `[star]` of `solar\StarArch.ini`. `FStarSphere` in
 * `src/freelancer/Client/star_sphere.cpp`, whose name is the decomp's: it is no sky. Its `star_glow`
 * and `star_center` are fans turned to the camera (`DrawBillboard`, `0x5118d0`, and `FUN_0050cd50`),
 * drawn as the solar's own draw in the lists (`FClientSolarGameobj::Slot188`) and again in a field.
 * Pure, no GL.
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
import type { LensGlow, StarLensFlare, StarSpines } from './corona.js'
import { textureHasAlpha } from './exterior.js'
import type { Draw } from './frame.js'
import type { TextureShape } from './ring.js'

const f = Math.fround

/** A `[star_glow]`, over `FStarSphere`'s defaults. `star_glow` and `star_center` both name one. */
export interface StarGlow {
  /** `shape`, a `tex_shape` of `StarArch.ini`'s `[Texture]`. Nothing draws without one. */
  shape?: TextureShape
  /** `scale`, 1 when absent: times the star's `radius`, half the fan's width. */
  scale?: number
  /** `inner_color`, at the fan's centre. White when absent; each is held to 1 as it's drawn. */
  innerColor?: Vector3
  /** `outer_color`, at its rim. White when absent. */
  outerColor?: Vector3
}

/**
 * A `[star]`, which the host reads (`FStarSphere::Load`, `0x511020`). Its `alpha` keys, its
 * `star_glow`'s included, are read and never used: the fans take their alpha from the caller.
 */
export interface Star {
  /** `radius`, 1000 when absent. */
  radius?: number
  /**
   * `star_glow`: the first of the section's `star_glow` keys that names a `[star_glow]`. With none,
   * the defaults: no shape, so nothing draws, but its scale of 1 still sizes the star.
   */
  glow?: StarGlow
  /** `star_center`: the last key's, and none when that names no `[star_glow]`. */
  center?: StarGlow
  /** `lens_glow`: the first that names a `[lens_glow]`. Its defaults when none does. */
  lensGlow?: LensGlow
  /** `spines`: the first that names a `[spines]`. None when none does. */
  spines?: StarSpines
  /** `lens_flare`: the first that names a `[lens_flare]`. None when none does. */
  lensFlare?: StarLensFlare
  /**
   * `+0x20` and `+0x24`, 1 s each when absent: how fast the flare follows what the corona shows.
   * `intensity_fade_in` and `_out` write them, a 0 as 1e-7, but so do `zone_occlusion_fade_in` and
   * `_out`, unheld (`0x511381`, `0x5113b7`): whichever comes last in the section wins.
   */
  intensityFade?: { fadeIn?: number; fadeOut?: number }
  /**
   * `+0x28` and `+0x2c`, 2 s each when absent: how fast a zone between hides it. No key reaches them
   * in retail, which a mod's patch could.
   */
  zoneOcclusionFade?: { fadeIn?: number; fadeOut?: number }
}

/** `StarSphereMaxGlowScale` (`0x512620`): the solar's sphere, `Slot178`'s radius about its position. */
export const starRadius = ({ radius = 1000, glow, center }: Star): number => {
  const glowScale = f(glow?.scale ?? 1)
  const centerScale = f(center ? (center.scale ?? 1) : 0)
  return f((centerScale > glowScale ? centerScale : glowScale) * f(radius))
}

// XYZ, D3DCOLOR and one UV set: Win3D's FVF 0x142, 24 bytes.
const FORMAT = setMapCount(VertexFormat.Position | VertexFormat.Diffuse, 1)
const STRIDE = 24
const BLACK: Vector3 = { x: 0, y: 0, z: 0 }
const WHITE: Vector3 = { x: 1, y: 1, z: 1 }

// `ScaleClampToByte`: times 255 on the FPU, truncated, held to a byte.
const byte = (value: number): number => Math.min(Math.max(Math.trunc(value * 255), 0), 255)

const add = (a: Vector3, b: Vector3): Vector3 => ({
  x: f(a.x + b.x),
  y: f(a.y + b.y),
  z: f(a.z + b.z),
})
const sub = (a: Vector3, b: Vector3): Vector3 => ({
  x: f(a.x - b.x),
  y: f(a.y - b.y),
  z: f(a.z - b.z),
})
const scaled = ({ x, y, z }: Vector3, by: number): Vector3 => ({
  x: f(x * by),
  y: f(y * by),
  z: f(z * by),
})

/**
 * `FUN_0050cd50`: a fan of eight triangles about the centre, through each corner and edge midpoint,
 * the inner colour at the centre and the outer at the rim. A texture with alpha blends by it,
 * one without as `ONE, INVSRCCOLOR` (`0x50cd6e`).
 */
const glowDraw = (
  { shape, scale = 1, innerColor = WHITE, outerColor = WHITE }: StarGlow,
  position: Vector3,
  size: number,
  right: Vector3,
  up: Vector3,
  alpha: number,
  projection: Matrix4,
): Draw | undefined => {
  if (!shape) return undefined
  const across = scaled(scaled(right, size), f(scale))
  const over = scaled(scaled(up, size), f(scale))
  // Top left, top right, bottom right, bottom left (`0x50ce2d` on).
  const c0 = add(sub(position, across), over)
  const c1 = add(add(position, across), over)
  const c2 = sub(add(position, across), over)
  const c3 = sub(sub(position, across), over)
  const centre = scaled(add(add(add(c0, c1), c2), c3), 0.25)
  const half = (a: Vector3, b: Vector3) => scaled(add(a, b), 0.5)
  const { u0, v0, u1, v1 } = shape
  const um = f(f(u0 + u1) * 0.5)
  const vm = f(f(v0 + v1) * 0.5)
  const fan: [Vector3, number, number][] = [
    [centre, um, vm],
    [c0, u0, v0],
    [half(c1, c0), um, v0],
    [c1, u1, v0],
    [half(c2, c1), u1, vm],
    [c2, u1, v1],
    [half(c3, c2), um, v1],
    [c3, u0, v1],
    [half(c3, c0), u0, vm],
    [c0, u0, v0],
  ]
  const a = byte(alpha)
  const inner = [byte(innerColor.z), byte(innerColor.y), byte(innerColor.x), a]
  const outer = [byte(outerColor.z), byte(outerColor.y), byte(outerColor.x), a]

  const vertices = new Uint8Array(fan.length * STRIDE)
  const floats = new Float32Array(vertices.buffer)
  fan.forEach(([{ x, y, z }, u, v], index) => {
    floats.set([x, y, z], (index * STRIDE) / 4)
    vertices.set(index === 0 ? inner : outer, index * STRIDE + 12)
    floats.set([u, v], (index * STRIDE + 16) / 4)
  })
  const count = fan.length
  const mesh: VMeshData = {
    name: 'star glow',
    version: 1,
    primitive: Primitive.TriangleFan,
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
    byteOffset: 0,
    count,
    // In world space, under the camera's own view (`Win3DApplyCamera`).
    world: Matrix4.identity,
    projection,
    materialName: 'star glow',
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
    blendMode: textureHasAlpha(shape.texture) ? 'alpha' : 'screen',
    unlit: true,
    // What the frame left. Taken as `GREATER 0`, as the fill sheets are. **Uncaptured.**
    alphaReference: 0,
    alphaFunction: 'greater',
  }
}

/**
 * `FStarSphere::DrawBillboard` (`0x5118d0`): the star's `star_glow`, then its `star_center` at
 * `alpha` squared, each a square of `radius × size × scale` across, turned to face the camera about
 * its up. Unlit, unculled, with no depth test or writes, under `projection`: the camera's own, its far
 * plane at 250000. The solar's own draw gives an `alpha` and `size` of 1 (`DrawSimple`).
 */
export const starGlowDraws = (
  star: Star,
  position: Vector3,
  camera: Camera,
  projection: Matrix4,
  alpha = 1,
  size = 1,
): Draw[] => {
  const { position: eye, orientation } = camera
  // From the camera to the star, z rounded to a float before it's squared (`0x511970`).
  const dx = position.x - eye.x
  const dy = position.y - eye.y
  const dz = position.z - eye.z
  const dzf = f(dz)
  const inverse = f(1 / Math.sqrt(dz * dzf + dy * dy + dx * dx))
  const dir = { x: f(dx * inverse), y: f(dy * inverse), z: f(dzf * inverse) }

  // Across: the way to it crossed with the camera's up, `(m[1], m[4], m[7])`; z unrounded.
  const upX = orientation.x.y
  const upY = orientation.y.y
  const upZ = orientation.z.y
  const rx = f(dir.y * upZ - upY * dir.z)
  const ry = f(dir.z * upX - upZ * dir.x)
  const rz = upY * dir.x - dir.y * upX
  const across = 1 / Math.sqrt(rz * rz + ry * ry + rx * rx)
  const right = { x: f(rx * across), y: f(ry * across), z: f(rz * across) }
  // Up: across crossed with the way to it.
  const up = {
    x: f(right.y * dir.z - right.z * dir.y),
    y: f(right.z * dir.x - dir.z * right.x),
    z: f(dir.y * right.x - right.y * dir.x),
  }

  const scale = f((star.radius ?? 1000) * size)
  const draws: Draw[] = []
  const glow = glowDraw(star.glow ?? {}, position, scale, right, up, alpha, projection)
  if (glow) draws.push(glow)
  if (star.center) {
    const centre = glowDraw(star.center, position, scale, right, up, f(alpha * alpha), projection)
    if (centre) draws.push(centre)
  }
  return draws
}
