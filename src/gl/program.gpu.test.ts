import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Browser } from 'playwright'
import { launch, runFixture, saveArtifact } from '#/harness.js'
import type { ProgramReport } from './program.fixture.js'

let browser: Browser

before(async () => {
  browser = await launch()
})

after(() => browser.close())

test('draws through a library Matrix4, and reports GLSL errors', async () => {
  const { value, png } = await runFixture<ProgramReport>(
    browser,
    new URL('./program.fixture.ts', import.meta.url),
    { width: 64, height: 64 },
  )

  await saveArtifact('program', png)

  assert.deepEqual(value.center, [0, 0, 0, 255])
  assert.deepEqual(value.translated, [0, 255, 0, 255])
  assert.match(value.compileError ?? '', /^Shader compilation failed: /)
})
