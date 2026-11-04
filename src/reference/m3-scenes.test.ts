/** M3's scenes against retail: batched glass and its order, and the classes that take stage 1. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Matrix4 } from '@treewyrm/freelancer/math'
import { readCapture } from '#/capture/capture.js'
import { indexTextures } from '#/capture/texture-names.js'
import { collectFrame } from '#/scene/frame.js'
import { vertexLayout } from '#/mesh/plan.js'
import { assertFrameMatches } from './compare.js'
import { loadScene } from './load.js'
import { scenes } from './scenes.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const runOf = (name: string) => join(references, name, 'd3d8log.jsonl')
const skipFor = (name: string) =>
  !existsSync(data)
    ? 'no retail DATA'
    : !existsSync(runOf(name))
      ? `no ${name} capture in references`
      : false

const load = async (name = 'ku_dragon') => {
  const read = async (path: string) => {
    const file = readFileSync(join(data, path))
    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
  }
  const { scene } = await loadScene(scenes.get(name)!, read)
  return collectFrame(scene)
}

test(
  'the batched glass comes last, without a reflection',
  { skip: !existsSync(data) && 'no retail DATA' },
  async () => {
    const frame = await load()
    assert.deepEqual(frame.unsupported, [])
    const glass = frame.draws.filter(({ materialName }) => materialName === 'D_glass')
    assert.ok(glass.length > 0)
    for (const draw of glass) {
      assert.equal(draw.blend, true)
      assert.equal(draw.environment, undefined)
      assert.equal(draw.normalizeNormals, false)
    }
  },
)

// The door shield's ramp isn't bound in retail's capture, so it's missing here too.
const MISSING: Record<string, string[]> = {
  dyson_door_shield: ['texture NomadRGB1_NomadAlpha1'],
}

for (const name of ['ku_dragon', 'prison', 'lair_core', 'dyson_door_shield', 'no_fighter'])
  test(`${name} is retail draw for draw, in retail order`, { skip: skipFor(name) }, async () => {
    const frame = await load(name)
    assert.deepEqual(frame.unsupported, MISSING[name] ?? [])
    const draws = readCapture(readFileSync(runOf(name), 'utf8')).frames.at(-1)!.draws
    assertFrameMatches(frame, draws, indexTextures(data))
  })

test(
  'a room flushes its queue once, after every object, far before near',
  { skip: skipFor('ku_dragon_pair') },
  async () => {
    const frame = await load('ku_dragon_pair')
    const glass = frame.draws.slice(-2)
    assert.deepEqual(
      glass.map(({ materialName }) => materialName),
      ['D_glass', 'D_glass'],
    )

    // Retail draws the far ship at a lower level, which M3 has yet to select, so only the glass
    // compares here. The hulls' 23 draws come first, in script order, nearer ship first.
    const draws = readCapture(readFileSync(runOf('ku_dragon_pair'), 'utf8')).frames.at(-1)!.draws
    const hull = draws.flatMap((draw) => (draw.fvf === 0x112 ? [draw] : []))
    assert.equal(hull.length, 25)
    assert.deepEqual(
      hull.map((draw) => draw.states['ALPHABLENDENABLE']),
      [...Array<number>(23).fill(0), 1, 1],
    )

    // Retail's world holds the modelview with Z flipped, so further is larger.
    const retail = hull.slice(-2).map((draw) => draw.world![14]!)
    assert.ok(retail[0]! > retail[1]!, `${retail}`)
    glass.forEach((draw, at) => {
      const ours = -Matrix4.multiply(frame.view, draw.world).w.z
      assert.ok(Math.abs(ours - retail[at]!) < 1e-2, `${ours} against ${retail[at]}`)
    })
  },
)

/** What `NomadWriteVert` wrote, vertex by vertex, against what the vertex shader computes. */
for (const name of ['dyson_door_shield', 'no_fighter'])
  test(
    `${name}'s written vertices are what the shader computes`,
    { skip: skipFor(name) },
    async () => {
      const frame = await load(name)
      const draws = readCapture(readFileSync(runOf(name), 'utf8')).frames.at(-1)!.draws
      let compared = 0
      frame.draws.forEach((ours, n) => {
        if (!ours.nomad) return
        const retail = draws[n]!
        const { mesh, reference, world } = ours
        const { stride, attributes } = vertexLayout(mesh.format)
        const normalAt = attributes.find((attribute) => attribute.name === 'normal')!.offset
        const bytes = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset)
        const float = (at: number) => bytes.getFloat32(at, true)
        const modelView = Matrix4.multiply(frame.view, world)
        // The transpose of the rotation, on (0, 0, -1): minus the third row of the columns.
        const axis = [-modelView.x.z, -modelView.y.z, -modelView.z.z]

        const logged = retail.vertexData!
        const first = logged[0]!.p
        let start = -1
        for (
          let at = reference.vertexStart;
          at < reference.vertexStart + reference.vertexCount;
          at++
        )
          if (
            Math.abs(float(at * stride) - first[0]!) < 1e-3 &&
            Math.abs(float(at * stride + 4) - first[1]!) < 1e-3 &&
            Math.abs(float(at * stride + 8) - first[2]!) < 1e-3
          ) {
            start = at
            break
          }
        assert.notEqual(start, -1, 'first vertex not found')

        logged.forEach((vertex, k) => {
          const from = (start + k) * stride
          const normal = [0, 4, 8].map((o) => float(from + normalAt + o))
          const ratio =
            (axis[0]! * normal[0]! + axis[1]! * normal[1]! + axis[2]! * normal[2]! + 1) * 0.5
          assert.ok(
            Math.abs(vertex.t1![0]! - ratio) < 1e-4,
            `${n}/${k}: ${vertex.t1![0]} against ${ratio}`,
          )
          assert.equal(vertex.d, '0xffffffff')
          assert.equal(vertex.t1![1], 1)
          compared++
        })
      })
      assert.ok(compared > 0)
    },
  )
