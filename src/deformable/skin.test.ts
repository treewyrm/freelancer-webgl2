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
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import { Directory } from '@treewyrm/freelancer/utf'
import { Primitive } from '@treewyrm/freelancer/vmesh'
import { boneTable, MAX_BONES, placeSkin, skinMesh } from './skin.js'

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
    bones: [{ ...bone(0), name: 'root' }, ...Array.from({ length: 7 }, () => bone(5))],
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
