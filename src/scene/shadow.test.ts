import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import { shadowDraw, shadowQuad, type RoomShadow } from './shadow.js'

const at = (y: number, world: Matrix4 = Matrix4.identity): Matrix4 =>
  Matrix4.multiply(Matrix4.translation({ x: 0, y, z: 0 }), world)

const BOX = { min: { x: -1, y: 0, z: -2 }, max: { x: 1, y: 3, z: 2 } }

const close = (actual: number[][], expected: number[][]) =>
  actual.forEach((corner, index) =>
    corner.forEach((value, axis) =>
      assert.ok(
        Math.abs(value - expected[index]![axis]!) < 1e-5,
        `corner ${index}: ${corner} ≉ ${expected[index]}`,
      ),
    ),
  )

test("a character's shadow: the small box, behind it and lifted, at 0.6 and whatever scale was left", () => {
  const shadow: RoomShadow = { fading: false, floor: 0, world: at(0) }
  const { quad, scale } = shadowQuad(shadow, 2)

  assert.equal(scale, 2)
  // 0.6² of 255, truncated.
  assert.equal(quad!.alpha, 91)

  // Each width is the whole box's, so the quad is twice the box, about a point 0.1 behind.
  const [x, z] = [0.56 * 2, 0.48 * 2]

  close(quad!.corners, [
    [-x, 0.05, z - 0.1, 0, 0],
    [-x, 0.05, -z - 0.1, 0, 1],
    [x, 0.05, -z - 0.1, 1, 1],
    [x, 0.05, z - 0.1, 1, 0],
  ])
})

test("a ship's shadow takes its box, and fades and grows with its height over the floor", () => {
  const shadow: RoomShadow = { fading: true, floor: 2, world: at(12), bounds: BOX }
  const { quad, scale } = shadowQuad(shadow, 1)

  // 10 over the floor is a fifth of 50: 4 × 0.2² + 0.8, and 0.8 - 0.2.
  assert.ok(Math.abs(scale - 0.96) < 1e-6)
  assert.equal(quad!.alpha, 91)

  const [x, z] = [2 * scale, 4 * scale]

  close(quad!.corners, [
    [-x, 2, z, 0, 0],
    [-x, 2, -z, 0, 1],
    [x, 2, -z, 1, 1],
    [x, 2, z, 1, 0],
  ])
})

test('too high, no shadow; faded out, none, but the scale is set', () => {
  assert.deepEqual(shadowQuad({ fading: true, floor: 0, world: at(51), bounds: BOX }, 1.5), {
    scale: 1.5,
  })

  const faded = shadowQuad({ fading: true, floor: 0, world: at(45), bounds: BOX }, 1)

  assert.equal(faded.quad, undefined)
  assert.ok(Math.abs(faded.scale - (4 * 0.81 + 0.8)) < 1e-5)
})

test('the quad turns with the Z axis about Y', () => {
  const turned = Matrix4.fromRotationTranslation(
    Matrix3.axisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2),
  )

  assert.ok(Math.abs(turned.z.x - 1) < 1e-6)

  const { quad } = shadowQuad({ fading: true, floor: 0, world: at(0, turned), bounds: BOX }, 1)

  // The box's X now runs along Z, and its Z along X, at the floor's scale of 0.8.
  close(
    quad!.corners.map((corner) => corner.slice(0, 3)),
    [
      [3.2, 0, 1.6],
      [-3.2, 0, 1.6],
      [-3.2, 0, -1.6],
      [3.2, 0, -1.6],
    ],
  )
})

test('drawn as two triangles of white at its alpha, blended, biased, with no depth written', () => {
  const { quad } = shadowQuad({ fading: false, floor: 0, world: at(0) }, 1)
  const draw = shadowDraw(quad!, {} as Texture)

  assert.equal(draw.count, 6)

  const colour = (vertex: number) => [
    ...draw.mesh.vertices.subarray(vertex * 24 + 12, vertex * 24 + 16),
  ]

  assert.deepEqual(colour(0), [255, 255, 255, 91])

  const floats = new Float32Array(draw.mesh.vertices.buffer)
  const corner = (vertex: number) => [...floats.subarray(vertex * 6, vertex * 6 + 3)]

  // (0, 1, 2) then (3, 0, 2).
  assert.deepEqual(corner(4), corner(0))
  assert.deepEqual(corner(5), corner(2))
  assert.equal(draw.depthBias, 4)
  assert.equal(draw.depthWrite, false)
  assert.equal(draw.depthFunc, 'lequal')
  assert.equal(draw.blend, true)
  assert.equal(draw.cull, 'none')
})
