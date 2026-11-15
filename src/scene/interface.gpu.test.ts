import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Browser } from 'playwright'
import { launch, runFixture } from '#/harness.js'
import type { InterfaceReport } from './interface.fixture.js'

let browser: Browser
let report: InterfaceReport

before(async () => {
  browser = await launch()

  const { value } = await runFixture<InterfaceReport>(
    browser,
    new URL('./interface.fixture.ts', import.meta.url),
    { width: 64, height: 48, context: { antialias: false, alpha: false } },
  )

  report = value
})

after(() => browser.close())

const near = (actual: number[], expected: number[]) =>
  assert.ok(
    actual.every((value, at) => Math.abs(value - expected[at]!) <= 1),
    `${actual} against ${expected}`,
  )

test('raises no GL error', () => assert.equal(report.error, 0))

test('draws over the frame beneath, keeping its colour', () =>
  near(report.corner, [0, 0, 255, 255]))

test('colours a ui_ material with its tint, under white ambient and no lights', () =>
  near(report.tinted, [0x87, 0xc3, 0xe0, 255]))

test('tests no depth: a farther square drawn later covers a nearer one', () =>
  near(report.overlap, [0x87, 0xc3, 0xe0, 255]))

test('culls nothing: a square facing away still draws', () =>
  near(report.backFacing, [255, 255, 0, 255]))
