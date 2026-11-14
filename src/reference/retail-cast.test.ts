/** A retail story scene's cast, made through `thorn`'s cast from the install's costumes. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Matrix4 } from '@treewyrm/freelancer/math'
import * as thn from '@treewyrm/freelancer/thn'
import * as thnScene from '@treewyrm/freelancer/thn/scene'
import { castEntities } from '#/thorn/cast.js'
import { loadCast } from './retail-cast.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const SCRIPT = 'SCRIPTS/STORY/s011x_nrml_juni_li_05_deck_01.thn'

const read = async (path: string) => {
  const file = readFileSync(join(data, path))

  return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
}

test(
  "s011x's characters are cast from their costumes, each standing at its record with a skeleton",
  { skip: existsSync(data) ? false : 'no retail DATA' },
  async () => {
    const scripts = [thnScene.read(thn.read(await read(SCRIPT)))]
    const entities = castEntities(scripts)
    const cast = await loadCast(read, scripts)
    const made = entities.filter(({ entity_name }) => cast.member(entity_name))

    assert.ok(made.length > 0, cast.skipped.join('; '))

    for (const { entity_name, spatialprops } of made) {
      const { mixer, models } = cast.member(entity_name)!
      const placed = cast.place(entity_name, Matrix4.identity, {
        position: { x: 0, y: 0, z: -10 },
        orientation: Matrix4.identity,
        fovh: 60,
        near: 1,
        far: 1000,
      })

      assert.ok(models.length > 0)
      assert.ok(placed && placed.length === models.length)
      assert.deepEqual(mixer.root.position, {
        x: spatialprops?.pos?.x ?? 0,
        y: spatialprops?.pos?.y ?? 0,
        z: spatialprops?.pos?.z ?? 0,
      })
    }
  },
)
