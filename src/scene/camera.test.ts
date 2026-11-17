import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import {
  classifySphere,
  eyeFor,
  projectionMatrix,
  sizeDepth,
  sphereInFrustum,
  underPixel,
  unitsPerPixel,
  viewMatrix,
  type Camera,
} from './camera.js'

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

const VGA = { width: 640, height: 480 }

test("a room camera's sphere under a pixel ranks 2, by π (R / z)² of its pixel scales", () => {
  // 30° each side: about 961,600 pixels at R / z of 1, so a unit sphere goes under one past 980.
  assert.equal(underPixel(-980, 1, 30, VGA), false)
  assert.equal(underPixel(-981, 1, 30, VGA), true)
  assert.equal(classifySphere({ x: 0, y: 0, z: -981 }, 1, camera, 4 / 3, VGA), 2)
  assert.equal(classifySphere({ x: 0, y: 0, z: -980 }, 1, camera, 4 / 3, VGA), 4)
  assert.equal(classifySphere({ x: 0, y: 0, z: -981 }, 1, camera, 4 / 3), 4)
  assert.equal(sphereInFrustum({ x: 0, y: 0, z: -981 }, 1, camera, 4 / 3, VGA), false)
})

test('outside still ranks 1 before its size is asked, and a centre on the eye plane is never sized', () => {
  assert.equal(classifySphere({ x: 5000, y: 0, z: -2000 }, 1, camera, 4 / 3, VGA), 1)
  assert.equal(underPixel(0, 0.001, 30, VGA), false)
  assert.equal(underPixel(-0.00009, 1e-9, 30, VGA), false)
})

const plan: Camera = { ...camera, near: 1, far: 1000, ortho: { halfWidth: 200 } }

test('ortho: the box is ±halfWidth across and ±halfWidth / aspect up, whatever the depth', () => {
  for (const depth of [1, 10, 999]) {
    const right = clip({ x: 200, y: 0, z: -depth }, plan)
    const top = clip({ x: 0, y: 150, z: -depth }, plan)

    near(right.w, 1)
    near(right.x, 1)
    near(top.y, 1)
  }
})

test('ortho: window depth runs 0 to 1 from near to far, linearly', () => {
  const windowDepth = (distance: number) => (clip({ x: 0, y: 0, z: -distance }, plan).z + 1) / 2

  near(windowDepth(1), 0)
  near(windowDepth(1000), 1)
  near(windowDepth(500.5), 0.5)
})

test('ortho: a sphere is culled against the box, its sides planes along the view', () => {
  const rank = (x: number, y: number, z = -10, radius = 1) =>
    classifySphere({ x, y, z }, radius, plan, 4 / 3)

  assert.equal(rank(0, 0), 4)
  assert.equal(rank(200.9, 0), 3)
  assert.equal(rank(201.1, 0), 1)
  assert.equal(rank(0, 151.1), 1)
  assert.equal(rank(198.5, 0), 4)
  // Far off to the side at any depth is out, as a cone would not have it.
  assert.equal(rank(300, 0, -999), 1)
  // The planes along the view still hold.
  assert.equal(rank(0, 0, 1.5), 1)
  assert.equal(rank(0, 0, -1001.5), 1)
  // Under a pixel: 400 units over 640 pixels, so a radius of 0.3 covers π·0.48² of one.
  assert.equal(classifySphere({ x: 0, y: 0, z: -10 }, 0.3, plan, 4 / 3, VGA), 2)
  assert.equal(classifySphere({ x: 0, y: 0, z: -10 }, 0.4, plan, 4 / 3, VGA), 4)
})

test('ortho: sizes read the view as fovh would at halfWidth / tan(fovh)', () => {
  near(sizeDepth(plan, -10), 200 / Math.tan(Math.PI / 6))
  near(sizeDepth(camera, -10), 10)
  near(unitsPerPixel(plan, -10, 400), 1)
  near(unitsPerPixel(camera, -10, 400), (2 * 10 * Math.tan(Math.PI / 6)) / 400)
})

test('ortho: the eye a point sees is back along the view from it, wherever it stands', () => {
  // Looking straight down: rows of a quarter turn about +X, so local -Z is world -Y.
  const down: Camera = {
    ...plan,
    orientation: { x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 0, z: 1 }, z: { x: 0, y: -1, z: 0 } },
  }
  const ahead = Matrix4.transformPoint({ x: 0, y: -5, z: 0 }, viewMatrix(down))

  near(ahead.z, -5)

  const eye = eyeFor(down, { x: 3000, y: 0, z: -7000 })

  near(eye.x, 3000)
  near(eye.z, -7000)
  assert.ok(eye.y > 1e6)
  assert.equal(eyeFor(camera, { x: 1, y: 2, z: 3 }), camera.position)
})
