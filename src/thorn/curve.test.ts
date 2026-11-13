import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCurve, progress } from './curve.js'

const close = (actual: number, expected: number, e = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= e, `${actual} ≠ ${expected}`)

test("retail's commonest curve, (0,0,0,0) to (1,1,0,0) free form, is a smoothstep", () => {
  const curve = createCurve({
    CLSID: 'FreeFormPCurve',
    points: [
      [0, 0, 0, 0],
      [1, 1, 0, 0],
    ],
  })!

  close(curve.evaluate(0.1), 0.028)
  close(curve.evaluate(0.5), 0.5)
  close(curve.evaluate(0.9), 0.972)
  // Held at both ends.
  assert.equal(curve.evaluate(-1), 0)
  assert.equal(curve.evaluate(2), 1)
})

test("a free-form row is (t, value, in, out), Hermite on the file's slopes", () => {
  const curve = createCurve({
    CLSID: 'FreeFormPCurve',
    points: [
      [0, 0, 0, 2],
      [0.5, 1, 0, 0],
    ],
  })!
  // (0, 0, out 2) to (0.5, 1, in 0); then (0.5, 1, out 0) to the default (1, 1).
  const s = 0.5
  const expected = (s ** 3 - 2 * s ** 2 + s) * 2 * 0.5 + (3 * s ** 2 - 2 * s ** 3) * 1

  close(curve.evaluate(0.25), expected)
  assert.equal(curve.evaluate(0.5), 1)
  assert.equal(curve.evaluate(0.75), 1)
})

test('a row at exactly 0 or 1 replaces an end key; one outside [0, 1] is dropped', () => {
  const curve = createCurve({
    CLSID: 'FreeFormPCurve',
    points: [
      [0, 0.25, 0, 0],
      [1, 0.75, 0, 0],
      [1.5, 9, 0, 0],
    ],
  })!

  assert.equal(curve.evaluate(0), 0.25)
  assert.equal(curve.evaluate(1), 0.75)
  close(curve.evaluate(0.5), 0.5)
})

test('the preset Hermite classes set slopes by mode, over a dt held at 1e-4 or more', () => {
  const points: [number, number, number, number][] = [[0.5, 0.5, 9, 9]]
  const smooth = createCurve({ CLSID: 'SmoothPCurve', points })!

  close(smooth.evaluate(0.25), 0.25)

  const step = createCurve({ CLSID: 'StepPCurve', points })!

  assert.equal(step.evaluate(0.49), 0)
  assert.equal(step.evaluate(0.5), 0.5)
  assert.equal(step.evaluate(0.99), 0.5)

  // RampUp: out 0, in twice the slope: (s³ − s²)·dt·2·slope + smooth part.
  const rampUp = createCurve({ CLSID: 'RampUpPCurve', points: [] })!

  close(rampUp.evaluate(0.5), (0.125 - 0.25) * 2 + 0.5)

  const rampDown = createCurve({ CLSID: 'rampdownpcurve', points: [] })!

  close(rampDown.evaluate(0.5), (0.125 - 0.5 + 0.5) * 2 + 0.5)
  // BumpIn rising is RampUp; BumpOut rising is RampDown.
  close(createCurve({ CLSID: 'BumpInPCurve' })!.evaluate(0.3), rampUp.evaluate(0.3))
  close(createCurve({ CLSID: 'BumpOutPCurve' })!.evaluate(0.3), rampDown.evaluate(0.3))
})

test('the list Catmull-Rom returns a key at its time and 0 outside the keys', () => {
  const curve = createCurve({
    CLSID: 'CatmullRomPCurve',
    points: [[0.5, 0.25, 0, 0]],
  })!

  assert.equal(curve.evaluate(0.5), 0.25)
  assert.equal(curve.evaluate(1), 1)
  assert.equal(curve.evaluate(-0.1), 0)
  assert.equal(curve.evaluate(1.1), 0)

  // Between 0 and 0.5: p0 doubled from the first key, p3 the 1.
  const u = 0.5
  const [p0, p1, p2, p3] = [0, 0, 0.25, 1]

  close(
    curve.evaluate(0.25),
    0.5 *
      (2 * p1 +
        (p2 - p0) * u +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u +
        (3 * p1 - p0 - 3 * p2 + p3) * u ** 3),
  )
})

test('the list lerp is 0 at 1 and before 0, and the non-negative classes hold the running maximum', () => {
  const linear = createCurve({ CLSID: 'LinearPCurve', points: [[0.5, 0.2, 0, 0]] })!

  close(linear.evaluate(0.25), 0.1)
  close(linear.evaluate(0.75), 0.6)
  assert.equal(linear.evaluate(1), 0)
  assert.equal(linear.evaluate(-0.5), 0)

  const floored = createCurve({ CLSID: 'ThornLPCurve', points: [[0.5, -0.4, 0, 0]] })!

  assert.equal(floored.evaluate(0.5), 0)
})

test('a class DACOM does not have makes no curve', () => {
  assert.equal(createCurve({ CLSID: 'SplinePCurve', points: [] }), undefined)
  assert.equal(createCurve({ points: [] }), undefined)
})

test('progress is 1 for an instant event, unclamped elapsed over duration, and a sawtooth with a period', () => {
  assert.equal(progress({ start: 100, duration: 0, period: -1 }, 100), 1)
  assert.equal(progress({ start: 100, duration: 1000, period: -1 }, 600), 0.5)
  assert.equal(progress({ start: 100, duration: 1000, period: -1 }, 1600), 1.5)

  const curve = createCurve({ CLSID: 'LinearPCurve', points: [[0.5, 0.5, 0, 0]] })!

  // A period of 400 ms: 500 elapsed is a quarter in again, and never reaches 1.
  assert.equal(progress({ start: 0, duration: 1000, curve, period: 400 }, 500), 0.25)
  // A period of -1000, -1 or 0 means over the duration.
  assert.equal(progress({ start: 0, duration: 1000, curve, period: -1000 }, 250), 0.25)
})
