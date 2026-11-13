/**
 * `beam_shots` against retail: `rh_elite` firing `li_gun01_mark01`'s spear and
 * `fc_ou_gun02_mark03`'s bolt at nothing, one click each, three frames twice. Each frame's shots are
 * rebuilt where retail drew them, turned by `lookMatrix` of their direction, and compared vertex for
 * vertex, and the batch's draw state for state.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Vector3 } from '@treewyrm/freelancer/math'
import { readCapture, type CaptureDraw } from '#/capture/capture.js'
import { contentHash, namesOf, type TextureIndex } from '#/capture/texture-names.js'
import { BeamEffect, beamBatch, beamDraw, lookMatrix, type BeamArchetype } from '#/scene/beam.js'
import type { Frame } from '#/scene/frame.js'
import { planUpload } from '#/texture/upload.js'
import { Directory } from '@treewyrm/freelancer/utf'
import { assertFrameMatches } from './compare.js'
import { loadBeamEffects } from './space-load.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const run = join(references, 'beam_shots')
const skip = !existsSync(data)
  ? 'no retail DATA'
  : !existsSync(join(run, 'd3d8log.jsonl'))
    ? 'no beam_shots capture in references'
    : false

const read = async (path: string) => {
  const file = readFileSync(join(data, path))

  return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
}

// The scene, the ship, then the effects, the last at 62: the bolt's own effect and the engine's.
const BEAMS = 63

/** Retail's order: the bolt fired from `HpWeapon02`, then the spear from `HpWeapon01`. */
const SHOTS = [
  { nickname: 'pi_particle_03_beam', vertices: 17, speed: 600 },
  { nickname: 'li_laser_01_beam', vertices: 12, speed: 750 },
] as const

const vector = ([x, y, z]: readonly number[]): Vector3 => ({ x: x!, y: y!, z: z! })
const less = (a: readonly number[], b: readonly number[]) => a.map((value, at) => value - b[at]!)

/** Each shot's centre and direction in a frame's batch: its first vertex, and toward its tip. */
const shotsOf = (draw: CaptureDraw) => {
  let start = 0

  return SHOTS.map((shot) => {
    const vertices = draw.vertexData!.slice(start, start + shot.vertices)

    start += shot.vertices

    // The tip's vertex follows the centre's second copy: at 6 in either kind.
    const ahead = less(vertices[6]!.p, vertices[0]!.p)
    const length = Math.hypot(...ahead)

    return {
      ...shot,
      vertices,
      position: vector(vertices[0]!.p),
      direction: vector(ahead.map((value) => value / length)),
    }
  })
}

/**
 * `code_beam`'s levels as retail's device holds them: a 16-bit Targa's 5-bit channels, rows as
 * stored, into R5G6B5 with green rounded to 6 bits. Hashes pin it, all seven levels.
 */
const retailCodeBeam = async (): Promise<Uint16Array[]> => {
  const library = Directory.read(await read('FX/beam.txm'))
  const entry = [...library.children]
    .flatMap((node) => (node instanceof Directory ? [...node.children] : []))
    .find((node) => node.name.toLowerCase() === 'code_beam')

  assert.ok(entry instanceof Directory)

  const levels = [...entry.children].sort((a, b) => a.name.localeCompare(b.name))

  return levels.map((level) => {
    assert.ok(!(level instanceof Directory))

    const { buffer, byteOffset, byteLength } = level.data
    const bytes = new Uint8Array(buffer, byteOffset, byteLength)

    // An uncompressed true-colour Targa of 16 bits, bottom-left first.
    assert.deepEqual([bytes[2], bytes[16], bytes[17]], [2, 16, 0])

    const texels = new Uint16Array((bytes.length - 18) / 2)

    texels.forEach((_, at) => {
      const texel = bytes[18 + at * 2]! | (bytes[19 + at * 2]! << 8)
      const green = (texel >> 5) & 31

      texels[at] = ((texel >> 10) << 11) | (Math.round((green * 63) / 31) << 5) | (texel & 31)
    })
    return texels
  })
}

const bytesOf = (texels: Uint16Array) =>
  new Uint8Array(texels.buffer, texels.byteOffset, texels.byteLength)

const load = async () => {
  const { beams, texture } = await loadBeamEffects(read)
  const { frames } = readCapture(readFileSync(join(run, 'd3d8log.jsonl'), 'utf8'))

  return { beams, texture, frames }
}

/** A shot grown to its length: its first frame, then one step past its growth. */
const grown = (archetype: BeamArchetype, position: Vector3, direction: Vector3, speed: number) => {
  const shot = new BeamEffect(archetype, {
    orientation: lookMatrix(direction),
    position,
    speed,
    look: true,
  })

  shot.walk(0, () => 'draw', beamBatch())

  const batch = beamBatch()

  shot.walk(1, () => 'draw', batch)
  return batch
}

test(
  'beam_shots: one batch a frame, after the effects and before the HUD, state for state',
  { skip },
  async () => {
    const { beams, texture, frames } = await load()
    const index: TextureIndex = new Map(
      planUpload(texture).faces[0]!.map((level, at) => [
        contentHash(bytesOf(level as Uint16Array)),
        [{ source: 'FX/beam.txm', name: 'code_beam', width: 64 >> at }],
      ]),
    )

    for (const { index: at, draws, events } of frames) {
      const retail = draws[BEAMS]!

      assert.equal(retail.call, 'DrawIndexedPrimitiveUP', `frame ${at}`)
      assert.equal(retail.fvf, 0x142, `frame ${at}`)

      // The HUD's depth clear follows it.
      const next = events[events.indexOf(retail) + 1]!

      assert.ok(next.kind === 'clear' && next.flags === 2, `frame ${at}`)

      const batch = beamBatch()

      for (const { nickname, position, direction, speed } of shotsOf(retail)) {
        const built = grown(beams.get(nickname)!, position, direction, speed)
        const base = batch.count

        batch.vertices.push(...built.vertices)
        batch.colors.push(...built.colors)
        batch.indices.push(...built.indices.map((index) => index + base))
        batch.count += built.count
      }

      const ours = beamDraw(batch, texture)!

      assertFrameMatches({ draws: [ours] } as unknown as Frame, [retail], index)

      const captured = retail.stages[0]!.texture!

      assert.deepEqual([captured.format, captured.levels], [23, 7])
      assert.equal(namesOf(index, captured).length, 1)
      assert.deepEqual(
        captured.hash,
        (await retailCodeBeam()).map((level) => contentHash(bytesOf(level))),
      )

      // What the batch inherits from the effects before it: clamped, linear, mips by nearest, no fog.
      const { states } = retail.stages[0]!

      assert.deepEqual(
        [states['ADDRESSV'], states['MAGFILTER'], states['MINFILTER'], states['MIPFILTER']],
        [3, 2, 2, 1],
      )
      assert.deepEqual(ours.texture!.sampler, {
        magnify: 'linear',
        minify: 'linear',
        mipmap: 'nearest',
        wrapU: 'clamp',
        wrapV: 'clamp',
      })
      assert.equal(retail.states['FOGENABLE'], 0)
      assert.equal(ours.fog, undefined)
    }
  },
)

test(
  'beam_shots: each shot is ours grown, at its place, turned by `lookMatrix`, vertex for vertex',
  { skip },
  async () => {
    const { beams, frames } = await load()

    for (const { index: at, draws } of frames) {
      const retail = draws[BEAMS]!

      for (const { nickname, vertices, position, direction, speed } of shotsOf(retail)) {
        const what = `frame ${at}, ${nickname}`
        const batch = grown(beams.get(nickname)!, position, direction, speed)

        assert.equal(batch.count, vertices.length, what)
        vertices.forEach(({ p, d, t0 }, n) => {
          const place = batch.vertices.slice(n * 5, n * 5 + 3)

          // The direction is read back from rounded vertices some 200 out.
          for (const axis of [0, 1, 2])
            assert.ok(Math.abs(place[axis]! - p[axis]!) < 5e-4, `${what}, vertex ${n}: ${place}`)

          assert.deepEqual(batch.vertices.slice(n * 5 + 3, n * 5 + 5), t0!.map(Math.fround), what)

          const [b, g, r, a] = batch.colors.slice(n * 4, n * 4 + 4)

          assert.equal(((a! << 24) | (r! << 16) | (g! << 8) | b!) >>> 0, Number(d), what)
        })
      }

      // Both shots' triangles, in the order built: bolt then spear.
      const offsets = shotsOf(retail).map(({ vertices }) => vertices.length)
      const expected = shotsOf(retail).flatMap(({ nickname, position, direction, speed }, n) =>
        grown(beams.get(nickname)!, position, direction, speed).indices.map(
          (index) => index + (n ? offsets[0]! : 0),
        ),
      )

      assert.deepEqual(retail.indexData, expected, `frame ${at}`)
    }
  },
)

test(
  'beam_shots: each frame, the bolt travels 600 / 750 of what the spear does',
  { skip },
  async () => {
    const { frames } = await load()
    const places = frames.map(({ draws }) => shotsOf(draws[BEAMS]!).map(({ position }) => position))

    for (let at = 1; at < places.length; at++) {
      const [bolt, spear] = places[at]!.map((place, shot) => {
        const { x, y, z } = places[at - 1]![shot]!

        return Math.hypot(place.x - x, place.y - y, place.z - z)
      })

      assert.ok(Math.abs(bolt! / spear! - 0.8) < 1e-4, `${bolt} against ${spear}`)
    }
  },
)

test("beam_shots: code_beam uploads as retail's device holds it", { skip }, async () => {
  const { texture } = await load()
  const ours = planUpload(texture).faces[0]!
  const retail = await retailCodeBeam()

  retail.forEach((level, at) => assert.deepEqual(ours[at], level, `level ${at}`))
})
