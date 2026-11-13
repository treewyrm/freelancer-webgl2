/** A retail cutscene held at its end through THN playback: it plays, and once captured, retail agrees. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Matrix4 } from '@treewyrm/freelancer/math'
import * as thn from '@treewyrm/freelancer/thn'
import * as thnScene from '@treewyrm/freelancer/thn/scene'
import { read as readText } from '@treewyrm/freelancer/thn/text'
import { readCapture } from '#/capture/capture.js'
import { collectRoomFrame } from '#/scene/room.js'
import { cutscenes, heldScript, heldText } from './cutscene.js'
import { loadRoomHardpoints, playScripts, retailRoomScene } from './retail-room.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const { script, capture } = cutscenes.get('cutscene_m13')!
const run = join(references, 'cutscene_m13', 'd3d8log.jsonl')

/**
 * Rotation cells tight; translation cells within 0.05, as retail multiplies in floats through world
 * positions near 20,000, whose ulp alone is 0.002, so its error doesn't shrink with the result's.
 */
const near = (a: number, b: number, cell: number) => Math.abs(a - b) <= (cell >= 9 ? 0.05 : 1e-4)

const read = async (path: string) => {
  const file = readFileSync(join(data, path))

  return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
}

test(
  'the held cutscene is the retail script an hour long, and reads back the same',
  { skip: existsSync(data) ? false : 'no retail DATA' },
  async () => {
    const bytes = await read(script)
    const retail = thnScene.read(thn.read(bytes))
    const back = thnScene.read(readText(heldText(bytes)))

    assert.equal(back.duration, 3600)
    assert.deepEqual(back.events, retail.events)
    assert.equal(back.entities.length, retail.entities.length)
  },
)

const settled = async () => {
  const room = playScripts([heldScript(await read(script))], capture)

  return { room, frame: collectRoomFrame(await retailRoomScene(read, room, 1024 / 768)) }
}

test(
  "m13's hypergate plays to its end through the monitor, every placement finite",
  { skip: existsSync(data) ? false : 'no retail DATA' },
  async () => {
    const { room, frame } = await settled()
    const playback = room.manager.sequences[0]!.playback!
    // A monitor has been cut to a camera: the view is the script's, not a room's.
    const monitors = playback.script.entities.filter(({ type }) => type === 'MONITOR')

    assert.ok(monitors.some(({ entity_name }) => playback.linkedCamera(entity_name) !== undefined))
    assert.ok(frame.draws.length > 0)
    for (const { world } of frame.draws) assert.ok(Matrix4.isFinite(world))
  },
)

test(
  'cutscene_m13: every draw we make is one retail made, by its modelview',
  {
    skip: !existsSync(data)
      ? 'no retail DATA'
      : !existsSync(run)
        ? 'no cutscene_m13 capture in references'
        : false,
  },
  async () => {
    const { frame } = await settled()
    const retail = readCapture(readFileSync(run, 'utf8')).frames.at(-1)!.draws

    const missing = frame.draws.filter(({ world }) => {
      const mv = Matrix4.multiply(frame.view, world)
      const ours = [mv.x, mv.y, mv.z, mv.w].flatMap(({ x, y, z }) => [x, y, -z])

      return !retail.some(
        (draw) =>
          draw.world &&
          ours.every((cell, i) => near(cell, draw.world![Math.trunc(i / 3) * 4 + (i % 3)]!, i)),
      )
    })

    assert.deepEqual(
      missing.map(({ materialName }) => materialName),
      [],
    )
  },
)

test(
  "m13's effects ride the hardpoints they attach to, as the host answers them",
  { skip: existsSync(data) ? false : 'no retail DATA' },
  async () => {
    const scripts = [thnScene.read(thn.read(await read(script)))]
    const hardpoint = await loadRoomHardpoints(read, scripts)
    const playback = playScripts(scripts, 45, { hardpoint }).manager.sequences[0]!.playback!
    const at = (name: string) => playback.world(name)!.w
    const on = (entity: string, point: string) =>
      Matrix4.multiply(playback.world(entity)!, hardpoint(entity, point)!).w

    for (const [effect, entity, point] of [
      // Attached until 1.9 s, started at 32.4: it stays where the attach left it.
      ['FX_dyson_city_beam_1', 'dyson_Nomad_city', 'hpfx03'],
      ['FX_dyson_city_beam_4', 'dyson_Nomad_city', 'hpfx05'],
      ['FX_dyson_city_beam_5', 'dyson_Nomad_city', 'hpfx06'],
    ] as const) {
      const [a, b] = [at(effect), on(entity, point)]

      assert.ok(
        Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.05,
        `${effect} at ${entity} ${point}`,
      )
    }
  },
)
