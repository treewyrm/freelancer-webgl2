import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Browser } from 'playwright'
import { launch, runFixture } from '#/harness.js'
import type { ContextReport } from './context.fixture.js'

let browser: Browser

before(async () => {
  browser = await launch()
})

after(() => browser.close())

test('acquires WebGL2 on the hardware GPU, with the DXT formats retail textures use', async (t) => {
  const { value, renderer } = await runFixture<ContextReport>(
    browser,
    new URL('./context.fixture.ts', import.meta.url),
  )

  t.diagnostic(renderer)
  assert.match(value.version, /^WebGL 2\.0/)
  assert.deepEqual(value.pixel, [255, 0, 0, 255])
  assert.equal(value.s3tc, true)
})
