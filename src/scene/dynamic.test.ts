import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3 } from '@treewyrm/freelancer/math'
import type { Camera } from './camera.js'
import { DynamicAsteroids, type DynamicField, type DynamicSettings } from './dynamic.js'
import { zoneOf } from './nebula.js'

const f = Math.fround
const msvcRand = () => {
  let state = 1
  return () => {
    state = (state * 214013 + 2531011) >>> 0
    return (state >>> 16) & 0x7fff
  }
}
/** Hands out the values given, then the ones after them from `msvcRand`. */
const scripted = (values: number[]) => {
  const rest = msvcRand()
  return () => values.shift() ?? rest()
}
const field: DynamicField = {
  zone: zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: 20000 }),
  diffuse: { x: 0.5, y: 0.5, z: 0.5 },
  ambient: { x: 0.8, y: 0.8, z: 0.8 },
}
// Looking down -Z from the origin.
const camera: Camera = {
  position: { x: 0, y: 0, z: 0 },
  orientation: Matrix3.identity,
  fovh: 35,
  near: 1,
  far: 21000,
}
const settings: DynamicSettings = { count: 12, placementRadius: 150 }
const make = (
  fields: Partial<DynamicSettings> = {},
  onField: Partial<DynamicField> = {},
  random = msvcRand(),
) => new DynamicAsteroids({ ...settings, ...fields }, { ...field, ...onField }, { random })
const away = (rocks: DynamicAsteroids, camera: Camera, at: number) => {
  const c = rocks.centre(camera)
  const p = rocks.rocks[at]!.position
  return Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z)
}

test('its count is scaled by the Asteroids option, (1 - d) · 0.5 + d, and rounded', () => {
  assert.equal(make().count, 12)
  const low = new DynamicAsteroids(settings, field, { detail: 0 })
  assert.equal(low.count, 6)
  const odd = new DynamicAsteroids({ count: 9.9 }, field, { detail: 0 })
  // `count` truncated to 9, then 4.5 + 0.5.
  assert.equal(odd.count, 5)
})

test('the spawn point is 0.7 of placement_radius ahead, or 75 with none written', () => {
  assert.deepEqual(make().centre(camera), { x: 0, y: 0, z: -f(150 * 0.7) })
  const unwritten = new DynamicAsteroids({}, field)
  assert.equal(unwritten.radius, 150)
  assert.deepEqual(unwritten.centre(camera), { x: 0, y: 0, z: -75 })
})

test("its tints are color_shift times the field's, held under 1 from above only", () => {
  const rocks = make({ colorShift: { x: 4, y: 1, z: 0.5 } })
  assert.deepEqual(rocks.diffuse, { x: 1, y: 0.5, z: 0.25 })
  assert.deepEqual(rocks.ambient, { x: 1, y: f(0.8), z: f(0.4) })
})

test('every slot is placed on the sphere at once, and drawn from the next frame', () => {
  const rocks = make()
  rocks.update(camera)
  assert.equal(rocks.rocks.length, 12)
  for (let at = 0; at < 12; at++) {
    assert.ok(Math.abs(away(rocks, camera, at) - 150) < 1e-3)
    assert.equal(rocks.rocks[at]!.alpha, 0)
  }
  // A new rock's alpha is unwritten, so nothing shows until it's faded.
  assert.equal(rocks.draws().length, 0)
  rocks.update(camera)
  // On the sphere: (1.05 r² - r²) / 0.35 r².
  const draws = rocks.draws()
  assert.equal(draws.length, 12)
  for (const { alpha } of draws) assert.ok(Math.abs(alpha - 0.05 / 0.35) < 1e-4, `${alpha}`)
})

test('it fades over the outer 0.35 of the radius squared, and is whole within', () => {
  const rocks = make({ maxVelocity: 0 })
  rocks.update(camera)
  const rock = rocks.rocks[0]! as { position: { x: number; y: number; z: number } }
  const c = rocks.centre(camera)
  rock.position = { x: c.x + 100, y: c.y, z: c.z }
  rocks.update(camera)
  assert.equal(rocks.rocks[0]!.alpha, 1)
  // sqrt(0.8) of the radius: (1.05 - 0.8) / 0.35.
  rock.position = { x: c.x + f(150 * Math.sqrt(0.8)), y: c.y, z: c.z }
  rocks.update(camera)
  assert.ok(Math.abs(rocks.rocks[0]!.alpha - 0.25 / 0.35) < 1e-4)
})

test('Place draws two for its point, then velocity squared toward the edges, then a spin', () => {
  // The sphere's two, then x, y, z of the velocity, then the spin's three.
  const rocks = make({ count: 1, maxVelocity: 10, maxAngularVelocity: 2 }, {}, () => 0)
  rocks.update(camera)
  const rock = rocks.rocks[0]!
  // rand 0 is -1 on each axis, squared and negated.
  assert.deepEqual(rock.velocity, { x: -10, y: -10, z: -10 })
  assert.deepEqual(rock.spin, { x: -2, y: -2, z: -2 })

  const second = make(
    { count: 1, maxVelocity: 10, maxAngularVelocity: 2 },
    {},
    scripted([0, 0, 24576, 16384, 8192, 32767, 0, 16384]),
  )
  second.update(camera)
  const { velocity, spin } = second.rocks[0]!
  // 0.5 squared, 0 (unsigned, so negated to -0), -0.5 squared and negated.
  assert.deepEqual(velocity, { x: 2.5, y: -0, z: -2.5 })
  // The first spin draw turns about Y, the second about X.
  assert.equal(spin.x, f(f(0 * 2) - 2))
  assert.ok(Math.abs(spin.y - f(f(f(32767 / 32768) * 2) * 2 - 2)) < 1e-6)
  assert.equal(spin.z, f(16384 * 2 * f(1 / 16384) - 2))
})

test('it moves at its velocity and turns about its own axes between frames', () => {
  const rocks = make({ count: 1, maxVelocity: 1, maxAngularVelocity: 2 }, {}, () => 0)
  rocks.update(camera)
  const before = rocks.rocks[0]!.position
  rocks.update(camera, 0.5)
  const { position, orientation } = rocks.rocks[0]!
  assert.deepEqual(position, {
    x: f(before.x - 0.5),
    y: f(before.y - 0.5),
    z: f(before.z - 0.5),
  })
  // Half a second at 2√3 rad/s about (-1, -1, -1): the axis stays put.
  const axis = Matrix3.transform({ x: 1, y: 1, z: 1 }, orientation)
  for (const value of [axis.x, axis.y, axis.z]) assert.ok(Math.abs(value - 1) < 1e-6)
  assert.ok(Math.abs(orientation.x.x - 1) > 0.1)
})

test('one past 1.05 of the radius is placed afresh on the sphere', () => {
  const rocks = make({ maxVelocity: 0 })
  rocks.update(camera)
  rocks.update(camera)
  const rock = rocks.rocks[3]! as { position: { x: number; y: number; z: number } }
  rock.position = { x: 1000, y: 0, z: 0 }
  const kept = rocks.rocks[4]!.position
  rocks.update(camera)
  assert.ok(Math.abs(away(rocks, camera, 3) - 150) < 1e-3)
  assert.equal(rocks.rocks[4]!.position, kept)
  // It keeps the alpha it had: here, on the sphere's surface a frame before.
  assert.ok(Math.abs(rocks.rocks[3]!.alpha - 0.05 / 0.35) < 1e-4)
})

test('outside its zone, in a lane, or in a zone excluding them, none is placed and those out are released', () => {
  const outside = make(
    {},
    { zone: zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: 5000 }, radius: 100 }) },
  )
  outside.update(camera)
  assert.ok(outside.rocks.every((rock) => rock === undefined))

  const lane = make({ maxVelocity: 0 })
  lane.update(camera)
  const rock = lane.rocks[0]! as { position: { x: number; y: number; z: number } }
  rock.position = { x: 1000, y: 0, z: 0 }
  lane.update(camera, 0, { blocked: true })
  assert.equal(lane.rocks[0], undefined)
  // The rest are within, and stay.
  assert.equal(lane.rocks.filter(Boolean).length, 11)

  const zone = zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: -105 }, radius: 50 })
  const excluded = make({}, { exclusions: [{ zone, excludeDynamicAsteroids: true }] })
  excluded.update(camera)
  assert.ok(excluded.rocks.every((rock) => rock === undefined))
  // Without the flag the zone is no matter.
  const thinned = make({}, { exclusions: [{ zone, emptyFrequency: 1 }] })
  thinned.update(camera)
  assert.equal(thinned.rocks.filter(Boolean).length, 12)
})

test('exclusion zones more than 100 outside from the camera are not asked', () => {
  // The spawn point is its centre, and the camera 103 outside it.
  const zone = zoneOf({
    type: 'ellipsoid',
    center: { x: 0, y: 0, z: -f(150 * 0.7) },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    radii: { x: 1000, y: 1000, z: 2 },
  })
  const rocks = make({}, { exclusions: [{ zone, excludeDynamicAsteroids: true }] })
  rocks.update(camera)
  assert.equal(rocks.rocks.filter(Boolean).length, 12)
})
