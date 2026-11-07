import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Vector3 } from '@treewyrm/freelancer/math'
import {
  exteriorFactor,
  findNebula,
  fogEnd,
  fogFar,
  immersion,
  listNebulae,
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

// Within a float's precision, at any magnitude.
const close = (actual: number, expected: number) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-4 * Math.max(1, Math.abs(expected)),
    `${actual} is not ${expected}`,
  )

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
    surface: 50,
  })
  const inside = nebulaState(nebula, { x: 0, y: 0, z: 70 })
  close(inside.depth, 30 / 60)
  assert.equal(inside.surface, -30)
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
  // A hint that still holds it wins, and one that doesn't is passed over.
  assert.equal(findNebula(states, { x: 0, y: 0, z: 50 }, states[1]!.nebula)?.state, states[1])
  assert.equal(findNebula(states, { x: 0, y: 0, z: 150 }, states[0]!.nebula)?.state, states[1])
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

test('every nebula the camera does not answer to is left to the far list, by its score', () => {
  const states = (...nebulae: SpaceNebula[]) => nebulae.map((n) => nebulaState(n, ORIGIN))
  const keys = (list: ReturnType<typeof listNebulae>) => list.deferred.map(({ key }) => key)
  // Outside them all: each that isn't the nearest, however far, and one the nearest replaces, with
  // the best score it had.
  const [a, b, c] = states(
    sphereAt({ x: 0, y: 0, z: 500 }, 100, 50),
    sphereAt({ x: 0, y: 0, z: 300 }, 100, 50),
    sphereAt({ x: 0, y: 0, z: 90000 }, 100, 50),
  )
  const outside = listNebulae([a!, b!, c!], ORIGIN, 10000)
  assert.equal(outside.field?.state, b)
  assert.deepEqual(
    outside.deferred.map(({ state }) => state),
    [a, c],
  )
  // Squared distances past each surface, by a length one Newton step leaves up to 0.17% short.
  keys(outside).forEach((key, at) => {
    const expected = [400, 89900][at]! ** 2
    assert.ok(Math.abs(key / expected - 1) < 0.005, `${key} is not ${expected}`)
  })
  // An edge defers the field it replaces, and everything after it.
  const edge = sphereAt({ x: 0, y: 0, z: 90 }, 100, 50)
  const [d, e, f] = states(b!.nebula, edge, a!.nebula)
  const inEdge = listNebulae([d!, e!, f!], ORIGIN, 10000)
  assert.deepEqual(inEdge.field, { state: e, enclosure: 1 })
  assert.deepEqual(
    inEdge.deferred.map(({ state }) => state),
    [d, f],
  )
  // A core clears them.
  const [g, h] = states(b!.nebula, sphereAt(ORIGIN, 1000, 50))
  assert.deepEqual(listNebulae([g!, h!], ORIGIN, 10000).deferred, [])
})

test("a zone's size is as written, and its axes its own", () => {
  const box = zoneOf({
    type: 'box',
    center: ORIGIN,
    orientation: TURNED,
    size: { x: 1, y: 2, z: 3 },
  })
  assert.deepEqual(box.size, { x: 1, y: 2, z: 3 })
  // Its own z along world x, and x along -z.
  close(box.axes[2].x, 1)
  close(box.axes[0].z, -1)
  close(box.axes[1].y, 1)
  const ring = zoneOf({
    type: 'ring',
    center: ORIGIN,
    orientation: IDENTITY,
    radius: 5,
    innerRadius: 2,
    height: 1,
  })
  assert.deepEqual(ring.size, { x: 5, y: 2, z: 1 })
  // A sphere has no orientation, but its `rotate` turns its axes.
  const sphere = zoneOf({ type: 'sphere', center: ORIGIN, radius: 4 }, { orientation: TURNED })
  close(sphere.axes[2].x, 1)
})

test("an exclusion zone's immersion rises from its surface over its edge fraction", () => {
  const zone = zoneOf({ type: 'sphere', center: ORIGIN, radius: 100 })
  assert.equal(immersion(zone, 0.2, { x: 0, y: 0, z: 110 }), 0)
  close(immersion(zone, 0.2, { x: 0, y: 0, z: 90 }), 0.5)
  assert.equal(immersion(zone, 0.2, { x: 0, y: 0, z: 50 }), 1)
  assert.equal(immersion(zone, 0, { x: 0, y: 0, z: 99 }), 1)
  assert.equal(immersion(zone, 0.2, ORIGIN), 1)
})

test('in an exclusion zone the fog ends towards its fog_far, and the far plane spans it', () => {
  const hole = { zone: zoneOf({ type: 'sphere', center: ORIGIN, radius: 4000 }), edgeFraction: 0.2 }
  const nebula = (fogFar?: number): SpaceNebula => ({
    ...sphereAt(ORIGIN, 10000, 1000),
    exclusions: [
      { zone: zoneOf({ type: 'sphere', center: { x: 9000, y: 0, z: 0 }, radius: 500 }) },
      { ...hole, ...(fogFar === undefined ? {} : { fogFar }) },
    ],
  })
  // Half in: half the fog's span, half the zone's.
  const eye = { x: 0, y: 0, z: 3600 }
  const state = nebulaState(nebula(5000), eye)
  close(state.inExclusion!.immersion, 0.5)
  close(state.end, 3000)
  // What is deep in it fogs to that end, and what's outside it to the fog's own span.
  close(fogEnd(state, ORIGIN), 3000)
  close(fogEnd(state, { x: 0, y: 0, z: 5000 }), 1000)
  close(fogEnd(state, eye), 2000)
  // At least the zone's diameter and 500.
  assert.equal(fogFar(state), 8500)
  // With no fog_far it keeps the span, and the zone is still the one the camera is in.
  const plain = nebulaState(nebula(), eye)
  assert.equal(plain.end, 1000)
  assert.equal(plain.inExclusion?.exclusion.zone, hole.zone)
  // From outside the nebula, its exclusion zones play no part.
  assert.equal(nebulaState(nebula(5000), { x: 0, y: 0, z: 20000 }).inExclusion, undefined)
})

test('a zone holds a point as `InZone` decides, shape by shape', () => {
  const at = (x: number, y: number, z: number) => ({ x, y, z })
  const sphere = zoneOf({ type: 'sphere', center: ORIGIN, radius: 100 })
  assert.equal(sphere.holds(at(99, 0, 0)), true)
  // Its sphere's test is strict.
  assert.equal(sphere.holds(at(100, 0, 0)), false)
  const ellipsoid = zoneOf({
    type: 'ellipsoid',
    center: ORIGIN,
    radii: { x: 100, y: 10, z: 50 },
    orientation: IDENTITY,
  })
  assert.equal(ellipsoid.holds(at(0, 9, 0)), true)
  assert.equal(ellipsoid.holds(at(0, 11, 0)), false)
  assert.equal(ellipsoid.holds(at(70, 0, 40)), false)
  const box = zoneOf({
    type: 'box',
    center: ORIGIN,
    size: { x: 100, y: 20, z: 40 },
    orientation: TURNED,
  })
  // Turned, its x runs along world -z.
  assert.equal(box.holds(at(0, 0, 49)), true)
  assert.equal(box.holds(at(19, 0, 0)), true)
  assert.equal(box.holds(at(21, 0, 0)), false)
  // On a face is out.
  assert.equal(box.holds(at(0, 10, 0)), false)
  const cylinder = zoneOf({
    type: 'cylinder',
    center: ORIGIN,
    radius: 100,
    height: 40,
    orientation: IDENTITY,
  })
  assert.equal(cylinder.holds(at(99, 20, 0)), true)
  assert.equal(cylinder.holds(at(99, 21, 0)), false)
  assert.equal(cylinder.holds(at(0, 0, 101)), false)
  // A ring of 1000 about a hole of 400, 100 high: past `400 + sqrt(400² + 50²)`, not 400.
  const ring = zoneOf({
    type: 'ring',
    center: ORIGIN,
    radius: 1000,
    innerRadius: 400,
    height: 100,
    orientation: IDENTITY,
  })
  const inner = 400 + Math.sqrt(400 * 400 + 100 * 100 * 0.25)
  assert.equal(ring.holds(at(500, 0, 0)), false)
  assert.equal(ring.holds(at(inner - 1, 0, 0)), false)
  assert.equal(ring.holds(at(inner + 1, 0, 0)), true)
  assert.equal(ring.holds(at(999, 0, 0)), true)
  assert.equal(ring.holds(at(900, 51, 0)), false)
  // Its centre, within 1e-2, holds whatever the shape.
  assert.equal(ring.holds(at(0, 0, 0.001)), true)
})
