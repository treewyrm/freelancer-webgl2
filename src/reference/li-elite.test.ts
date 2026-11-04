/** M0's check: the `li_elite` capture accounts for every draw, read against the model and the source. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readRigidModel } from '@treewyrm/freelancer/rigid'
import { Directory } from '@treewyrm/freelancer/utf'
import { getMesh, getMeshDraw, readVMeshLibrary, type VMeshPart } from '@treewyrm/freelancer/vmesh'
import { readCapture, type CaptureDraw } from '#/capture/capture.js'
import { indexTextures, namesOf } from '#/capture/texture-names.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const run = join(references, 'li_elite/d3d8log.jsonl')

const skip = !existsSync(data)
  ? 'no retail DATA'
  : !existsSync(run)
    ? 'no li_elite capture in references'
    : false

// Draws that are a model's mesh groups: the top level of each part, as `getLevel` picks up close.
const topLevels = (node: {
  part: { part?: VMeshPart | { type: 'multilevel'; levels: VMeshPart[] } }
  children?: unknown[]
}): VMeshPart[] => {
  const source = node.part.part
  const own = !source ? [] : 'levels' in source ? source.levels.slice(0, 1) : [source]
  return [...own, ...((node.children ?? []) as (typeof node)[]).flatMap(topLevels)]
}

const lastFrame = (): CaptureDraw[] => readCapture(readFileSync(run, 'utf8')).frames.at(-1)!.draws

test('every draw of the frame is accounted for', { skip }, () => {
  const draws = lastFrame()
  assert.equal(draws.length, 60)

  const file = readFileSync(join(data, 'SHIPS/LIBERTY/LI_ELITE/li_elite.cmp'))
  const root = Directory.read(new Uint8Array(file.buffer, file.byteOffset, file.byteLength))
  const meshes = readVMeshLibrary(root)
  const groups = topLevels(readRigidModel(root) as never).flatMap((part) => [
    ...getMeshDraw(getMesh(meshes, part.reference.meshId)!, part.reference),
  ])

  // Nineteen mesh groups, in the first 22 draws.
  const claimed = new Set<number>()
  for (const group of groups) {
    const at = draws.findIndex(
      (draw, n) =>
        n < 22 &&
        !claimed.has(n) &&
        draw.startIndex === group.startIndex &&
        (draw.baseVertex ?? 0) + (draw.minIndex ?? 0) === group.baseVertex &&
        draw.indices === group.elementCount,
    )
    assert.notEqual(at, -1, `no draw for the group at index ${group.startIndex}`)
    claimed.add(at)
  }
  assert.equal(groups.length, 19)

  // The other three are second passes of the same vertices, reached with the winding reversed.
  // Glass: `SubmitEnvMapGeometry` (`src/flmaterials/MaterialImpl.cpp`). Bay doors: `DcDtTwo`.
  assert.deepEqual(
    Array.from({ length: 22 }, (_, n) => n).filter((n) => !claimed.has(n)),
    [13, 19, 21],
  )
  assert.deepEqual(
    [12, 13, 18, 19, 20, 21].map((n) => draws[n]!.states['CULLMODE']),
    [3, 2, 2, 3, 2, 3],
  )
  assert.equal(draws[12]!.startIndex, draws[13]!.startIndex)
  assert.deepEqual(draws[18]!.vertexData, draws[19]!.vertexData)
  assert.deepEqual(draws[20]!.vertexData, draws[21]!.vertexData)

  // The menu: a full screen logo quad, five buttons of six parts each, six labels, the cursor.
  assert.equal(draws[22]!.space, 'screen')
  assert.equal(draws[22]!.stages[0]!.texture?.width, 1024)
  for (let button = 0; button < 5; button++)
    assert.deepEqual(
      draws.slice(23 + button * 6, 29 + button * 6).map((draw) => draw.startIndex),
      draws.slice(23, 29).map((draw) => draw.startIndex),
    )
  for (const draw of draws.slice(53, 59)) {
    assert.equal(draw.space, 'screen')
    assert.equal(draw.primitives, 4)
  }
  assert.equal(draws[59]!.call, 'DrawIndexedPrimitiveUP')
})

test('a hull draw reads end to end', { skip }, () => {
  const draw = lastFrame()[0]!
  const index = indexTextures(data)
  const namesAt = (stage: number) =>
    namesOf(index, draw.stages[stage]!.texture!).map(({ name }) => name.toLowerCase())

  // Stage 0 is the material's texture, stage 1 the reflection `BindEnvMap` adds.
  assert.ok(namesAt(0).includes('elite_256.tga'))
  assert.ok(namesAt(1).includes('envmapbasic'))
  assert.equal(draw.stages[1]!.states['COLOROP'], 5) // kEnvMapTss0: MODULATE2X
  assert.equal(draw.stages[1]!.states['TEXCOORDINDEX'], 0x30000) // camera space reflection

  assert.deepEqual(draw.material.diffuse, [1, 1, 1, 1])
  assert.equal(draw.states['AMBIENT'], 0xff282828) // the scene's 40

  // `set_modelview` flips Z into the world matrix and leaves the view identity, as do lights.
  assert.deepEqual(draw.view, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  assert.deepEqual(draw.world!.slice(12), [0, 0, 40, 1])
  const [light] = draw.lights
  assert.ok(Math.abs(light!.direction[2]! - Math.sqrt(2 / 3)) < 1e-5) // from z < 0 in the scene

  // `fovh` is half the horizontal angle: cot(30 degrees), and 4:3.
  assert.ok(Math.abs(draw.projection![0]! - 1 / Math.tan(Math.PI / 6)) < 1e-5)
  assert.ok(Math.abs(draw.projection![5]! / draw.projection![0]! - 4 / 3) < 1e-5)
})
