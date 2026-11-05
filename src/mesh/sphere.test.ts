import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planReference, vertexLayout } from './plan.js'
import { spherePatch } from './sphere.js'

const floats = (level: number, radius = 1): Float32Array => {
  const { vertices } = spherePatch(radius, level).mesh
  return new Float32Array(vertices.buffer, vertices.byteOffset, vertices.byteLength / 4)
}

test('each level has the vertices and triangles retail allocates', () => {
  // `UpdateLevel`'s count, and `Tessellate`'s `(1 << Level) * 12` bytes of indices.
  for (const [level, vertices] of [
    [3, 13],
    [4, 25],
    [5, 41],
    [6, 81],
    [7, 145],
    [8, 289],
    [9, 545],
    [10, 1089],
  ] as const) {
    const { mesh, reference } = spherePatch(1000, level)
    assert.equal(reference.vertexCount, vertices)
    assert.equal(mesh.indices.length, 2 ** level * 6)
    assert.equal(reference.indexCount, mesh.indices.length)
    assert.equal(mesh.groups[0]!.vertexEnd, vertices - 1)
    assert.equal(Math.max(...mesh.indices), vertices - 1)
  }
})

test('an even level alternates its diagonal, and an odd one fans round each centre', () => {
  // Hand-worked from `Tessellate`, width 3 and 5. The capture holds the same at levels 8 and 5.
  assert.deepEqual(
    [...spherePatch(1, 2).mesh.indices],
    [0, 4, 3, 0, 1, 4, 1, 2, 4, 2, 5, 4, 3, 4, 6, 4, 7, 6, 4, 8, 7, 4, 5, 8],
  )
  assert.deepEqual(
    [...spherePatch(1, 3).mesh.indices.slice(0, 12)],
    [0, 1, 3, 1, 6, 3, 6, 5, 3, 5, 0, 3],
  )
})

test('vertices lie on the sphere, the normal is the unit position, and S and T run +X and +Y', () => {
  const stride = vertexLayout(spherePatch(1, 4).mesh.format).stride / 4
  assert.equal(stride, 8)
  for (const level of [3, 4, 9]) {
    const data = floats(level, 200)
    for (let at = 0; at < data.length; at += stride) {
      const [x, y, z, nx, ny, nz, s, t] = data.slice(at, at + stride) as unknown as number[]
      assert.ok(Math.abs(Math.hypot(x!, y!, z!) - 200) < 1e-3)
      assert.ok(Math.abs(Math.hypot(nx!, ny!, nz!) - 1) < 1e-6)
      assert.ok(Math.abs(x! - nx! * 200) < 1e-3)
      // The gnomonic grid: uniform on the cube, not on the sphere.
      assert.ok(Math.abs(x! / z! - (2 * s! - 1)) < 1e-5)
      assert.ok(Math.abs(y! / z! - (2 * t! - 1)) < 1e-5)
    }
  }
})

test('every triangle winds outward, as a retail mesh does', () => {
  for (const level of [3, 4, 5, 8]) {
    const { indices } = spherePatch(1, level).mesh
    const data = floats(level)
    const point = (index: number) => [...data.slice(index * 8, index * 8 + 3)] as number[]
    for (let at = 0; at < indices.length; at += 3) {
      const [ax, ay, az] = point(indices[at]!) as [number, number, number]
      const [bx, by, bz] = point(indices[at + 1]!) as [number, number, number]
      const [cx, cy, cz] = point(indices[at + 2]!) as [number, number, number]
      const u = [bx - ax, by - ay, bz - az] as const
      const v = [cx - ax, cy - ay, cz - az] as const
      const normal = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
      ]
      assert.ok(normal[0]! * ax + normal[1]! * ay + normal[2]! * az > 0)
    }
  }
})

test('the same radius and level are the same object, so buffers are shared', () => {
  assert.equal(spherePatch(1000, 5), spherePatch(1000, 5))
  assert.notEqual(spherePatch(1000, 5), spherePatch(1000, 6))
  assert.notEqual(spherePatch(1000, 5), spherePatch(2000, 5))
})

test('a patch plans like any mesh', () => {
  const { mesh, reference } = spherePatch(1, 5)
  const { indices, groups } = planReference(mesh, reference)
  assert.deepEqual(indices, mesh.indices)
  assert.deepEqual(groups, [{ materialId: 0, byteOffset: 0, count: 192 }])
})

test('a level that cannot index or is no level throws', () => {
  assert.throws(() => spherePatch(1, 15), RangeError)
  assert.throws(() => spherePatch(1, 2.5), RangeError)
})
