import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { CompoundNode } from '@treewyrm/freelancer/compound'
import type { Material } from '@treewyrm/freelancer/material'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import type { MaterialAnim, RigidPart } from '@treewyrm/freelancer/rigid'
import type { TextureEntry } from '@treewyrm/freelancer/texture'
import { Primitive, VertexFormat, type VMeshData, type VMeshRef } from '@treewyrm/freelancer/vmesh'
import { projectionMatrix } from './camera.js'
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
  const frame = collectFrame(scene({ name: 'planet', type: 'StarsphereMaterial' }))
  assert.deepEqual(frame.draws, [])
  assert.deepEqual(frame.unsupported, ['planet'])
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

  const unbuilt = collectFrame(scene(skinned({ type: 'StarsphereMaterial' })))
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

const named = (name: string, flags = 0x40) => ({ name, flags })

test('DcDtEt adds its Et, ignoring Ec and Oc, and never blends', () => {
  const material = skinned({
    type: 'DcDtEt',
    emission: { x: 1, y: 0, z: 0 },
    opacity: 0.5,
    emissionTexture: named('glow'),
  })
  const [draw] = collectFrame(scene(material)).draws
  assert.equal(draw!.second?.operation, 'add')
  assert.deepEqual([draw!.blend, draw!.alphaReference, draw!.diffuse[3]], [false, 0, 1])
  assert.deepEqual(draw!.emissive, { x: 0, y: 0, z: 0 })
})

test('stage 1 taken shuts out the reflection, and a DcDtEt without Et leaves it free', () => {
  const environment = { environment: 'cube' }
  const [withEt] = collectFrame(
    scene(skinned({ type: 'DcDtEt', emissionTexture: named('glow') }), environment),
  ).draws
  assert.deepEqual([withEt!.environment, withEt!.normalizeNormals], [undefined, false])

  const [withoutEt] = collectFrame(scene(skinned({ type: 'DcDtEt' }), environment)).draws
  assert.deepEqual([withoutEt!.environment, withoutEt!.second], ['cube', undefined])

  const [detail] = collectFrame(
    scene(skinned({ type: 'BtDetailMapMaterial', detailTexture: named('bt') }), environment),
  ).draws
  assert.deepEqual([detail!.environment, detail!.second?.operation], [undefined, 'modulate2x'])
})

test('BtDetailMapMaterial keeps Ec and Oc, and takes the stage even without a Bt', () => {
  const [draw] = collectFrame(
    scene(skinned({ type: 'BtDetailMapMaterial', emission: { x: 1, y: 0, z: 0 }, opacity: 0.5 })),
  ).draws
  assert.deepEqual([draw!.blend, draw!.diffuse[3]], [false, 0.5])
  assert.deepEqual(draw!.emissive, { x: 1, y: 0, z: 0 })
  assert.deepEqual(draw!.second, { operation: 'modulate2x' })
})

test('a UV set the mesh has not got is kept, as retail keeps its coordinate index', () => {
  const material = skinned({ type: 'DcDtEt', emissionTexture: named('glow', 0x5a) })
  assert.equal(collectFrame(scene(material)).draws[0]!.second?.texture?.uvSet, 1)
})

test('the other glass names are glass', () => {
  for (const name of ['planet_glass', 'planet_dome_glass'])
    assert.equal(collectFrame(scene(skinned({ name, type: 'DcDt' }))).draws.length, 2)
})

test('a nomad surface draws once, blended, both sides, writing no depth, with its ramp', () => {
  const material = skinned({
    name: 'nomad_hull',
    type: 'DcDtBtOcOtTwo',
    diffuse: { x: 1, y: 0, z: 0 },
  })
  const ramp = texture('rgb24_888')
  const frame = collectFrame(
    scene(material, {
      texture: (name) => (name === 'NomadRGB1_NomadAlpha1' ? ramp : texture('dxt1')),
    }),
  )
  assert.equal(frame.draws.length, 1)
  const [draw] = frame.draws
  assert.deepEqual(
    [draw!.cull, draw!.depthWrite, draw!.blend, draw!.nomad, draw!.alphaReference],
    ['none', false, true, true, 0],
  )
  assert.deepEqual(draw!.diffuse, [1, 1, 1, 1])
  assert.equal(draw!.environment, undefined)
  assert.equal(draw!.second?.operation, 'add')
  assert.equal(draw!.second?.texture?.entry, ramp)
  assert.equal(draw!.second?.texture?.uvSet, 1)
})

test('fade reaches a nomad surface through a smoothstep, truncated to a byte', () => {
  const alphaAt = (fade: number) =>
    collectFrame(scene(skinned({ name: 'nomad_hull' }), { fade })).draws[0]!.diffuse[3]
  assert.equal(alphaAt(1), 1)
  assert.equal(alphaAt(0), 0)
  // 1 - (3 - 1) * 0.25 = 0.5, and int(127.5) is 127.
  assert.equal(alphaAt(0.5), 127 / 255)
})

test('other draws write depth', () => {
  assert.equal(collectFrame(scene(skinned({}))).draws[0]!.depthWrite, true)
})

test('a .3db is placed as one part, at the transform', () => {
  const single = root.part
  const placed = placeParts(single, Matrix4.translation({ x: 1, y: 2, z: 3 }))
  assert.equal(placed.length, 1)
  assert.equal(placed[0]!.world.w.x, 1)
})

describe('a cloaked model', () => {
  const cloaked = { cloaked: true, fade: 0.5, environment: 'cube', texture: () => texture('dxt1') }

  test('keeps its texture, multiplies alpha, blends, and neither cuts nor reflects', () => {
    const [draw] = collectFrame(scene(skinned({ opacity: 0.5 }), cloaked)).draws
    assert.equal(draw!.texture?.name, 'skin')
    assert.equal(draw!.diffuse[3], 0.25)
    assert.deepEqual([draw!.blend, draw!.alphaReference], [true, 0])
    assert.deepEqual([draw!.environment, draw!.normalizeNormals], [undefined, false])
  })

  test('fully there draws plain, whatever its texture blended by', () => {
    const [draw] = collectFrame(
      scene(skinned({}), { cloaked: true, fade: 1, texture: () => texture('dxt5') }),
    ).draws
    assert.deepEqual([draw!.blend, draw!.diffuse[3]], [false, 1])
  })

  test('keeps a two-sided pair and a stage 1', () => {
    assert.equal(collectFrame(scene(skinned({ type: 'DcDtTwo' }), cloaked)).draws.length, 2)
    const [emission] = collectFrame(
      scene(skinned({ type: 'DcDtEt', emissionTexture: named('glow') }), cloaked),
    ).draws
    assert.deepEqual([emission!.second?.operation, emission!.diffuse[3]], ['add', 0.5])
  })

  test('undoes nothing but the reflection on a batched material', () => {
    const [draw] = collectFrame(scene(skinned({ type: 'DcDtOcOt', opacity: 0.5 }), cloaked)).draws
    assert.deepEqual([draw!.diffuse[3], draw!.environment], [0.5, undefined])
  })

  test('leaves a nomad surface to the value alone', () => {
    const [draw] = collectFrame(scene(skinned({ name: 'nomad_hull' }), cloaked)).draws
    assert.deepEqual([draw!.nomad, draw!.diffuse[3]], [true, 127 / 255])
  })
})

const scroll = {
  name: 'hull',
  flags: 0,
  segments: [
    {
      duration: 2,
      start: { uOffset: 0, vOffset: 0, uScale: 0, vScale: 0 },
      velocity: { uOffset: 0.5, vOffset: 0, uScale: 0, vScale: 0 },
    },
  ],
} as unknown as MaterialAnim

test('a single-pass material takes its UV animation by name, at the host clock', () => {
  const frame = collectFrame({
    ...scene(skinned({}), { materialAnimations: [scroll] }),
    time: 1,
  })
  assert.deepEqual(frame.draws[0]!.uvTransform, { offset: [0.5, 0], scale: [1, 1] })
})

test('a material with none, or of another class, has no transform', () => {
  const [other] = collectFrame(
    scene(skinned({ name: 'other' }), { materialAnimations: [scroll] }),
  ).draws
  assert.equal(other!.uvTransform, undefined)
  const [emission] = collectFrame(
    scene(skinned({ type: 'DcDtEt' }), { materialAnimations: [scroll] }),
  ).draws
  assert.equal(emission!.uvTransform, undefined)
})

describe('the classes that take a per-object colour', () => {
  const ambient = { x: 0.1, y: 0.2, z: 0.3 }
  const opaque = { texture: () => texture('rgb24_888') }

  test('a HUD icon takes its instance over Ac and Oc, and blends only below 1', () => {
    const icon = skinned({ name: 'ui_x', opacity: 0.5, diffuse: { x: 1, y: 1, z: 1 } })
    const [drawn] = collectFrame(
      scene(icon, { ...opaque, instance: { ambient, alpha: 0.25 } }),
    ).draws
    assert.deepEqual([drawn!.ambient, drawn!.diffuse[3], drawn!.blend], [ambient, 0.25, true])
    const [own] = collectFrame(scene(skinned({ name: 'ui_x' }), opaque)).draws
    assert.deepEqual([own!.blend, own!.cull, own!.alphaReference], [false, 'back', 0])
  })

  test('an exclusion zone always blends, under a white ambient', () => {
    const [drawn] = collectFrame(scene(skinned({ name: 'exclusion_x' }), opaque)).draws
    assert.equal(drawn!.blend, true)
    assert.deepEqual(drawn!.sceneAmbient, { x: 1, y: 1, z: 1 })
  })

  test('water writes no depth, compares at or below, and animates', () => {
    const [drawn] = collectFrame({
      ...scene(skinned({ name: 'sea_anim_x' }), {
        ...opaque,
        materialAnimations: [{ ...scroll, name: 'sea_anim_x' }],
      }),
      time: 1,
    }).draws
    assert.deepEqual([drawn!.depthWrite, drawn!.depthFunc], [false, 'lequal'])
    assert.deepEqual(drawn!.uvTransform?.offset, [0.5, 0])
  })

  test('each leaves stage 1 free for a reflection', () => {
    for (const name of ['ui_x', 'anim_hud_x', 'exclusion_x', 'sea_anim_x']) {
      const [drawn] = collectFrame(
        scene(skinned({ name }), { ...opaque, environment: 'cube' }),
      ).draws
      assert.deepEqual([name, drawn!.environment], [name, 'cube'])
    }
  })
})

test('a host`s own [MaterialMap] replaces retail`s', () => {
  const rules = [{ on: 'name', pattern: /^mine/, to: 'DcDtTwo' }] as const
  const draws = collectFrame(scene(skinned({ name: 'mine_hull' }), { materialMap: rules })).draws
  assert.equal(draws.length, 2)
  const untouched = collectFrame(
    scene(skinned({ name: 'nomad_hull' }), { materialMap: rules }),
  ).draws
  assert.equal(untouched[0]!.nomad, false)
})

describe('the classes with fixed tables', () => {
  const env = { environment: 'cube', texture: () => texture('rgb24_888') }

  test('EcEt adds its Et on stage 0, lit, twice when Two, and reflects', () => {
    const glow = named('glow')
    const [draw] = collectFrame(scene(skinned({ type: 'EcEt', emissionTexture: glow }), env)).draws
    assert.deepEqual(
      [draw!.texture?.name, draw!.blendMode, draw!.blend, draw!.unlit, draw!.environment],
      ['glow', 'add', true, false, 'cube'],
    )
    assert.equal(collectFrame(scene(skinned({ type: 'EcEtTwo' }), env)).draws.length, 2)
  })

  test('LightMap multiplies the frame, unlit, at or below', () => {
    const [draw] = collectFrame(scene(skinned({ type: 'LightMap' }), env)).draws
    assert.deepEqual(
      [draw!.blendMode, draw!.unlit, draw!.depthFunc, draw!.environment],
      ['multiply', true, 'lequal', 'cube'],
    )
  })

  test('engine glow has no texture and doesn`t blend, and takes the reflection', () => {
    const [draw] = collectFrame(scene(skinned({ type: 'EngineGlowMaterial' }), env)).draws
    assert.deepEqual(
      [draw!.texture, draw!.blend, draw!.unlit, draw!.environment],
      [undefined, false, false, 'cube'],
    )
  })

  test('Nebula adds by alpha, unlit, and Two draws twice', () => {
    const [draw] = collectFrame(scene(skinned({ type: 'Nebula' }), env)).draws
    assert.deepEqual([draw!.blendMode, draw!.unlit], ['alphaAdd', true])
    assert.equal(collectFrame(scene(skinned({ type: 'NebulaTwo' }), env)).draws.length, 2)
  })

  test('other draws blend by alpha, and are lit', () => {
    const [draw] = collectFrame(scene(skinned({ opacity: 0.5 }), env)).draws
    assert.deepEqual([draw!.blendMode, draw!.unlit], ['alpha', false])
  })
})

test('a nomad surface vanishes on an environment-mapped object', () => {
  const [draw] = collectFrame(scene(skinned({ name: 'nomad_hull' }), { environment: 'cube' })).draws
  assert.equal(draw!.diffuse[3], 0)
})

test('an override type named by a material is reported, and draws nothing', () => {
  for (const type of [
    'VisibleCounterMaterial',
    'ShadowMaterial',
    'CloakMaterial',
    'WireMaterial',
  ]) {
    const { draws, unsupported } = collectFrame(scene(skinned({ type })))
    assert.deepEqual([type, draws, unsupported], [type, [], ['hull']])
  }
})

test('a planet surface tiles its mask on UV0, and each class has its own passes', () => {
  const masks = {
    maskTexture: { name: 'dm', flags: 0x40 },
    maskTexture0: { name: 'dm0', flags: 0x44 },
    maskTexture1: { name: 'dm1', flags: 0x44 },
    tileRate: 3,
    tileRate0: 5,
    tileRate1: 7,
  }
  const passes = (type: string) =>
    collectFrame(scene(skinned({ type, ...masks }))).draws.map(
      ({ alphaFunction, alphaReference, blend, depthFunc, depthWrite, unlit, second }) => [
        alphaFunction,
        alphaReference,
        blend,
        depthFunc,
        depthWrite,
        unlit,
        second?.texture?.name,
        second?.texture?.uvSet,
        second?.tile,
      ],
    )
  const a = ['less', 0xfe, false, 'less', true, false]
  const b = ['greater', 1, true, 'lequal', true, false]
  assert.deepEqual(passes('DetailMapMaterial'), [
    ['greater', 0, false, 'less', true, false, 'dm', 0, 3],
  ])
  assert.deepEqual(passes('DetailMap2Dm1Msk2PassMaterial'), [
    [...a, 'dm1', 0, 3],
    [...b, undefined, undefined, undefined],
  ])
  assert.deepEqual(passes('Masked2DetailMapMaterial'), [
    [...a, 'dm0', 0, 5],
    [...b, 'dm1', 0, 7],
  ])
  assert.deepEqual(passes('IllumDetailMapMaterial'), [
    ['always', 0, false, 'less', true, false, 'dm0', 0, 5],
    ['greater', 1, true, 'lequal', false, true, 'dm1', 0, 7],
  ])
})

test('an atmosphere draws scaled, unwritten, with its UVs from the unscaled object', () => {
  const frame = collectFrame(
    scene(skinned({ type: 'AtmosphereMaterial', fade: 1.1, alpha: 0.6, scale: 2 })),
  )
  const [draw] = frame.draws
  assert.deepEqual([draw!.blend, draw!.depthWrite, draw!.depthFunc], [true, false, 'lequal'])
  assert.equal(draw!.world.x.x, 2)
  assert.ok(draw!.atmosphere)
})

test('a starsphere stands at the camera and ignores depth, light and the queue', () => {
  const base = scene(skinned({ type: 'DcDtOcOt', opacity: 0.5 }))
  const camera = { ...base.camera, position: { x: 0, y: 0, z: 30 } }
  const sky = collectFrame({
    ...base,
    camera,
    models: [{ ...base.models[0]!, sky: 'starsphere' }, base.models[0]!],
  })
  const [first] = sky.draws
  // Queued glass flushes last, and the sky's copy of it stays first.
  assert.equal(first!.depthFunc, 'always')
  assert.equal(first!.depthWrite, false)
  assert.equal(first!.lightless, true)
  assert.deepEqual(first!.sceneAmbient, { x: 1, y: 1, z: 1 })
  const { w } = Matrix4.multiply(sky.view, first!.world)
  assert.deepEqual([w.x, w.y, w.z], [0, 0, 0])
  assert.equal(sky.draws[1]!.depthFunc, 'less')
  // The opaque hook waits for the first blended draw that isn't sky.
  assert.equal(sky.hooks.find(({ name }) => name === 'opaque')!.before, 1)
})

test('a mod can change the least alpha of glass and the planes of a backdrop', () => {
  const glass: Material = { name: 'L_glass', type: 'DcDtOcOt', opacity: 0.5 }
  const limits = { glassLeastAlpha: 0.3 }
  const draws = collectFrame({ ...scene(glass), limits }).draws
  assert.deepEqual(
    draws.map(({ diffuse }) => diffuse[3]),
    [0.5, 0.5],
  )

  const base = scene(skinned({ type: 'DcDt' }))
  const models = [{ ...base.models[0]!, sky: 'backdrop' as const }]
  const planes = { backdropNear: 2, backdropFar: 500000 }
  const [draw] = collectFrame({ ...base, models, limits: planes }).draws
  assert.deepEqual(draw!.projection, projectionMatrix({ ...base.camera, near: 2, far: 500000 }, 1))
  const [retail] = collectFrame({ ...base, models }).draws
  assert.deepEqual(
    retail!.projection,
    projectionMatrix({ ...base.camera, near: 1, far: 200000 }, 1),
  )
})

test('a backdrop keeps the view, and has planes of its own', () => {
  const base = scene(skinned({ type: 'DcDt' }))
  const camera = { ...base.camera, position: { x: 0, y: 0, z: 30 } }
  const frame = collectFrame({
    ...base,
    camera,
    models: [{ ...base.models[0]!, sky: 'backdrop' }],
  })
  const [draw] = frame.draws
  assert.equal(draw!.depthFunc, 'always')
  assert.equal(draw!.lightless, undefined)
  assert.equal(draw!.sceneAmbient, undefined)
  assert.deepEqual(draw!.world, base.models[0]!.parts[0]!.world)
  assert.notDeepEqual(draw!.projection, frame.projection)
})
