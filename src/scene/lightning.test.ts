import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BackgroundLightning } from './lightning.js'

const BASE = { x: 0.5, y: 0.25, z: 0 }
// `rand()` at its middle, counting the calls.
const middle = () => {
  const calls = { count: 0 }
  return { calls, random: () => (calls.count++, 0x4000) }
}

test('with no duration it never flashes, nor draws a number', () => {
  const { calls, random } = middle()
  const lightning = new BackgroundLightning({ duration: 0 }, random)
  for (let n = 0; n < 10; n++) assert.deepEqual(lightning.fogColor(BASE, 1), BASE)
  assert.equal(calls.count, 0)
})

test('a flash comes once the wait is over, lasts its duration, then waits 0.8 to 1.5 gaps', () => {
  const { calls, random } = middle()
  const lightning = new BackgroundLightning({}, random)
  // `Load` leaves a second's wait.
  assert.deepEqual(lightning.fogColor(BASE, 0.5), BASE)
  // Half of a half of the intensity, of a colour of 0.25.
  const flash = { x: 0.5 + 0.0625, y: 0.25 + 0.0625, z: 0.0625 }
  assert.deepEqual(lightning.fogColor(BASE, 0.6), flash)
  assert.equal(calls.count, 2)
  // Past its duration it re-arms, at (0.5 · 0.7 − 1.5) gaps, and still flashes this frame.
  assert.deepEqual(lightning.fogColor(BASE, 0.5), flash)
  assert.equal(calls.count, 5)
  assert.deepEqual(lightning.fogColor(BASE, 11.4), BASE)
  assert.deepEqual(lightning.fogColor(BASE, 0.2), flash)
})

test("a file's gap is the first wait, and a flash stops at 1", () => {
  const { random } = middle()
  const lightning = new BackgroundLightning(
    { gap: 3, color: { x: 1, y: 1, z: 1 }, intensity: 4 },
    random,
  )
  assert.deepEqual(lightning.fogColor(BASE, 2.9), BASE)
  // A scale of 1 over each channel.
  assert.deepEqual(lightning.fogColor(BASE, 0.2), { x: 1, y: 1, z: 1 })
})
