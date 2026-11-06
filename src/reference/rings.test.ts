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
  /** The ring's `[Clouds]`, after the objects: random, so compared in kind. */
  clouds?: number
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
    clouds: 66,
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
  return { frame: collectSpaceFrame(scene), retail: draws, scene }
}

const skipOf = (name: string) =>
  !existsSync(data)
    ? 'no retail DATA'
    : !existsSync(join(references, name, 'd3d8log.jsonl'))
      ? `no ${name} capture in references`
      : false

for (const { name, draws, rings, farPieces, clouds } of RUNS_COMPARED) {
  test(`${name} is retail draw for draw, in retail order`, { skip: skipOf(name) }, async () => {
    const { frame, retail } = await load(name)
    assert.deepEqual(frame.unsupported, ['texture envmapglass'])
    assert.equal(frame.draws.length, draws + (clouds === undefined ? 0 : 1))
    assert.deepEqual(
      frame.draws.flatMap(({ materialName }, n) => (materialName === 'ring' ? [n] : [])),
      rings,
    )
    assertFrameMatches(
      { ...frame, draws: frame.draws.slice(0, draws) },
      retail.slice(0, draws),
      indexTextures(data),
      { streamed: true },
    )
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

  if (clouds !== undefined)
    test(
      `${name}: its clouds are retail's in kind, one list of puffs in view space`,
      { skip: skipOf(name) },
      async () => {
        const { frame, retail, scene } = await load(name)
        const theirs = retail[clouds]!
        const ours = frame.draws[clouds]!
        const { states, stages, world } = theirs
        assert.equal(theirs.call, 'DrawPrimitive')
        assert.equal(theirs.primitive, 'trilist')
        assert.deepEqual(
          ['ZENABLE', 'ZWRITEENABLE', 'ZFUNC', 'CULLMODE', 'LIGHTING', 'SRCBLEND', 'DESTBLEND'].map(
            (key) => states[key],
          ),
          [1, 0, 4, 1, 0, 5, 6],
        )
        assert.deepEqual(
          [states['ALPHATESTENABLE'], states['ALPHAFUNC'], states['ALPHAREF']],
          [1, 5, ours.alphaReference],
        )
        assert.deepEqual(
          ['COLOROP', 'ALPHAOP', 'ADDRESSU', 'MAGFILTER', 'MIPFILTER'].map(
            (key) => stages[0]!.states[key],
          ),
          [4, 4, 1, 2, 1],
        )
        assert.equal(stages[1]!.states['COLOROP'], 1)
        // Under an identity modelview, in view space; ours stands its world at the view's inverse.
        assert.deepEqual(world, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1])
        const identity = Matrix4.multiply(frame.view, ours.world)
        for (const axis of ['x', 'y', 'z', 'w'] as const)
          for (const cell of ['x', 'y', 'z', 'w'] as const)
            assert.ok(Math.abs(identity[axis][cell] - (axis[0] === cell[0] ? 1 : 0)) < 1e-6)

        // What every puff must be, in retail's and in ours.
        const sim = scene.rings![0]!.clouds![0]!
        const ahead = sim.reach + sim.radius
        const { puffRadius = 50, colorA, colorB, nearFade = [50, 100] } = sim.settings
        const quadsOf = (corners: { p: number[]; d: number }[]) =>
          Array.from({ length: corners.length / 6 }, (_, at) => {
            const [a, b, c] = [corners[at * 6]!, corners[at * 6 + 1]!, corners[at * 6 + 2]!]
            return {
              centre: [(a.p[0]! + c.p[0]!) / 2, (a.p[1]! + c.p[1]!) / 2, a.p[2]!],
              half: Math.hypot(c.p[0]! - a.p[0]!, c.p[1]! - a.p[1]!) / 2 / Math.SQRT2,
              // Its corners step along the kept up and across it: (1, 1) and (1, -1) to begin.
              diagonal: Math.abs(Math.abs(b.p[0]! - a.p[0]!) - Math.abs(b.p[1]! - a.p[1]!)),
              colour: a.d,
            }
          })
        const vertices = new Float32Array(ours.mesh.vertices.buffer)
        const bytes = ours.mesh.vertices
        const ourCorners = Array.from({ length: ours.count }, (_, at) => ({
          p: [...vertices.slice(at * 6, at * 6 + 3)],
          d:
            ((bytes[at * 24 + 15]! << 24) |
              (bytes[at * 24 + 14]! << 16) |
              (bytes[at * 24 + 13]! << 8) |
              bytes[at * 24 + 12]!) >>>
            0,
        }))
        const theirCorners = theirs.vertexData!.map(({ p, d }) => ({ p, d: Number(d) }))
        for (const [who, quads] of [
          ['retail', quadsOf(theirCorners)],
          ['ours', quadsOf(ourCorners)],
        ] as const) {
          // About the budget of 40 puffs, minus what fades near the camera or at the sphere's edge.
          assert.ok(quads.length > 20 && quads.length <= 40, `${who}: ${quads.length}`)
          quads.forEach(({ centre, half, diagonal, colour }, at) => {
            const what = `${who}, puff ${at}`
            const depth = -centre[2]!
            assert.ok(depth >= nearFade[0], what)
            assert.ok(
              half >= puffRadius * 0.8 - 0.1 && half <= puffRadius * 1.2 + 0.1,
              `${what}: ${half}`,
            )
            assert.ok(diagonal < 0.01, what)
            const distance = Math.hypot(centre[0]!, centre[1]!, depth - ahead)
            assert.ok(distance <= sim.radius * Math.sqrt(1.02), `${what}: ${distance}`)
            // Far to near, by the depth the last frame drew it at.
            if (at) assert.ok(depth <= -quads[at - 1]!.centre[2]! + 1e-3, what)
            // Each colour lies between A and B, the same way along each channel.
            const [r, g] = [(colour >>> 16) & 0xff, (colour >>> 8) & 0xff]
            const t = (r - colorA!.x * 255) / ((colorB!.x - colorA!.x) * 255)
            assert.ok(t >= -0.05 && t <= 1.05, `${what}: ${t}`)
            assert.ok(Math.abs(g - (colorA!.y + (colorB!.y - colorA!.y) * t) * 255) <= 2, what)
          })
        }
      },
    )
}
