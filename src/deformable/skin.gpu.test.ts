import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Browser } from 'playwright'
import { launch, runFixture } from '#/harness.js'
import type { SkinReport } from './skin.fixture.js'

let browser: Browser
let report: SkinReport

before(async () => {
  browser = await launch()
  const { value } = await runFixture<SkinReport>(
    browser,
    new URL('./skin.fixture.ts', import.meta.url),
    { width: 128, height: 128, context: { antialias: false, alpha: false } },
  )
  report = value
})

after(() => browser.close())

const shift = (from: string, to: string) => {
  const [a, b] = [report.rows[from]!, report.rows[to]!]
  return [b[0]! - a[0]!, b[1]! - a[1]!]
}

test('raises no GL error', () => assert.equal(report.error, 0))

test('at bind the quad stands where its points say', () => {
  // 2 across at 10, under tan 45°: 128 × 2 / 20.
  const [left, right] = report.rows['bind']!
  assert.ok(Math.abs(right! - left! + 1 - 12.8) <= 1, `${report.rows['bind']}`)
})

test('it follows its one bone, 3 along', () => {
  for (const moved of shift('bind', 'moved')) assert.ok(Math.abs(moved - 19.2) <= 1, `${moved}`)
})

test('half weights move it half way', () => {
  for (const moved of shift('bind', 'blended')) assert.ok(Math.abs(moved - 9.6) <= 1, `${moved}`)
})

test('a root moving with its bones goes where the root does', () => {
  for (const moved of shift('bind', 'root')) assert.ok(Math.abs(moved + 12.8) <= 1, `${moved}`)
})

test('a bone carries the normal: head on is full, and at cos 0.6 it dims to match', () => {
  assert.equal(report.lit['faced'], 255)
  assert.ok(Math.abs(report.lit['turned']! - 0.6 * 255) <= 2, `${report.lit['turned']}`)
})
