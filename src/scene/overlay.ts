/**
 * A nebula's fog overlay: `FNebulaEffect::DrawFogOverlay` (`LAB_00508b00`, `cli_nebula.cpp`). Inside
 * a field, after the main lists, one quad over the viewport in the fog's colour, as opaque as the
 * camera is deep, so what lies outside the nebula fades to its fog. Pure, no GL.
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import {
  Primitive,
  setMapCount,
  VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import type { Draw } from './frame.js'
import type { NebulaState, SpaceNebula } from './nebula.js'

const f = Math.fround

// XYZ, D3DCOLOR and one UV set: Win3D's FVF 0x142, 24 bytes. The UVs are stale in retail; unread.
const FORMAT = setMapCount(VertexFormat.Position | VertexFormat.Diffuse, 1)
const STRIDE = 24
const BLACK: Vector3 = { x: 0, y: 0, z: 0 }

// `ScaleClampToByte`: times 255, truncated, held to a byte.
const byte = (value: number): number => Math.min(Math.max(Math.trunc(f(value * 255)), 0), 255)

/**
 * `+0x2b8`, per nebula: set on the frame the camera's depth reaches 1, which still draws, and cleared
 * once it's under 1 again. While set, no overlay. Kept here as retail keeps it on the nebula.
 */
const latched = new WeakMap<SpaceNebula, boolean>()

/**
 * The overlay for a frame in a field, or nothing: none at a depth of 0 or less, nor past the frame
 * that reached 1. The quad runs from the viewport's corner to its last pixel, `0` to `width - 1`
 * (`GetViewport`'s rectangle ends on it), under `Win3DSetOrtho2DForCamera`, so retail leaves the
 * last column and row bare. Without a viewport it covers the whole view. Untextured (`0xde1` off),
 * blended, with no depth test or writes and no culling; `ALPHAREF` is the frame's, 0 as captured.
 */
export const fogOverlayDraw = (
  { nebula, depth }: NebulaState,
  view: Matrix4,
  viewport?: { width: number; height: number },
): Draw | undefined => {
  if (depth < 1) latched.set(nebula, false)
  if (!(depth < 1) && latched.get(nebula)) return undefined
  if (!(depth > 0)) return undefined
  if (depth >= 1) latched.set(nebula, true)

  const { color } = nebula.fog
  const bytes = [byte(color.z), byte(color.y), byte(color.x), byte(depth)]
  // In clip space: the ortho's x · 2 / width - 1 and 1 - y · 2 / height.
  const right = viewport ? f(f(viewport.width - 1) * (2 / viewport.width) - 1) : 1
  const bottom = viewport ? f(1 - f(viewport.height - 1) * (2 / viewport.height)) : -1
  const corners = [
    [-1, 1],
    [right, 1],
    [right, bottom],
    [-1, bottom],
  ]
  const vertices = new Uint8Array(corners.length * STRIDE)
  const floats = new Float32Array(vertices.buffer)
  corners.forEach(([x, y], at) => {
    floats.set([x!, y!, 0], (at * STRIDE) / 4)
    vertices.set(bytes, at * STRIDE + 12)
  })
  const mesh: VMeshData = {
    name: 'fog overlay',
    version: 1,
    primitive: Primitive.TriangleList,
    format: FORMAT,
    groups: [{ materialId: 0, vertexStart: 0, vertexEnd: 3, elementCount: 6, padding: 0 }],
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    vertices,
  }
  const reference: VMeshRef = {
    meshId: 0,
    vertexStart: 0,
    vertexCount: 4,
    indexStart: 0,
    indexCount: 6,
    groupStart: 0,
    groupCount: 1,
    boundingBox: { min: BLACK, max: BLACK },
    boundingSphere: { center: BLACK, radius: 0 },
  }
  return {
    mesh,
    reference,
    byteOffset: 0,
    count: 6,
    // Its corners are in clip space: the host's view is undone by `world`, the projection is none.
    world: Matrix4.invert(view),
    projection: Matrix4.identity,
    materialName: 'fog overlay',
    diffuse: [1, 1, 1, 1],
    ambient: BLACK,
    emissive: BLACK,
    colorVertex: true,
    nomad: false,
    cull: 'none',
    depthWrite: false,
    depthFunc: 'always',
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
