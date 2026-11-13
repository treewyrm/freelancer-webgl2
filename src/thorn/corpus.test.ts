import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Matrix4 } from '@treewyrm/freelancer/math'
import * as thn from '@treewyrm/freelancer/thn'
import * as scene from '@treewyrm/freelancer/thn/scene'
import { Playback } from './playback.js'
import { ScriptRun } from './script.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const scripts = join(data, 'SCRIPTS')

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)

    return statSync(path).isDirectory()
      ? walk(path)
      : name.toLowerCase().endsWith('.thn')
        ? [path]
        : []
  })

test(
  'every retail script plays to its end with every placement finite',
  { skip: existsSync(scripts) ? false : 'no retail DATA' },
  () => {
    const files = walk(scripts)

    assert.ok(files.length > 1000)

    const failures: string[] = []

    for (const file of files) {
      const script = scene.read(thn.read(new Uint8Array(readFileSync(file))))
      const run = new ScriptRun(new Playback(script))
      // 60 frames a second, as uneven as the carry makes them.
      for (let frame = 0; frame < 100_000 && !run.update(frame % 3 === 0 ? 16 : 17); frame++);

      for (const { entity_name } of script.entities) {
        const world = run.playback.world(entity_name)
        if (world && !Matrix4.isFinite(world)) failures.push(`${file}: ${entity_name}`)
      }
    }

    assert.deepEqual(failures, [])
  },
)
