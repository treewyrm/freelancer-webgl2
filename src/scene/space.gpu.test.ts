import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Browser } from 'playwright'
import { launch, runFixture } from '#/harness.js'
import type { SpaceReport } from './space.fixture.js'

let browser: Browser
let report: SpaceReport

before(async () => {
  browser = await launch()
  const { value } = await runFixture<SpaceReport>(
    browser,
    new URL('./space.fixture.ts', import.meta.url),
    { width: 32, height: 32, context: { antialias: false, alpha: false } },
  )
  report = value
})

after(() => browser.close())

const RED = [255, 0, 0]
const GREEN = [0, 255, 0]

test('raises no GL error', () => assert.equal(report.error, 0))

test('a far solar past the pass far plane draws, behind what the main list draws over it', () => {
  assert.deepEqual(report.beyondFar, [GREEN, RED])
})

test('the far list leaves no depth: the ship draws over a square in front of it', () => {
  assert.deepEqual(report.noDepth, [GREEN, RED])
})

test('on the main list the same square hides the ship', () => {
  assert.deepEqual(report.withDepth, [RED, RED])
})

test('a point light attenuates by distance and stops at its range, per vertex', () => {
  const [full, half, none] = report.pointLit
  const d = Math.sqrt(43)
  // With `NORMALIZENORMALS` off, the world's scale of 3 leaves the normal a third as long, as in D3D8.
  const facing = 5 / d / 3
  assert.ok(Math.abs(full! - 255 * facing) <= 1, `${full}`)
  assert.ok(Math.abs(half! - (255 * facing) / (0.4 * d)) <= 1, `${half}`)
  // Its range reaches the middle, but no corner, and D3D8 lights the corners.
  assert.equal(none, 0)
})
