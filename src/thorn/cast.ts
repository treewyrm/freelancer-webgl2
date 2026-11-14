/**
 * A cutscene's characters as the game makes them when no cast or mirror answers an actor: each
 * `DEFORMABLE` but a `REFERENCE`, the first of a name, one mixer at its record pose. Which costume
 * it wears, its parts and the animation table are the host's answers; this module reads no file.
 */
import type { AnimationScript } from '@treewyrm/freelancer/animation'
import type { CompoundNode } from '@treewyrm/freelancer/compound'
import { getBoneModel, type DeformableModel } from '@treewyrm/freelancer/deformable'
import { getMaterial, type Material } from '@treewyrm/freelancer/material'
import { Matrix4 } from '@treewyrm/freelancer/math'
import type { TextureEntry } from '@treewyrm/freelancer/texture'
import type { Deformable, Script } from '@treewyrm/freelancer/thn/scene'
import type { SwitchTable } from '#/deformable/level.js'
import { Mixer, type MixerJoint } from '#/deformable/mixer.js'
import { costumeWorlds, placeCostume } from '#/deformable/skin.js'
import type { Camera } from '#/scene/camera.js'
import type { SceneModel } from '#/scene/frame.js'
import { mixerCharacters } from './character.js'
import { placement, quaternionOf, type Frame } from './frame.js'
import type { CharacterHost, ThornHost } from './playback.js'

/** One part of a costume as the host read it: `costumes.ini`'s slots in order, the body first. */
export interface CostumePart {
  model: DeformableModel
  /** Its file's material and texture libraries: a costume's parts' names don't collide. */
  materials: readonly Material[]
  textures: readonly TextureEntry[]
  /** Its `[DetailSwitchTable]`. With any part lacking one, no level of detail is chosen. */
  table?: SwitchTable
}

export interface CastSource {
  /** A character's parts, body first, from its `template_name`, or nothing where none answers. */
  costume(entity: Deformable): readonly CostumePart[] | undefined
  /** An animation by name, from the one global table, ignoring case (`0x435100`). */
  animation(name: string): AnimationScript | undefined
}

export interface Cast {
  /** The playback's host for every character made. */
  characters: CharacterHost
  /** A character's bone and hardpoint at its pose, relative to its root, for `ATTACH_ENTITY` and `START_IK`. */
  bone: NonNullable<ThornHost['bone']>
  hardpoint: NonNullable<ThornHost['hardpoint']>
  /** A character's parts where its mixer stands, one model each, or nothing for one not made. */
  place(entity: string, world: Frame, camera: Camera): SceneModel[] | undefined
  /** A character's mixer and parts, for a test to look into. */
  member(entity: string): { mixer: Mixer; models: readonly DeformableModel[] } | undefined
  skipped: string[]
}

/** Who a cast makes: every `DEFORMABLE` but a `REFERENCE`, by entity name, the first of a name winning. */
export const castEntities = (scripts: readonly Script[]): Deformable[] => {
  const found = new Map<string, Deformable>()

  for (const { entities } of scripts)
    for (const entity of entities)
      if (
        entity.type === 'DEFORMABLE' &&
        !found.has(entity.entity_name) &&
        !entity.flags?.includes('REFERENCE')
      )
        found.set(entity.entity_name, entity)

  return [...found.values()]
}

// Every jointed descendant as { name, parent, joint }, depth first.
const jointsOf = <T>(node: CompoundNode<T>): MixerJoint[] =>
  node.children.flatMap((child) => [
    ...(child.joint ? [{ name: child.name, parent: node.name, joint: child.joint }] : []),
    ...jointsOf(child),
  ])

interface Member {
  parts: readonly CostumePart[]
  models: DeformableModel[]
  materials: Material[]
  textures: TextureEntry[]
  mixer: Mixer
}

/** The cast of `scripts`, each character's mixer standing at its record. */
export const createCast = (scripts: readonly Script[], source: CastSource): Cast => {
  const skipped: string[] = []
  const members = new Map<string, Member>()

  for (const entity of castEntities(scripts)) {
    const parts = source.costume(entity)
    if (!parts?.length) continue

    const models = parts.map(({ model }) => model)
    const bones = getBoneModel(models[0]!)

    if (!bones) {
      skipped.push(`${entity.entity_name}: no skeleton`)
      continue
    }

    const joints = models.flatMap((model) => {
      const root = getBoneModel(model)
      return root ? jointsOf(root) : []
    })
    const record = placement(entity.spatialprops?.pos, entity.spatialprops?.orient)

    members.set(entity.entity_name, {
      parts,
      models,
      materials: parts.flatMap(({ materials }) => materials),
      textures: parts.flatMap(({ textures }) => textures),
      mixer: new Mixer({
        root: bones.name,
        // Each joint name once, the first part's winning.
        joints: joints.filter(
          (each, at) => joints.findIndex(({ name }) => name === each.name) === at,
        ),
        position: { x: record.w.x, y: record.w.y, z: record.w.z },
        orientation: quaternionOf(record),
      }),
    })
  }

  const characters = mixerCharacters({
    mixer: (entity) => members.get(entity)?.mixer,
    animation: source.animation,
  })

  // Every bone's world relative to the root, at the mixer's pose now.
  const posed = (entity: string) => {
    const member = members.get(entity)
    if (!member) return undefined

    const { models, mixer } = member
    const all = costumeWorlds(models, Matrix4.identity, {
      jointState: ({ name }) => mixer.jointState(name),
    })

    return models.map((model, at) => ({ model, worlds: all[at] }))
  }

  return {
    characters,
    bone: (entity, name) => {
      for (const { model, worlds } of posed(entity) ?? []) {
        const at = model.bones.findIndex((bone) => bone.name?.toLowerCase() === name.toLowerCase())
        if (at >= 0 && worlds?.[at]) return worlds[at]
      }

      return undefined
    },
    // The last of a name wins (`HardpointSummary::find_name`).
    hardpoint: (entity, name) => {
      let found: Matrix4 | undefined

      for (const { model, worlds } of posed(entity) ?? [])
        model.bones.forEach(({ hardpoints }, at) => {
          for (const point of hardpoints)
            if (point.name.toLowerCase() === name.toLowerCase() && worlds?.[at])
              found = Matrix4.multiply(
                worlds[at],
                Matrix4.fromRotationTranslation(point.orientation, point.position),
              )
        })

      return found
    },
    skipped,
    member: (entity) => members.get(entity),
    place: (entity, world, camera) => {
      const member = members.get(entity)
      if (!member) return undefined

      const { parts, models, mixer, materials, textures } = member
      const tables = parts.map(({ table }) => table)
      const known = tables.every((each) => each !== undefined)
      const placed = placeCostume(models, world, {
        jointState: ({ name }) => mixer.jointState(name),
        ...(known && { lod: { camera, tables: tables as SwitchTable[] } }),
      })

      return placed.map((part) => ({
        parts: [part],
        mesh: () => undefined,
        material: (id: number) => getMaterial(materials, id),
        texture: (name: string) =>
          textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase()),
      }))
    },
  }
}
