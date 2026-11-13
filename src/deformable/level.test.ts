import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Level } from '@treewyrm/freelancer/deformable'
import { adjustedDistance, costumeLevel, switchDistance, type SwitchTable } from './level.js'

// The body's, in retail's `bodyparts.ini`.
const BODY: SwitchTable = {
  rows: [
    [100, 10],
    [80, 18],
    [60, 40],
    [40, 60],
    [20, 100],
    [10, 220],
  ],
}
const LEVELS = [1, 0.8, 0.6, 0.4, 0.2, 0.1].map((fraction) => ({ fraction })) as Level[]
// tan 20°, so `adjust_distance` is the identity.
const FOV = 20

test('a distance is linear between rows, and clamped past them', () => {
  assert.equal(switchDistance(BODY, 100), 10)
  assert.equal(switchDistance(BODY, 200), 10)
  assert.equal(switchDistance(BODY, 90), 14)
  assert.equal(switchDistance(BODY, 10), 220)
  assert.equal(switchDistance(BODY, 0), 220)
})

test('a narrow lens counts as closer, against the table fovx, 40 by default', () => {
  assert.ok(Math.abs(adjustedDistance(BODY, 100, FOV) - 100) < 1e-9)
  assert.ok(adjustedDistance(BODY, 100, 10) < 50)
  assert.ok(Math.abs(adjustedDistance({ ...BODY, fovx: 80 }, 100, 40) - 100) < 1e-9)
})

test('the first level whose distance reaches it, and none past the far cutoff', () => {
  const at = (distance: number) => costumeLevel(LEVELS, BODY, distance, FOV)

  assert.equal(at(4), 0)
  assert.equal(at(10), 0)
  assert.equal(at(10.5), 1)
  assert.equal(at(35), 2)
  assert.equal(at(100), 4)
  assert.equal(at(220), 5)
  assert.equal(at(221), undefined)
})

test('the last level reaches the far cutoff, whatever its own fraction reads', () => {
  const four = [1, 0.8, 0.6, 0.2].map((fraction) => ({ fraction })) as Level[]

  // 0.2 reads 100, and the table at 0 reads 220.
  assert.equal(costumeLevel(four, BODY, 150, FOV), 3)
})
