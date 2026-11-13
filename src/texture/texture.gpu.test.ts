import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Browser } from 'playwright'
import { launch, runFixture } from '#/harness.js'
import type { TextureReport } from './texture.fixture.js'

let browser: Browser
let report: TextureReport

before(async () => {
  browser = await launch()

  const { value } = await runFixture<TextureReport>(
    browser,
    new URL('./texture.fixture.ts', import.meta.url),
    { width: 4, height: 4 },
  )

  report = value
})

after(() => browser.close())

const RED = [255, 0, 0, 255]
const GREEN = [0, 255, 0, 255]
const BLUE = [0, 0, 255, 255]
const WHITE = [255, 255, 255, 255]
const BLACK = [0, 0, 0, 255]

const expectAll = (expected: Record<string, number[]>) => {
  for (const [name, pixel] of Object.entries(expected)) assert.deepEqual(report[name], pixel, name)
}

test('the upload raises no GL error', () => assert.deepEqual(report['error'], [0]))

test('V = 0 samples the first row uploaded, and a top-left Targa is reversed', () =>
  expectAll({ v0: RED, u1: GREEN, v1: BLUE, flippedV0: BLUE }))

test('24-bit Targa reads back through R5G6B5 without shearing', () =>
  expectAll({ rgb565: RED, rgb565Green: GREEN, rgb565Second: WHITE }))

test('A1R5G5B5 keeps colour and alpha apart', () =>
  expectAll({
    rgb5a1: RED,
    rgb5a1Alpha: WHITE,
    rgb5a1Second: BLUE,
    rgb5a1SecondAlpha: BLACK,
  }))

test('DXT1 punches through by block, and DXT5 carries its alpha', () => {
  expectAll({
    dxt1: RED,
    dxt1Alpha: WHITE,
    dxt1Punched: BLACK,
    dxt1PunchedAlpha: BLACK,
    dxt5: GREEN,
    dxt5Alpha: [128, 128, 128, 255],
  })
})

test('a chain short of 1x1 is complete, with no blending between levels', () =>
  expectAll({ chainLevel0: RED, chainLevel1: BLUE, chainNoBlend: RED }))

test('filters within a level, and each wrap acts past the edge', () => {
  const [red, green, blue] = report['bilinear']!

  assert.ok(
    Math.abs(red! - 128) <= 1 && green === 0 && Math.abs(blue! - 128) <= 1,
    `${red},${blue}`,
  )
  expectAll({ wrapRepeat: RED, wrapMirror: BLUE, wrapClamp: BLUE })
})

test('cube faces sit on their axes, and carry a generated chain', () =>
  expectAll({
    cubePosX: RED,
    cubeNegX: GREEN,
    cubePosY: BLUE,
    cubeNegY: [255, 255, 0, 255],
    cubePosZ: [255, 0, 255, 255],
    cubeNegZ: [0, 255, 255, 255],
    cubeLastLevel: [0, 255, 255, 255],
  }))
