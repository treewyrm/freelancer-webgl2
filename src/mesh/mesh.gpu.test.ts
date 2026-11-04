import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Browser } from 'playwright'
import { launch, runFixture } from '#/harness.js'
import type { MeshReport } from './mesh.fixture.js'

let browser: Browser
let report: MeshReport

before(async () => {
  browser = await launch()
  const { value } = await runFixture<MeshReport>(
    browser,
    new URL('./mesh.fixture.ts', import.meta.url),
    { width: 4, height: 4 },
  )
  report = value
})

after(() => browser.close())

test('raises no GL error', () => assert.deepEqual(report['error'], [0]))

test('each group draws its own vertices, whichever offset put them there', () => {
  assert.deepEqual(report['firstGroup'], [255, 0, 0, 255])
  assert.deepEqual(report['secondGroup'], [0, 255, 0, 255])
  assert.deepEqual(report['summedBases'], [0, 0, 255, 255])
})

test('attributes sit where the FVF puts them, and diffuse is B G R A', () => {
  // Normal is (base, 0, 1): the second triangle's base is 0.25.
  assert.deepEqual(report['normal'], [64, 0, 255, 255])
  assert.deepEqual(report['uv0'], [255, 0, 0, 255])
  assert.deepEqual(report['uv1'], [0, 255, 0, 255])
})
