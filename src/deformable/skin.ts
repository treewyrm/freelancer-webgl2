/** A `.dfm` detail level as a mesh and its bone table: `FMeshArchetype::Skin`, in `Deformable2`. Pure, no GL. */
import { getResourceId } from '@treewyrm/freelancer'
import type { CompoundNode, JointState } from '@treewyrm/freelancer/compound'
import {
  getBoneModel,
  type Bone,
  type DeformableModel,
  type Level,
} from '@treewyrm/freelancer/deformable'
import { Matrix4 } from '@treewyrm/freelancer/math'
import {
  Primitive,
  type VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import { partTransforms } from '#/scene/hierarchy.js'
import type { DrawSkin, PlacedPart } from '#/scene/frame.js'

/** The game's table holds this many, and nothing checks it (`0x65f3898`). Retail's largest is 86. */
export const MAX_BONES = 150

export const INFLUENCE_FLOATS = 8

// As retail's vertex buffer: position, normal and UV0, which is all `deformable2.dll` reads.
const FORMAT = 0x112 as VertexFormat
const STRIDE_FLOATS = 8
const MOST_BLENDED = 4

export interface SkinMesh {
  mesh: VMeshData
  reference: VMeshRef
  /** Four bone indices, then four weights, per vertex. */
  influences: Float32Array
}

/** `ExpandTristrip` (`0x65f7d70`), which every strip goes through at load: what has no area goes. */
const expanded = (indices: Uint16Array): number[] => {
  const out: number[] = []
  for (let at = 0; at + 2 < indices.length; at++) {
    const [a, b, c] = [indices[at]!, indices[at + 1]!, indices[at + 2]!]
    if (a === b || b === c || a === c) continue
    if (at % 2 === 0) out.push(a, b, c)
    else out.push(a, c, b)
  }
  return out
}

const buildSkin = ({ geometry, groups }: Level, bones: number): SkinMesh => {
  const { indices: elements, points, normals, uv0, boneCount, boneIds, boneWeights } = geometry
  const count = elements.length
  if (count > 0x10000) throw new RangeError(`${count} elements, past a 16-bit index`)

  // The slices are cumulative from `Point_bone_count`: `Point_bone_first` is never read (`0x65f8239`).
  const starts = new Uint32Array(boneCount.length)
  for (let point = 1; point < starts.length; point++)
    starts[point] = starts[point - 1]! + boneCount[point - 1]!

  const vertices = new Float32Array(count * STRIDE_FLOATS)
  const influences = new Float32Array(count * INFLUENCE_FLOATS)
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }

  for (let element = 0; element < count; element++) {
    const point = elements[element]!
    const coordinate = uv0.indices[element]!
    const at = element * STRIDE_FLOATS
    const [x, y, z] = [
      points[point * 3] ?? 0,
      points[point * 3 + 1] ?? 0,
      points[point * 3 + 2] ?? 0,
    ]
    vertices.set(
      [
        x,
        y,
        z,
        normals[point * 3] ?? 0,
        normals[point * 3 + 1] ?? 0,
        normals[point * 3 + 2] ?? 0,
        uv0.coordinates[coordinate * 2] ?? 0,
        uv0.coordinates[coordinate * 2 + 1] ?? 0,
      ],
      at,
    )
    min.x = Math.min(min.x, x)
    min.y = Math.min(min.y, y)
    min.z = Math.min(min.z, z)
    max.x = Math.max(max.x, x)
    max.y = Math.max(max.y, y)
    max.z = Math.max(max.z, z)

    // `Skin`: one influence ignores its weight, and five or more keep the first at its own.
    const declared = boneCount[point] ?? 0
    const used = declared > MOST_BLENDED ? 1 : declared
    const first = starts[point] ?? 0
    const out = element * INFLUENCE_FLOATS
    for (let slot = 0; slot < used; slot++) {
      const id = boneIds[first + slot] ?? 0
      if (id >= bones) throw new RangeError(`Bone id ${id} past a table of ${bones}`)
      influences[out + slot] = id
      influences[out + MOST_BLENDED + slot] = declared === 1 ? 1 : (boneWeights[first + slot] ?? 0)
    }
    // Under a weighted sum a point with none would collapse on the origin. Retail has none.
    if (!used) influences[out + MOST_BLENDED] = 1
  }

  // `DrawFaceGroup` skips an empty group.
  const drawn = groups.filter(({ indices }) => indices.length > 0)
  const lists = drawn.map(({ indices, primitive }) =>
    primitive === 'list' ? [...indices] : expanded(indices),
  )
  const radius = Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2
  const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 }
  const indices = new Uint16Array(lists.flat())
  for (const index of indices)
    if (index >= count) throw new RangeError(`Face group index ${index} past ${count} elements`)

  return {
    mesh: {
      name: 'skin',
      version: 1,
      primitive: Primitive.TriangleList,
      format: FORMAT,
      groups: drawn.map(({ material }, at) => ({
        materialId: getResourceId(material),
        vertexStart: 0,
        vertexEnd: count - 1,
        elementCount: lists[at]!.length,
        padding: 0,
      })),
      indices,
      vertices: new Uint8Array(vertices.buffer),
    },
    reference: {
      meshId: 0,
      vertexStart: 0,
      vertexCount: count,
      indexStart: 0,
      indexCount: indices.length,
      groupStart: 0,
      groupCount: drawn.length,
      boundingBox: { min, max },
      boundingSphere: { center, radius },
    },
    influences,
  }
}

const skins = new WeakMap<Level, SkinMesh>()

/** The same object for the same level, so a renderer's buffers are shared between characters. */
export const skinMesh = (level: Level, bones: number): SkinMesh => {
  let skin = skins.get(level)
  if (!skin) {
    skin = buildSkin(level, bones)
    skins.set(level, skin)
  }
  return skin
}

/**
 * `K = W(root)⁻¹ · W(bone) · B`, `B` being `Bone to root` as stored (`Skin`). A slot with no world keeps
 * the identity, as one past the bound cursor does in retail.
 */
export const boneTable = (
  bones: readonly Bone[],
  worlds: readonly (Matrix4 | undefined)[],
  root: Matrix4,
): Float32Array => {
  if (bones.length > MAX_BONES) throw new RangeError(`${bones.length} bones, past ${MAX_BONES}`)
  const table = new Float32Array(bones.length * 16)
  const inverse = Matrix4.invert(root)
  bones.forEach(({ orientation, position }, index) => {
    const world = worlds[index]
    const matrix = world
      ? Matrix4.multiply(
          Matrix4.multiply(inverse, world),
          Matrix4.fromRotationTranslation(orientation, position),
        )
      : Matrix4.identity
    Matrix4.toArray(matrix, table, index * 16)
  })
  return table
}

export interface SkinOptions {
  /** Clamped to what the model has. The top one when absent. */
  level?: number
  jointState?: (bone: CompoundNode<Bone>) => JointState | undefined
  /**
   * The skin as modelled, ignoring the joints. `chain` is the default and what the game draws: its
   * joints' rest plus `jointState`. On a body that rest is another pose entirely, which it only ever
   * shows under a script, so a viewer with none playing wants `bind` (library `DEFORMABLE.md`).
   */
  pose?: 'chain' | 'bind'
}

/** A posed model as a part: drawn with its root's world, skinned relative to it. */
export const placeSkin = (
  model: DeformableModel,
  transform: Matrix4,
  { level = 0, jointState, pose = 'chain' }: SkinOptions = {},
): PlacedPart | undefined => {
  const root = getBoneModel(model)
  const chosen = model.levels[Math.min(level, model.levels.length - 1)]
  if (!root || !chosen) return undefined

  if (pose === 'bind') {
    const { mesh, reference, influences } = skinMesh(chosen, model.bones.length)
    const bones = boneTable(model.bones, [], transform)
    return { reference, mesh, world: transform, skin: { influences, bones } }
  }

  const transforms = partTransforms(root, transform, jointState)
  const worlds: (Matrix4 | undefined)[] = []
  for (const [node, world] of transforms) worlds[node.index] = world
  const world = transforms.get(root)!

  const { mesh, reference, influences } = skinMesh(chosen, model.bones.length)
  const skin: DrawSkin = { influences, bones: boneTable(model.bones, worlds, world) }
  return { reference, mesh, world, skin }
}
