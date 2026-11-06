/**
 * `ring_outside` and `ring_inside`: two ringed planets, their pieces sorted among what's in space,
 * from outside and from within the near one's band, against retail.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Matrix4 } from '@treewyrm/freelancer/math'
import { indexTextures } from '#/capture/texture-names.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { assertFrameMatches } from './compare.js'
import { readSpaceRun, RUNS } from './space-capture.js'
import { loadSystem } from './space-load.js'
import { systems } from './systems.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
interface RingRun {
  name: 'ring_outside' | 'ring_inside'
  /** The objects and ring pieces; the engine's effects follow, then a depth clear and the HUD. */
  draws: number
  rings: number[]
  /** Where the far list ends. */
  farPieces: number
}

const RUNS_COMPARED: RingRun[] = [
  {
    // The far ring's six far pieces lead, on the far list; its other two and the near ring's eight
    // sort among the planets.
    name: 'ring_outside',
    draws: 70,
    rings: [10, 11, 12, 13, 14, 15, 26, 27, 28, 29, 30, 31, 42, 43, 44, 45],
    farPieces: 3 + 13,
  },
  {
    // From within the band: three far pieces, and two about the camera keyed 0, after the ship. Retail
    // then draws the ring's `[Clouds]` as draw 66, which isn't built.
    name: 'ring_inside',
    draws: 66,
    rings: [10, 11, 12, 23, 24, 25, 26, 27, 28, 29, 38, 39, 64, 65],
    farPieces: 13,
  },
]

/** A captured row-vector modelview, with its Z flip, as a column-major GL one. */
const modelViewOf = (world: readonly number[]): Matrix4 => {
  const column = (c: number) => ({
    x: world[c * 4]!,
    y: world[c * 4 + 1]!,
    z: -world[c * 4 + 2]!,
    w: world[c * 4 + 3]!,
  })
  return { x: column(0), y: column(1), z: column(2), w: column(3) }
}

const load = async (name: RingRun['name']) => {
  const folder = join(references, name)
  const system = systems.get(name)!
  const read = async (path: string) => {
    const file = readFileSync(join(data, path))
    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
  }
  const { draws, options } = readSpaceRun(folder, system, RUNS[name])
  const scene = await loadSystem(system, read, options)
  return { frame: collectSpaceFrame(scene), retail: draws }
}

const skipOf = (name: string) =>
  !existsSync(data)
    ? 'no retail DATA'
    : !existsSync(join(references, name, 'd3d8log.jsonl'))
      ? `no ${name} capture in references`
      : false

for (const { name, draws, rings, farPieces } of RUNS_COMPARED) {
  test(`${name} is retail draw for draw, in retail order`, { skip: skipOf(name) }, async () => {
    const { frame, retail } = await load(name)
    assert.deepEqual(frame.unsupported, ['texture envmapglass'])
    assert.equal(frame.draws.length, draws)
    assert.deepEqual(
      frame.draws.flatMap(({ materialName }, n) => (materialName === 'ring' ? [n] : [])),
      rings,
    )
    assertFrameMatches(frame, retail.slice(0, draws), indexTextures(data), { streamed: true })
  })

  test(
    `${name}: each ring piece is drawn as retail drew it, its states and where it stands`,
    { skip: skipOf(name) },
    async () => {
      const { frame, retail } = await load(name)
      for (const n of rings) {
        const { states, stages, world } = retail[n]!
        const ours = frame.draws[n]!
        const what = `draw ${n}`
        const far = n < farPieces
        assert.equal(states['ZENABLE'], far ? 0 : 1, what)
        assert.equal(ours.depthFunc, far ? 'always' : 'lequal', what)
        assert.deepEqual(
          [states['ZWRITEENABLE'], states['ZFUNC'], states['CULLMODE'], states['LIGHTING']],
          [0, 4, 1, 0],
          what,
        )
        assert.deepEqual([states['SRCBLEND'], states['DESTBLEND']], [5, 6], what)
        assert.deepEqual(
          [states['ALPHATESTENABLE'], states['ALPHAFUNC'], states['ALPHAREF']],
          [1, 5, 0],
        )
        // Both stages wrap and filter as the default sampler does.
        for (const stage of [0, 1])
          assert.deepEqual(
            ['ADDRESSU', 'ADDRESSV', 'MAGFILTER', 'MINFILTER', 'MIPFILTER'].map(
              (key) => stages[stage]!.states[key],
            ),
            [1, 1, 2, 2, 1],
            `${what} stage ${stage}`,
          )
        assert.equal(stages[1]!.states['COLOROP'], ours.second ? 5 : 1, what)
        // Drawn in world space: the modelview is the view alone.
        const theirs = modelViewOf(world!)
        for (const axis of ['x', 'y', 'z', 'w'] as const)
          for (const cell of ['x', 'y', 'z'] as const)
            assert.ok(Math.abs(frame.view[axis][cell] - theirs[axis][cell]) < 1e-3, what)
      }
    },
  )

  test(
    `${name}: each piece's strip is retail's, positions, colour and both UV sets`,
    { skip: skipOf(name) },
    async () => {
      const { frame, retail } = await load(name)
      for (const n of rings) {
        const ours = frame.draws[n]!
        const vertices = retail[n]!.vertexData!
        const floats = new Float32Array(ours.mesh.vertices.buffer)
        const bytes = ours.mesh.vertices
        assert.equal(vertices.length, bytes.length / 32, `draw ${n}`)
        vertices.forEach(({ p, d, t0, t1 }, at) => {
          const what = `draw ${n}, vertex ${at}`
          // The zone's transform runs at extended precision in retail: within two float steps.
          p.forEach((c, axis) =>
            assert.ok(Math.abs(c - floats[at * 8 + axis]!) <= Math.abs(c) * 2.4e-7 + 1e-4, what),
          )
          const [b, g, r, a] = bytes.slice(at * 32 + 12, at * 32 + 16)
          assert.equal(Number(d), ((a! << 24) | (r! << 16) | (g! << 8) | b!) >>> 0, what)
          assert.deepEqual(
            [...t0!, ...t1!].map(Math.fround),
            [...floats.slice(at * 8 + 4, at * 8 + 8)],
            what,
          )
        })
      }
    },
  )
}
