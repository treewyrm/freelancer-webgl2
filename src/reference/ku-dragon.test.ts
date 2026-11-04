/** M3's first scene: a batched `DcDtOcOt` on an environment-mapped ship, against retail. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readCapture } from '#/capture/capture.js'
import { indexTextures } from '#/capture/texture-names.js'
import { collectFrame } from '#/scene/frame.js'
import { assertFrameMatches } from './compare.js'
import { loadScene } from './load.js'
import { scenes } from './scenes.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const run = join(references, 'ku_dragon/d3d8log.jsonl')
const skip = !existsSync(data)
  ? 'no retail DATA'
  : !existsSync(run)
    ? 'no ku_dragon capture in references'
    : false

const load = async () => {
  const read = async (path: string) => {
    const file = readFileSync(join(data, path))
    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
  }
  const { scene } = await loadScene(scenes.get('ku_dragon')!, read)
  return collectFrame(scene)
}

test(
  'the batched glass comes last, without a reflection',
  { skip: !existsSync(data) && 'no retail DATA' },
  async () => {
    const frame = await load()
    assert.deepEqual(frame.unsupported, [])
    const glass = frame.draws.filter(({ materialName }) => materialName === 'D_glass')
    assert.ok(glass.length > 0)
    for (const draw of glass) {
      assert.equal(draw.blend, true)
      assert.equal(draw.environment, undefined)
      assert.equal(draw.normalizeNormals, false)
    }
  },
)

test('the frame is retail draw for draw, in retail order', { skip }, async () => {
  const frame = await load()
  const draws = readCapture(readFileSync(run, 'utf8')).frames.at(-1)!.draws
  assertFrameMatches(frame, draws, indexTextures(data))
})
