/**
 * A cutscene's characters as the game makes them when no cast or mirror answers an actor: each
 * `DEFORMABLE`'s `template_name` a `costumes.ini` `[Costume]`, its parts from `bodyparts.ini`, one
 * mixer each at its record pose, and every `[Animations]` file in the one global table. Test-only.
 *
 * Left out, each reported: accessories, and a `player` or role actor resolved to the room's own
 * character (here it is made from its costume like any other).
 */
import { readAnimationLibrary, type AnimationScript } from '@treewyrm/freelancer/animation'
import type { CompoundNode } from '@treewyrm/freelancer/compound'
import {
  getBoneModel,
  readDeformableModel,
  type DeformableModel,
} from '@treewyrm/freelancer/deformable'
import { Document, type Section } from '@treewyrm/freelancer/ini'
import { getMaterial, readMaterialLibrary, type Material } from '@treewyrm/freelancer/material'
import { Matrix4 } from '@treewyrm/freelancer/math'
import { readTextureLibrary, type TextureEntry } from '@treewyrm/freelancer/texture'
import type * as thnScene from '@treewyrm/freelancer/thn/scene'
import { Directory } from '@treewyrm/freelancer/utf'
import type { SwitchTable } from '#/deformable/level.js'
import { Mixer, type MixerJoint } from '#/deformable/mixer.js'
import { costumeWorlds, placeCostume } from '#/deformable/skin.js'
import type { Camera } from '#/scene/camera.js'
import type { SceneModel } from '#/scene/frame.js'
import { mixerCharacters } from '#/thorn/character.js'
import { placement, quaternionOf } from '#/thorn/frame.js'
import type { CharacterHost, ThornHost } from '#/thorn/playback.js'

type ReadAsset = (path: string) => Promise<Uint8Array>

const path = (value: string) => value.replaceAll('\\', '/')

const text = (section: Section, key: string) => {
  const value = section.getValue(key)?.value
  return value === undefined ? undefined : String(value)
}

/** `costumes.ini`'s four slots, in `common.dll`'s order (`0x63ebd68`): the body first. */
const SLOTS = ['body', 'head', 'lefthand', 'righthand'] as const

interface PartEntry {
  mesh: string
  table: SwitchTable | undefined
}

/**
 * `bodyparts.ini`: each part with the last `[DetailSwitchTable]` before it (`load_bodyparts`,
 * `0x6300500`, positional), and the `[Animations]` files.
 */
const readBodyparts = (bytes: Uint8Array) => {
  const parts = new Map<string, PartEntry>()
  const animations: string[] = []
  let table: SwitchTable | undefined

  for (const section of Document.read(bytes)) {
    const kind = section.name.toLowerCase()

    if (kind === 'animations')
      for (const { name, values } of section.properties)
        if (name.toLowerCase() === 'anim') animations.push(path(String(values[0]!.value)))

    if (kind === 'detailswitchtable') {
      const rows = section.properties
        .filter(({ name }) => name.toLowerCase() === 'switch')
        .map(({ values }) => [Number(values[0]!.value), Number(values[1]!.value)] as const)
      const fovx = section.getValue('fovx')?.value

      table = { rows, ...(fovx !== undefined && { fovx: Number(fovx) }) }
    }

    if ((SLOTS as readonly string[]).includes(kind)) {
      const nickname = section.getNickname()?.toLowerCase()
      const mesh = text(section, 'mesh')

      if (nickname && mesh) parts.set(`${kind}:${nickname}`, { mesh: path(mesh), table })
    }
  }

  return { parts, animations }
}

// Every jointed descendant as { name, parent, joint }, depth first.
const jointsOf = <T>(node: CompoundNode<T>): MixerJoint[] =>
  node.children.flatMap((child) => [
    ...(child.joint ? [{ name: child.name, parent: node.name, joint: child.joint }] : []),
    ...jointsOf(child),
  ])

interface Member {
  costume: string
  /** Every part's libraries, body first: the parts' material and texture names don't collide. */
  materials: Material[]
  textures: TextureEntry[]
  models: DeformableModel[]
  roots: Directory[]
  tables: (SwitchTable | undefined)[]
  mixer: Mixer
}

export interface Cast {
  /** The playback's host for every character made. */
  characters: CharacterHost
  /** A character's bone and hardpoint at its pose, relative to its root, for `ATTACH_ENTITY` and `START_IK`. */
  bone: NonNullable<ThornHost['bone']>
  hardpoint: NonNullable<ThornHost['hardpoint']>
  /** A character's parts where its mixer stands, one model each, or nothing for one not made. */
  place(entity: string, world: Matrix4, camera: Camera): SceneModel[] | undefined
  /** A character's mixer and parts, for a test to look into. */
  member(entity: string): { mixer: Mixer; models: readonly DeformableModel[] } | undefined
  skipped: string[]
}

/** Every `DEFORMABLE` in `scripts` but a `REFERENCE`, by entity name, the first of a name winning. */
export const loadCast = async (
  read: ReadAsset,
  scripts: readonly thnScene.Script[],
): Promise<Cast> => {
  const { parts, animations } = readBodyparts(await read('CHARACTERS/bodyparts.ini'))
  const costumes = new Map<string, Section>()
  const skipped: string[] = []

  for (const section of Document.read(await read('CHARACTERS/costumes.ini')))
    if (section.name.toLowerCase() === 'costume') {
      const nickname = section.getNickname()?.toLowerCase()
      if (nickname) costumes.set(nickname, section)
    }

  // One global table, found by name ignoring case (`0x435100`); the first file's script wins.
  const table = new Map<string, AnimationScript>()

  for (const file of animations)
    for (const script of readAnimationLibrary(Directory.read(await read(file)))) {
      const key = script.name.toLowerCase()
      if (!table.has(key)) table.set(key, script)
    }

  const members = new Map<string, Member>()

  for (const script of scripts)
    for (const entity of script.entities) {
      if (entity.type !== 'DEFORMABLE' || members.has(entity.entity_name)) continue
      if ('flags' in entity && entity.flags?.includes('REFERENCE')) continue

      const name = (entity.template_name ?? '').toLowerCase()
      const costume = costumes.get(name)

      if (!costume) {
        skipped.push(`${entity.entity_name}: no costume ${entity.template_name}`)
        continue
      }

      const accessories = costume.properties.filter(
        ({ name }) => name.toLowerCase() === 'accessory',
      )
      if (accessories.length)
        skipped.push(`${entity.entity_name}: ${accessories.length} accessories`)

      const entries = SLOTS.flatMap((slot) => {
        const part = text(costume, slot)
        const entry = part && parts.get(`${slot}:${part.toLowerCase()}`)

        if (part && !entry) skipped.push(`${entity.entity_name}: no ${slot} ${part}`)
        return entry ? [entry] : []
      })
      const roots = await Promise.all(
        entries.map(async ({ mesh }) => Directory.read(await read(mesh))),
      )
      const models = roots.map(readDeformableModel)
      const bones = getBoneModel(models[0]!)

      if (!bones) {
        skipped.push(`${entity.entity_name}: no skeleton`)
        continue
      }

      const joints = models.flatMap((model) => {
        const root = getBoneModel(model)
        return root ? jointsOf(root) : []
      })
      const record =
        'spatialprops' in entity
          ? placement(entity.spatialprops?.pos, entity.spatialprops?.orient)
          : placement()

      members.set(entity.entity_name, {
        costume: name,
        materials: roots.flatMap((root) => [...readMaterialLibrary(root)]),
        textures: roots.flatMap((root) => [...readTextureLibrary(root)]),
        models,
        roots,
        tables: entries.map(({ table }) => table),
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
    animation: (name) => table.get(name.toLowerCase()),
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

      const { models, roots, tables, mixer } = member
      const known = tables.every((each) => each !== undefined)
      const placed = placeCostume(models, world, {
        jointState: ({ name }) => mixer.jointState(name),
        ...(known && { lod: { camera, tables: tables as SwitchTable[] } }),
      })

      const { materials, textures } = member
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
