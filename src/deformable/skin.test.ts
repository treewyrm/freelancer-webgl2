import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { test } from 'node:test'
import { getResourceId } from '@treewyrm/freelancer'
import {
  readDeformableModel,
  type Bone,
  type DeformableModel,
  type FaceGroup,
  type Level,
} from '@treewyrm/freelancer/deformable'
import { Matrix3, Matrix4, Quat } from '@treewyrm/freelancer/math'
import { Directory } from '@treewyrm/freelancer/utf'
import { Primitive } from '@treewyrm/freelancer/vmesh'
import type { Camera } from '#/scene/camera.js'
import type { SwitchTable } from './level.js'
import { boneTable, MAX_BONES, placeCostume, placeSkin, poseSkin, skinMesh } from './skin.js'

const strip = (material: string, ...indices: number[]): FaceGroup => ({
  material,
  primitive: 'strip',
  indices: new Uint16Array(indices),
})

// Five points, each with a different number of influences, through a welded element list.
const level = (groups: FaceGroup[] = [strip('skin', 0, 1, 2, 3)]): Level =>
  ({
    fraction: 1,
    groups,
    geometry: {
      indices: new Uint32Array([0, 1, 2, 3, 3]),
      points: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uv0: {
        indices: new Uint32Array([0, 1, 2, 3, 0]),
        coordinates: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      },
      // Deliberately wrong: the game never reads these.
      boneFirst: new Uint32Array([9, 9, 9, 9]),
      boneCount: new Uint32Array([1, 2, 5, 0]),
      boneIds: new Uint32Array([3, 1, 2, 4, 0, 1, 2, 3]),
      boneWeights: new Float32Array([0.25, 0.75, 0.25, 0.5, 0.1, 0.1, 0.1, 0.1]),
    },
  }) as unknown as Level

const influence = (level: Level, element: number) => {
  const { influences } = skinMesh(level, 8)
  return [...influences.slice(element * 8, element * 8 + 8)]
}

test('a lone influence ignores its weight, and two to four blend as written', () => {
  const skin = level()
  assert.deepEqual(influence(skin, 0), [3, 0, 0, 0, 1, 0, 0, 0])
  assert.deepEqual(influence(skin, 1), [1, 2, 0, 0, 0.75, 0.25, 0, 0])
})

test('five or more keep the first influence, at its own weight', () => {
  assert.deepEqual(influence(level(), 2), [4, 0, 0, 0, 0.5, 0, 0, 0])
})

test('a point with none takes bone 0, where a zero sum would collapse it', () => {
  assert.deepEqual(influence(level(), 3), [0, 0, 0, 0, 1, 0, 0, 0])
})

test('each element is a vertex, pairing its point with its own coordinate', () => {
  const { mesh, reference } = skinMesh(level(), 8)
  const floats = new Float32Array(mesh.vertices.buffer)
  assert.equal(reference.vertexCount, 5)
  assert.equal(mesh.format, 0x112)
  // Elements 3 and 4 share a point, and split at their coordinates.
  assert.deepEqual([...floats.slice(3 * 8, 3 * 8 + 8)], [1, 1, 0, 0, 0, 1, 1, 1])
  assert.deepEqual([...floats.slice(4 * 8, 4 * 8 + 8)], [1, 1, 0, 0, 0, 1, 0, 0])
})

test('strips expand to lists, group by group, as the game loads them, and an empty group goes', () => {
  const { mesh, reference } = skinMesh(
    level([strip('a', 0, 1, 2, 3), strip('none'), strip('b', 2, 1, 3)]),
    8,
  )
  assert.equal(mesh.primitive, Primitive.TriangleList)
  // `ExpandTristrip`: an odd triangle swaps its last two. `character_reed` holds 0, 1, 2, 1, 3, 2.
  assert.deepEqual([...mesh.indices], [0, 1, 2, 1, 3, 2, 2, 1, 3])
  assert.deepEqual(
    mesh.groups.map(({ materialId, elementCount }) => [materialId, elementCount]),
    [
      [getResourceId('a'), 6],
      [getResourceId('b'), 3],
    ],
  )
  assert.equal(reference.groupCount, 2)
})

test('expanding drops what has no area, without losing the parity, and a list stays', () => {
  const { mesh } = skinMesh(
    level([
      strip('a', 0, 1, 2, 2, 3, 4),
      { material: 'b', primitive: 'list', indices: new Uint16Array([0, 1, 2]) },
    ]),
    8,
  )
  // At 3, odd, so 2, 3, 4 swaps its last two.
  assert.deepEqual([...mesh.indices], [0, 1, 2, 2, 4, 3, 0, 1, 2])
})

test('what can only be a broken file throws', () => {
  assert.throws(() => skinMesh(level(), 2), RangeError)
  assert.throws(() => skinMesh(level([strip('a', 0, 1, 9)]), 8), RangeError)
})

test('the same level is the same object, so buffers are shared', () => {
  const skin = level()
  assert.equal(skinMesh(skin, 8), skinMesh(skin, 8))
})

const bone = (x: number): Bone =>
  ({ orientation: Matrix3.identity, position: { x, y: 0, z: 0 } }) as unknown as Bone

const moved = (x: number, y = 0, z = 0) => Matrix4.translation({ x, y, z })

const applied = (table: Float32Array, slot: number, x: number, y: number, z: number) => {
  const at = slot * 16
  return [
    table[at]! * x + table[at + 4]! * y + table[at + 8]! * z + table[at + 12]!,
    table[at + 1]! * x + table[at + 5]! * y + table[at + 9]! * z + table[at + 13]!,
    table[at + 2]! * x + table[at + 6]! * y + table[at + 10]! * z + table[at + 14]!,
  ]
}

test('the table is relative to the root, wherever the root is', () => {
  // `Bone to root` is the inverse bind, so a bone standing at bind cancels it, far from the origin too.
  const root = moved(1000, 2000, 3000)
  const world = Matrix4.multiply(root, moved(-5))
  const table = boneTable([bone(0), bone(5)], [root, world], root)
  assert.deepEqual(applied(table, 1, 7, 8, 9), [7, 8, 9])
  assert.deepEqual(applied(table, 0, 7, 8, 9), [7, 8, 9])

  // Moved along from bind, by its own 2.
  const along = Matrix4.multiply(root, moved(-3))
  assert.deepEqual(
    applied(boneTable([bone(0), bone(5)], [root, along], root), 1, 0, 0, 0),
    [2, 0, 0],
  )
})

test('a slot with no world keeps the identity', () => {
  const table = boneTable([bone(5)], [undefined], moved(10))
  assert.deepEqual(applied(table, 0, 7, 8, 9), [7, 8, 9])
})

test('a table past the game has no room for throws', () => {
  const bones = Array.from({ length: MAX_BONES + 1 }, () => bone(0))
  assert.throws(() => boneTable(bones, [], Matrix4.identity), RangeError)
})

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')

const files = function* (directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) yield* files(path)
    else if (extname(path).toLowerCase() === '.dfm') yield path
  }
}

test(
  'every retail level becomes a mesh, within the table',
  { skip: !existsSync(data) && 'no retail DATA' },
  () => {
    let models = 0
    let levels = 0
    let largest = 0
    for (const path of files(data)) {
      const model = readDeformableModel(Directory.read(readFileSync(path)))
      models++
      largest = Math.max(largest, model.bones.length)
      boneTable(model.bones, [], Matrix4.identity)
      for (const entry of model.levels) {
        skinMesh(entry, model.bones.length)
        levels++
      }
    }
    assert.deepEqual([models, levels, largest], [204, 1220, 86])
  },
)

test('the chain is the default, and bind draws the skin as modelled whatever the joints say', () => {
  const model = {
    levels: [level()],
    // As many as `level` skins to. Only the first has a name, so a joint.
    bones: [
      { ...bone(0), name: 'root', hardpoints: [] },
      ...Array.from({ length: 7 }, () => ({ ...bone(5), hardpoints: [] })),
    ],
    constraints: [],
  } as unknown as DeformableModel
  const transform = moved(10)

  const chain = placeSkin(model, transform)!
  assert.deepEqual(chain.world, transform)
  // The root stands at its world, and a bone no part claims keeps the identity.
  assert.deepEqual(applied(chain.skin!.bones, 0, 1, 2, 3), [1, 2, 3])
  assert.deepEqual(applied(chain.skin!.bones, 1, 1, 2, 3), [1, 2, 3])

  const bind = placeSkin(model, transform, { pose: 'bind' })!
  assert.deepEqual(bind.world, transform)
  for (const slot of [0, 1]) assert.deepEqual(applied(bind.skin!.bones, slot, 1, 2, 3), [1, 2, 3])
})

test('a model with no named bone or no level has nothing to place', () => {
  const none = { levels: [], bones: [bone(0)], constraints: [] } as unknown as DeformableModel
  assert.equal(placeSkin(none, Matrix4.identity), undefined)
})

// One point on bone 0, so a level builds whatever the bones are.
const single = (): Level =>
  ({
    fraction: 1,
    groups: [strip('skin', 0, 0, 0)],
    geometry: {
      indices: new Uint32Array([0]),
      points: new Float32Array(3),
      normals: new Float32Array(3),
      uv0: { indices: new Uint32Array([0]), coordinates: new Float32Array(2) },
      boneFirst: new Uint32Array(1),
      boneCount: new Uint32Array([1]),
      boneIds: new Uint32Array([0]),
      boneWeights: new Float32Array([1]),
    },
  }) as unknown as Level

const hardpoint = (name: string, x = 0) => ({
  type: 'fixed' as const,
  name,
  orientation: Matrix3.identity,
  position: { x, y: 0, z: 0 },
})

const part = (...bones: Partial<Bone>[]) =>
  ({
    levels: [single()],
    bones: bones.map((fields) => ({ ...bone(0), hardpoints: [], ...fields })),
    constraints: [],
  }) as unknown as DeformableModel

const origin = (matrix: Matrix4) => matrix.w.x

test('a part joins its first holder by shared name, whatever the name, and ignoring case', () => {
  const body = part({ name: 'root', hardpoints: [hardpoint('hp_anything', 3)] })
  const head = part({ name: 'skull', hardpoints: [hardpoint('HP_ANYTHING', 1)] })
  const parts = placeCostume([body, head], moved(10))
  // W(later) = W(first) · H(first) · H(later)⁻¹
  assert.deepEqual(
    parts.map(({ world }) => origin(world)),
    [10, 12],
  )
})

test('body first makes the body the host, and an unmatched part stands at the transform', () => {
  const body = part({ name: 'root', hardpoints: [hardpoint('a', 3)] })
  const prop = part({ name: 'loose', hardpoints: [hardpoint('b', 1)] })
  assert.deepEqual(
    placeCostume([body, prop], moved(10)).map(({ world }) => origin(world)),
    [10, 10],
  )
})

test('a seam is one detached bone, linked by its own name, into its own slot', () => {
  const body = part({ name: 'root', hardpoints: [hardpoint('neck', 2)] })
  const head = part(
    { name: 'skull' },
    { hardpoints: [hardpoint('neck', 0)], position: { x: 0, y: 0, z: 0 } },
    { name: 'jaw' },
  )
  const [, placed] = placeCostume([body, head], moved(10))
  // In the head's root space, at 10: the seam stands at the body's 12.
  assert.deepEqual(applied(placed!.skin!.bones, 1, 0, 0, 0), [2, 0, 0])
})

test('a seam nothing seats keeps the identity as its world, and past the cursor its slot is', () => {
  const head = part(
    { name: 'skull' },
    { hardpoints: [hardpoint('nothing')], position: { x: 4, y: 0, z: 0 } },
    { name: 'jaw' },
    { hardpoints: [hardpoint('after')], position: { x: 4, y: 0, z: 0 } },
  )
  const [placed] = placeCostume([head], moved(10))
  // `W(root)⁻¹ · B`: torn towards the world origin.
  assert.deepEqual(applied(placed!.skin!.bones, 1, 0, 0, 0), [-6, 0, 0])
  assert.deepEqual(applied(placed!.skin!.bones, 3, 0, 0, 0), [0, 0, 0])
})

const eyed = (z: { x: number; y: number; z: number }, parent: Matrix3 = Matrix3.identity) => {
  const uvBone = {
    bone: 1,
    scaleU: 0.4,
    scaleV: 0.4,
    minU: -0.2,
    maxU: 0.2,
    minV: -0.1,
    maxV: 0.1,
    distance: 1,
  }
  const level = single()
  ;(level.geometry as { uvBone?: unknown }).uvBone = uvBone
  const model = {
    levels: [level],
    bones: [
      { ...bone(0), name: 'head', hardpoints: [] },
      { ...bone(0), name: 'eye', hardpoints: [] },
    ],
    constraints: [
      {
        parent: 'head',
        child: 'eye',
        joint: {
          type: 'sphere',
          position: { x: 0, y: 0, z: 0 },
          offset: { x: 0, y: 0, z: 0 },
          orientation: Matrix3.identity,
        },
      },
    ],
  } as unknown as DeformableModel
  const length = Math.hypot(z.x, z.y, z.z)
  const unit = { x: z.x / length, y: z.y / length, z: z.z / length }
  const orientation = Quat.fromTo({ x: 0, y: 0, z: 1 }, unit)
  const root = Matrix4.fromRotationTranslation(parent, { x: 0, y: 0, z: 0 })
  return placeSkin(model, root, { jointState: () => ({ orientation }) })!.eyeOffset
}

test("an eye's offset is its bone's Z in its parent's frame, scaled, and clamped to the bone", () => {
  const offset = eyed({ x: 0.1, y: -0.05, z: 1 })!
  const length = Math.hypot(0.1, 0.05, 1)
  assert.ok(Math.abs(offset[0] - (0.4 * 0.1) / length) < 1e-5, `${offset}`)
  assert.ok(Math.abs(offset[1] - (0.4 * -0.05) / length) < 1e-5, `${offset}`)
  assert.deepEqual(eyed({ x: 1, y: 1, z: 0.01 }), [0.2, 0.1])
  assert.deepEqual(eyed({ x: -1, y: -1, z: 0.01 }), [-0.2, -0.1])
})

test('an eye within the dead zone has no offset at all', () => {
  assert.equal(eyed({ x: 0, y: 0, z: 1 }), undefined)
})

test("the head turning doesn't move the eye, as the offset is in its parent's frame", () => {
  const turned = Matrix3.axisAngle({ x: 0, y: 1, z: 0 }, 1)
  assert.equal(eyed({ x: 0, y: 0, z: 1 }, turned), undefined)
})

test('a level past what a part may skin draws rigid, a pick out of its table hides it', () => {
  const twoLevels = () =>
    ({ ...part({ name: 'root' }), levels: [single(), single(), single()] }) as DeformableModel
  const worldOf = (model: DeformableModel, skinnedLevels: number[], level: number) =>
    placeCostume([model], moved(10), { level, skinnedLevels })[0]!.skin!.bones
  const model = twoLevels()
  const bound = worldOf(model, [Infinity], 2)
  const rigid = worldOf(model, [2], 2)
  assert.deepEqual(applied(rigid, 0, 1, 2, 3), [1, 2, 3])
  assert.deepEqual(applied(bound, 0, 1, 2, 3), [1, 2, 3])
  // A bone off its bind shows the difference, with a body that has no limit by default.
  const off = {
    ...twoLevels(),
    bones: [{ ...bone(4), name: 'root', hardpoints: [] }],
  } as DeformableModel
  assert.deepEqual(applied(worldOf(off, [Infinity], 2), 0, 0, 0, 0), [4, 0, 0])
  assert.deepEqual(applied(worldOf(off, [2], 2), 0, 0, 0, 0), [0, 0, 0])

  const tables = [
    {
      rows: [
        [100, 10],
        [0, 20],
      ],
    },
  ] as SwitchTable[]
  const camera = (z: number) =>
    ({
      position: { x: 0, y: 0, z },
      orientation: Matrix3.identity,
      fovh: 20,
      near: 1,
      far: 100,
    }) as Camera
  assert.equal(
    placeCostume([model], Matrix4.identity, { lod: { camera: camera(5), tables } }).length,
    1,
  )
  assert.equal(
    placeCostume([model], Matrix4.identity, { lod: { camera: camera(50), tables } }).length,
    0,
  )
})

test('a host posing its own bones gets the same part as placing them, or a rigid one', () => {
  const model = part(
    { name: 'root', position: { x: 0, y: 0, z: 0 } },
    { name: 'arm', position: { x: -2, y: 0, z: 0 } },
  )
  const root = moved(10)
  const worlds = [root, moved(12)]
  const posed = poseSkin(model.levels[0]!, model.bones, { worlds, root })
  assert.deepEqual(posed.world, root)
  assert.deepEqual(applied(posed.skin!.bones, 1, 1, 0, 0), [1, 0, 0])
  const rigid = poseSkin(model.levels[0]!, model.bones, {
    worlds: [root, moved(99)],
    root,
    rigid: true,
  })
  assert.deepEqual(applied(rigid.skin!.bones, 1, 1, 0, 0), [1, 0, 0])
})
