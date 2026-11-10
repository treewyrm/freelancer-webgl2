import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import { Primitive, type VMeshData, type VMeshRef } from '@treewyrm/freelancer/vmesh'
import type { Camera } from './camera.js'
import {
  closestCubePosition,
  cubeId,
  cubeOrientation,
  entryOrientation,
  fieldCubes,
  mergeCube,
  nearField,
  nearFieldFraction,
  RETAIL_CUBE_ROTATIONS,
  type CubeField,
} from './asteroids.js'
import { zoneOf } from './nebula.js'

test('a cube centres on half a cube either side of zero, as Common snaps it', () => {
  assert.deepEqual(closestCubePosition({ x: 10, y: -10, z: 399 }, 400), { x: 200, y: -200, z: 200 })
  assert.deepEqual(closestCubePosition({ x: 401, y: -401, z: -800 }, 400), {
    x: 600,
    y: -600,
    z: -1000,
  })
})

test("a cube's id packs its grid cell and signs, and is 0 past the grid", () => {
  const id = cubeId({ x: -1000, y: -600, z: -1000 })
  // |x| >> 7 = 7, |y| >> 7 = 4, |z| >> 7 = 7, each with its sign bit.
  assert.equal(id, (((7 | 0x400) << 21) | ((7 | 0x400) << 10) | (4 | 0x200)) >>> 0)
  assert.equal(cubeId({ x: 200000, y: 0, z: 0 }), 0)
})

test("a cube's emptiness and turn are its id's alone, at the frequency asked", () => {
  const id = cubeId({ x: -1000, y: -600, z: -1000 })
  const a = cubeOrientation(id, RETAIL_CUBE_ROTATIONS, 0)!
  const b = cubeOrientation(id, RETAIL_CUBE_ROTATIONS, 0)!
  assert.deepEqual(a, b)
  // A rotation: its columns are unit and square.
  for (const column of [a.x, a.y, a.z])
    assert.ok(Math.abs(Math.hypot(column.x, column.y, column.z) - 1) < 1e-6)
  assert.equal(cubeOrientation(id, RETAIL_CUBE_ROTATIONS, 1), undefined)
  // Over many cubes some are left empty, not all: the ids along one axis differ in high bits only,
  // which the LCG mixes poorly, so the share is retail's, not the frequency itself.
  let empty = 0
  for (let x = 0; x < 1000; x++)
    if (
      !cubeOrientation(cubeId({ x: x * 400 - 199800, y: 200, z: 200 }), RETAIL_CUBE_ROTATIONS, 0.5)
    )
      empty++
  assert.ok(empty > 0 && empty < 1000, `${empty}`)
})

test("an asteroid's turn is about X, then Y, then Z, applied to its vertices", () => {
  const turn = (x: number, y: number, z: number) =>
    Matrix4.transformDirection({ x: 0, y: 0, z: 1 }, entryOrientation(x, y, z))
  // A quarter turn about X takes +Z to -Y.
  const r = turn(90, 0, 0)
  assert.ok(Math.abs(r.y + 1) < 1e-6 && Math.abs(r.z) < 1e-6, JSON.stringify(r))
  // About Y, +Z to +X.
  const s = turn(0, 90, 0)
  assert.ok(Math.abs(s.x - 1) < 1e-6, JSON.stringify(s))
})

const camera: Camera = {
  position: { x: 0, y: 0, z: 0 },
  orientation: Matrix3.identity,
  fovh: 35,
  near: 3,
  far: 21000,
}

const field = (fields: Partial<CubeField> = {}): CubeField => ({
  zone: zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: -4000 }, radius: 5000 }),
  cubeSize: 400,
  fillDistance: 1650,
  emptyFrequency: 0,
  ...fields,
})

test('the walk is near the field or not at all', () => {
  assert.equal(nearField(field(), { x: 0, y: 0, z: 0 }), true)
  // Past its surface by more than (cube + fill) · 1.74, nothing.
  assert.equal(nearField(field(), { x: 0, y: 0, z: 1000 + 3600 }), false)
  assert.deepEqual(fieldCubes(field(), { ...camera, position: { x: 0, y: 0, z: 9000 } }, 4 / 3), [])
})

test('near_field_fraction is 1 at the surface, 0 a distance past it, and over 1 within', () => {
  // 1000 inside: unclamped, 2.
  assert.equal(nearFieldFraction(field(), { x: 0, y: 0, z: 0 }, 1000), 2)
  assert.equal(nearFieldFraction(field(), { x: 0, y: 0, z: 1000 }, 1000), 1)
  // 250 and 750 past the surface at z 1000.
  assert.equal(nearFieldFraction(field(), { x: 0, y: 0, z: 1250 }, 1000), 0.75)
  assert.equal(nearFieldFraction(field(), { x: 0, y: 0, z: 1750 }, 1000), 0.25)
  assert.equal(nearFieldFraction(field(), { x: 0, y: 0, z: 2001 }, 1000), 0)
  // No distance: (fill + cube) · 1.2, 2460.
  assert.equal(
    nearFieldFraction(field(), { x: 0, y: 0, z: 1000 + 1230 }, 0),
    Math.fround(1 - 1230 / Math.fround(2050 * Math.fround(1.2))),
  )
})

test('cubes fill the view ahead, out to fill_dist, fading over the last half cube', () => {
  // A fill of 1500 reaches 2000 from a point 500 behind the camera: the row at -1400, 1900 deep,
  // is in the last half cube.
  const cubes = fieldCubes(field({ fillDistance: 1500 }), camera, 4 / 3)
  assert.ok(cubes.length > 50, `${cubes.length}`)
  for (const { position, alpha } of cubes) {
    // Ahead, but for the camera's own cube, and no further than the reach.
    assert.ok(position.z < 400, JSON.stringify(position))
    assert.ok(-position.z <= 1500 + 400, JSON.stringify(position))
    assert.ok(alpha > 0 && alpha <= 1)
  }
  assert.ok(cubes.some(({ alpha }) => alpha < 1))
})

test('an exclusion zone takes its cubes, or thins them to its own frequency', () => {
  const hole = zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: -1200 }, radius: 600 })
  const inHole = ({ position: p }: { position: { x: number; y: number; z: number } }) =>
    Math.hypot(p.x, p.y, p.z + 1200) < 600
  assert.ok(fieldCubes(field(), camera, 4 / 3).some(inHole))
  assert.ok(!fieldCubes(field({ exclusions: [{ zone: hole }] }), camera, 4 / 3).some(inHole))
  // Its own frequency of 1 empties them too; of 0, none.
  assert.ok(
    !fieldCubes(field({ exclusions: [{ zone: hole, emptyFrequency: 1 }] }), camera, 4 / 3).some(
      inHole,
    ),
  )
  assert.ok(
    fieldCubes(
      field({ emptyFrequency: 1, exclusions: [{ zone: hole, emptyFrequency: 0 }] }),
      camera,
      4 / 3,
    ).some(inHole),
  )
})

/** One triangle's worth of an asteroid in `format`, each float its vertex and slot. */
const rock = (format: number): { mesh: VMeshData; reference: VMeshRef } => {
  const floats = format === 0x212 ? 10 : 8
  const vertices = new Float32Array(3 * floats).map(
    (_, at) => (at % floats) + Math.floor(at / floats) * 100,
  )
  return {
    mesh: {
      name: 'rock',
      version: 1,
      primitive: Primitive.TriangleList,
      format,
      groups: [{ materialId: 7, vertexStart: 0, vertexEnd: 2, elementCount: 3, padding: 0 }],
      indices: Uint16Array.of(0, 1, 2),
      vertices: new Uint8Array(vertices.buffer),
    } as VMeshData,
    reference: {
      meshId: 0,
      vertexStart: 0,
      vertexCount: 3,
      indexStart: 0,
      indexCount: 3,
      groupStart: 0,
      groupCount: 1,
      boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      center: { x: 0, y: 0, z: 0 },
      radius: 0,
    } as unknown as VMeshRef,
  }
}

test("a cube copies each asteroid as retail's FVF 0x252 does: position, normal, first UV", () => {
  // `Li01_Badlands_Asteroids`: `badlands_large` is 0x212, the rest 0x112.
  const at = { offset: { x: 0, y: 0, z: 0 }, orientation: Matrix4.identity }
  const merged = mergeCube([
    { ...rock(0x212), ...at },
    { ...rock(0x112), ...at },
  ])!
  assert.equal(merged.mesh.format, 0x112)
  const floats = new Float32Array(merged.mesh.vertices.buffer)
  // The 0x212 rock's second UV set (its slots 8 and 9) is dropped.
  assert.deepEqual([...floats.subarray(0, 8)], [0, 1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual([...floats.subarray(8 * 3, 8 * 4)], [0, 1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual([...merged.mesh.indices], [0, 1, 2, 3, 4, 5])
  assert.equal(merged.mesh.groups[0]!.materialId, 7)
})
