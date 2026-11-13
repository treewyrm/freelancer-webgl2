/**
 * `nebula_exterior` and `nebula_exterior_edge`: a nebula's bits (`NebulaDrawBolts`) from outside, on
 * the far list and after the field's list, and from the field's edge after its overlay, against
 * retail. Each bit's spin is the game's `rand()`, so its corners are compared by their centre and
 * size, not one by one.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { indexTextures } from '#/capture/texture-names.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { assertFrameMatches } from './compare.js'
import { readSpaceRun, RUNS } from './space-capture.js'
import { loadSystem } from './space-load.js'
import { systems } from './systems.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'

const RUNS_COMPARED = [
  // The sky, the far sphere's sheet and 8 bits, the ellipsoid's sheets and 9 bits, the station, the
  // ship.
  { name: 'nebula_exterior', scene: 77, effects: 4, bits: [11, 13] },
  // In the ellipsoid's edge: the far sphere's, then the ellipsoid's sheets, overlay and 4 bits. The
  // engine's effects end in two draws here, its rings not among them.
  { name: 'nebula_exterior_edge', scene: 41, effects: 2, bits: [11, 14] },
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

  // Entering the system is a cut, which turns the bits to the camera; then a frame on.
  collectSpaceFrame({ ...scene, cut: true })
  return { frame: collectSpaceFrame({ ...scene, step: 1 / 60 }), captured: draws }
}

type Corner = readonly [number, number, number]

const middle = (a: Corner, c: Corner): Corner => [
  (a[0] + c[0]) / 2,
  (a[1] + c[1]) / 2,
  (a[2] + c[2]) / 2,
]
const apart = (a: Corner, b: Corner) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

for (const { name, scene, effects, bits } of RUNS_COMPARED) {
  test(`${name} is retail draw for draw`, { skip: skipOf(name) }, async () => {
    const { frame, captured } = await load(name)
    const retail = captured.slice(0, scene - effects)

    assert.deepEqual(frame.unsupported, ['texture envmapglass'])
    assert.equal(frame.draws.length, retail.length)
    assertFrameMatches(frame, retail, indexTextures(data), { streamed: true })
  })

  test(
    `${name}: each bit's place, size, colour and UVs, in retail's order`,
    { skip: skipOf(name) },
    async () => {
      const { frame, captured } = await load(name)

      for (const n of bits) {
        const ours = frame.draws[n]!
        const theirs = captured[n]!

        assert.equal(ours.materialName, 'nebula exterior', `draw ${n}`)

        const { states } = theirs

        assert.deepEqual(
          [
            'ZENABLE',
            'ZWRITEENABLE',
            'CULLMODE',
            'LIGHTING',
            'ALPHAREF',
            'FOGENABLE',
            'FOGTABLEMODE',
          ].map((key) => states[key]),
          [0, 0, 1, 0, 4, 1, 3],
        )
        assert.ok(Math.abs(ours.fog!.start - states['FOGSTART']!) < 0.05, `draw ${n} fog start`)
        assert.ok(
          Math.abs(ours.fog!.end / states['FOGEND']! - 1) < 1e-5,
          `draw ${n} fog end ${ours.fog!.end} against ${states['FOGEND']}`,
        )

        const floats = new Float32Array(ours.mesh.vertices.buffer)
        const bytes = ours.mesh.vertices
        const vertices = theirs.vertexData!

        assert.equal(ours.reference.vertexCount, vertices.length, `draw ${n}`)

        const ourCorner = (at: number): Corner => [
          floats[at * 6]!,
          floats[at * 6 + 1]!,
          floats[at * 6 + 2]!,
        ]

        for (let bit = 0; bit < vertices.length / 4; bit++) {
          const what = `draw ${n} bit ${bit}`
          const first = bit * 4
          const theirCorner = (at: number) => vertices[first + at]!.p as unknown as Corner
          const ourMiddle = middle(ourCorner(first), ourCorner(first + 2))
          const theirMiddle = middle(theirCorner(0), theirCorner(2))

          // Where it stands, to a hundredth: the bits are 15000 to 60000 out.
          assert.ok(
            apart(ourMiddle, theirMiddle) < 0.01,
            `${what}: ${ourMiddle} against ${theirMiddle}`,
          )

          // Its radius along both axes: each corner √2 of it from the middle.
          for (let at = 0; at < 4; at++)
            assert.ok(
              Math.abs(
                apart(theirCorner(at), theirMiddle) - apart(ourCorner(first + at), ourMiddle),
              ) < 0.01,
              `${what} corner ${at}`,
            )

          for (let at = 0; at < 4; at++) {
            const { d, t0 } = vertices[first + at]!
            const [b, g, r, a] = bytes.slice((first + at) * 24 + 12, (first + at) * 24 + 16)
            const colour = ((a! << 24) | (r! << 16) | (g! << 8) | b!) >>> 0

            assert.equal(colour.toString(16), Number(d).toString(16), `${what} corner ${at}`)
            assert.deepEqual(
              [floats[(first + at) * 6 + 4], floats[(first + at) * 6 + 5]],
              t0!.map(Math.fround),
              `${what} corner ${at}`,
            )
          }
        }
      }
    },
  )
}
