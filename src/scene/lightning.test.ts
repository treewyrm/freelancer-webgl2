import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NebulaLightning } from './lightning.js'

const BASE = { x: 0.5, y: 0.25, z: 0 }
const EYE = { x: 1, y: 2, z: 3 }

// `rand()` at its middle, counting the calls.
const middle = () => {
  const calls = { count: 0 }

  return { calls, random: () => (calls.count++, 0x4000) }
}

// Each number in turn, then the middle.
const sequence =
  (...numbers: number[]) =>
  () =>
    numbers.shift() ?? 0x4000
const NO_LIGHT = { dynamic: { duration: 0 } }
// Read afresh: a getter, which an assertion would otherwise narrow.
const lit = (lightning: NebulaLightning) => lightning.light

// The background alone, `step` on, deep in the nebula.
const fogAfter = (lightning: NebulaLightning, step: number) => {
  lightning.update(step, 1, EYE)
  return lightning.fogColor(BASE)
}

test('with no duration the background never flashes, nor draws a number', () => {
  const { calls, random } = middle()
  const lightning = new NebulaLightning({ ...NO_LIGHT, background: { duration: 0 } }, random)
  for (let n = 0; n < 10; n++) assert.deepEqual(fogAfter(lightning, 1), BASE)
  assert.equal(calls.count, 0)
})

test('a flash comes once the wait is over, lasts its duration, then waits 0.8 to 1.5 gaps', () => {
  const { calls, random } = middle()
  const lightning = new NebulaLightning(NO_LIGHT, random)

  // `Load` leaves a second's wait.
  assert.deepEqual(fogAfter(lightning, 0.5), BASE)

  // Half of a half of the intensity, of a colour of 0.25.
  const flash = { x: 0.5 + 0.0625, y: 0.25 + 0.0625, z: 0.0625 }

  assert.deepEqual(fogAfter(lightning, 0.6), flash)
  assert.equal(calls.count, 2)
  // Past its duration it re-arms, at (0.5 · 0.7 − 1.5) gaps, and still flashes this frame.
  assert.deepEqual(fogAfter(lightning, 0.5), flash)
  assert.equal(calls.count, 5)
  assert.deepEqual(fogAfter(lightning, 11.4), BASE)
  assert.deepEqual(fogAfter(lightning, 0.2), flash)
})

test("a file's gap is the first wait, and a flash stops at 1", () => {
  const { random } = middle()
  const background = { gap: 3, color: { x: 1, y: 1, z: 1 }, intensity: 4 }
  const lightning = new NebulaLightning({ ...NO_LIGHT, background }, random)

  assert.deepEqual(fogAfter(lightning, 2.9), BASE)
  // A scale of 1 over each channel.
  assert.deepEqual(fogAfter(lightning, 0.2), { x: 1, y: 1, z: 1 })
})

test('the light flashes at the camera, then turns off and a new way for the next', () => {
  // The flicker's two numbers, the re-arm's wait, then the direction's three: the first lands in z.
  const random = sequence(0x4000, 0x4000, 0x4000, 0x6000, 0x4000, 0x4000)
  const lightning = new NebulaLightning({}, random)

  lightning.update(0.5, 1, EYE)
  assert.equal(lit(lightning), undefined)
  // Each flicker: a quarter's intensity, by half of a half. Down -Z, as constructed.
  lightning.update(0.6, 1, EYE)
  assert.deepEqual(lit(lightning), {
    type: 'directional',
    position: EYE,
    direction: { x: 0, y: 0, z: -1 },
    color: { x: 15, y: 15, z: 15 },
    range: 500000,
  })
  // Past its duration: off, and turned for the next.
  lightning.update(0.5, 1, EYE)
  assert.equal(lit(lightning), undefined)
  lightning.update(3.5, 1, EYE)
  assert.deepEqual(lit(lightning)?.direction, { x: 0, y: 0, z: 1 })
})

test('the light keeps its state part way in, is off outside, and brightens with the background', () => {
  const { random } = middle()
  const lightning = new NebulaLightning({ background: { gap: 1 } }, random)

  lightning.update(1.1, 1, EYE)
  assert.ok(lit(lightning))
  lightning.update(1, 0.5, EYE)
  assert.ok(lit(lightning))
  lightning.update(0, 0, EYE)
  assert.equal(lit(lightning), undefined)

  // With the background flashing, its increase adds to the intensity: a whole one, by a quarter.
  const both = new NebulaLightning({ background: { gap: 1 } }, random)

  both.update(1.1, 1, EYE)
  both.fogColor(BASE)
  both.update(0.1, 1, EYE)
  assert.deepEqual(lit(both)?.color, { x: 63, y: 63, z: 63 })
})

test('fired, either flashes on the next step instead of after its wait', () => {
  const { random } = middle()
  const background = { gap: 30, color: { x: 1, y: 1, z: 1 }, intensity: 4 }
  const lightning = new NebulaLightning({ background, dynamic: { gap: 30 } }, random)

  assert.deepEqual(fogAfter(lightning, 0.1), BASE)
  assert.equal(lit(lightning), undefined)

  lightning.fire('background')
  lightning.fire('dynamic')

  assert.notDeepEqual(fogAfter(lightning, 0.1), BASE)
  assert.ok(lit(lightning))
})
