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

test('in a nebula, what it holds fades to its fog by depth, effects fade to black over its overlay', () => {
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

  // Over the fog overlay, at half the camera's depth: the fog's colour at alpha 127 over black.
  const overlay = [127, 63, 255].map((fog) => (fog * 127) / 255)
  const red = 255 * ((800 - 300) / 800) * 0.5
  const added = [overlay[0]! + red, overlay[1]!, overlay[2]!]

  for (const [index, value] of effect.entries())
    assert.ok(Math.abs(value - added[index]!) <= 1, `${effect} against ${added}`)
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

test("in a nebula's edge its sheets draw after the main lists, over what's nearer, then the overlay", () => {
  // The overlay alone: a tenth deep, 25 of 255 of red over the green square.
  const tenth = 25 / 255
  const overlay = [255 * tenth, 255 * (1 - tenth), 0]

  for (const [index, value] of report.sheets.unfilled.entries())
    assert.ok(Math.abs(value - overlay[index]!) <= 1, `${report.sheets.unfilled}`)

  // With no depth test, the sheet covers the square in the fog's red, which the overlay keeps.
  assert.deepEqual(report.sheets.filled, RED)
})

test("a far sun's glow draws first, under what's nearer, and fills the view past it", () => {
  assert.deepEqual(report.suns.behind, [GREEN, RED])
})

test("a sun's glow neither tests depth nor is hidden by what stands in front of it", () => {
  assert.deepEqual(report.suns.over, RED)
})

test('a glow whose texture has no alpha adds itself less what it covers: ONE, INVSRCCOLOR', () => {
  const grey = [(16 / 31) * 255, (32 / 63) * 255, (16 / 31) * 255]
  const dst = [0, 128, 0]
  const expected = grey.map((src, at) => src + dst[at]! * (1 - src / 255))

  for (const [index, value] of report.suns.screen.entries())
    assert.ok(Math.abs(value - expected[index]!) <= 2, `${report.suns.screen} against ${expected}`)
})

test("a sun's corona adds over what stands in front of it, at half its samples' alpha", () => {
  const [middle, corner] = report.corona

  // White at 127 of 255, added over green.
  for (const [index, value] of middle!.entries())
    assert.ok(Math.abs(value - [127, 255, 127][index]!) <= 1, `${middle}`)

  assert.deepEqual(corner, [0, 0, 0])
})

test("a screen quad takes the effects' fog by its W, as a light's flare does in a nebula", () => {
  const [plain, fogged] = report.quadFog

  assert.deepEqual(plain, [255, 255, 255])
  // Halfway through black fog from 0 to 300: half white.
  for (const value of fogged!) assert.ok(Math.abs(value - 127.5) <= 1, `${fogged}`)
})

test("a sun's corona writes no depth, so what a host draws after the frame isn't hidden by it", () => {
  assert.deepEqual(report.coronaDepth, [0, 0, 255])
})

test("a gate tunnel draws over the jump's clear, its second layer added ONE, INVSRCALPHA", () => {
  const [middle, corner] = report.tunnel

  assert.deepEqual(middle, [255, 255, 255])

  // Blue at 200 whole, then green at 31 / 255 over what that leaves.
  const expected = [0, 255, 200 * (1 - 31 / 255)]

  for (const [index, value] of corner!.entries())
    assert.ok(Math.abs(value - expected[index]!) <= 1, `${corner} against ${expected}`)
})

test('a shot adds over what stands behind it, and no further than its width', () => {
  const { over, beside } = report.beams

  assert.deepEqual(over, [255, 255, 255])
  assert.deepEqual(beside, GREEN)
})

test("a shot takes the depth test, and the effects' fog", () => {
  const { hidden, fogged } = report.beams

  assert.deepEqual(hidden, GREEN)
  assert.deepEqual(fogged, [0, 0, 0])
})

test("a tractor's line adds its colour over what's behind, under the depth test", () => {
  const { over, beside, hidden } = report.tractor

  assert.deepEqual(over, [255, 255, 0])
  assert.deepEqual(beside, GREEN)
  assert.deepEqual(hidden, GREEN)
})

test("a frame's own meshes are freed when it's drawn, however many frames go by", () => {
  assert.equal(report.beamBuffers, 0)
})

test("the cockpit's mesh shows over a nearer scene, as its pass clears depth", () => {
  const { mesh, bare } = report.cockpit

  assert.deepEqual(mesh, GREEN)
  assert.deepEqual(bare, RED, 'with neither HUD nor mesh, what the scene drew stands')
})

test("a cockpit's glass blends over the scene, in place or at the frame's end", () => {
  for (const glass of [report.cockpit.glass, report.cockpit.atEnd])
    for (const [index, value] of glass.entries())
      assert.ok(Math.abs(value - [127.5, 0, 127.5][index]!) <= 1, `${glass}`)
})
