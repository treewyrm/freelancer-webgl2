import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix4, Quat, type Vector3 } from '@treewyrm/freelancer/math'
import {
  equipmentLight,
  evaluateColorGraph,
  evaluateGraph,
  lightObject,
  lightSet,
  systemAmbient,
  type Graph,
  type SpaceLight,
} from './light.js'

const ORIGIN: Vector3 = { x: 0, y: 0, z: 0 }
const BLACK: Vector3 = { x: 0, y: 0, z: 0 }
const WHITE: Vector3 = { x: 255, y: 255, z: 255 }

const point = (x: number, range: number, fields: Partial<SpaceLight> = {}): SpaceLight => ({
  type: 'point',
  position: { x, y: 0, z: 0 },
  color: WHITE,
  range,
  attenuation: { x: 1, y: 0, z: 0 },
  ...fields,
})

const lit = (lights: SpaceLight[], position = ORIGIN, radius = 1, ambient = BLACK, time = 0) =>
  lightObject(lightSet(lights), position, radius, ambient, time)

// Which lights reached it, by their x.
const reached = (lights: SpaceLight[], position = ORIGIN, radius = 1) =>
  lit(lights, position, radius).lights.map(({ position }) => position?.x)

test('the four widest-reaching lights are taken, whatever order the file has', () => {
  const lights = [10, 20, 30, 40, 50].map((x) => point(x, 100 + x))
  assert.deepEqual(reached(lights), [50, 40, 30, 20])
})

test('of equal ranges in one cell, the file decides: the one listed first wins', () => {
  const lights = [1, 2, 3, 4, 5].map((x) => point(x, 1000))
  assert.deepEqual(reached(lights), [1, 2, 3, 4])
})

test('a light reaches by range and the object radius, and the last test is in 3D', () => {
  assert.deepEqual(reached([point(110, 100)], ORIGIN, 9), [])
  assert.deepEqual(reached([point(108, 100)], ORIGIN, 9), [108])
  // In XZ it reaches, but not from above: `EngineLightAffectsPoint`.
  assert.deepEqual(reached([point(50, 100)], { x: 0, y: 200, z: 0 }), [])
})

test('the grid keeps lights by XZ alone: a light out of reach never takes a place', () => {
  // The far one is widest, but out of reach, so it doesn't push out a fifth.
  const lights = [point(5000, 4000), ...[1, 2, 3, 4].map((x) => point(x, 100))]
  assert.deepEqual(reached(lights), [1, 2, 3, 4])
})

test('a point light keeps its place, range and attenuation, (0, 1, 0) unless written', () => {
  const [light] = lit([point(10, 100)]).lights
  assert.deepEqual(light!.position, { x: 10, y: 0, z: 0 })
  assert.equal(light!.range, 100)
  assert.deepEqual(light!.attenuation, { x: 1, y: 0, z: 0 })
  const plain: SpaceLight = { type: 'point', position: ORIGIN, color: WHITE, range: 10 }
  assert.deepEqual(lit([plain]).lights[0]!.attenuation, { x: 0, y: 1, z: 0 })
})

test('a colour is whole bytes, truncated and clamped as it is read', () => {
  const [light] = lit([point(1, 10, { color: { x: 300, y: 127.9, z: -4 } })]).lights
  assert.deepEqual(light!.color, { x: 1, y: 127 / 255, z: 0 })
})

const flat = (value: number): Graph => ({
  points: [
    [0, value],
    [1, value],
  ],
})

test('a directional light reaches by its range in XZ alone, until a curve turns it at each object', () => {
  const sun: SpaceLight = {
    type: 'directional',
    position: { x: 0, y: 0, z: 1000 },
    direction: { x: 0, y: -2, z: 0 },
    color: WHITE,
    range: 2000,
  }
  const [plain] = lit([sun]).lights
  assert.deepEqual(plain!.direction, { x: 0, y: -1, z: 0 })
  assert.equal(plain!.position, undefined)
  // The grid's test is in XZ, and without a curve the last one passes it: high above, still lit.
  assert.equal(lit([sun], { x: 0, y: 50000, z: 0 }).lights.length, 1)
  assert.deepEqual(lit([{ ...sun, range: 10 }]).lights, [])

  const turned = { ...sun, attenuationCurve: flat(0.5) }
  const [light] = lit([turned]).lights
  assert.deepEqual(light!.direction, { x: 0, y: 0, z: -1 })
  assert.deepEqual(light!.color, { x: 0.5, y: 0.5, z: 0.5 })
  // With a curve the last test is in 3D too.
  assert.deepEqual(lit([turned], { x: 0, y: 50000, z: 0 }).lights, [])
})

test('DYNAMIC_DIRECTION-like curves dim a sun over its range', () => {
  const fading: Graph = {
    points: [
      [0, 1],
      [1, 0],
    ],
  }
  const sun: SpaceLight = {
    type: 'directional',
    position: { x: 1000, y: 0, z: 0 },
    color: WHITE,
    range: 4000,
    attenuationCurve: fading,
  }
  // A quarter of the range away: three quarters left.
  assert.ok(Math.abs(lit([sun]).lights[0]!.color.x - 0.75) < 1e-6)
})

test('an ambient light adds to the ambient, by its curve, and is no light itself', () => {
  const glow: SpaceLight = {
    type: 'ambient',
    position: ORIGIN,
    color: { x: 51, y: 0, z: 0 },
    range: 100,
    ambientCurve: flat(0.5),
  }
  const { lights, ambient } = lit([glow], ORIGIN, 1, { x: 10, y: 20, z: 30 })
  assert.deepEqual(lights, [])
  // 10/255 + 0.5 * 51/255, back to a byte.
  assert.deepEqual(ambient, { x: 35 / 255, y: 20 / 255, z: 30 / 255 })
})

test('the system ambient is whole bytes', () => {
  assert.deepEqual(systemAmbient({ x: 300, y: 12.7, z: -1 }), { x: 1, y: 12 / 255, z: 0 })
})

test('a light dimmed under a byte is left off', () => {
  assert.deepEqual(lit([point(1, 10, { attenuationCurve: flat(0.001) })]).lights, [])
})

test('a cone has no angles to shine through, so draws nothing', () => {
  assert.deepEqual(lit([point(1, 10, { type: 'cone' })]).lights, [])
})

test('a curve clamps short of its range end, and maps onto its own keys', () => {
  const curve: Graph = {
    points: [
      [10, 0],
      [20, 1],
    ],
  }
  assert.equal(evaluateGraph(curve, 50, 100), 0.5)
  assert.equal(evaluateGraph(curve, -5, 100), 0)
  assert.ok(Math.abs(evaluateGraph(curve, 500, 100) - (1 - 0.001 / 100)) < 1e-6)
})

test('a colour curve repeats over its period and runs backwards between keys', () => {
  const curve: Graph = {
    points: [
      [0, 0xff000000],
      [1, 0xffff0000],
    ],
  }
  // At a quarter of the way the high key gets three quarters, not one (`0x41963c`).
  assert.deepEqual(evaluateColorGraph(curve, 0.25, 1), { x: 191, y: 0, z: 0 })
  assert.deepEqual(evaluateColorGraph(curve, 1.25, 1), { x: 191, y: 0, z: 0 })
})

test('a colour curve tints over the host clock', () => {
  const flicker: Graph = {
    points: [
      [0, 0xff000000],
      [1, 0xff000000],
      [1, 0xffffffff],
      [2, 0xffffffff],
    ],
  }
  const light = point(1, 10, { colorCurve: { graph: flicker, period: 2 } })
  assert.deepEqual(lit([light], ORIGIN, 1, BLACK, 1.5).lights[0]!.color, { x: 1, y: 1, z: 1 })
  assert.deepEqual(lit([light], ORIGIN, 1, BLACK, 0.5).lights, [])
})

test("an equipment light shines down its hardpoint's -Z, a spot below 180°, its range its intensity", () => {
  // A quarter turn about Y takes -Z to -X.
  const turn = Quat.axisAngle({ axis: { x: 0, y: 1, z: 0 }, angle: Math.PI / 2 })
  const world = Matrix4.fromTRS({ x: 1, y: 2, z: 3 }, turn)
  const spot = equipmentLight({ world, color: { x: 0.5, y: 1, z: 0 }, intensity: 40, cone: 60 })!
  assert.equal(spot.type, 'cone')
  assert.deepEqual(spot.position, { x: 1, y: 2, z: 3 })
  assert.ok(Math.abs(spot.direction!.x + 1) < 1e-6 && Math.abs(spot.direction!.z) < 1e-6)
  // Rounded to bytes.
  assert.deepEqual(spot.color, { x: 128, y: 255, z: 0 })
  assert.deepEqual(spot.attenuation, { x: 1, y: 0, z: Math.fround(16 / 1600) })
  assert.equal(spot.range, 40)
  assert.ok(Math.abs(spot.spot!.phi - Math.PI / 3) < 1e-6)
  assert.ok(Math.abs(spot.spot!.theta - Math.PI / 6) < 1e-6)

  const point = equipmentLight({ world, color: { x: 1, y: 1, z: 1 }, intensity: 40 })!
  assert.equal(point.type, 'point')
  assert.equal(point.spot, undefined)
  assert.equal(equipmentLight({ world, color: { x: 1, y: 1, z: 1 }, intensity: 0 }), undefined)

  // Through `lightObject` a spot keeps its way and its angles.
  const [lit] = lightObject(lightSet([spot]), { x: -10, y: 2, z: 3 }, 1, BLACK, 0).lights
  assert.deepEqual(lit!.spot, spot.spot)
  assert.deepEqual(lit!.direction, spot.direction)
})
