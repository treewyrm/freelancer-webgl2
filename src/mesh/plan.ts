/** What a VMesh becomes on the GPU. Pure, no GL. */
import {
  getMapCount,
  getMeshDraw,
  Primitive,
  vertexByteLength,
  VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'

/** Fixed attribute locations, so every program fits every mesh. */
export const ATTRIBUTE_LOCATIONS = { position: 0, normal: 1, diffuse: 2, uv0: 3, uv1: 4 } as const

export type AttributeName = keyof typeof ATTRIBUTE_LOCATIONS

export interface VertexAttribute {
  name: AttributeName
  size: number
  /** `D3DCOLOR` bytes, B G R A: a shader reading `diffuse` wants `.bgra`. */
  normalizedBytes: boolean
  offset: number
}

export interface VertexLayout {
  stride: number
  attributes: VertexAttribute[]
}

/** The FVF's layout: position, normal, point size, diffuse, specular, then UV sets. */
export const vertexLayout = (format: VertexFormat): VertexLayout => {
  const attributes: VertexAttribute[] = []
  let offset = 0
  const add = (name: AttributeName, size: number, normalizedBytes = false) => {
    attributes.push({ name, size, normalizedBytes, offset })
    offset += normalizedBytes ? size : size * 4
  }

  if (format & VertexFormat.Position) add('position', 3)
  if (format & VertexFormat.Normal) add('normal', 3)
  // Neither occurs in retail, and no material reads them, but they take up room in the stride.
  if (format & VertexFormat.PointSize) offset += 4
  if (format & VertexFormat.Diffuse) add('diffuse', 4, true)
  if (format & VertexFormat.Specular) offset += 4

  const maps = getMapCount(format)
  for (let map = 0; map < maps; map++) {
    if (map < 2) add(map === 0 ? 'uv0' : 'uv1', 2)
    else offset += 8
  }

  return { stride: vertexByteLength(format), attributes }
}

const MODES: Partial<Record<Primitive, GLenum>> = {
  [Primitive.PointList]: 0,
  [Primitive.LineList]: 1,
  [Primitive.LineStrip]: 3,
  [Primitive.TriangleList]: 4,
  [Primitive.TriangleStrip]: 5,
  [Primitive.TriangleFan]: 6,
}

/** The `drawElements` mode: the game passes the primitive through unexamined. */
export const drawMode = (primitive: Primitive): GLenum => {
  const mode = MODES[primitive]
  if (mode === undefined) throw new RangeError(`Mesh has no primitive type: ${primitive}`)
  return mode
}

export interface GroupDraw {
  /** CRC of the material name. */
  materialId: number
  /** Into the reference's index buffer. */
  byteOffset: number
  count: number
}

export interface ReferencePlan {
  /** Absolute vertices, since WebGL2 has no base vertex parameter. */
  indices: Uint16Array
  groups: GroupDraw[]
}

/**
 * A reference's indices made absolute, one buffer per reference. Retail keeps `ref.vertexStart` as
 * `BaseVertexIndex`, with `group.vertexStart` already added to its indices (`li_elite`, draw 7).
 */
export const planReference = (data: VMeshData, reference: VMeshRef): ReferencePlan => {
  const draws = [...getMeshDraw(data, reference)]
  const indices = new Uint16Array(
    draws.reduce((total, { elementCount }) => total + elementCount, 0),
  )
  const groups: GroupDraw[] = []

  let written = 0
  for (const { materialId, startIndex, elementCount, baseVertex } of draws) {
    groups.push({
      materialId,
      byteOffset: written * Uint16Array.BYTES_PER_ELEMENT,
      count: elementCount,
    })
    for (let at = 0; at < elementCount; at++)
      indices[written++] = data.indices[startIndex + at]! + baseVertex
  }

  return { indices, groups }
}
