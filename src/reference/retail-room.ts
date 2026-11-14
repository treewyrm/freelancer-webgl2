/**
 * The retail install's answers to {@link RoomStage}, for the base-room capture and the reference
 * tools: the room INI read, models resolved as the game's hosts resolve them, the scripts' effects
 * and the compounds' hardpoints read ahead. Test-only; the room itself is `thorn`'s.
 *
 * Its INI reads name retail's own files (`SHIPS/shiparch.ini`, the eight `FX/*_ale.ini`) rather than
 * following `freelancer.ini`'s `[Data]`, which is right for retail and wrong for a mod: a host
 * reading a mod resolves through `[Data]`.
 *
 * Left out, each reported: characters (the server chooses who stands where and what they fidget),
 * a base room's effects (its `PSYS`es draw only through `playScripts` with `loadRoomEffects`),
 * loadouts, `$terrain` asteroids, `Equipment` and `Spaceship` templates, and the room's
 * `[FlashlightSet]`s.
 */
import { Document, type Section } from '@treewyrm/freelancer/ini'
import { getMaterial, readMaterialLibrary } from '@treewyrm/freelancer/material'
import type { Matrix4 } from '@treewyrm/freelancer/math'
import {
  readMaterialAnimLibrary,
  readRigidModel,
  type RigidModel,
} from '@treewyrm/freelancer/rigid'
import { readTextureLibrary } from '@treewyrm/freelancer/texture'
import * as thn from '@treewyrm/freelancer/thn'
import * as thnScene from '@treewyrm/freelancer/thn/scene'
import { Directory } from '@treewyrm/freelancer/utf'
import { getResourceId } from '@treewyrm/freelancer'
import { getNodeName, readAlchemy, type Node } from '@treewyrm/freelancer/alchemy'
import { createPools, EffectInstance } from '#/alchemy/effect.js'
import { buildEffect, lookupOver } from '#/alchemy/tree.js'
import { getMesh, readVMeshLibrary } from '@treewyrm/freelancer/vmesh'
import type { Camera } from '#/scene/camera.js'
import { placeParts, type SceneEffect, type SceneModel } from '#/scene/frame.js'
import type { RoomScene } from '#/scene/room.js'
import type { CharacterHost, ThornHost } from '#/thorn/playback.js'
import { roomEntities, userProp, type RtcSetting, type SpawnOptions } from '#/thorn/room.js'
import {
  ambientSequence,
  readSetScript,
  type SequenceFlags,
  type SequenceManager,
  type SetScript,
} from '#/thorn/sequence.js'
import {
  compoundHardpoint,
  RoomStage,
  type SceneLine,
  type SceneMode,
  type StageTemplate,
} from '#/thorn/stage.js'
import type { Cast } from './retail-cast.js'

type ReadAsset = (path: string) => Promise<Uint8Array>

const path = (value: string) => value.replaceAll('\\', '/')

const values = (section: Section, key: string): string[][] =>
  section.properties
    .filter(({ name }) => name.toLowerCase() === key)
    .map(({ values }) => values.map(({ value }) => String(value)))

/** A model file and its libraries, by `category` and template (`Spaceship` from both ship tables), as `0x44e430` resolves them. */
export type ModelLookup = (
  category: string,
  template: string,
) => { file: string; libraries: string[] } | undefined

/**
 * `petaldb.ini`'s `[ObjectTable]` (`room`, `prop`, `cart`, the record's category matching) and
 * `solararch.ini`'s `DA_archetype` with its `material_library` lines, names ignoring case.
 */
const buildModelLookup = async (read: ReadAsset): Promise<ModelLookup> => {
  const petal = new Map<string, { file: string; libraries: string[] }>()

  for (const section of Document.read(await read('petaldb.ini')))
    for (const [key, category] of [
      ['room', 'Room'],
      ['prop', 'Prop'],
      ['cart', 'Equipment Cart'],
    ] as const)
      for (const [nickname = '', file = '', ...libraries] of values(section, key))
        petal.set(`${category}:${nickname.toLowerCase()}`, {
          file: path(file),
          libraries: libraries.map(path),
        })

  const solar = new Map<string, { file: string; libraries: string[] }>()
  const ships = new Map<string, { file: string; libraries: string[] }>()
  const asteroids = new Map<string, { file: string; libraries: string[] }>()
  const equipment = new Map<string, { file: string; libraries: string[] }>()
  const EQUIPMENT = [
    'prop_equip',
    'misc_equip',
    'st_equip',
    'select_equip',
    'engine_equip',
    'weapon_equip',
    'light_equip',
  ]

  for (const [file, into] of [
    ['SHIPS/shiparch.ini', ships],
    ['SHIPS/rtc_shiparch.ini', ships],
    ['SOLAR/asteroidarch.ini', asteroids],
    ...EQUIPMENT.map((name) => [`EQUIPMENT/${name}.ini`, equipment] as const),
  ] as const)
    for (const section of Document.read(await read(file))) {
      const nickname = section.getNickname()?.toLowerCase()
      const [model] = values(section, 'da_archetype')[0] ?? []

      if (nickname && model)
        into.set(nickname, {
          file: path(model),
          libraries: values(section, 'material_library').map(([each = '']) => path(each)),
        })
    }

  for (const section of Document.read(await read('SOLAR/solararch.ini'))) {
    const nickname = section.getNickname()?.toLowerCase()
    const [file] = values(section, 'da_archetype')[0] ?? []

    if (nickname && file)
      solar.set(nickname, {
        file: path(file),
        libraries: values(section, 'material_library').map(([each = '']) => path(each)),
      })
  }

  return (category, template) =>
    category === 'Solar'
      ? solar.get(template.toLowerCase())
      : category === 'Spaceship'
        ? ships.get(template.toLowerCase())
        : category === 'Asteroid'
          ? asteroids.get(template.toLowerCase())
          : category === 'Equipment'
            ? equipment.get(template.toLowerCase())
            : petal.get(`${category}:${template.toLowerCase()}`)
}

const lookups = new WeakMap<ReadAsset, Promise<ModelLookup>>()

/** {@link buildModelLookup}, once per reader: a scene built every frame reads it every frame. */
export const readModelLookup = (read: ReadAsset): Promise<ModelLookup> => {
  let found = lookups.get(read)
  if (!found) lookups.set(read, (found = buildModelLookup(read)))

  return found
}

// The `[VisEffect]` tables among `freelancer.ini`'s `[Data] effects` lines.
const ALE_TABLES = [
  'FX/ENGINES/engines_ale.ini',
  'FX/EQUIPMENT/equipment_ale.ini',
  'FX/EXPLOSIONS/explosions_ale.ini',
  'FX/HULL_HITS/hull_hits_ale.ini',
  'FX/MISC/misc_ale.ini',
  'FX/SHIELDS/shields_ale.ini',
  'FX/SPACE/space_ale.ini',
  'FX/WEAPONS/weapons_ale.ini',
]

/**
 * Each `COMPOUND`'s hardpoints by entity name, read ahead from its model and resolved as
 * `roomEntities` resolves it, at rest: this host plays no compound animation. Every part is searched,
 * names ignoring case, and the last found wins as `HardpointSummary::find_name` has it; that the
 * summary lists parts in the order `partTransforms` walks them is assumed, not traced.
 */
export const loadRoomHardpoints = async (
  read: ReadAsset,
  scripts: readonly thnScene.Script[],
): Promise<NonNullable<ThornHost['hardpoint']>> => {
  const lookup = await readModelLookup(read)
  const models = new Map<string, RigidModel>()

  for (const { entities } of scripts)
    for (const entity of entities) {
      if (entity.type !== 'COMPOUND' || models.has(entity.entity_name)) continue

      const template =
        entity.template_name === 'NULL' ? '' : (entity.template_name ?? entity.entity_name)
      const category = userProp(entity, 'category')
      const found = category ? lookup(category, template) : undefined

      if (found)
        models.set(entity.entity_name, readRigidModel(Directory.read(await read(found.file))))
    }

  return (entity, name) => {
    const model = models.get(entity)

    return model && compoundHardpoint(model, name)
  }
}

/** What a script's `PSYS`es make: a host's `createEffect`, and the textures each instance draws with. */
export interface RoomEffects {
  create: (entity: string, template: string) => EffectInstance | undefined
  texture: (instance: EffectInstance) => SceneEffect['texture'] | undefined
}

/**
 * Every `[VisEffect]` the scripts' `PSYS`es name, by nickname ignoring case, read ahead: playback
 * creates an instance synchronously. One pool for the room, as one effect manager serves it.
 */
export const loadRoomEffects = async (
  read: ReadAsset,
  scripts: readonly thnScene.Script[],
): Promise<RoomEffects> => {
  const visuals = new Map<string, Section>()

  for (const file of ALE_TABLES)
    for (const section of Document.read(await read(file))) {
      const [[nickname] = []] = values(section, 'nickname')

      if (section.name.toLowerCase() === 'viseffect' && nickname)
        visuals.set(nickname.toLowerCase(), section)
    }

  const pools = createPools()
  const sources = new Map<string, { make: () => EffectInstance; texture: SceneEffect['texture'] }>()
  const templates = new Set(
    scripts.flatMap(({ entities }) =>
      entities
        .filter(({ type }) => type === 'PSYS')
        .map(({ entity_name, template_name }) =>
          (template_name === 'NULL' ? '' : (template_name ?? entity_name)).toLowerCase(),
        ),
    ),
  )

  for (const template of templates) {
    const visual = visuals.get(template)
    const [[alchemyFile] = [], [crcText] = []] = visual
      ? [values(visual, 'alchemy'), values(visual, 'effect_crc')].map((lines) => lines[0] ?? [])
      : []
    if (!visual || !alchemyFile || !crcText) continue

    const alchemy = readAlchemy(Directory.read(await read(path(alchemyFile))))
    if (!alchemy) continue

    const nodes = new Map<number, Node>()

    for (const node of alchemy.nodes.nodes)
      nodes.set(getResourceId(getNodeName(node) ?? '', true), node)

    const resolve = (crc: number) => nodes.get(crc)
    const crc = Number(crcText) | 0
    const found = alchemy.effects.effects.find(
      ({ name }) => (getResourceId(name, true) | 0) === crc,
    )
    if (!found) continue

    const lookup = lookupOver(alchemy.effects.effects, resolve)
    const textures = (
      await Promise.all(
        values(visual, 'textures').map(async ([file = '']) => [
          ...readTextureLibrary(Directory.read(await read(path(file)))),
        ]),
      )
    ).flat()

    sources.set(template, {
      make: () => new EffectInstance(buildEffect(found, resolve), { lookup, pools }),
      texture: (name) => textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase()),
    })
  }

  const made = new WeakMap<EffectInstance, SceneEffect['texture']>()

  return {
    create: (_entity, template) => {
      const source = sources.get(template.toLowerCase())
      if (!source) return undefined

      const instance = source.make()

      made.set(instance, source.texture)
      return instance
    },
    texture: (instance) => made.get(instance),
  }
}

interface ParsedModel {
  model: RigidModel
  meshes: ReturnType<typeof readVMeshLibrary>
  materials: ReturnType<typeof readMaterialLibrary> extends Iterable<infer T> ? T[] : never
  textures: ReturnType<typeof readTextureLibrary> extends Iterable<infer T> ? T[] : never
  materialAnimations: ReturnType<typeof readMaterialAnimLibrary> extends Iterable<infer T>
    ? T[]
    : never
}

/**
 * Parsed once per reader: a frame drawn again holds the same meshes and textures, which the renderer
 * keys its GPU resources on, so it uploads nothing twice.
 */
const parsed = new WeakMap<ReadAsset, Map<string, Promise<ParsedModel>>>()

const parseModel = (read: ReadAsset, file: string, libraries: readonly string[]) => {
  let cache = parsed.get(read)
  if (!cache) parsed.set(read, (cache = new Map()))

  const key = [file, ...libraries].join('|').toLowerCase()
  let found = cache.get(key)

  if (!found) {
    found = (async () => {
      const root = Directory.read(await read(file))
      const libs = await Promise.all(
        libraries.map(async (each) => Directory.read(await read(each))),
      )
      const all = [root, ...libs]

      return {
        model: readRigidModel(root),
        meshes: readVMeshLibrary(root),
        materials: all.flatMap((library) => [...readMaterialLibrary(library)]),
        textures: all.flatMap((library) => [...readTextureLibrary(library)]),
        materialAnimations: all.flatMap((library) => [...readMaterialAnimLibrary(library)]),
      }
    })()
    cache.set(key, found)
  }

  return found
}

/** A parsed model placed at `world`. */
const placeModel = (
  { model, meshes, materials, textures, materialAnimations }: ParsedModel,
  world: Matrix4,
  camera: Camera,
  sky?: 'starsphere' | 'backdrop',
): SceneModel => ({
  parts: placeParts(model, world, { camera }),
  mesh: (id) => getMesh(meshes, id),
  material: (id) => getMaterial(materials, id),
  texture: (name) => textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase()),
  materialAnimations,
  ...(sky && { sky }),
})

/** `SCRIPTS/rtcslider.ini`'s `set` and `set_less` lines, in file order. */
export const readRtcSlider = async (read: ReadAsset): Promise<RtcSetting[]> =>
  [...Document.read(await read('SCRIPTS/rtcslider.ini'))].flatMap((section) =>
    section.properties.flatMap(({ name, values }) => {
      const key = name.toLowerCase()
      if (key !== 'set' && key !== 'set_less') return []

      return [
        {
          name: String(values[0]!.value),
          threshold: Number(values[1]!.value),
          ...(key === 'set_less' && { less: true }),
        },
      ]
    }),
  )

export interface RetailRoom {
  stage: RoomStage
  set: SetScript
  /** `animation` and `animation_oneshot`: the room's main prop's own scripts, which aren't played here. */
  animations: string[]
  manager: SequenceManager
  /** The `[Camera]` the room shows until a script with a monitor plays. */
  camera: string | undefined
  skipped: string[]
  /** The scripts' effects, when they were given: none is made without. */
  effects?: RoomEffects
}

const readScript = async (read: ReadAsset, file: string) =>
  thnScene.read(thn.read(await read(path(file))))

/** The stage played at 60 frames a second for `seconds`, as the menu plays its room. */
const playFor = (stage: RoomStage, seconds: number) => {
  for (let frame = 0; frame < seconds * 60; frame++) stage.advance(1 / 60)
}

/**
 * Scripts played as the menu plays its room's: each a looping, exporting ambient sequence at `C = I`,
 * started in order, at 60 frames a second for `seconds`. No set script.
 */
export const playScripts = (
  scripts: readonly thnScene.Script[],
  seconds: number,
  { effects, hardpoint }: { effects?: RoomEffects; hardpoint?: ThornHost['hardpoint'] } = {},
): RetailRoom => {
  const stage = new RoomStage({
    host: { ...(effects && { createEffect: effects.create }), ...(hardpoint && { hardpoint }) },
  })

  for (const script of scripts) stage.manager.add(ambientSequence(script, stage.options))
  playFor(stage, seconds)

  return {
    stage,
    set: stage.set,
    animations: [],
    manager: stage.manager,
    camera: undefined,
    skipped: [],
    ...(effects && { effects }),
  }
}

/** What a room plays over its own `scene` lines, and the hosts its playback calls. */
export interface RoomPlayOptions {
  /** Started after the room's own, in order: a mission's ambients, then its cutscene. */
  scripts?: readonly { script: thnScene.Script; flags: SequenceFlags }[]
  effects?: RoomEffects
  hardpoint?: ThornHost['hardpoint']
  /** A character's bones, which its aims and attachments read. */
  bone?: ThornHost['bone']
  characters?: CharacterHost
}

const MODES: Record<string, SceneMode> = { ambient: 'ambient', traffic: 'traffic', once: 'once' }

/**
 * A room's INI read (`0x6275490`, `0x62752b0`): its set script, its `[Camera]` and its `scene` lines,
 * started on a stage with `scripts` after them and played at 60 frames a second for `seconds`.
 */
export const playRetailRoom = async (
  read: ReadAsset,
  roomIni: string,
  seconds: number,
  { scripts = [], effects, hardpoint, bone, characters }: RoomPlayOptions = {},
): Promise<RetailRoom> => {
  const sections = [...Document.read(await read(roomIni))]
  const info = sections.find(({ name }) => name.toLowerCase() === 'room_info')
  const [[setScript] = []] = info ? values(info, 'set_script') : []
  const cameraSection = sections.find(({ name }) => name.toLowerCase() === 'camera')
  const [[camera] = []] = cameraSection ? values(cameraSection, 'name') : []
  const skipped: string[] = []
  const scenes: SceneLine[] = []

  for (const line of info ? values(info, 'scene') : []) {
    // A leading `all` is read and discarded; then two or three values.
    const [kind = '', scriptFile = '', setting] =
      line[0]?.toLowerCase() === 'all' ? line.slice(1) : line
    const mode = MODES[kind.toLowerCase()]

    if (!mode) {
      skipped.push(`scene ${scriptFile}: ${kind}`)
      continue
    }

    scenes.push({
      mode,
      script: await readScript(read, scriptFile),
      ...(setting !== undefined && { setting }),
    })
  }

  const animations = info
    ? [...values(info, 'animation'), ...values(info, 'animation_oneshot')].map(
        ([name = '']) => name,
      )
    : []
  const stage = new RoomStage({
    ...(setScript && { set: readSetScript(await readScript(read, setScript)) }),
    scenes,
    camera,
    animated: animations.length > 0,
    host: {
      ...(effects && { createEffect: effects.create }),
      ...(hardpoint && { hardpoint }),
      ...(bone && { bone }),
      ...(characters && { characters }),
    },
  })

  for (const { script, flags } of scripts) stage.play([{ script }], flags)
  playFor(stage, seconds)

  if (animations.length) skipped.push(`the main prop's ${animations.join(', ')}`)
  return {
    stage,
    set: stage.set,
    animations,
    manager: stage.manager,
    camera,
    skipped: [...skipped, ...stage.skipped],
    ...(effects && { effects }),
  }
}

/** Every model the frame can ask for now, parsed: the set script's props and what the scripts spawn. */
const loadTemplates = async (
  read: ReadAsset,
  room: RetailRoom,
  spawn: SpawnOptions | undefined,
): Promise<Map<string, ParsedModel>> => {
  const lookup = await readModelLookup(read)
  const wanted: StageTemplate[] = [
    ...room.set.props,
    ...room.manager.sequences.flatMap((sequence) =>
      sequence.playback
        ? roomEntities(sequence.playback, spawn).flatMap(({ category, template }) =>
            category ? [{ category, template }] : [],
          )
        : [],
    ),
  ]
  const parsedModels = new Map<string, ParsedModel>()

  for (const { category, template } of wanted) {
    const key = `${category}\n${template.toLowerCase()}`
    const found = parsedModels.has(key) ? undefined : lookup(category, template)

    if (found) parsedModels.set(key, await parseModel(read, found.file, found.libraries))
  }

  return parsedModels
}

/**
 * The frame the room leaves: the set script's props, then each playing script's compounds, its
 * lights, the shared fog, and the view of the highest-priority monitor, else the room's `[Camera]`.
 */
export const retailRoomScene = async (
  read: ReadAsset,
  room: RetailRoom,
  aspect: number,
  {
    playing = true,
    still = false,
    cast,
    spawn,
  }: { playing?: boolean; still?: boolean; cast?: Cast; spawn?: SpawnOptions } = {},
): Promise<RoomScene> => {
  const models = await loadTemplates(read, room, spawn)
  const { scene, skipped } = room.stage.scene(
    {
      model: (category, template, world, camera, sky) => {
        const parsedModel = models.get(`${category}\n${template.toLowerCase()}`)

        return parsedModel && placeModel(parsedModel, world, camera, sky)
      },
      ...(cast && { character: cast.place }),
      ...(room.effects && { effectTexture: room.effects.texture }),
    },
    { aspect, playing, still, ...(spawn && { spawn }) },
  )

  room.skipped.push(...skipped)
  return scene
}

/** A save in the base's start room, docked: `[Player] base`, as a retail save names it. */
export const baseSaveText = (
  name: string,
  system: string,
  base: string,
  initialWorld: string,
): string =>
  [
    '[Player]',
    'name = Lab',
    `description = ${name}`,
    'rank = 0',
    'money = 500',
    'voice = trent_voice',
    'costume = trent',
    'com_costume = trent',
    `system = ${system}`,
    `base = ${base}`,
    'ship_archetype = li_elite',
    '',
    '[StoryInfo]',
    'Mission = No_Mission',
    'delta_worth = -1',
    '',
    '',
  ].join('\r\n') + initialWorld
