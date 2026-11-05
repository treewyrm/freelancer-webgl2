/** A real `.sph` against retail, in a scene of its own: draws, then every logged vertex and normal. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Matrix4 } from '@treewyrm/freelancer/math'
import { readCapture } from '#/capture/capture.js'
import { indexTextures } from '#/capture/texture-names.js'
import { collectFrame } from '#/scene/frame.js'
import { assertFrameMatches } from './compare.js'
import { loadScene } from './load.js'
import { scenes } from './scenes.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const run = join(references, 'planet_earth/d3d8log.jsonl')
const skip = !existsSync(data)
  ? 'no retail DATA'
  : !existsSync(run)
    ? 'no planet_earth capture in references'
    : false

const load = async () => {
  const read = async (path: string) => {
    const file = readFileSync(join(data, path))
    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
  }
  const { scene } = await loadScene(scenes.get('planet_earth')!, read)
  return {
    frame: collectFrame(scene),
    retail: readCapture(readFileSync(run, 'utf8')).frames.at(-1)!.draws,
  }
}

test('planet_earth is retail draw for draw, in retail order', { skip }, async () => {
  const { frame, retail } = await load()
  assert.deepEqual(frame.unsupported, [])
  assertFrameMatches(frame, retail, indexTextures(data), { streamed: true })
})

test('its patch is retail vertex for vertex, normals included', { skip }, async () => {
  const { frame, retail } = await load()
  let checked = 0
  frame.draws.forEach(({ mesh }, n) => {
    const written = retail[n]!.vertexData
    if (!written) return
    const ours = new Float32Array(
      mesh.vertices.buffer,
      mesh.vertices.byteOffset,
      mesh.vertices.byteLength / 4,
    )
    written.forEach(({ p, n: normal }, at) => {
      p.forEach((value, c) =>
        assert.ok(Math.abs(ours[at * 8 + c]! - value) < 2e-3, `draw ${n}, vertex ${at}: ${p}`),
      )
      normal!.forEach((value, c) =>
        assert.ok(Math.abs(ours[at * 8 + 3 + c]! - value) < 1e-5, `draw ${n}, normal ${at}`),
      )
      checked++
    })
  })
  assert.ok(checked > 0, 'no vertices logged: raise verts_max')
})

test('each draw stands where retail drew it, the shell scaled', { skip }, async () => {
  const { frame, retail } = await load()
  frame.draws.forEach(({ world, materialName }, n) => {
    const modelView = Matrix4.multiply(frame.view, world)
    const columns = [modelView.x, modelView.y, modelView.z, modelView.w]
    // Retail's world is the modelview with Z flipped, written as rows for row vectors.
    columns.forEach((column, c) =>
      [column.x, column.y, -column.z].forEach((cell, r) => {
        const theirs = retail[n]!.world![c * 4 + r]!
        assert.ok(Math.abs(cell - theirs) < 0.01, `draw ${n}, ${materialName}: ${cell}, ${theirs}`)
      }),
    )
  })
})

test('the shell has the UVs retail wrote, vertex for vertex', { skip }, async () => {
  const { frame, retail } = await load()
  let checked = 0
  frame.draws.forEach(({ atmosphere, mesh }, n) => {
    if (!atmosphere) return
    const ours = new Float32Array(
      mesh.vertices.buffer,
      mesh.vertices.byteOffset,
      mesh.vertices.byteLength / 4,
    )
    retail[n]!.vertexData!.forEach(({ t0 }, at) => {
      const { direction, threshold, gain, v } = atmosphere
      const facing =
        direction.x * ours[at * 8 + 3]! +
        direction.y * ours[at * 8 + 4]! +
        direction.z * ours[at * 8 + 5]!
      const u = facing < threshold ? 0 : ((facing - threshold) / (1 - threshold)) * gain
      assert.ok(Math.abs(u - t0![0]!) < 2e-5, `draw ${n}, vertex ${at}: ${u}, ${t0![0]}`)
      assert.ok(Math.abs(v - t0![1]!) < 1e-5, `draw ${n}, vertex ${at}: ${v}, ${t0![1]}`)
      checked++
    })
  })
  assert.equal(checked, 5 * 289)
})
