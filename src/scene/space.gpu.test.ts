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

test('in a nebula, what it holds fades to its fog by depth, and effects fade to black', () => {
  const { square, effect, unfoggedEffect } = report.fogged
  // The camera is half through the fog: it ends 200 away, and 1 / 0.75² that for the square, which
  // is three quarters in. D3D's linear fog at W = 50, blending white into (127, 63, 255).
  const end = 200 / 0.75 ** 2
  const f = (end - 50) / end
  const expected = [127, 63, 255].map((fog) => 255 * f + fog * (1 - f))
  for (const [index, value] of square.entries())
    assert.ok(Math.abs(value - expected[index]!) <= 1, `${square} against ${expected}`)
  // Effects use the camera's fog: it ends at 200 / 0.5², and the quad is 300 away.
  assert.deepEqual(unfoggedEffect, [127, 0, 0])
  const red = 255 * ((800 - 300) / 800) * 0.5
  assert.ok(Math.abs(effect[0]! - red) <= 1, `${effect}`)
  assert.deepEqual(effect.slice(1), [0, 0])
})

test('an equipment spot lights within its outer cone, fading from its inner, per vertex', () => {
  const [wide, partial, narrow] = report.spotLit
  // Each corner is √43 away and 40.3° off its axis, by 1 + 16 / 50² · 43.
  const d = Math.sqrt(43)
  const lit = (255 * (5 / d / 3)) / (1 + (16 / 2500) * 43)
  const angle = Math.acos(5 / d)
  // 179°: inside the inner cone of 89.5°. 120°: between 30° and 60°. 60°: outside 30°.
  assert.ok(Math.abs(wide! - lit) <= 1, `${wide}`)
  const cos = (degrees: number) => Math.cos((degrees * Math.PI) / 180)
  const spot = (Math.cos(angle) - cos(60)) / (cos(30) - cos(60))
  assert.ok(Math.abs(partial! - lit * spot) <= 1, `${partial}`)
  assert.equal(narrow, 0)
})

test('in space, an effect in the plane of what is drawn still draws, as LESSEQUAL lets it', () => {
  // Half red, added.
  assert.deepEqual(report.coplanar.space, [127, 0, 0])
  assert.deepEqual(report.coplanar.less, [0, 0, 0])
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

test("a ring's band draws in its colour, blended by its opacity, the detail doubling it", () => {
  const [r, g, b] = report.ring.plain
  // Half of 255, the opacity halved without a detail shape.
  assert.ok(Math.abs(r! - 127.5) <= 1 && g === 0 && b === 0, `${report.ring.plain}`)
  assert.deepEqual(report.ring.detailed, [255, 0, 0])
})

test("a field's band draws in its texture and vertex colour, and cull mode 2 hides its near face", () => {
  // The near face, unbaked, is white on the red texture.
  assert.deepEqual(report.band.drawn, RED)
  // Then only the far side shows through, from behind: its unbaked back colour, 0.2.
  assert.deepEqual(report.band.culled, [51, 0, 0])
})
