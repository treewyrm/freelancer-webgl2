import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Browser } from 'playwright'
import { launch, runFixture } from '#/harness.js'
import type { RoomReport } from './room.fixture.js'

let browser: Browser
let report: RoomReport

before(async () => {
  browser = await launch()

  const { value } = await runFixture<RoomReport>(
    browser,
    new URL('./room.fixture.ts', import.meta.url),
    { width: 32, height: 32, context: { antialias: false, alpha: false } },
  )

  report = value
})

after(() => browser.close())

test('raises no GL error', () => assert.equal(report.error, 0))

test("a room's exponential fog blends into its colour by W, as D3D's EXP and EXP2", () => {
  const { none, exp, exp2 } = report.fogged

  assert.deepEqual(none, [255, 255, 255])

  // At W = 50 and density 0.01: e^-0.5 and e^-0.25 of white over black.
  const near = (actual: number[], f: number) =>
    actual.forEach((channel) =>
      assert.ok(Math.abs(channel - 255 * f) <= 1, `${actual} ≉ ${255 * f}`),
    )

  near(exp, Math.exp(-0.5))
  near(exp2, Math.exp(-0.25))
})

test('a shadow blends its texture over the floor it lies on, at its alpha', () => {
  assert.deepEqual(report.shadow.bare, [255, 255, 255])

  // At the floor, 0.8 of alpha, squared: 163 of 255 of black over white.
  const left = Math.round(255 * (1 - 163 / 255))

  report.shadow.shadowed.forEach((channel) =>
    assert.ok(Math.abs(channel - left) <= 1, `${channel}`),
  )
})

test('a flashlight adds its glow and its bulb', () => {
  // A quarter of 255 is 63, twice.
  assert.deepEqual(report.flashlight, [126, 0, 0])
})
