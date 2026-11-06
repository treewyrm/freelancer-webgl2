import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Vector3 } from '@treewyrm/freelancer/math'
import {
  exteriorFactor,
  findNebula,
  fogEnd,
  fogFar,
  nebulaState,
  pickField,
  zoneOf,
  type SpaceNebula,
} from './nebula.js'

const ORIGIN: Vector3 = { x: 0, y: 0, z: 0 }
const X: Vector3 = { x: 1, y: 0, z: 0 }
const Y: Vector3 = { x: 0, y: 1, z: 0 }
const Z: Vector3 = { x: 0, y: 0, z: 1 }
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 }
// A quarter turn about Y: its local Z points along world X.
const TURNED = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-4, `${actual} is not ${expected}`)

const sphereAt = (center: Vector3, radius: number, distance: number, near = 0): SpaceNebula => ({
  zone: zoneOf({ type: 'sphere', center, radius }),
  fog: { distance, near, color: { x: 0, y: 0, z: 0 } },
})

test("each zone shape's radius and reach, as `ZONE` has them", () => {
  const sphere = zoneOf({ type: 'sphere', center: ORIGIN, radius: 7 })
  assert.equal(sphere.radius, 7)
  assert.equal(sphere.radiusAlong(X), 7)

  const radii = { x: 2, y: 3, z: 4 }
  const ellipsoid = zoneOf({ type: 'ellipsoid', center: ORIGIN, orientation: IDENTITY, radii })
  assert.equal(ellipsoid.radius, 4)
  close(ellipsoid.radiusAlong(X), 2)
  close(ellipsoid.radiusAlong(Y), 3)
  close(ellipsoid.radiusAlong(Z), 4)

  // A box's size is its edges, and it reaches half of one.
  const size = { x: 10, y: 20, z: 40 }
  const box = zoneOf({ type: 'box', center: ORIGIN, orientation: IDENTITY, size })
  assert.equal(box.radius, Math.fround(Math.sqrt(2100) / 2))
  close(box.radiusAlong(X), 5)
  close(box.radiusAlong(Y), 10)
  close(box.radiusAlong(Z), 20)
  const turned = zoneOf({ type: 'box', center: ORIGIN, orientation: TURNED, size })
  close(turned.radiusAlong(X), 20)

  // A ring's hole doesn't count: it reaches as its outer cylinder does.
  const cylinder = zoneOf({
    type: 'cylinder',
    center: ORIGIN,
    orientation: IDENTITY,
    radius: 10,
    height: 40,
  })
  const ring = zoneOf({
    type: 'ring',
    center: ORIGIN,
    orientation: IDENTITY,
    radius: 10,
    innerRadius: 5,
    height: 40,
  })
  for (const zone of [cylinder, ring]) {
    assert.equal(zone.radius, Math.fround(Math.sqrt(500)))
    close(zone.radiusAlong(X), 10)
    close(zone.radiusAlong(Y), 20)
  }
})

test('the exterior factor rises from its surface to a fog distance in', () => {
  const { zone } = sphereAt(ORIGIN, 100, 50)
  assert.equal(exteriorFactor(zone, 50, { x: 0, y: 0, z: 120 }), 0)
  close(exteriorFactor(zone, 50, { x: 0, y: 0, z: 80 }), 0.4)
  assert.equal(exteriorFactor(zone, 50, { x: 0, y: 0, z: 10 }), 1)
  // Its very centre has no direction, and counts as deep.
  assert.equal(exteriorFactor(zone, 50, ORIGIN), 1)
})

test('outside, the fog starts at the surface; inside, at its near, ending its span on', () => {
  const nebula = sphereAt(ORIGIN, 100, 50, 10)
  assert.deepEqual(nebulaState(nebula, { x: 0, y: 0, z: 150 }), {
    nebula,
    fogDistance: 50,
    depth: 0,
    start: 60,
    end: 110,
  })
  const inside = nebulaState(nebula, { x: 0, y: 0, z: 70 })
  close(inside.depth, 30 / 60)
  assert.equal(inside.start, 10)
  assert.equal(inside.end, 60)
  assert.equal(nebulaState(nebula, { x: 0, y: 0, z: 10 }).depth, 1)
})

test("an object's fog ends further out the shallower it is, and the far plane has a floor", () => {
  const state = nebulaState(sphereAt(ORIGIN, 100, 50), ORIGIN)
  assert.equal(fogEnd(state, { x: 0, y: 0, z: 10 }), 50)
  assert.equal(fogEnd(state, { x: 0, y: 0, z: 75 }), Math.fround(50 / 0.25))
  // At the surface the factor is 0, which is kept off the divisor.
  assert.equal(fogEnd(state, { x: 0, y: 0, z: 100 }), Math.fround(50 / Math.fround(1e-4)))
  assert.equal(fogFar(state), 5000)
  assert.equal(fogFar({ ...state, end: 6000 }), 6500)
})

test('a point is in the first nebula that holds it', () => {
  const states = [sphereAt(ORIGIN, 100, 50), sphereAt(ORIGIN, 200, 50)].map((nebula) =>
    nebulaState(nebula, ORIGIN),
  )
  assert.equal(findNebula(states, { x: 0, y: 0, z: 50 })?.state, states[0])
  assert.equal(findNebula(states, { x: 0, y: 0, z: 150 })?.state, states[1])
  assert.equal(findNebula(states, { x: 0, y: 0, z: 250 }), undefined)
})

test('the camera answers to the first nebula it is in, or the nearest within range', () => {
  const states = (...nebulae: SpaceNebula[]) => nebulae.map((n) => nebulaState(n, ORIGIN))
  // In the edge of the first, it ignores a core after it, and a core ends the search.
  const edge = sphereAt({ x: 0, y: 0, z: 90 }, 100, 50)
  const core = sphereAt(ORIGIN, 1000, 50)
  const [first, second] = states(edge, core)
  assert.deepEqual(pickField([first!, second!], ORIGIN, 10000), { state: first, enclosure: 1 })
  assert.deepEqual(pickField([second!, first!], ORIGIN, 10000), { state: second, enclosure: 2 })

  // From outside, the nearest surface, but only within the range.
  const [far, near] = states(sphereAt({ x: 0, y: 0, z: 900 }, 100, 50), sphereAt(X, 0.5, 50))
  assert.deepEqual(pickField([far!, near!], { x: 0, y: 0, z: -400 }, 10000), {
    state: near,
    enclosure: 0,
  })
  assert.equal(pickField([far!], ORIGIN, 700), undefined)
  assert.deepEqual(pickField([far!], ORIGIN, 900), { state: far, enclosure: 0 })
})
