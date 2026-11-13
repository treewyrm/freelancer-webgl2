import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Browser } from 'playwright'
import { launch, runFixture } from '#/harness.js'
import type { EffectReport } from './effect.fixture.js'

let browser: Browser
let report: EffectReport

before(async () => {
  browser = await launch()

  const { value } = await runFixture<EffectReport>(
    browser,
    new URL('./effect.fixture.ts', import.meta.url),
    { width: 64, height: 64, context: { antialias: false, alpha: false } },
  )

  report = value
})

after(() => browser.close())

test('raises no GL error', () => assert.equal(report.error, 0))

test('a basic quad is a half-extent, colour modulated by alpha, additively', () => {
  // 2 of a 10-wide view on 64 pixels.
  assert.ok(Math.abs(report.basicSpan - 12.8) <= 1, `${report.basicSpan}`)
  // `_ftol(0.5 × 255)` is 127, and SourceAlpha / One over black.
  assert.deepEqual(report.basicCentre.slice(0, 3), [127, 0, 0])
})

test('alpha goes into the top byte unclamped, and wraps', () => {
  // `_ftol(1.5 × 255)` is 382, whose low byte is 126.
  assert.deepEqual(report.alphaWrapped.slice(0, 3), [126, 126, 126])
})

test('a basic particle under an alpha of 0.01 is not drawn, and one over is', () => {
  // Both fills skip it before building it (`fcomp` 0.01 at `0x6216735` and `0x62171d5`);
  // `_ftol(0.0101 × 255)` is 2.
  assert.deepEqual(report.faint.under.slice(0, 3), [0, 0, 0])
  assert.deepEqual(report.faint.over.slice(0, 3), [2, 2, 2])
})

test('a roll of a quarter turn takes the wide axis to the vertical', () => {
  assert.ok(Math.abs(report.rolled.above - 38.4) <= 1.5, `${report.rolled.above}`)
  assert.ok(Math.abs(report.rolled.right - 12.8) <= 1.5, `${report.rolled.right}`)
})

test('with no QuadTexture it is the equilateral triangle: apex at 2S, base √3·S either side, retail not the decomp', () => {
  const { apexRow, baseRow, baseSpan } = report.triangle

  // Apex 2 up and base 1 down: 3 of 10 on 64 is 19 rows.
  assert.ok(Math.abs(apexRow - baseRow - 18.2) <= 2, `${apexRow - baseRow}`)
  assert.ok(apexRow - 32 > 32 - baseRow, `${apexRow} ${baseRow}`)
  // 2√3 of 10 on 64 is 22.
  assert.ok(Math.abs(baseSpan - 22) <= 3, `${baseSpan}`)
})

test('MotionBlur stretches along the motion, and leaves the width', () => {
  assert.ok(report.blurSpan.y > 25, `${report.blurSpan.y}`)
  assert.ok(Math.abs(report.blurSpan.x - 12.8) <= 2, `${report.blurSpan.x}`)
})

test('a rect runs a full length ahead of its particle, or centres on it, and end-on it is gone', () => {
  assert.ok(report.rect.above > 22 && report.rect.below === 0, JSON.stringify(report.rect))
  assert.ok(Math.abs(report.rect.span - 6.4) <= 1.5, `${report.rect.span}`)
  assert.ok(report.rectCentered.above > 10 && report.rectCentered.below > 10)
  assert.equal(report.rectEndOn, 0)
})

test("a perp's Size is the full extent, and with the fade it is gone edge-on", () => {
  assert.ok(Math.abs(report.perp.span - 12.8) <= 1, `${report.perp.span}`)
  assert.equal(report.perp.perpFadeEdgeOn, 0)
})

test("a perp's u runs along its roll, which starts from +X", () => {
  const { left, right } = report.perp.roll

  assert.ok(left[0]! > left[1]!, `${left}`)
  assert.ok(right[1]! > right[0]!, `${right}`)
})

test('a beam chains its particles along their path', () => {
  assert.ok(report.beam.lit > 5, `${report.beam.lit}`)
  assert.equal(report.beam.offChain[0], 0)
  assert.ok(report.beam.onChain[0]! > 0)
})

test('order under a blend that cares follows the tree, not the file', () => {
  // One / Zero: the last drawn wins. Beside the root draws before what's under it, though later in the file.
  assert.deepEqual(report.blendOrder.under.slice(0, 3), [0, 255, 0])
  // Siblings of one class keep entry order.
  assert.deepEqual(report.blendOrder.over.slice(0, 3), [255, 0, 0])
})

test('hooks: opaque before the effects, end after, and neither changes a pixel', () => {
  assert.equal(report.hookSeesEffects.opaque[0], 0)
  assert.ok(report.hookSeesEffects.end[0]! > 0)
  assert.equal(report.emptyHookMatches, true)
})

test('a lost context rebuilds from the next frame', () =>
  assert.deepEqual(report.afterRestore.after, report.afterRestore.before))

test("an appearance's scale resizes a perp, built in its frame, and not a basic, built in the view", () => {
  assert.ok(Math.abs(report.scaleMovesBasic - 12.8) <= 1, `${report.scaleMovesBasic}`)
  assert.ok(Math.abs(report.scaleResizesPerp - 25.6) <= 2, `${report.scaleResizesPerp}`)
})

test("a particle's frame -1 is the playback's, and one past either end is the last (GetFrame)", () => {
  const { current, past, inside } = report.frameChoice

  assert.deepEqual(
    [current.slice(0, 3), past.slice(0, 3), inside.slice(0, 3)],
    [
      [0, 0, 255],
      [255, 255, 255],
      [0, 255, 0],
    ],
  )
})

test("a hook's outline frames each sprite through its own corners, and draws no sprite", () => {
  const { edges, axisX, axisY, inside, perpNormal, error } = report.outlined

  assert.equal(error, 0)
  // Half-extent 1 of a 10-wide view on 64 pixels: edges 6.4 either side of the middle.
  assert.equal(edges.length, 2, `${edges}`)
  assert.ok(Math.abs(edges[0]! - 25.6) <= 1 && Math.abs(edges[1]! - 38.4) <= 1, `${edges}`)
  // Centre to edge, about 6 pixels each.
  assert.ok(Math.abs(axisX - 6.4) <= 1.5, `${axisX}`)
  assert.ok(Math.abs(axisY - 6.4) <= 1.5, `${axisY}`)
  assert.deepEqual(inside.slice(0, 3), [0, 0, 0])
  // Half of the two half-extents of 1.
  assert.ok(Math.abs(perpNormal - 6.4) <= 1.5, `${perpNormal}`)
})
