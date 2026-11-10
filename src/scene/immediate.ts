/**
 * A frame's own triangles of code-built effects, as D3D's FVF `0x142` (XYZ, D3DCOLOR, one UV) holds
 * them: world-placed, unlit, the texture times each vertex's colour, added, unculled, `LEQUAL` and no
 * depth writes. The shots' batch and a tractor's lines are drawn so. Pure, no GL.
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
import type { Draw } from './frame.js'
import type { Fog } from './nebula.js'
import { DEFAULT_SAMPLER, type SamplerState } from '#/texture/texture.js'

/** Vertices as `x, y, z, u, v`, colours as D3D's bytes `b, g, r, a`, and triangles. */
export interface ImmediateBatch {
  vertices: number[]
  colors: number[]
  indices: number[]
  count: number
}

const FORMAT = setMapCount(VertexFormat.Position | VertexFormat.Diffuse, 1)
const STRIDE = 24
const ORIGIN: Vector3 = { x: 0, y: 0, z: 0 }

// Left as Alchemy's `BeginDraw` set it, the last before either, which set none. Captured for the
// shots in `beam_shots`: clamped, linear, mips by nearest.
const IMMEDIATE_SAMPLER: SamplerState = { ...DEFAULT_SAMPLER, wrapU: 'clamp', wrapV: 'clamp' }

/**
 * One draw of a batch, at the texture's first frame. The fog is the effects', black in a nebula; the
 * alpha test is inherited, `GREATER 0`, captured for the shots in `beam_shots`. Nothing with
 * nothing built.
 */
export const immediateDraw = (
  name: string,
  { count, vertices: built, colors, indices }: ImmediateBatch,
  texture: Texture,
  fog?: Fog,
): Draw | undefined => {
  if (!indices.length) return undefined
  const vertices = new Uint8Array(count * STRIDE)
  const floats = new Float32Array(vertices.buffer)
  for (let at = 0; at < count; at++) {
    floats.set(built.slice(at * 5, at * 5 + 3), (at * STRIDE) / 4)
    vertices.set(colors.slice(at * 4, at * 4 + 4), at * STRIDE + 12)
    floats.set(built.slice(at * 5 + 3, at * 5 + 5), (at * STRIDE + 16) / 4)
  }
  const mesh: VMeshData = {
    name,
    version: 1,
    primitive: Primitive.TriangleList,
    format: FORMAT,
    groups: [
      {
        materialId: 0,
        vertexStart: 0,
        vertexEnd: count - 1,
        elementCount: indices.length,
        padding: 0,
      },
    ],
    indices: Uint16Array.from(indices),
    vertices,
  }
  const reference: VMeshRef = {
    meshId: 0,
    vertexStart: 0,
    vertexCount: count,
    indexStart: 0,
    indexCount: indices.length,
    groupStart: 0,
    groupCount: 1,
    boundingBox: { min: ORIGIN, max: ORIGIN },
    boundingSphere: { center: ORIGIN, radius: 0 },
  }
  return {
    mesh,
    reference,
    transient: true,
    byteOffset: 0,
    count: indices.length,
    world: Matrix4.identity,
    materialName: name,
    diffuse: [1, 1, 1, 1],
    ambient: ORIGIN,
    emissive: ORIGIN,
    colorVertex: true,
    nomad: false,
    texture: { name: texture.name, entry: texture, sampler: IMMEDIATE_SAMPLER, uvSet: 0 },
    cull: 'none',
    depthWrite: false,
    depthFunc: 'lequal',
    lightless: true,
    ...(fog && { fog }),
    negateNormals: false,
    normalizeNormals: false,
    blend: true,
    blendMode: 'add',
    unlit: true,
    alphaReference: 0,
    alphaFunction: 'greater',
  }
}
