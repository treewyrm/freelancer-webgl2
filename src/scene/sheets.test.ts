import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import { nebulaState, zoneOf, type SpaceNebula, type Zone } from './nebula.js'
import { textureShape } from './ring.js'
import { fillSheetsDraw } from './sheets.js'

const texture = { name: 'nebula_circle2', width: 128, height: 128 } as Texture
const fill = textureShape(texture, {})
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 }
const ellipsoid = zoneOf({
  type: 'ellipsoid',
  center: { x: 0, y: 0, z: 0 },
  orientation: IDENTITY,
  radii: { x: 1000, y: 500, z: 400 },
})
const nebulaOf = (zone: Zone, fields: Partial<SpaceNebula> = {}): SpaceNebula => ({
  zone,
  fog: { distance: 300, color: { x: 10 / 255, y: 7 / 255, z: 30 / 255 } },
  fill,
  ...fields,
})
const sheetsFrom = (eye: Vector3, nebula = nebulaOf(ellipsoid)) =>
  fillSheetsDraw(nebulaState(nebula, eye), eye, Matrix4.identity)

const cornersOf = (draw: NonNullable<ReturnType<typeof fillSheetsDraw>>) => {
  const floats = new Float32Array(draw.mesh.vertices.buffer)
  return Array.from({ length: draw.reference.vertexCount }, (_, at) => [
    ...floats.slice(at * 6, at * 6 + 3),
  ])
}
const alphasOf = (draw: NonNullable<ReturnType<typeof fillSheetsDraw>>) =>
  Array.from({ length: draw.reference.vertexCount }, (_, at) => draw.mesh.vertices[at * 24 + 15])
const near = (actual: number[][], expected: number[][]) => {
  assert.equal(actual.length, expected.length)
  actual.forEach((corner, at) =>
    corner.forEach((value, axis) =>
      assert.ok(Math.abs(value - expected[at]![axis]!) < 1e-3, `${at}: ${corner} ${expected[at]}`),
    ),
  )
}

// One Newton step leaves a unit vector 0.17% short (`0x507663`), and an ellipsoid's reach along it
// as much long: 500 · 1.15 is 575.973, 400 · 1.15 is 460.778.
test('looking along z, sheet A stands along x, faces the camera, and reaches 1.15 past', () => {
  const draw = sheetsFrom({ x: 0, y: 0, z: 5000 })!
  // Along its longer of x and z, 1000 · 1.15; across to its surface along y, its first corner on the
  // side of the look from the camera across x. Sheet B, looked along its other axis, is gone.
  near(cornersOf(draw), [
    [-1150, -575.973, 0],
    [1150, -575.973, 0],
    [1150, 575.973, 0],
    [-1150, 575.973, 0],
  ])
  assert.deepEqual(alphasOf(draw), [255, 255, 255, 255])
  assert.deepEqual([...draw.mesh.vertices.slice(12, 16)], [30, 7, 10, 255])
  assert.deepEqual([...draw.mesh.indices], [0, 1, 2, 0, 2, 3])
  const uvs = new Float32Array(draw.mesh.vertices.buffer)
  assert.deepEqual(
    [0, 1, 2, 3].map((at) => [uvs[at * 6 + 4], uvs[at * 6 + 5]]),
    [
      [fill.u0, fill.v0],
      [fill.u1, fill.v0],
      [fill.u1, fill.v1],
      [fill.u0, fill.v1],
    ],
  )
  assert.deepEqual(
    [draw.depthFunc, draw.depthWrite, draw.blend, draw.blendMode, draw.cull, draw.unlit],
    ['always', false, true, 'alpha', 'none', true],
  )
  assert.equal(draw.texture?.name, 'nebula_circle2')
})

test('looking along x, sheet B stands along y, across to the surface along z', () => {
  const draw = sheetsFrom({ x: 5000, y: 0, z: 0 })!
  near(cornersOf(draw).slice(4), [
    [0, -575, -460.778],
    [0, 575, -460.778],
    [0, 575, 460.778],
    [0, -575, 460.778],
  ])
  // Refined by the other axis, it runs past 1, and the byte holds it.
  assert.deepEqual(alphasOf(draw).slice(4), [255, 255, 255, 255])
})

test('looking exactly along its axis, sheet A still draws, from 0/0, as retail does', () => {
  // The look's 0.17% short of 1 leaves (1 - |cos| - 0.0001) · 204 above 0, by how far the camera
  // is. Its edge, the look across its axis, is nothing, and its reach over its length 0/0.
  for (const [x, alpha] of [
    [5000, 65],
    [4096, 82],
  ] as const) {
    const draw = sheetsFrom({ x, y: 0, z: 0 })!
    assert.deepEqual(alphasOf(draw).slice(0, 4), [alpha, alpha, alpha, alpha])
    assert.ok(cornersOf(draw).slice(0, 4).flat().every(Number.isNaN))
  }
})

test('between the axes both show, sheet B fading as the camera comes round to z', () => {
  const eye = { x: 3000, y: 0, z: 3000 }
  const draw = sheetsFrom(eye)!
  assert.equal(draw.reference.vertexCount, 8)
  assert.equal(draw.count, 12)
  const cosine = Math.fround(Math.SQRT1_2)
  const faded = (1 - cosine - Math.fround(0.2)) * 5
  assert.deepEqual(alphasOf(draw), [255, 255, 255, 255, ...Array(4).fill(Math.trunc(faded * 255))])
  assert.deepEqual([...draw.mesh.indices.slice(6)], [4, 5, 6, 4, 6, 7])
})

test('looking down y, sheet B is gone and sheet A crosses along z', () => {
  const draw = sheetsFrom({ x: 0, y: 5000, z: 0 })!
  near(cornersOf(draw), [
    [-1150, 0, 460.778],
    [1150, 0, 460.778],
    [1150, 0, -460.778],
    [-1150, 0, -460.778],
  ])
})

test('a sphere written with one value has no y, so its sheet B draws with no height', () => {
  const sphere = zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: 1000 })
  assert.deepEqual(sphere.size, { x: 1000, y: 0, z: 0 })
  // A sphere's reach takes no direction, so the short look changes nothing.
  const draw = sheetsFrom({ x: 5000, y: 1, z: 0 }, nebulaOf(sphere))!
  near(cornersOf(draw).slice(4), [
    [0, 0, -1150],
    [0, 0, -1150],
    [0, 0, 1150],
    [0, 0, 1150],
  ])
  // Written with three, it has, and its x no longer beats its z: sheet A turns to stand along z.
  const written = zoneOf(
    { type: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: 1000 },
    { size: { x: 1000, y: 1000, z: 1000 } },
  )
  const tall = cornersOf(sheetsFrom({ x: 3000, y: 0, z: 3000 }, nebulaOf(written))!)
  assert.ok(Math.abs(Math.abs(tall[0]![2]!) - 1150) < 1e-3)
  assert.ok(Math.abs(tall[5]![1]! - 1150) < 1e-3)
})

test("a turned zone's sheets follow its axes", () => {
  // A quarter turn about y: its own x is world -z.
  const s = Math.SQRT1_2
  const turned = zoneOf({
    type: 'ellipsoid',
    center: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: s, z: 0, w: s },
    radii: { x: 1000, y: 500, z: 400 },
  })
  assert.ok(Math.abs(turned.axes[0].z + 1) < 1e-6)
  // Looking along world x, its own z: sheet A along its x, world z.
  const draw = sheetsFrom({ x: 5000, y: 0, z: 1 }, nebulaOf(turned))!
  const corners = cornersOf(draw).slice(0, 4)
  assert.ok(corners.every(([x]) => Math.abs(x!) < 1e-3))
  assert.ok(Math.abs(Math.abs(corners[0]![2]!) - 1150) < 1e-3)
})

test('none without a fill shape, nor once the camera is fully in', () => {
  assert.equal(
    sheetsFrom({ x: 0, y: 0, z: 5000 }, nebulaOf(ellipsoid, { fill: undefined })),
    undefined,
  )
  // Deep in, past its fog's distance.
  assert.equal(sheetsFrom({ x: 0, y: 0, z: 10 }), undefined)
  // In its edge, they draw.
  assert.ok(sheetsFrom({ x: 0, y: 0, z: 350 }))
})
