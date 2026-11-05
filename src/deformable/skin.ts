/** A `.dfm` detail level as a mesh and its bone table: `FMeshArchetype::Skin`, in `Deformable2`. Pure, no GL. */
import { getResourceId } from '@treewyrm/freelancer'
import type { CompoundNode, Hardpoint, JointState } from '@treewyrm/freelancer/compound'
import {
  getBoneModel,
  type Bone,
  type DeformableModel,
  type Level,
  type UVBone,
} from '@treewyrm/freelancer/deformable'
import { Matrix4 } from '@treewyrm/freelancer/math'
import {
  Primitive,
  type VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import type { Camera } from '#/scene/camera.js'
import { partTransforms } from '#/scene/hierarchy.js'
import type { DrawSkin, PlacedPart } from '#/scene/frame.js'
import { costumeLevel, type SwitchTable } from './level.js'

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
  /** Pinned, clamped to what a part has. The top one when there's neither this nor `lod`. */
  level?: number
  /** Each part's level as the game chooses it, `tables` in part order. */
  lod?: { camera: Camera; tables: readonly SwitchTable[] }
  /** A level at or past this draws rigid, at bind. A costume's default is the builder's: see below. */
  skinnedLevels?: readonly number[]
  jointState?: (bone: CompoundNode<Bone>) => JointState | undefined
  /**
   * The skin as modelled, ignoring the joints. `chain` is the default and what the game draws: its
   * joints' rest plus `jointState`. On a body that rest is another pose entirely, which it only ever
   * shows under a script, so a viewer with none playing wants `bind` (library `DEFORMABLE.md`).
   */
  pose?: 'chain' | 'bind'
}

// `EyeUvClampPair`: below this on both axes, the stage's transform stays off.
const EYE_DEAD_ZONE = 1e-4

/**
 * What `FEyeMaterial::Bind` slides the eye's texture by: the bone's Z axis in its parent's frame. The
 * decomp writes it to the wrong cells of the matrix, and `character_eyes` has it in the third row.
 */
const eyeOffset = (
  { scaleU, scaleV, minU, maxU, minV, maxV, distance }: UVBone,
  world: Matrix4 | undefined,
  parent: Matrix4 | undefined,
): [number, number] | undefined => {
  if (!world) return undefined
  const { x, y, z } = world.z
  const axes = parent ?? Matrix4.identity
  const across = axes.x.x * x + axes.x.y * y + axes.x.z * z
  const along = axes.y.x * x + axes.y.y * y + axes.y.z * z
  const [u, v] = [scaleU * across * distance, scaleV * along * distance]
  if (Math.abs(u) <= EYE_DEAD_ZONE && Math.abs(v) <= EYE_DEAD_ZONE) return undefined
  return [Math.min(maxU, Math.max(minU, u)), Math.min(maxV, Math.max(minV, v))]
}

const CHILD_SKINNED_LEVELS = 2

const placement = ({
  orientation,
  position,
}: Pick<Hardpoint, 'orientation' | 'position'>): Matrix4 =>
  Matrix4.fromRotationTranslation(orientation, position)

/**
 * A character's parts, body first, each drawn with its root's world and skinned relative to it. Their
 * skeletons join by shared hardpoint name (`0x65f3540`, library `COSTUME.md`): walking every bone, the
 * first with a name holds it, and a later one with no parent links to it. That's a part's root, placing
 * the part, or a detached bone, placing one seam. A part with no root or level is skipped.
 */
export const placeCostume = (
  models: readonly DeformableModel[],
  transform: Matrix4,
  { level, lod, skinnedLevels, jointState, pose = 'chain' }: SkinOptions = {},
): PlacedPart[] => {
  const holders = new Map<string, { world: Matrix4; hardpoint: Matrix4 }>()
  const linked = (name: string, hardpoint: Hardpoint): Matrix4 | undefined => {
    const holder = holders.get(name.toLowerCase())
    return (
      holder &&
      Matrix4.multiply(
        Matrix4.multiply(holder.world, holder.hardpoint),
        Matrix4.invert(placement(hardpoint)),
      )
    )
  }

  const parts: PlacedPart[] = []
  models.forEach((model, at) => {
    const root = getBoneModel(model)
    const table = lod?.tables[at]
    const chosenAt =
      level === undefined && lod && table
        ? costumeLevel(
            model.levels,
            table,
            Math.hypot(
              lod.camera.position.x - transform.w.x,
              lod.camera.position.y - transform.w.y,
              lod.camera.position.z - transform.w.z,
            ),
            lod.camera.fovh,
          )
        : Math.min(level ?? 0, model.levels.length - 1)
    const chosen = chosenAt === undefined ? undefined : model.levels[chosenAt]
    if (!root) return

    // A root links by the first of its names already held. No other can join it to a second.
    const place = root.part.hardpoints.flatMap((hardpoint) => {
      const world = linked(hardpoint.name, hardpoint)
      return world ? [world] : []
    })[0]
    const transforms = partTransforms(root, place ?? transform, jointState)

    const worlds: (Matrix4 | undefined)[] = []
    for (const [node, world] of transforms) worlds[node.index] = world
    // The modelled pose is the host's to ask for: a head's and hand's chain already is theirs.
    if (pose === 'bind' && at === 0)
      for (const [node] of transforms)
        worlds[node.index] = Matrix4.multiply(transform, Matrix4.invert(placement(node.part)))

    // Everything stops at the last bone a part claims (`0x65f5a52`), so past it a slot keeps the identity.
    const cursor = model.bones.reduce(
      (last, { name }, index) => (name === undefined ? last : index + 1),
      0,
    )
    for (let index = 0; index < cursor; index++) {
      const bone = model.bones[index]!
      for (const hardpoint of bone.hardpoints) {
        const name = hardpoint.name.toLowerCase()
        const world = worlds[index]
        if (holders.has(name)) {
          // The engine refuses a link to a bone with a parent, so only a detached one takes it here.
          if (!world) worlds[index] = linked(name, hardpoint)
        } else if (world) holders.set(name, { world, hardpoint: placement(hardpoint) })
      }
      // A seam nothing seats is destroyed, and its record keeps the identity (`0x65f3d49`).
      worlds[index] ??= Matrix4.identity
    }

    // Past its far cutoff a part draws nothing, and its bones still hold for those after it.
    if (!chosen) return
    const rootWorld = worlds[root.index]!
    const { mesh, reference, influences } = skinMesh(chosen, model.bones.length)
    // `BuildCharacterDeformable` (`0x443b60`): the body has no limit, and the others skin levels 0 and 1.
    const skinned = skinnedLevels?.[at] ?? (at === 0 ? Infinity : CHILD_SKINNED_LEVELS)
    // `Flag70`: every bone the identity (`0x65f6cc6`).
    const bones =
      chosenAt! < skinned
        ? boneTable(model.bones, worlds, rootWorld)
        : boneTable(model.bones, [], rootWorld)
    const skin: DrawSkin = { influences, bones }
    // Only the first UV bone drives, and only eye groups read it (`0x65f75ca`).
    const uvBone = chosen.geometry.uvBone
    const parentOf = new Map<number, number>()
    const walk = (node: typeof root) => {
      for (const child of node.children) {
        parentOf.set(child.index, node.index)
        walk(child)
      }
    }
    walk(root)
    const offset =
      uvBone && eyeOffset(uvBone, worlds[uvBone.bone], worlds[parentOf.get(uvBone.bone) ?? -1])
    parts.push({
      reference,
      mesh,
      world: rootWorld,
      skin,
      ...(offset ? { eyeOffset: offset } : {}),
    })
  })
  return parts
}

/** One model, as a costume of one part. */
export const placeSkin = (
  model: DeformableModel,
  transform: Matrix4,
  options: SkinOptions = {},
): PlacedPart | undefined => placeCostume([model], transform, options)[0]
