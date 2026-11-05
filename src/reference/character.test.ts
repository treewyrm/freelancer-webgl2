/** A body at the last keyframe of its script, against what the game skinned: the costume's other parts aside. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Matrix4 } from '@treewyrm/freelancer/math'
import { readCapture, type CaptureDraw } from '#/capture/capture.js'
import { indexTextures } from '#/capture/texture-names.js'
import { collectFrame, type Draw, type Frame } from '#/scene/frame.js'
import { assertFrameMatches } from './compare.js'
import { loadScene } from './load.js'
import { scenes } from './scenes.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const run = join(references, 'character_reed/d3d8log.jsonl')
const skip = !existsSync(data)
  ? 'no retail DATA'
  : !existsSync(run)
    ? 'no character_reed capture in references'
    : false

const load = async (): Promise<{ frame: Frame; retail: CaptureDraw[] }> => {
  const read = async (path: string) => {
    const file = readFileSync(join(data, path))
    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
  }
  const { scene } = await loadScene(scenes.get('character_reed')!, read)
  const frame = collectFrame(scene)
  const draws = readCapture(readFileSync(run, 'utf8')).frames.at(-1)!.draws
  // The body's run of draws: its groups' sizes, in order, among the costume's four parts.
  const sizes = frame.draws.map(({ count }) => count)
  const at = draws.findIndex((_, start) =>
    sizes.every((size, n) => draws[start + n]?.indices === size),
  )
  assert.ok(at >= 0, `no run of ${sizes} in ${draws.map(({ indices }) => indices)}`)
  return { frame, retail: draws.slice(at, at + sizes.length) }
}

/** `FMeshArchetype::Skin` in JavaScript, for what the capture holds rather than what a shader draws. */
const skinned = ({ mesh, skin }: Draw, element: number) => {
  const floats = new Float32Array(mesh.vertices.buffer, mesh.vertices.byteOffset)
  const [px, py, pz] = floats.slice(element * 8, element * 8 + 3) as unknown as number[]
  const [nx, ny, nz] = floats.slice(element * 8 + 3, element * 8 + 6) as unknown as number[]
  const { influences, bones } = skin!
  const position = [0, 0, 0]
  const normal = [0, 0, 0]
  for (let slot = 0; slot < 4; slot++) {
    const weight = influences[element * 8 + 4 + slot]!
    if (!weight) continue
    const at = influences[element * 8 + slot]! * 16
    for (let c = 0; c < 3; c++) {
      position[c]! +=
        weight *
        (bones[at + c]! * px! +
          bones[at + 4 + c]! * py! +
          bones[at + 8 + c]! * pz! +
          bones[at + 12 + c]!)
      normal[c]! +=
        weight * (bones[at + c]! * nx! + bones[at + 4 + c]! * ny! + bones[at + 8 + c]! * nz!)
    }
  }
  const length = Math.hypot(normal[0]!, normal[1]!, normal[2]!)
  return { position, normal: normal.map((value) => value / length) }
}

test('the body is retail draw for draw', { skip }, async () => {
  const { frame, retail } = await load()
  assert.deepEqual(frame.unsupported, [])
  assertFrameMatches(frame, retail, indexTextures(data), { streamed: true })
})

test(
  'at the last keyframe every vertex and normal is where retail skinned it',
  { skip },
  async () => {
    const { frame, retail } = await load()
    let checked = 0
    let worst = 0
    frame.draws.forEach((draw, n) => {
      const { vertexData, minIndex } = retail[n]!
      assert.ok(vertexData, 'no vertices logged: raise verts_max')
      vertexData.forEach(({ p, n: normal }, at) => {
        const ours = skinned(draw, (minIndex ?? 0) + at)
        p.forEach((value, c) => {
          worst = Math.max(worst, Math.abs(ours.position[c]! - value))
          assert.ok(
            Math.abs(ours.position[c]! - value) < 2e-3,
            `draw ${n}, vertex ${at}: ${ours.position}, ${p}`,
          )
        })
        normal!.forEach((value, c) =>
          assert.ok(
            Math.abs(ours.normal[c]! - value) < 2e-3,
            `draw ${n}, normal ${at}: ${ours.normal}, ${normal}`,
          ),
        )
        checked++
      })
    })
    assert.ok(checked > 0)
  },
)

test('the indices are the ones retail drew', { skip }, async () => {
  const { frame, retail } = await load()
  frame.draws.forEach(({ mesh, byteOffset, count }, n) => {
    const ours = mesh.indices.slice(byteOffset / 2, byteOffset / 2 + count)
    // The log stops at 1024.
    assert.deepEqual([...ours.slice(0, 1024)], retail[n]!.indexData, `draw ${n}`)
    assert.equal(retail[n]!.startIndex, byteOffset / 2, `draw ${n}`)
  })
})

test('the root stands where retail drew it', { skip }, async () => {
  const { frame, retail } = await load()
  const modelView = Matrix4.multiply(frame.view, frame.draws[0]!.world)
  const columns = [modelView.x, modelView.y, modelView.z, modelView.w]
  // Retail's world is the modelview with Z flipped, written as rows for row vectors.
  columns.forEach((column, c) =>
    [column.x, column.y, -column.z].forEach((cell, r) => {
      const theirs = retail[0]!.world![c * 4 + r]!
      assert.ok(Math.abs(cell - theirs) < 0.01, `column ${c}, row ${r}: ${cell}, ${theirs}`)
    }),
  )
})
