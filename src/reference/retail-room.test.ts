/** A retail base room built through THN playback: it plays, and once captured, retail agrees. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Matrix4 } from '@treewyrm/freelancer/math'
import { readCapture } from '#/capture/capture.js'
import { collectRoomFrame } from '#/scene/room.js'
import { playRetailRoom, retailRoomScene } from './retail-room.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const ROOM = 'UNIVERSE/SYSTEMS/LI01/BASES/ROOMS/li01_01_cityscape.ini'
const run = join(references, 'base_li01_01', 'd3d8log.jsonl')

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
  "Li01_01's Cityscape plays its ambient scenes and draws, every placement finite",
  { skip: existsSync(data) ? false : 'no retail DATA' },
  async () => {
    const room = await playRetailRoom(read, ROOM, 10)

    assert.ok(room.manager.sequences.length > 0)
    assert.ok(room.set.props.length > 0)

    const scene = await retailRoomScene(read, room, 1024 / 768)
    const frame = collectRoomFrame(scene)

    assert.ok(frame.draws.length > 0)
    for (const { world } of frame.draws) assert.ok(Matrix4.isFinite(world))
  },
)

test(
  'base_li01_01: every draw we make is one retail made, by its modelview',
  {
    skip: !existsSync(data)
      ? 'no retail DATA'
      : !existsSync(run)
        ? 'no base_li01_01 capture in references'
        : false,
  },
  async () => {
    // The set script's props alone, which stand still whenever F9 is pressed: the ambient scenes'
    // traffic moves, and so do the Room model's own parts under its `animation = Sc_loop`. The view is the room's `[Camera]`, as no ambient scene has a monitor.
    const room = await playRetailRoom(read, ROOM, 10)
    const frame = collectRoomFrame(
      await retailRoomScene(read, room, 1024 / 768, { playing: false, still: true }),
    )
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
