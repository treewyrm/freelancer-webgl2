/** M0's check: the `li_elite` capture accounts for every draw, read against the model and the source. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CompoundNode } from '@treewyrm/freelancer/compound'
import { Matrix3, Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import { getMaterial, readMaterialLibrary } from '@treewyrm/freelancer/material'
import { readRigidModel, type RigidPart } from '@treewyrm/freelancer/rigid'
import { readTextureLibrary } from '@treewyrm/freelancer/texture'
import { Directory } from '@treewyrm/freelancer/utf'
import { getMesh, getMeshDraw, readVMeshLibrary, type VMeshPart } from '@treewyrm/freelancer/vmesh'
import { readCapture, type CaptureDraw } from '#/capture/capture.js'
import { indexTextures, namesOf } from '#/capture/texture-names.js'
import { planReference, vertexLayout } from '#/mesh/plan.js'
import { projectionMatrix, viewMatrix, type Camera } from '#/scene/camera.js'
import { collectFrame, placeParts } from '#/scene/frame.js'
import { partTransforms } from '#/scene/hierarchy.js'
import { assertFrameMatches } from './compare.js'
import { scenes } from './scenes.js'

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

test('planned indices and vertices are what retail drew', { skip }, () => {
  const draws = lastFrame()
  const file = readFileSync(join(data, 'SHIPS/LIBERTY/LI_ELITE/li_elite.cmp'))
  const root = Directory.read(new Uint8Array(file.buffer, file.byteOffset, file.byteLength))
  const meshes = readVMeshLibrary(root)

  let checked = 0
  let vertices = 0
  for (const part of topLevels(readRigidModel(root) as never)) {
    const mesh = getMesh(meshes, part.reference.meshId)!
    const { indices, groups } = planReference(mesh, part.reference)
    const view = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset)
    const { stride } = vertexLayout(mesh.format)

    groups.forEach(({ byteOffset, count }, at) => {
      const { startIndex } = [...getMeshDraw(mesh, part.reference)][at]!
      const draw = draws.find((candidate) => candidate.startIndex === startIndex)!
      const planned = indices.subarray(byteOffset / 2, byteOffset / 2 + count)

      // The log keeps the first 1024 of a draw's indices.
      draw.indexData!.forEach((index, n) =>
        assert.equal(planned[n], draw.baseVertex! + index, `index ${n} at ${startIndex}`),
      )

      // Small draws also log their vertices, in buffer order from `minIndex`.
      draw.vertexData?.forEach(({ p, t0 }, n) => {
        const from = (draw.baseVertex! + draw.minIndex! + n) * stride
        const position = [0, 4, 8].map((offset) => view.getFloat32(from + offset, true))
        const uv = [24, 28].map((offset) => view.getFloat32(from + offset, true))
        // The log's nine significant digits round-trip a 32-bit float exactly.
        assert.deepEqual(position, p.map(Math.fround))
        assert.deepEqual(uv, t0!.map(Math.fround))
        vertices++
      })
      checked++
    })
  }
  assert.equal(checked, 19)
  assert.ok(vertices > 100, `only ${vertices} vertices compared`)
})

// `li_elite` in `scenes.ts`. THN triples are columns, so the rows are their transpose.
const CAMERA: Camera = {
  position: { x: 0, y: 0, z: 0 },
  orientation: Matrix3.identity,
  fovh: 30,
  near: 1,
  far: 10000,
}

const sceneModel = (): Matrix4 => {
  const [x, y, z] = scenes.get('li_elite')!.model!.orientation
  const [px, py, pz] = scenes.get('li_elite')!.model!.position
  return Matrix4.fromRotationTranslation(
    {
      x: { x: x[0], y: y[0], z: z[0] },
      y: { x: x[1], y: y[1], z: z[1] },
      z: { x: x[2], y: y[2], z: z[2] },
    },
    { x: px, y: py, z: pz },
  )
}

const rootVertices = (): Vector3[] => {
  const file = readFileSync(join(data, 'SHIPS/LIBERTY/LI_ELITE/li_elite.cmp'))
  const root = Directory.read(new Uint8Array(file.buffer, file.byteOffset, file.byteLength))
  const meshes = readVMeshLibrary(root)
  const part = topLevels(readRigidModel(root) as never)[0]!
  const mesh = getMesh(meshes, part.reference.meshId)!
  const { stride } = vertexLayout(mesh.format)
  const view = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset)
  return [...new Set(planReference(mesh, part.reference).indices)].map((index) => ({
    x: view.getFloat32(index * stride, true),
    y: view.getFloat32(index * stride + 4, true),
    z: view.getFloat32(index * stride + 8, true),
  }))
}

const clipOf = (point: Vector3) =>
  Matrix4.transform(
    { ...point, w: 1 },
    Matrix4.multiply(
      Matrix4.multiply(projectionMatrix(CAMERA, 1024 / 768), viewMatrix(CAMERA)),
      sceneModel(),
    ),
  )

test('camera and model reach the clip space retail reached', { skip }, () => {
  const { world, view, projection } = lastFrame()[0]!
  // D3D's row vectors: p * world * view * projection.
  const rowTimes = (v: number[], m: number[]) =>
    [0, 1, 2, 3].map((c) => v.reduce((sum, value, r) => sum + value * m[r * 4 + c]!, 0))

  for (const point of rootVertices()) {
    const retail = rowTimes(
      rowTimes(rowTimes([point.x, point.y, point.z, 1], world!), view!),
      projection!,
    )
    const ours = clipOf(point)
    const within = (a: number, b: number) =>
      assert.ok(Math.abs(a - b) < 1e-3 * Math.max(1, Math.abs(b)), `${a} against ${b}`)
    within(ours.x, retail[0]!)
    within(ours.y, retail[1]!)
    within(ours.w, retail[3]!)
    // GL's clip z is D3D's remapped, so that window depth is the same number.
    within(ours.z, 2 * retail[2]! - retail[3]!)
  }
})

test('the mirror is settled by the retail screenshot, not by the matrices', { skip }, () => {
  const shot = readFileSync(join(references, 'li_elite/d3d8log.f607.bmp'))
  const lit = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= 1024 || y >= 768) return false
    // 24-bit BMP, bottom row first, after its 54-byte header.
    const at = 54 + (767 - y) * ((1024 * 3 + 3) & ~3) + x * 3
    return shot[at]! + shot[at + 1]! + shot[at + 2]! > 0
  }
  const near = (x: number, y: number) =>
    [-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) => lit(x + dx, y + dy)))

  const onShip = (mirrored: boolean) => {
    const points = rootVertices()
    const hits = points.filter((point) => {
      const { x, y, w } = clipOf(point)
      const ndcX = ((mirrored ? -x : x) / w + 1) / 2
      return near(Math.round(ndcX * 1024), Math.round(((1 - y / w) / 2) * 768))
    })
    return hits.length / points.length
  }
  const [ours, flipped] = [onShip(false), onShip(true)]
  assert.ok(ours > 0.99, `only ${ours} of the hull lands on the ship`)
  assert.ok(flipped < ours - 0.1, `mirrored scores ${flipped} against ${ours}`)
})

test('retail winding faces the camera, seen through this view', { skip }, () => {
  const file = readFileSync(join(data, 'SHIPS/LIBERTY/LI_ELITE/li_elite.cmp'))
  const root = Directory.read(new Uint8Array(file.buffer, file.byteOffset, file.byteLength))
  const meshes = readVMeshLibrary(root)
  const part = topLevels(readRigidModel(root) as never)[0]!
  const mesh = getMesh(meshes, part.reference.meshId)!
  const { stride } = vertexLayout(mesh.format)
  const view = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset)
  const { indices } = planReference(mesh, part.reference)

  const read = (index: number, offset: number): Vector3 => ({
    x: view.getFloat32(index * stride + offset, true),
    y: view.getFloat32(index * stride + offset + 4, true),
    z: view.getFloat32(index * stride + offset + 8, true),
  })
  const toWorld = sceneModel()
  const minus = (a: Vector3, b: Vector3): Vector3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
  const dot = (a: Vector3, b: Vector3) => a.x * b.x + a.y * b.y + a.z * b.z

  for (let at = 0; at + 2 < indices.length; at += 3) {
    const corners = [indices[at]!, indices[at + 1]!, indices[at + 2]!] as const
    const [a, b, c] = corners.map((index) => read(index, 0)) as [Vector3, Vector3, Vector3]
    const [u, v] = [minus(b, a), minus(c, a)]
    const face = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x }

    // Index order is right-handed against the normals stored beside it, independently of any view.
    const stored = corners
      .map((index) => read(index, 12))
      .reduce((sum, n) => ({ x: sum.x + n.x, y: sum.y + n.y, z: sum.z + n.z }))
    assert.ok(dot(face, stored) > 0, `triangle ${at / 3} winds against its normals`)

    // So counter-clockwise on screen is exactly the triangles facing the camera, at the origin.
    const [pa, pb, pc] = [a, b, c].map(clipOf).map(({ x, y, w }) => ({ x: x / w, y: y / w })) as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ]
    const counterClockwise = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x) > 0
    const position = Matrix4.transformPoint(a, toWorld)
    const towards = -dot(Matrix4.transformDirection(face, toWorld), position) > 0
    assert.equal(counterClockwise, towards, `triangle ${at / 3}`)
  }
})

test('each part stands where retail drew it', { skip }, () => {
  const draws = lastFrame()
  const file = readFileSync(join(data, 'SHIPS/LIBERTY/LI_ELITE/li_elite.cmp'))
  const root = Directory.read(new Uint8Array(file.buffer, file.byteOffset, file.byteLength))
  const meshes = readVMeshLibrary(root)
  const model = readRigidModel(root) as CompoundNode<RigidPart>
  const transforms = partTransforms(model, sceneModel())
  const view = viewMatrix(CAMERA)

  const columns = (matrix: Matrix4) => [matrix.x, matrix.y, matrix.z, matrix.w]
  let compared = 0
  for (const [part, world] of transforms) {
    const source = part.part.type === 'rigid' ? part.part.part : undefined
    const level = source && 'levels' in source ? source.levels[0] : source
    if (!level) continue
    const modelView = columns(Matrix4.multiply(view, world))

    for (const { startIndex } of getMeshDraw(
      getMesh(meshes, level.reference.meshId)!,
      level.reference,
    )) {
      const { world: retail } = draws.find((draw) => draw.startIndex === startIndex)!
      // Retail's world is the modelview with Z flipped, written as rows for row vectors.
      modelView.forEach((column, c) =>
        [column.x, column.y, -column.z].forEach((cell, r) =>
          assert.ok(
            Math.abs(cell - retail![c * 4 + r]!) < 1e-3,
            `${part.name} [${r}][${c}]: ${cell} against ${retail![c * 4 + r]}`,
          ),
        ),
      )
      compared++
    }
  }
  assert.equal(compared, 19)
})

test('the collected frame is retail draw for draw, in retail order', { skip }, () => {
  const draws = lastFrame().slice(0, 22)
  const file = readFileSync(join(data, 'SHIPS/LIBERTY/LI_ELITE/li_elite.cmp'))
  const root = Directory.read(new Uint8Array(file.buffer, file.byteOffset, file.byteLength))
  const meshes = readVMeshLibrary(root)
  const library = (path: string) => {
    const bytes = readFileSync(join(data, path))
    return Directory.read(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  }
  const ships = library('SHIPS/LIBERTY/li_playerships.mat')
  const materials = readMaterialLibrary(ships)
  const textures = [
    ...readTextureLibrary(ships),
    ...readTextureLibrary(root),
    ...readTextureLibrary(library('FX/envmapbasic.mat')),
    ...readTextureLibrary(library('FX/envmapglass.txm')),
  ]
  const index = indexTextures(data)

  const frame = collectFrame({
    camera: CAMERA,
    aspect: 1024 / 768,
    ambient: { x: 40 / 255, y: 40 / 255, z: 40 / 255 },
    lights: [{ color: { x: 1, y: 1, z: 1 }, direction: { x: 0.5, y: -0.5, z: -1 } }],
    models: [
      {
        parts: placeParts(readRigidModel(root) as CompoundNode<RigidPart>, sceneModel()),
        mesh: (id) => getMesh(meshes, id),
        material: (id) => getMaterial(materials, id),
        texture: (name) =>
          textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase()),
        environment: 'envmapbasic',
      },
    ],
  })

  assert.deepEqual(frame.unsupported, [])
  assert.equal(frame.draws.length, 22)

  assertFrameMatches(frame, draws, index)

  const close = (a: number, b: number, what: string) =>
    assert.ok(Math.abs(a - b) < 1e-5, `${what}: ${a} against ${b}`)

  // Retail's lights are in flipped view space, and this camera is identity.
  const [light] = draws[0]!.lights
  const length = Math.hypot(0.5, 0.5, 1)
  close(light!.direction[0]!, 0.5 / length, 'light x')
  close(light!.direction[1]!, -0.5 / length, 'light y')
  close(light!.direction[2]!, 1 / length, 'light z')
  assert.equal(draws[0]!.states['AMBIENT'], 0xff282828)
})
