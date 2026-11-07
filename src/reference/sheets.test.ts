/**
 * `nebula_sheets` and `nebula_sheets_edge`: a nebula's fill sheets (`DrawFogShell`) from outside, on
 * the far list and before the field's list, and in the field's edge before its overlay, against retail.
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
  // The sky, the far sphere's sheet A alone, the near ellipsoid's two, the station, then the ship.
  { name: 'nebula_sheets', scene: 75 },
  // In the ellipsoid's edge: the same sheets, then the fog overlay, then the ship in its field.
  { name: 'nebula_sheets_edge', scene: 41 },
] as const

// Draws 10 and 11 in both, and the zone each stands about.
const SHEETS = [
  { n: 10, zone: 'Lab_sheets_far' },
  { n: 11, zone: 'Lab_sheets_near' },
]

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
  // A frame before, as the game had drawn many.
  collectSpaceFrame(scene)
  return { frame: collectSpaceFrame(scene), captured: draws }
}

for (const { name, scene } of RUNS_COMPARED) {
  test(`${name} is retail draw for draw`, { skip: skipOf(name) }, async () => {
    const { frame, captured } = await load(name)
    // Less the engine's four effect draws at the end.
    const retail = captured.slice(0, scene - 4)
    assert.deepEqual(frame.unsupported, ['texture envmapglass'])
    assert.equal(frame.draws.length, retail.length)
    assertFrameMatches(frame, retail, indexTextures(data), { streamed: true })
  })

  test(
    `${name}: each sheet's corners, UVs and colour, as retail drew them`,
    { skip: skipOf(name) },
    async () => {
      const { frame, captured } = await load(name)
      for (const { n, zone } of SHEETS) {
        const centre = systems.get(name)!.zones!.find(({ nickname }) => nickname === zone)!.position
        const ours = frame.draws[n]!
        const theirs = captured[n]!
        assert.equal(ours.materialName, 'fill sheets', `draw ${n}`)
        // Retail's state, which the frame leaves: no fog, the alpha test `GREATER 0`, no culling.
        assert.deepEqual(
          [
            'ZENABLE',
            'ZWRITEENABLE',
            'CULLMODE',
            'LIGHTING',
            'FOGENABLE',
            'ALPHATESTENABLE',
            'ALPHAREF',
            'ALPHAFUNC',
          ].map((key) => theirs.states[key]),
          [0, 0, 1, 0, 0, 1, 0, 5],
        )
        const floats = new Float32Array(ours.mesh.vertices.buffer)
        const bytes = ours.mesh.vertices
        const vertices = theirs.vertexData!
        assert.equal(ours.reference.vertexCount, vertices.length, `draw ${n}`)
        vertices.forEach(({ p, d, t0 }, at) => {
          const what = `draw ${n} vertex ${at}`
          for (const axis of [0, 1, 2]) {
            const ourValue = floats[at * 6 + axis]!
            // To two float steps of what was added: the corner, or the zone's centre it's offset
            // from. Where they cancel, -4000 + 3380 in x, the rest is half a step at 4000.
            const step = Math.max(Math.abs(p[axis]!), Math.abs(centre[axis]!), 1) * 2 ** -22
            assert.ok(
              Math.abs(ourValue - p[axis]!) <= step,
              `${what} ${axis}: ${ourValue} against ${p[axis]}`,
            )
          }
          const [b, g, r, a] = bytes.slice(at * 24 + 12, at * 24 + 16)
          const colour = ((a! << 24) | (r! << 16) | (g! << 8) | b!) >>> 0
          assert.equal(colour.toString(16), Number(d).toString(16), what)
          assert.deepEqual([floats[at * 6 + 4], floats[at * 6 + 5]], t0!.map(Math.fround), what)
        })
      }
    },
  )
}
