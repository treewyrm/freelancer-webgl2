import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CompoundNode } from '@treewyrm/freelancer/compound'
import type { Material } from '@treewyrm/freelancer/material'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import type { RigidPart } from '@treewyrm/freelancer/rigid'
import type { TextureEntry } from '@treewyrm/freelancer/texture'
import { Primitive, VertexFormat, type VMeshData, type VMeshRef } from '@treewyrm/freelancer/vmesh'
import { collectFrame, placeParts, type Scene, type SceneModel } from './frame.js'

const reference: VMeshRef = {
  meshId: 1,
  vertexStart: 0,
  vertexCount: 3,
  indexStart: 0,
  indexCount: 3,
  groupStart: 0,
  groupCount: 1,
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
  boundingSphere: { center: { x: 0, y: 0, z: 0 }, radius: 0 },
}

const mesh: VMeshData = {
  name: 'mesh',
  version: 1,
  primitive: Primitive.TriangleList,
  format: 0x112 as VertexFormat,
  groups: [{ materialId: 7, vertexStart: 0, vertexEnd: 2, elementCount: 3, padding: 0 }],
  indices: new Uint16Array([0, 1, 2]),
  vertices: new Uint8Array(96),
}

const root: CompoundNode<RigidPart> = {
  type: 'compound',
  name: 'Root',
  index: 0,
  filename: 'root.3db',
  part: { type: 'rigid', hardpoints: [], part: { type: 'vmeshpart', reference } },
  children: [],
}

const texture = (format: 'dxt1' | 'dxt5' | 'rgb24_888'): TextureEntry => ({
  name: 'skin',
  type: 'image',
  storage: 'dds',
  format,
  width: 4,
  height: 4,
  flip: true,
  levels: [],
})

const scene = (material: Material, model: Partial<SceneModel> = {}): Scene => ({
  camera: {
    position: { x: 0, y: 0, z: 0 },
    orientation: Matrix3.identity,
    fovh: 30,
    near: 1,
    far: 100,
  },
  aspect: 1,
  ambient: { x: 0, y: 0, z: 0 },
  lights: [],
  models: [
    {
      parts: placeParts(root, Matrix4.translation({ x: 0, y: 0, z: 0 })),
      mesh: () => mesh,
      material: () => material,
      texture: () => texture('dxt1'),
      ...model,
    },
  ],
})

const skinned = (fields: Partial<Material>): Material => ({
  name: 'hull',
  type: 'DcDt',
  diffuseTexture: { name: 'skin', flags: 0x40 },
  ...fields,
})

test('a texture with one alpha bit is cut, and one with more is blended', () => {
  const [cut] = collectFrame(scene(skinned({}))).draws
  assert.deepEqual([cut!.blend, cut!.alphaReference], [false, 0x80])

  const [blended] = collectFrame(scene(skinned({}), { texture: () => texture('dxt5') })).draws
  assert.deepEqual([blended!.blend, blended!.alphaReference], [true, 0])

  const [opaque] = collectFrame(scene(skinned({}), { texture: () => texture('rgb24_888') })).draws
  assert.deepEqual([opaque!.blend, opaque!.alphaReference], [false, 0])
})

test('opacity under 1 blends, whatever the texture', () => {
  const [draw] = collectFrame(scene(skinned({ opacity: 0.5 }))).draws
  assert.equal(draw!.blend, true)
  assert.equal(draw!.diffuse[3], 0.5)
})

test('Two draws again reversed, with normals negated and no alpha cut', () => {
  const draws = collectFrame(scene(skinned({ type: 'DcDtTwo' }))).draws
  assert.deepEqual(
    draws.map(({ cull, negateNormals, alphaReference }) => [cull, negateNormals, alphaReference]),
    [
      ['back', false, 0x80],
      ['front', true, 0],
    ],
  )
})

test('glass draws inner faces opaque, then outer blended and reflecting', () => {
  const material: Material = { name: 'L_glass', type: 'DcDtOcOt', opacity: 0.5 }
  const draws = collectFrame(scene(material, { environment: 'envmapbasic' })).draws
  assert.deepEqual(
    draws.map(({ cull, blend, environment, diffuse }) => [cull, blend, environment, diffuse[3]]),
    [
      ['front', false, undefined, 0.8],
      ['back', true, 'envmapglass', 0.8],
    ],
  )
})

test('the archetype decides the reflection, and it normalizes normals', () => {
  const [plain] = collectFrame(scene(skinned({}))).draws
  assert.deepEqual([plain!.environment, plain!.normalizeNormals], [undefined, false])
  const [shiny] = collectFrame(scene(skinned({}), { environment: 'envmapbasic' })).draws
  assert.deepEqual([shiny!.environment, shiny!.normalizeNormals], ['envmapbasic', true])
})

test('the flags choose wrap and UV set', () => {
  const material = skinned({ diffuseTexture: { name: 'skin', flags: 0x5a } })
  const { sampler, uvSet } = collectFrame(scene(material)).draws[0]!.texture!
  assert.deepEqual([sampler.wrapU, sampler.wrapV, uvSet], ['clamp', 'clamp', 1])
})

test('what M3 has yet to cover is reported, and draws nothing', () => {
  const frame = collectFrame(scene({ name: 'detailmap_rock', type: 'DcDt' }))
  assert.deepEqual(frame.draws, [])
  assert.deepEqual(frame.unsupported, ['detailmap_rock'])
})

test('placing a compound model takes the level asked for, clamped, and leaves out hidden parts', () => {
  const near = { ...reference, meshId: 1 }
  const far = { ...reference, meshId: 2 }
  const levelled = (
    name: string,
    children: CompoundNode<RigidPart>[],
  ): CompoundNode<RigidPart> => ({
    ...root,
    name,
    children,
    part: {
      type: 'rigid',
      hardpoints: [],
      part: {
        type: 'multilevel',
        levels: [
          { type: 'vmeshpart', reference: near },
          { type: 'vmeshpart', reference: far },
        ],
      },
    } as RigidPart,
  })
  const tree = levelled('parent', [levelled('child', [])])
  const origin = Matrix4.translation({ x: 0, y: 0, z: 0 })

  const ids = (options: Parameters<typeof placeParts>[2]) =>
    placeParts(tree, origin, options).map(({ reference }) => reference.meshId)

  assert.deepEqual(ids({}), [1, 1])
  assert.deepEqual(ids({ level: 9 }), [2, 2])
  // A hidden parent's child still draws.
  assert.deepEqual(ids({ visible: ({ name }) => name !== 'parent' }), [1])
})

test('every single-pass type draws, and a two-sided one twice', () => {
  for (const [type, count] of [
    ['DcDt', 1],
    ['DcDtEc', 1],
    ['DcDtOcOt', 1],
    ['DcDtEcOcOt', 1],
    ['DcDtTwo', 2],
    ['DcDtEcTwo', 2],
    ['DcDtOcOtTwo', 2],
    ['DcDtEcOcOtTwo', 2],
  ] as const) {
    const { draws, unsupported } = collectFrame(scene(skinned({ type })))
    assert.deepEqual([type, draws.length, unsupported], [type, count, []])
  }
})

test('below full opacity a one-bit texture blends, and is not cut', () => {
  const [draw] = collectFrame(scene(skinned({ opacity: 0.5 }))).draws
  assert.deepEqual([draw!.blend, draw!.alphaReference], [true, 0])
})

test('the type drawn is the one the map gives, by the lowercased name', () => {
  const opaque = { texture: () => texture('rgb24_888') }
  const [mask] = collectFrame(
    scene(skinned({ name: 'Alpha_Mask_x', type: 'DcDtBt' }), opaque),
  ).draws
  assert.equal(mask!.materialName, 'Alpha_Mask_x')
  assert.equal(
    collectFrame(scene(skinned({ name: 'L_GLASS', type: 'DcDtOcOt' }), opaque)).draws.length,
    2,
  )
})

test('an unregistered type is told apart from one not built yet, and NullMaterial is neither', () => {
  const unregistered = collectFrame(scene(skinned({ type: 'DcDtEtTwo' })))
  assert.deepEqual(
    [unregistered.draws, unregistered.unregistered, unregistered.unsupported],
    [[], ['hull'], []],
  )

  const unbuilt = collectFrame(scene(skinned({ type: 'Nebula' })))
  assert.deepEqual([unbuilt.draws, unbuilt.unregistered, unbuilt.unsupported], [[], [], ['hull']])

  const nothing = collectFrame(scene(skinned({ name: 'null', type: 'DcDt' })))
  assert.deepEqual([nothing.draws, nothing.unregistered, nothing.unsupported], [[], [], []])
})

test('a mesh with vertex colours says so on its draws', () => {
  const [plain] = collectFrame(scene(skinned({}))).draws
  assert.equal(plain!.colorVertex, false)
  const coloured = { ...mesh, format: mesh.format | VertexFormat.Diffuse }
  const [draw] = collectFrame(scene(skinned({}), { mesh: () => coloured })).draws
  assert.equal(draw!.colorVertex, true)
})

test('setting a diffuse overwrites the ambient, and neither set is white', () => {
  const colour = { x: 0.5, y: 0.25, z: 1 }
  const other = { x: 0.1, y: 0.2, z: 0.3 }
  const ambientOf = (fields: Partial<Material>) =>
    collectFrame(scene(skinned(fields))).draws[0]!.ambient
  assert.deepEqual(ambientOf({ diffuse: colour, ambient: other }), colour)
  assert.deepEqual(ambientOf({ ambient: other }), other)
  assert.deepEqual(ambientOf({}), { x: 1, y: 1, z: 1 })
})

test('a blended batched type loses the environment stage and normalized normals', () => {
  const environment = { environment: 'cube', texture: () => texture('rgb24_888') }
  const [plain] = collectFrame(scene(skinned({}), environment)).draws
  assert.deepEqual([plain!.environment, plain!.normalizeNormals], ['cube', true])

  for (const type of ['DcDtOcOt', 'DcDtEcOcOt', 'DcDtOcOtTwo', 'DcDtEcOcOtTwo'])
    for (const draw of collectFrame(scene(skinned({ type, opacity: 0.5 }), environment)).draws)
      assert.deepEqual([type, draw.environment, draw.normalizeNormals], [type, undefined, false])
})

test('an opaque batched type submits at once, losing only the stage', () => {
  const environment = { environment: 'cube', texture: () => texture('rgb24_888') }
  const [draw] = collectFrame(scene(skinned({ type: 'DcDtOcOt' }), environment)).draws
  assert.deepEqual([draw!.environment, draw!.normalizeNormals], [undefined, true])
})

const placedAt = (z: number) => ({
  reference,
  world: Matrix4.translation({ x: 0, y: 0, z }),
})

test('blended batched draws wait for the end, far before near, keeping their passes together', () => {
  const frame = collectFrame({
    ...scene(skinned({})),
    models: [
      {
        parts: [placedAt(-5), placedAt(-50), placedAt(-20)],
        mesh: () => mesh,
        material: () => skinned({ name: 'glass', type: 'DcDtOcOtTwo', opacity: 0.5 }),
        texture: () => texture('rgb24_888'),
      },
      {
        parts: [placedAt(-10)],
        mesh: () => mesh,
        material: () => skinned({ name: 'hull', type: 'DcDt' }),
        texture: () => texture('rgb24_888'),
      },
    ],
  })
  assert.deepEqual(
    frame.draws.map(({ materialName, world, cull }) => [materialName, world.w.z, cull]),
    [
      ['hull', -10, 'back'],
      ['glass', -50, 'back'],
      ['glass', -50, 'front'],
      ['glass', -20, 'back'],
      ['glass', -20, 'front'],
      ['glass', -5, 'back'],
      ['glass', -5, 'front'],
    ],
  )
})

test('a blended type that is not batched keeps its place', () => {
  const frame = collectFrame({
    ...scene(skinned({})),
    models: [
      {
        parts: [placedAt(-5), placedAt(-50)],
        mesh: () => mesh,
        material: () => skinned({ type: 'DcDt', opacity: 0.5 }),
        texture: () => texture('rgb24_888'),
      },
    ],
  })
  assert.deepEqual(
    frame.draws.map(({ world }) => world.w.z),
    [-5, -50],
  )
})
