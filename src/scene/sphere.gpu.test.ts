import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Browser } from 'playwright'
import { launch, runFixture } from '#/harness.js'
import type { SphereReport } from './sphere.fixture.js'

let browser: Browser
let report: SphereReport

before(async () => {
  browser = await launch()
  const { value } = await runFixture<SphereReport>(
    browser,
    new URL('./sphere.fixture.ts', import.meta.url),
    { width: 64, height: 64, context: { antialias: false, alpha: false } },
  )
  report = value
})

after(() => browser.close())

test('raises no GL error', () => assert.equal(report.error, 0))

test('each side shows where the file says: +Z, +X, -Z, -X, +Y, -Y', () => {
  assert.deepEqual(report.pixels['front'], [255, 0, 0])
  assert.deepEqual(report.pixels['right'], [0, 255, 0])
  assert.deepEqual(report.pixels['back'], [0, 0, 255])
  assert.deepEqual(report.pixels['left'], [255, 255, 0])
  assert.deepEqual(report.pixels['top'], [0, 255, 255])
  assert.deepEqual(report.pixels['bottom'], [255, 0, 255])
})

test('neighbouring faces meet where the cube says', () => {
  assert.deepEqual(report.pixels['edgeLeft'], [255, 0, 0])
  assert.deepEqual(report.pixels['edgeRight'], [0, 255, 0])
  assert.deepEqual(report.pixels['edgeBelow'], [255, 0, 0])
  assert.deepEqual(report.pixels['edgeAbove'], [0, 255, 255])
})

test('every level closes: no missing cell, and no crack between faces', () => {
  assert.deepEqual(report.holes, { 3: 0, 4: 0, 5: 0, 6: 0, 9: 0 })
})

test("a shell's UVs follow the camera in the vertex shader, as retail wrote them", () => {
  // At the point facing the camera `u` is `Fade × k³`, of 255. It falls to the rim.
  assert.ok(Math.abs(report.shell[0]! - 0.5787 * 255) < 4, `${report.shell}`)
  for (let at = 1; at < report.shell.length; at++)
    assert.ok(report.shell[at]! < report.shell[at - 1]!, `${report.shell}`)
  // `v` is `1 - Alpha`, of 255: with k³ past 0.5, no fade.
  assert.ok(Math.abs(report.shellRow - 0.5 * 255) < 3, `${report.shellRow}`)
  assert.equal(report.shellDraws, 5)
})
