import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CompoundNode } from '@treewyrm/freelancer/compound'
import type { Material } from '@treewyrm/freelancer/material'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import type { RigidPart } from '@treewyrm/freelancer/rigid'
import type { TextureEntry } from '@treewyrm/freelancer/texture'
import {
  Primitive,
  type VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
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

test('ambient follows diffuse unless a material names its own', () => {
  const diffuse = { x: 0.5, y: 0.25, z: 0.125 }
  assert.deepEqual(collectFrame(scene(skinned({ diffuse }))).draws[0]!.ambient, diffuse)
  const ambient = { x: 1, y: 0, z: 0 }
  assert.deepEqual(collectFrame(scene(skinned({ diffuse, ambient }))).draws[0]!.ambient, ambient)
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
