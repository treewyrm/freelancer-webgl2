/** The one patch a `.sph` draws six times, turned: `FSphereMaterialSlot::Tessellate`. Pure, no GL. */
import {
  Primitive,
  type VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'

export interface SpherePatch {
  mesh: VMeshData
  reference: VMeshRef
}

// FVF 0x112, as `FSphereAnim::Init` sets it.
const STRIDE_FLOATS = 8

// Past this a patch outgrows 16-bit indices, which retail's maximum of 10 never nears.
const MAXIMUM_LEVEL = 14

/**
 * The `+Z` face, S along +X and T along +Y, in rows from T = 0. Retail lerps normalized corners and
 * normalizes again, which comes to `normalize(2S - 1, 2T - 1, 1)` before float rounding.
 */
const writeVertices = (radius: number, cells: number, odd: boolean): Float32Array => {
  const rows = odd ? 2 * cells + 1 : cells + 1
  const data: number[] = []
  for (let row = 0; row < rows; row++) {
    const t = row / (rows - 1)
    const shifted = odd && row % 2 === 1
    const columns = shifted ? cells : cells + 1
    for (let column = 0; column < columns; column++) {
      const s = (shifted ? column + 0.5 : column) / cells
      const x = 2 * s - 1
      const y = 2 * t - 1
      const scale = 1 / Math.hypot(x, y, 1)
      const nx = Math.fround(x * scale)
      const ny = Math.fround(y * scale)
      const nz = Math.fround(scale)
      data.push(nx * radius, ny * radius, nz * radius, nx, ny, nz, s, t)
    }
  }
  return new Float32Array(data)
}

/** An even level: two triangles a cell, the diagonal alternating (`0x6c2d1a2`). */
const evenIndices = (cells: number): number[] => {
  const width = cells + 1
  const indices: number[] = []
  for (let row = 0; row < cells; row++)
    for (let column = 0; column < cells; column++) {
      const p = row * width + column
      const q = p + width
      if ((row + column) % 2 !== 0) indices.push(p, p + 1, q, p + 1, q + 1, q)
      else indices.push(p, q + 1, q, p, p + 1, q + 1)
    }
  return indices
}

/** An odd level: four triangles a cell, round the vertex at its centre (`0x6c2cd10`). */
const oddIndices = (cells: number): number[] => {
  const width = cells + 1
  const stride = 2 * cells + 1
  const indices: number[] = []
  for (let row = 0; row < cells; row++)
    for (let column = 0; column < cells; column++) {
      const a = row * stride + column
      const m = a + width
      const c = a + stride
      indices.push(a, a + 1, m, a + 1, c + 1, m, c + 1, c, m, c, a, m)
    }
  return indices
}

const buildPatch = (radius: number, level: number): SpherePatch => {
  // Level 2n and 2n + 1 share a grid of 2^n cells; odd adds each cell's centre. `2^level * 2` triangles.
  const cells = 1 << (level >> 1)
  const odd = level % 2 !== 0
  const vertices = writeVertices(radius, cells, odd)
  const indices = odd ? oddIndices(cells) : evenIndices(cells)
  const vertexCount = vertices.length / STRIDE_FLOATS
  const corner = radius * Math.SQRT1_2
  return {
    mesh: {
      name: `sphere ${radius} ${level}`,
      version: 1,
      primitive: Primitive.TriangleList,
      format: 0x112 as VertexFormat,
      groups: [
        {
          materialId: 0,
          vertexStart: 0,
          vertexEnd: vertexCount - 1,
          elementCount: indices.length,
          padding: 0,
        },
      ],
      indices: new Uint16Array(indices),
      vertices: new Uint8Array(vertices.buffer),
    },
    reference: {
      meshId: 0,
      vertexStart: 0,
      vertexCount,
      indexStart: 0,
      indexCount: indices.length,
      groupStart: 0,
      groupCount: 1,
      boundingBox: {
        min: { x: -corner, y: -corner, z: radius * Math.sqrt(1 / 3) },
        max: { x: corner, y: corner, z: radius },
      },
      boundingSphere: { center: { x: 0, y: 0, z: 0 }, radius },
    },
  }
}

const patches = new Map<string, SpherePatch>()

/**
 * The patch at a radius and level. Vertices hold the radius, since a world scale would scale normals.
 * The same object comes back each time, so a renderer's buffers for it are shared between spheres.
 */
export const spherePatch = (radius: number, level: number): SpherePatch => {
  if (!Number.isInteger(level) || level < 0 || level > MAXIMUM_LEVEL)
    throw new RangeError(`Sphere level must be an integer in 0..${MAXIMUM_LEVEL}, not ${level}`)
  const key = `${radius}/${level}`
  let patch = patches.get(key)
  if (!patch) {
    patch = buildPatch(radius, level)
    patches.set(key, patch)
  }
  return patch
}
