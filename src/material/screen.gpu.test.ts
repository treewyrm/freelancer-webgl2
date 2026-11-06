import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Browser } from 'playwright'
import { launch, runFixture } from '#/harness.js'
import type { ScreenReport } from './screen.fixture.js'

let browser: Browser
let report: ScreenReport

before(async () => {
  browser = await launch()
  const { value } = await runFixture<ScreenReport>(
    browser,
    new URL('./screen.fixture.ts', import.meta.url),
    { width: 32, height: 32, context: { antialias: false, alpha: false } },
  )
  report = value
})

after(() => browser.close())

test('raises no GL error', () => assert.equal(report.error, 0))

test("a quad covers D3D's pixels from x0 up to x1, and its colour times the texture adds", () => {
  const { row } = report
  assert.deepEqual(row[3], [0, 0, 0])
  // 0x40 times (255, 128, 255): 64, 32, 64.
  for (const x of [4, 5, 6, 7]) assert.deepEqual(row[x], [64, 32, 64], `x ${x}`)
  for (const x of [8, 9, 10, 11]) assert.deepEqual(row[x], [128, 64, 128], `x ${x}`)
  for (const x of [12, 15]) assert.deepEqual(row[x], [64, 32, 64], `x ${x}`)
  assert.deepEqual(row[16], [0, 0, 0])
})

test('quads test depth with LEQUAL and write none', () => {
  // Both draw: the farther at the clear's own depth, behind the nearer.
  for (const x of [4, 11]) assert.deepEqual(report.depthRow[x], [64, 32, 64], `x ${x}`)
})
