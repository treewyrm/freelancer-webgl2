/**
 * `dust_zone`, `_edge`, `_off` and `_quarter`: `sun_ahead` in a zone of `attractdust`, against
 * retail. Its three emitters' caps are linear in the intensity, so their counts pin it: deep in at
 * 250 particles, in the edge about half in, off centre and whole, and deep in at 125. Their places
 * are `rand()`'s, so each is checked against the sphere the dust's point holds them in.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SpriteDraw } from '#/alchemy/draw.js'
import { indexTextures, namesOf } from '#/capture/texture-names.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { assertFrameMatches } from './compare.js'
import { readSpaceRun, RUNS } from './space-capture.js'
import { loadSystem } from './space-load.js'
import { systems } from './systems.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
// `sun_ahead`'s scene, then the engine's effects, then the dust's three emitters.
const SCENE = 36
const DUST = [40, 41, 42]

type DustRun = 'dust_zone' | 'dust_zone_edge' | 'dust_zone_off' | 'dust_zone_quarter'

/** Each run, and the intensity the zone gives, to the float. */
const RUNS_COMPARED: { name: DustRun; intensity: (sparam: number) => boolean }[] = [
  { name: 'dust_zone', intensity: (sparam) => sparam === 0.5 },
  // 250 over 500 times an immersion of (1 - 1500.4 / 2000) / 0.5.
  { name: 'dust_zone_edge', intensity: (sparam) => Math.abs(sparam - 0.2498) < 1e-4 },
  { name: 'dust_zone_off', intensity: (sparam) => sparam === 0.5 },
  { name: 'dust_zone_quarter', intensity: (sparam) => sparam === 0.25 },
]

const skipOf = (name: string) =>
  !existsSync(data)
    ? 'no retail DATA'
    : !existsSync(join(references, name, 'd3d8log.jsonl'))
      ? `no ${name} capture in references`
      : false

const load = async (name: DustRun) => {
  const read = async (path: string) => {
    const file = readFileSync(join(data, path))

    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
  }

  const system = systems.get(name)!
  const { draws, options } = readSpaceRun(join(references, name), system, RUNS[name])
  const scene = await loadSystem(system, read, options)
  const frame = collectSpaceFrame({ ...scene, step: 1 / 96 })

  return { frame, retail: draws }
}

for (const { name, intensity } of RUNS_COMPARED) {
  const skip = skipOf(name)

  test(`${name} is retail's scene draw for draw`, { skip }, async () => {
    const { frame, retail } = await load(name)

    assertFrameMatches(
      { ...frame, draws: frame.draws.slice(0, SCENE) },
      retail.slice(0, SCENE),
      indexTextures(data),
      { streamed: true },
    )
  })

  test(
    `${name}: the zone's dust holds retail's count in each emitter, where it puts them`,
    { skip },
    async () => {
      const { frame, retail } = await load(name)
      const index = indexTextures(data)
      const theirs = DUST.map((n) => retail[n]!)

      for (const draw of theirs) {
        assert.ok(
          namesOf(index, draw.stages[0]!.texture!).some(({ name }) => name === 'small-flare'),
        )
        // Added by alpha, tested and not written: `SpaceEffectsDrawFrame`'s.
        assert.equal(draw.states['SRCBLEND'], 5)
        assert.equal(draw.states['DESTBLEND'], 2)
        assert.equal(draw.states['ZFUNC'], 4)
        assert.equal(draw.states['ZWRITEENABLE'], 0)
      }

      // Every emitter full, at the cap the intensity gives.
      const ours = (frame.effects as SpriteDraw[]).filter(
        (draw) => draw.type === 'sprite' && draw.texture?.name === 'small-flare' && draw.sparam > 0,
      )

      assert.ok(ours.every(({ sparam }) => intensity(sparam)))
      assert.deepEqual(
        ours.map(({ lane }) => lane.count),
        theirs.map(({ primitives }) => primitives / 2),
      )

      // Each quad's centre in view space, within the emitter's sphere about the point 60 ahead.
      for (const { vertexData } of theirs) {
        for (let at = 0; at < vertexData!.length; at += 4) {
          const [a, , , d] = vertexData!.slice(at, at + 4)
          const centre = [0, 1, 2].map((axis) => (a!.p[axis]! + d!.p[axis]!) / 2)

          assert.ok(Math.hypot(centre[0]!, centre[1]!, centre[2]! + 60) < 61)
        }
      }
    },
  )

  test(
    `${name}: the system's dust, at rest, issues no draw; ours issues one faded out`,
    { skip },
    async () => {
      const { frame, retail } = await load(name)
      const index = indexTextures(data)
      // The engine's four, then the zone's three; the sun's `stripe_narrow` follows the effects.
      const effects = retail.slice(SCENE, DUST.at(-1)! + 1)

      assert.equal(effects.length, 7)

      const next = retail[DUST.at(-1)! + 1]!.stages[0]!.texture!

      assert.ok(namesOf(index, next).some(({ name }) => name === 'stripe_narrow'))

      const sprites = frame.effects as SpriteDraw[]
      const faded = sprites.filter(({ dust }) => dust)

      assert.deepEqual(
        faded.map(({ dust }) => dust!.fade),
        [0],
      )
      assert.equal(sprites.length - faded.length, effects.length)
    },
  )
}
