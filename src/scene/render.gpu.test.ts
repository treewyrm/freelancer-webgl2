import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Browser } from 'playwright'
import { launch, runFixture } from '#/harness.js'
import type { RenderReport } from './render.fixture.js'

let browser: Browser
let report: RenderReport

before(async () => {
  browser = await launch()
  const { value } = await runFixture<RenderReport>(
    browser,
    new URL('./render.fixture.ts', import.meta.url),
    { width: 32, height: 32, context: { antialias: false, alpha: false } },
  )
  report = value
})

after(() => browser.close())

test('raises no GL error', () => assert.equal(report.error, 0))

test('a hook that draws nothing changes no pixel, even leaving GL state wrecked', () => {
  assert.equal(report.emptyHooksMatch, true)
  assert.equal(report.trashingHooksMatch, true)
})

test('hooks run in frame order, and a host draws with the game path depth', () => {
  assert.deepEqual(report.hookOrder, ['begin', 'opaque', 'end'])
  // Half green over red: the far triangle at `opaque` lost to the opaque square's depth.
  const [red, green, blue] = report.opaqueHookSeesDepth
  assert.ok(
    Math.abs(red! - 128) <= 1 && Math.abs(green! - 128) <= 1 && blue === 0,
    `${red},${green},${blue}`,
  )
  assert.deepEqual(report.endHookDraws, [0, 0, 255, 255])
})

test('a hook, and the host after a frame, find no sampler object overriding their textures', () => {
  assert.deepEqual(report.samplersInHook, [false, false])
  assert.deepEqual(report.samplersAfter, [false, false])
})

test('models on one mesh share its vertex buffer', () => {
  // One vertex buffer and two index buffers, one array per reference.
  assert.deepEqual(report.sharedBuffers, { vertexBuffers: 4, arrays: 2 })
})

test('invalidating an asset rebuilds it alone', () => {
  assert.equal(report.afterInvalidate.before[0], 255)
  assert.deepEqual(report.afterInvalidate.after, [0, 0, 0, 255])
  assert.equal(report.afterInvalidate.untouched, true)
})

test('a lost context draws nothing, and the next frame rebuilds it', () => {
  assert.equal(report.whileLost, false)
  assert.deepEqual(report.afterRestore, { drew: true, matches: true })
})

test('disposal is complete and final, and leaves other renderers alone', () => {
  assert.equal(report.liveAfterDispose.buffers, 0)
  assert.equal(report.liveAfterDispose.textures, 1)
  assert.equal(report.disposedThrows, true)
  assert.equal(report.otherRendererStillDraws, true)
})
