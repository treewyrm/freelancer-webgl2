/** A moved, turned camera, and every hull vertex with its normal: what `li_elite` can't check. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Matrix4 } from '@treewyrm/freelancer/math'
import { readCapture, type CaptureDraw } from '#/capture/capture.js'
import { vertexLayout } from '#/mesh/plan.js'
import { collectFrame, type Frame } from '#/scene/frame.js'
import { loadScene } from './load.js'
import { scenes } from './scenes.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const run = join(references, 'li_elite_turned/d3d8log.jsonl')

const skip = !existsSync(data)
  ? 'no retail DATA'
  : !existsSync(run)
    ? 'no li_elite_turned capture in references'
    : false

const load = async (): Promise<{ frame: Frame; retail: CaptureDraw[] }> => {
  const read = async (path: string) => {
    const file = readFileSync(join(data, path))

    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
  }

  const { scene } = await loadScene(scenes.get('li_elite_turned')!, read)

  return {
    frame: collectFrame(scene),
    retail: readCapture(readFileSync(run, 'utf8')).frames.at(-1)!.draws,
  }
}

test(
  'the turned camera reaches retail, part by part, at the same projection',
  { skip },
  async () => {
    const { frame, retail } = await load()

    assert.equal(frame.draws.length, 22)

    frame.draws.forEach(({ world, materialName }, n) => {
      const modelView = Matrix4.multiply(frame.view, world)
      const columns = [modelView.x, modelView.y, modelView.z, modelView.w]

      // Retail's world is the modelview with Z flipped, written as rows for row vectors.
      columns.forEach((column, c) =>
        [column.x, column.y, -column.z].forEach((cell, r) => {
          const theirs = retail[n]!.world![c * 4 + r]!

          assert.ok(
            Math.abs(cell - theirs) < 1e-3,
            `${n} ${materialName}: ${cell} against ${theirs}`,
          )
        }),
      )
    })

    // `gl_Position` matches with z remapped; x and y scales are the shared part.
    const projection = retail[0]!.projection!

    assert.ok(Math.abs(frame.projection.x.x - projection[0]!) < 1e-5)
    assert.ok(Math.abs(frame.projection.y.y - projection[5]!) < 1e-5)
  },
)

test('a world-space light reaches retail turned by the view', { skip }, async () => {
  const { frame, retail } = await load()
  const { x, y, z } = Matrix4.transformDirection(frame.lights[0]!.direction, frame.view)
  const length = Math.hypot(x, y, z)
  // Flipped into D3D's camera space.
  const expected = [x / length, y / length, -z / length]

  retail[0]!.lights[0]!.direction.forEach((value, c) =>
    assert.ok(Math.abs(value - expected[c]!) < 1e-5, `${value} against ${expected[c]}`),
  )
})

test(
  'every hull vertex matches the file, normals included, negated on second passes',
  { skip },
  async () => {
    const { frame, retail } = await load()

    let compared = 0

    frame.draws.forEach(({ mesh, negateNormals }, n) => {
      const draw = retail[n]!
      const { stride } = vertexLayout(mesh.format)
      const view = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset)
      // A second pass is a copy elsewhere, so its vertices start where its first pass's did.
      const source = negateNormals ? retail[n - 1]! : draw
      const first = source.baseVertex! + source.minIndex!

      assert.equal(draw.vertexData?.length, draw.vertices, `draw ${n} is missing vertices`)
      draw.vertexData!.forEach(({ p, n: normal }, k) => {
        const from = (first + k) * stride
        const floats = (offset: number) =>
          [0, 4, 8].map((step) => view.getFloat32(from + offset + step, true))

        // The log's nine significant digits round-trip a 32-bit float exactly.
        assert.deepEqual(floats(0), p.map(Math.fround), `draw ${n} position ${k}`)

        const sign = negateNormals ? -1 : 1

        assert.deepEqual(
          floats(12).map((value) => value * sign),
          normal!.map(Math.fround),
          `draw ${n} normal ${k}`,
        )
        compared++
      })
    })
    assert.ok(compared > 2000, `only ${compared} vertices compared`)
  },
)
