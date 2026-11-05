/** Four retail skies against what the game drew: `usr_flg` 1's override over each material class. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Matrix4 } from '@treewyrm/freelancer/math'
import { readCapture } from '#/capture/capture.js'
import { indexTextures } from '#/capture/texture-names.js'
import { collectFrame } from '#/scene/frame.js'
import { assertFrameMatches } from './compare.js'
import { loadScene } from './load.js'
import { scenes } from './scenes.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'

for (const name of ['starsphere_li01', 'starsphere_st03b', 'starsphere_ew05', 'starsphere_ew06']) {
  const run = join(references, name, 'd3d8log.jsonl')
  const skip = !existsSync(data)
    ? 'no retail DATA'
    : !existsSync(run)
      ? `no ${name} capture in references`
      : false

  test(`${name} is retail draw for draw, where the camera alone places it`, { skip }, async () => {
    const read = async (path: string) => {
      const file = readFileSync(join(data, path))
      return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
    }
    const { scene } = await loadScene(scenes.get(name)!, read)
    const frame = collectFrame(scene)
    const retail = readCapture(readFileSync(run, 'utf8')).frames.at(-1)!.draws
    assert.deepEqual(frame.unsupported, [])
    assertFrameMatches(frame, retail, indexTextures(data))

    frame.draws.forEach(({ world, materialName }, n) => {
      const modelView = Matrix4.multiply(frame.view, world)
      const columns = [modelView.x, modelView.y, modelView.z, modelView.w]
      // Retail's world is the modelview with Z flipped, written as rows for row vectors.
      columns.forEach((column, c) =>
        [column.x, column.y, -column.z].forEach((cell, r) => {
          const theirs = retail[n]!.world![c * 4 + r]!
          assert.ok(
            Math.abs(cell - theirs) < 0.01,
            `draw ${n}, ${materialName}: ${cell}, ${theirs}`,
          )
        }),
      )
    })
  })
}
