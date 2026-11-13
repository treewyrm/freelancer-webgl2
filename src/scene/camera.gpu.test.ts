import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Browser } from 'playwright'
import { launch, runFixture } from '#/harness.js'
import type { CameraReport } from './camera.fixture.js'

let browser: Browser

before(async () => {
  browser = await launch()
})

after(() => browser.close())

test('world +X draws on the right, retail winding is front, and nearer depth wins', async () => {
  const { value } = await runFixture<CameraReport>(
    browser,
    new URL('./camera.fixture.ts', import.meta.url),
    { width: 64, height: 64 },
  )

  assert.equal(value.error, 0)
  assert.deepEqual(value.right, [255, 0, 0, 255])
  assert.deepEqual(value.left, [0, 0, 0, 255])
  assert.deepEqual(value.culled, [0, 0, 0, 255])
  assert.deepEqual(value.nearerWins, [0, 255, 0, 255])
})
