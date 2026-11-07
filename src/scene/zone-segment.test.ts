import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Quat } from '@treewyrm/freelancer/math'
import { zoneOf } from './nebula.js'

const at = (x: number, y: number, z: number) => ({ x, y, z })
const centre = at(0, 0, -1000)
const sphere = zoneOf({ type: 'sphere', center: centre, radius: 100 })

test('a segment meets a sphere it passes through, or starts in, and not one it stops short of', () => {
  assert.equal(sphere.meets(at(0, 0, 0), at(0, 0, -2000)), true)
  assert.equal(sphere.meets(at(0, 0, 0), at(0, 0, -800)), false)
  assert.equal(sphere.meets(at(0, 200, 0), at(0, 200, -2000)), false)
  // From inside, wherever it ends.
  assert.equal(sphere.meets(at(0, 0, -1000), at(0, 0, -1050)), true)
})

test('an ellipsoid is clipped by its written size', () => {
  const ellipsoid = zoneOf({
    type: 'ellipsoid',
    center: centre,
    orientation: Quat.identity,
    radii: at(300, 50, 100),
  })
  assert.equal(ellipsoid.meets(at(250, 0, 0), at(250, 0, -2000)), true)
  assert.equal(ellipsoid.meets(at(0, 80, 0), at(0, 80, -2000)), false)
})

test('a box by its faces, turned with it', () => {
  const box = zoneOf({
    type: 'box',
    center: centre,
    orientation: Quat.axisAngle({ axis: at(0, 1, 0), angle: Math.PI / 4 }),
    size: at(200, 200, 200),
  })
  // Turned 45°, its corner reaches 141 along x.
  assert.equal(box.meets(at(130, 0, 0), at(130, 0, -2000)), true)
  assert.equal(box.meets(at(150, 0, 0), at(150, 0, -2000)), false)
  assert.equal(box.meets(at(0, 0, 0), at(0, 0, -850)), false)
})

test('a ring lets what passes through its hole by, and its band stops it', () => {
  // Lying flat: its axis is y, so a segment down through its middle misses.
  const ring = zoneOf({
    type: 'ring',
    center: centre,
    orientation: Quat.identity,
    radius: 300,
    innerRadius: 100,
    height: 20,
  })
  assert.equal(ring.meets(at(0, 500, -1000), at(0, -500, -1000)), false)
  assert.equal(ring.meets(at(200, 500, -1000), at(200, -500, -1000)), true)
  // Along its plane, through the band on both sides.
  assert.equal(ring.meets(at(-500, 0, -1000), at(500, 0, -1000)), true)
})

test('a cylinder by its wall and its caps', () => {
  const cylinder = zoneOf({
    type: 'cylinder',
    center: centre,
    orientation: Quat.identity,
    radius: 100,
    height: 50,
  })
  assert.equal(cylinder.meets(at(0, 500, -1000), at(0, -500, -1000)), true)
  assert.equal(cylinder.meets(at(0, 40, 0), at(0, 40, -2000)), false)
  assert.equal(cylinder.meets(at(0, 10, 0), at(0, 10, -2000)), true)
})
