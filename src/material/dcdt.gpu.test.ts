import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Browser } from 'playwright'
import { launch, runFixture } from '#/harness.js'
import type { DcDtReport } from './dcdt.fixture.js'

let browser: Browser
let report: DcDtReport

before(async () => {
  browser = await launch()
  const { value } = await runFixture<DcDtReport>(
    browser,
    new URL('./dcdt.fixture.ts', import.meta.url),
    { width: 8, height: 8 },
  )
  report = value
})

after(() => browser.close())

// Within one step of 255, for how a GPU rounds to 8 bits.
const rgb = (name: string, expected: number[]) => {
  const actual = report[name]!
  expected.forEach((value, channel) =>
    assert.ok(
      Math.abs(actual[channel]! - value) <= 1,
      `${name}: ${actual.slice(0, 3)} against ${expected}`,
    ),
  )
}

test('raises no GL error', () => assert.deepEqual(report['error'], [0]))

test('ambient is material × scene, and emissive adds', () => {
  rgb('ambient', [51, 51, 102])
  rgb('emissive', [64, 0, 128])
})

test('diffuse follows N·L, and goes no lower than nothing', () => {
  rgb('facing', [128, 64, 255])
  rgb('atSixty', [64, 32, 128])
  rgb('behind', [0, 0, 0])
  rgb('negated', [128, 64, 255])
  rgb('twoLights', [128, 128, 128])
})

test('a normal keeps its length unless normalized', () => {
  rgb('longNormal', [128, 128, 128])
  rgb('longNormalized', [64, 64, 64])
})

test('the vertex saturates before the texture, and an empty stage is white', () => {
  rgb('clampedBeforeTexture', [128, 128, 128])
  rgb('noTextureIsWhite', [128, 64, 255])
})

test('the reflecting stage is 2X, clamped', () => {
  rgb('twoXClamps', [255, 255, 255])
  rgb('twoX', [102, 102, 102])
})

test('the reflection lands on the right cube face, in D3D space', () => {
  rgb('reflectBack', [0, 255, 255])
  rgb('reflectSide', [255, 0, 0])
})

test('lights and normals turn with the view', () => rgb('turnedView', [128, 64, 255]))

test('alpha test is GREATER on the 8-bit value', () => {
  rgb('alphaKept', [255, 255, 255])
  rgb('alphaCut', [0, 0, 255])
  rgb('alphaZero', [0, 0, 255])
})

test('a vertex colour replaces the material diffuse, alpha included, in B G R A', () => {
  rgb('vertexColor', [255, 128, 64])
  rgb('vertexColorAlpha', [0, 0, 255])
  rgb('vertexColorOff', [0, 255, 0])
})
