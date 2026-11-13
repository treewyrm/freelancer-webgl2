/** A whole costume at the last keyframe of its script, against what the game skinned and joined. */
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
const runOf = (name: string) => join(references, name, 'd3d8log.jsonl')
const skipOf = (name: string) =>
  !existsSync(data)
    ? 'no retail DATA'
    : !existsSync(runOf(name))
      ? `no ${name} capture in references`
      : false
const skip = skipOf('character_reed')

const load = async (name = 'character_reed'): Promise<{ frame: Frame; retail: CaptureDraw[] }> => {
  const read = async (path: string) => {
    const file = readFileSync(join(data, path))

    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
  }

  const { scene } = await loadScene(scenes.get(name)!, read)
  const frame = collectFrame(scene)
  const draws = readCapture(readFileSync(runOf(name), 'utf8')).frames.at(-1)!.draws

  return { frame, retail: draws.slice(0, frame.draws.length) }
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

for (const name of ['character_reed', 'character_far', 'character_eyes']) {
  test(`${name} is retail draw for draw, body first`, { skip: skipOf(name) }, async () => {
    const { frame, retail } = await load(name)

    assert.deepEqual(frame.unsupported, [])
    assertFrameMatches(frame, retail, indexTextures(data), { streamed: true })
  })

  test(
    `${name}'s vertices and normals are where retail skinned them, or left them rigid`,
    { skip: skipOf(name) },
    async () => {
      const { frame, retail } = await load(name)
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

  test(`${name}'s indices are the ones retail drew`, { skip: skipOf(name) }, async () => {
    const { frame, retail } = await load(name)

    frame.draws.forEach(({ mesh, byteOffset, count }, n) => {
      const ours = mesh.indices.slice(byteOffset / 2, byteOffset / 2 + count)

      // The log stops at 1024.
      assert.deepEqual([...ours.slice(0, 1024)], retail[n]!.indexData, `draw ${n}`)
      assert.equal(retail[n]!.startIndex, byteOffset / 2, `draw ${n}`)
    })
  })

  test(`each part of ${name} stands where retail joined it`, { skip: skipOf(name) }, async () => {
    const { frame, retail } = await load(name)

    frame.draws.forEach(({ world, materialName }, n) => {
      const modelView = Matrix4.multiply(frame.view, world)
      const columns = [modelView.x, modelView.y, modelView.z, modelView.w]

      // Retail's world is the modelview with Z flipped, written as rows for row vectors.
      columns.forEach((column, c) =>
        [column.x, column.y, -column.z].forEach((cell, r) => {
          const theirs = retail[n]!.world![c * 4 + r]!

          assert.ok(
            Math.abs(cell - theirs) < 0.01,
            `${materialName} ${c}, ${r}: ${cell}, ${theirs}`,
          )
        }),
      )
    })
  })
}

test('an eye bone at rest leaves the transform off', { skip }, async () => {
  const { frame, retail } = await load()

  frame.draws.forEach(({ uvTransform }, n) => {
    assert.equal(uvTransform, undefined)
    assert.equal(retail[n]!.stages[0]!.transform, undefined)
  })
})

test(
  "a turned eye bone slides only the eye's texture, by what retail set, moving no vertex",
  { skip: skipOf('character_eyes') },
  async () => {
    const { frame, retail } = await load('character_eyes')

    assert.deepEqual(frame.unsupported, [])
    assertFrameMatches(frame, retail, indexTextures(data), { streamed: true })

    const eyes = frame.draws.flatMap(({ uvTransform }, n) => (uvTransform ? [n] : []))

    assert.deepEqual(eyes.length, 1)

    const at = eyes[0]!
    const { offset, scale } = frame.draws[at]!.uvTransform!
    const theirs = retail[at]!.stages[0]!.transform!

    // Row-major: retail's translation is the third row, as a 2D coordinate reads one.
    assert.deepEqual(scale, [1, 1])
    assert.ok(Math.abs(offset[0] - theirs[8]!) < 1e-5, `${offset} against ${theirs}`)
    assert.ok(Math.abs(offset[1] - theirs[9]!) < 1e-5, `${offset} against ${theirs}`)
  },
)
