import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import { projectionMatrix, sphereInFrustum, viewMatrix, type Camera } from './camera.js'

const camera: Camera = {
  position: { x: 0, y: 0, z: 0 },
  orientation: Matrix3.identity,
  fovh: 30,
  near: 1,
  far: 10000,
}

const clip = (point: { x: number; y: number; z: number }, used = camera, aspect = 4 / 3) =>
  Matrix4.transform(
    { ...point, w: 1 },
    Matrix4.multiply(projectionMatrix(used, aspect), viewMatrix(used)),
  )

const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`)

test('fovh is half the horizontal angle, and the vertical follows the aspect', () => {
  const edge = Math.tan(Math.PI / 6)
  const right = clip({ x: edge, y: 0, z: -1 })
  near(right.x / right.w, 1)
  const top = clip({ x: 0, y: edge / (4 / 3), z: -1 })
  near(top.y / top.w, 1)
})

test('+X is to the right and +Y up, looking down -Z', () => {
  const point = clip({ x: 1, y: 2, z: -10 })
  assert.ok(point.x > 0 && point.y > 0 && point.w === 10)
})

test('window depth is D3D z / w: 0 at the near plane and 1 at the far', () => {
  const windowDepth = (distance: number) => {
    const point = clip({ x: 0, y: 0, z: -distance })
    return (point.z / point.w + 1) / 2
  }
  near(windowDepth(1), 0)
  near(windowDepth(10000), 1)
  // SetPerspective: (far / (far - near)) * (1 - near / d), at a distance d of 100.
  near(windowDepth(100), (10000 / 9999) * (1 - 1 / 100))
})

test('the view undoes the camera frame', () => {
  // Rows of a quarter turn about +Y: local -Z, where it looks, is world -X.
  const turned: Camera = {
    ...camera,
    position: { x: 5, y: 0, z: 0 },
    orientation: { x: { x: 0, y: 0, z: 1 }, y: { x: 0, y: 1, z: 0 }, z: { x: -1, y: 0, z: 0 } },
  }
  const ahead = Matrix4.transformPoint({ x: 2, y: 0, z: 0 }, viewMatrix(turned))
  near(ahead.x, 0)
  near(ahead.y, 0)
  near(ahead.z, -3)
})

test('a sphere is culled only when wholly past one plane', () => {
  // Half-angles of 45° across, at 4:3 so tan 36.87° up: a side plane is `x + z = 0`, off by √2.
  const camera = {
    position: { x: 0, y: 0, z: 0 },
    orientation: Matrix3.identity,
    fovh: 45,
    near: 1,
    far: 100,
  }
  const inside = (x: number, y: number, z: number, radius = 1) =>
    sphereInFrustum({ x, y, z }, radius, camera, 4 / 3)
  assert.equal(inside(0, 0, -10), true)
  // Behind, and past the far plane, with their edges either side of it.
  assert.equal(inside(0, 0, 1), false)
  assert.equal(inside(0, 0, 0.5), false)
  assert.equal(inside(0, 0, -0.5), true)
  assert.equal(inside(0, 0, -101.5), false)
  assert.equal(inside(0, 0, -100.5), true)
  // Across: at depth 10 the plane's at x = 10, and a radius of 1 reaches √2 further.
  assert.equal(inside(11.4, 0, -10), true)
  assert.equal(inside(11.5, 0, -10), false)
  assert.equal(inside(-11.5, 0, -10), false)
  // Up: at depth 10 the plane's at y = 7.5, and 1 reaches 1.25 further.
  assert.equal(inside(0, 8.7, -10), true)
  assert.equal(inside(0, 8.8, -10), false)
})
