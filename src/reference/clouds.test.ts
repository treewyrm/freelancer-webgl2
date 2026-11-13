/**
 * `nebula_clouds` and `nebula_clouds_hole`: a nebula's `[Clouds]` from inside (`DrawCloudsPanels`),
 * against retail. The puffs are the game's `rand()`, so they're compared in kind.
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

const RUNS_COMPARED = [
  // Deep in the core: the ship, then its clouds last, then the engine's four effect draws.
  { name: 'nebula_clouds', scene: 29, clouds: 24 },
  // In its exclusion zone: every puff placed on entering the system was tested before the zones were
  // first sorted, so none is hidden.
  { name: 'nebula_clouds_hole', scene: 29, clouds: 24 },
] as const

const skipOf = (name: string) =>
  !existsSync(data)
    ? 'no retail DATA'
    : !existsSync(join(references, name, 'd3d8log.jsonl'))
      ? `no ${name} capture in references`
      : false

const load = async (name: (typeof RUNS_COMPARED)[number]['name']) => {
  const read = async (path: string) => {
    const file = readFileSync(join(data, path))

    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
  }

  const system = systems.get(name)!
  const { draws, options } = readSpaceRun(join(references, name), system, RUNS[name])
  const scene = await loadSystem(system, read, options)

  // Entering the system, a cut; then the game's frames, a few seconds of them.
  collectSpaceFrame({ ...scene, cut: true })
  for (let frame = 0; frame < 180; frame++) collectSpaceFrame({ ...scene, step: 1 / 60 })
  return { frame: collectSpaceFrame({ ...scene, step: 1 / 60 }), captured: draws, scene }
}

for (const { name, scene, clouds } of RUNS_COMPARED) {
  test(`${name} is retail draw for draw, but its clouds`, { skip: skipOf(name) }, async () => {
    const { frame, captured } = await load(name)
    const retail = captured.slice(0, scene - 4)

    assert.deepEqual(frame.unsupported, ['texture envmapglass'])
    assert.equal(frame.draws.length, retail.length)
    assertFrameMatches(
      { ...frame, draws: frame.draws.slice(0, clouds) },
      retail.slice(0, clouds),
      indexTextures(data),
      { streamed: true },
    )
  })

  test(
    `${name}: its clouds are retail's in kind, fogged to the nebula's range`,
    { skip: skipOf(name) },
    async () => {
      const { frame, captured, scene: loaded } = await load(name)
      const theirs = captured[clouds]!
      const ours = frame.draws[clouds]!

      assert.equal(ours.materialName, 'clouds')

      const { states, world } = theirs

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
      // Fogged as the nebula's own range, in its colour.
      assert.deepEqual(
        [states['FOGENABLE'], states['FOGTABLEMODE'], states['FOGSTART'], states['FOGEND']],
        [1, 3, ours.fog!.start, ours.fog!.end],
      )

      const colour = states['FOGCOLOR']!

      assert.deepEqual(
        [ours.fog!.color.x, ours.fog!.color.y, ours.fog!.color.z].map((c) => Math.round(c * 255)),
        [(colour >> 16) & 0xff, (colour >> 8) & 0xff, colour & 0xff],
      )
      assert.equal(ours.cull, 'none')
      // In view space under an identity modelview.
      assert.deepEqual(world, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1])

      const identity = Matrix4.multiply(frame.view, ours.world)

      for (const axis of ['x', 'y', 'z', 'w'] as const)
        for (const cell of ['x', 'y', 'z', 'w'] as const)
          assert.ok(Math.abs(identity[axis][cell] - (axis[0] === cell[0] ? 1 : 0)) < 1e-6)

      const sim = loaded.nebulae![0]!.clouds![0]!
      const ahead = sim.reach + sim.radius
      const {
        puffRadius = 50,
        colorA,
        colorB,
        nearFade = [50, 100],
        puffCount,
        maxAlpha = 0.75,
      } = sim.settings

      const quadsOf = (corners: { p: readonly number[]; d: number }[]) =>
        Array.from({ length: corners.length / 6 }, (_, at) => {
          const [a, c] = [corners[at * 6]!, corners[at * 6 + 2]!]

          return {
            centre: [(a.p[0]! + c.p[0]!) / 2, (a.p[1]! + c.p[1]!) / 2, a.p[2]!],
            half: Math.hypot(c.p[0]! - a.p[0]!, c.p[1]! - a.p[1]!) / 2 / Math.SQRT2,
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
        // All ten, but what fades near the camera or at the sphere's edge.
        assert.ok(
          quads.length >= puffCount - 3 && quads.length <= puffCount,
          `${who}: ${quads.length}`,
        )
        quads.forEach(({ centre, half, colour }, at) => {
          const what = `${who}, puff ${at}`
          const depth = -centre[2]!

          assert.ok(depth >= nearFade[0], what)
          assert.ok(
            half >= puffRadius * 0.8 - 0.1 && half <= puffRadius * 1.2 + 0.1,
            `${what}: ${half}`,
          )

          const distance = Math.hypot(centre[0]!, centre[1]!, depth - ahead)

          assert.ok(distance <= sim.radius * Math.sqrt(1.02), `${what}: ${distance}`)
          if (at) assert.ok(depth <= -quads[at - 1]!.centre[2]! + 1e-3, what)
          // No more opaque than puff_max_alpha, a nebula fully in.
          assert.ok(colour >>> 24 <= Math.trunc(maxAlpha * 255) + 1, `${what}: ${colour >>> 24}`)

          // Between A and B the same way along each channel, read off blue's span, the widest.
          const [r, g, b] = [(colour >>> 16) & 0xff, (colour >>> 8) & 0xff, colour & 0xff]
          const t = (b - colorA!.z * 255) / ((colorB!.z - colorA!.z) * 255)

          assert.ok(t >= -0.05 && t <= 1.05, `${what}: ${t}`)
          assert.ok(Math.abs(r - (colorA!.x + (colorB!.x - colorA!.x) * t) * 255) <= 2, what)
          assert.ok(Math.abs(g - (colorA!.y + (colorB!.y - colorA!.y) * t) * 255) <= 2, what)
        })
      }
    },
  )
}
