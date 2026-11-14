/**
 * A retail base room as the game builds it, for the base-room capture: the set script as data, its
 * `scene` lines played as looping, exporting sequences from `C = I` frame by frame, and the room
 * frame that leaves, models resolved as the game's hosts resolve them. Test-only.
 *
 * Left out, each reported: characters (the server chooses who stands where and what they fidget),
 * a base room's effects (its `PSYS`es draw only through `playScripts` with `loadRoomEffects`),
 * loadouts, `$terrain` asteroids, `Equipment` and `Spaceship` templates, and the room's
 * `[FlashlightSet]`s.
 */
import { Document, type Section } from '@treewyrm/freelancer/ini'
import { getMaterial, readMaterialLibrary } from '@treewyrm/freelancer/material'
import { Matrix4 } from '@treewyrm/freelancer/math'
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
import type { RoomObject, RoomScene } from '#/scene/room.js'
import { NO_FOG } from '#/thorn/light.js'
import type { CharacterHost, PlaybackOptions, ThornHost } from '#/thorn/playback.js'
import { roomEntities, spawns, userProp, type RtcSetting, type SpawnOptions } from '#/thorn/room.js'
import { partTransforms } from '#/scene/hierarchy.js'
import type { CompoundNode } from '@treewyrm/freelancer/compound'
import { frameMilliseconds } from '#/thorn/script.js'
import {
  ambientSequence,
  readSetScript,
  Sequence,
  SequenceManager,
  type SequenceFlags,
  type SetScript,
} from '#/thorn/sequence.js'
import type { Cast } from './retail-cast.js'
import { cameraOf, ViewTable } from '#/thorn/view.js'

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
    if (!model) return undefined

    const parts: [RigidModel, Matrix4][] =
      model.type === 'compound'
        ? [...partTransforms(model as CompoundNode<RigidModel>, Matrix4.identity)].map(
            ([node, world]) => [node.part, world],
          )
        : [[model, Matrix4.identity]]
    let frame: Matrix4 | undefined

    for (const [part, world] of parts) {
      if (part.type !== 'rigid') continue

      for (const point of part.hardpoints)
        if (point.name.toLowerCase() === name.toLowerCase())
          frame = Matrix4.multiply(
            world,
            Matrix4.fromRotationTranslation(
              point.orientation,
              point.position ?? { x: 0, y: 0, z: 0 },
            ),
          )
    }

    return frame
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

/** A rigid model from its file and libraries, placed. */
const loadModel = async (
  read: ReadAsset,
  { file, libraries }: { file: string; libraries: string[] },
  world: Matrix4,
  camera: Camera,
  sky?: 'starsphere' | 'backdrop',
): Promise<SceneModel> => {
  const { model, meshes, materials, textures, materialAnimations } = await parseModel(
    read,
    file,
    libraries,
  )

  return {
    parts: placeParts(model, world, { camera }),
    mesh: (id) => getMesh(meshes, id),
    material: (id) => getMaterial(materials, id),
    texture: (name) => textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase()),
    materialAnimations,
    ...(sky && { sky }),
  }
}

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

/**
 * A room's INI, its set script read and its `scene` lines started in file order and played at 60
 * frames a second for `seconds`. A `REFERENCE` binds to an earlier scene's entity, else the set
 * script's setpoint or camera.
 */
/**
 * Scripts played as the menu plays its room's: each a looping, exporting ambient sequence at `C = I`,
 * started in order, at 60 frames a second for `seconds`. No set script.
 */
export const playScripts = (
  scripts: readonly thnScene.Script[],
  seconds: number,
  { effects, hardpoint }: { effects?: RoomEffects; hardpoint?: ThornHost['hardpoint'] } = {},
): RetailRoom => {
  const manager = new SequenceManager()
  const fog = { state: NO_FOG }
  const options = (): PlaybackOptions => ({
    fog,
    resolve: (type, name) => manager.find(type, name),
    ...(effects && { createEffect: effects.create }),
    ...(hardpoint && { host: { hardpoint } }),
  })
  for (const script of scripts) manager.add(ambientSequence(script, options))

  let carry = 0

  // Fixed 1/60 s frames: `frameMilliseconds` floors each to whole ms and carries the remainder on.
  for (let frame = 0; frame < seconds * 60; frame++) {
    const next = frameMilliseconds(carry, 1 / 60)

    carry = next.carry
    manager.update(next.milliseconds)
  }

  return {
    set: { props: [], cameras: [], setpoints: [], lights: [] },
    animations: [],
    manager,
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

export const playRetailRoom = async (
  read: ReadAsset,
  roomIni: string,
  seconds: number,
  { scripts = [], effects, hardpoint, bone, characters }: RoomPlayOptions = {},
): Promise<RetailRoom> => {
  const sections = [...Document.read(await read(roomIni))]
  const info = sections.find(({ name }) => name.toLowerCase() === 'room_info')
  const [[setScript] = []] = info ? values(info, 'set_script') : []
  const set = setScript
    ? readSetScript(await readScript(read, setScript))
    : { props: [], cameras: [], setpoints: [], lights: [] }
  const cameraSection = sections.find(({ name }) => name.toLowerCase() === 'camera')
  const [[camera] = []] = cameraSection ? values(cameraSection, 'name') : []
  const manager = new SequenceManager()
  const fog = { state: NO_FOG }
  const skipped: string[] = []

  const options = (): PlaybackOptions => ({
    fog,
    ...(effects && { createEffect: effects.create }),
    host: { ...(hardpoint && { hardpoint }), ...(bone && { bone }) },
    ...(characters && { characters }),
    resolve: (type, name) => {
      const found = manager.find(type, name)
      if (found) return found

      const at = (type === 'CAMERA' ? set.cameras : set.setpoints).find(
        (each) => each.name === name,
      )

      return at && { frame: at.frame }
    },
  })

  for (const line of info ? values(info, 'scene') : []) {
    // A leading `all` is read and discarded.
    const [mode = '', scriptFile = ''] = line[0]?.toLowerCase() === 'all' ? line.slice(1) : line

    if (mode.toLowerCase() !== 'ambient') {
      skipped.push(`scene ${scriptFile}: ${mode}`)
      continue
    }

    manager.add(ambientSequence(await readScript(read, scriptFile), options))
  }

  for (const { script, flags } of scripts) manager.add(new Sequence([{ script }], flags, options))

  let carry = 0

  // Fixed 1/60 s frames: `frameMilliseconds` floors each to whole ms and carries the remainder on.
  for (let frame = 0; frame < seconds * 60; frame++) {
    const next = frameMilliseconds(carry, 1 / 60)

    carry = next.carry
    manager.update(next.milliseconds)
  }

  const animations = info
    ? [...values(info, 'animation'), ...values(info, 'animation_oneshot')].map(
        ([name = '']) => name,
      )
    : []
  if (animations.length) skipped.push(`the main prop's ${animations.join(', ')}`)
  return { set, animations, manager, camera, skipped, ...(effects && { effects }) }
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
  const { set, manager, camera, skipped } = room
  const lookup = await readModelLookup(read)
  const table = new ViewTable()
  const monitors = manager.sequences.flatMap((sequence) =>
    (sequence.playback?.script.entities ?? [])
      // A monitor the slider has off gets no host, so never takes the view.
      .filter((entity) => entity.type === 'MONITOR' && spawns(entity, spawn))
      .map((entity) => ({
        playback: sequence.playback!,
        name: entity.entity_name,
        slot: table.register(sequence.flags.priority ?? 0, true),
      })),
  )
  const shown = monitors.find(({ slot }) => slot === table.active)
  const roomCamera = set.cameras.find(({ name }) => name === camera) ?? set.cameras[0]
  const view: Camera = shown
    ? cameraOf(shown.playback.view(shown.name)!)
    : cameraOf({
        world: roomCamera?.frame ?? Matrix4.identity,
        fovh: roomCamera?.fovh ?? 60,
        near: roomCamera?.near ?? 1,
        far: roomCamera?.far ?? 10000,
        aspect,
      })
  const objects: RoomObject[] = []
  const effects: SceneEffect[] = []

  for (const prop of set.props) {
    // `still`: only what stands still, so not a main prop its room animates.
    if (still && prop.main && room.animations.length) continue

    const found = lookup(prop.category, prop.template)

    if (!found) {
      skipped.push(`prop ${prop.template}: ${prop.category}`)
      continue
    }

    objects.push({
      model: await loadModel(read, found, prop.frame, view, prop.sky),
      position: { x: prop.frame.w.x, y: prop.frame.w.y, z: prop.frame.w.z },
      layer: prop.layer,
      lightGroup: prop.lightGroup,
      visible: prop.visible,
      lit: prop.lit,
      fog: prop.fog,
    })
  }

  for (const sequence of playing ? manager.sequences : []) {
    const playback = sequence.playback
    if (!playback) continue

    for (const entity of roomEntities(playback, spawn)) {
      const character =
        entity.entity.type === 'DEFORMABLE'
          ? cast?.place(entity.entity.entity_name, entity.world, view)
          : undefined

      if (character) {
        for (const model of character) objects.push({ ...entity.object, model })
        continue
      }

      const found = entity.category ? lookup(entity.category, entity.template) : undefined

      if (!found) {
        skipped.push(
          `${entity.entity.entity_name}: ${entity.category ?? 'a character'} ${entity.template}`,
        )
        continue
      }

      objects.push({
        ...entity.object,
        model: await loadModel(read, found, entity.world, view, entity.sky),
      })
    }

    for (const { entity, instance } of playback.effects) {
      const texture = room.effects?.texture(instance)

      if (texture) effects.push({ instance, texture })
      else skipped.push(`effect ${entity}`)
    }

    if (!room.effects) {
      const psys = playback.script.entities.filter(({ type }) => type === 'PSYS').length
      if (psys) skipped.push(`${psys} PSYS entities: no effects given`)
    }
  }

  const first = manager.sequences[0]?.playback

  return {
    camera: view,
    aspect,
    ...(set.ambient && { ambient: set.ambient }),
    lights: [
      ...set.lights,
      ...manager.sequences.flatMap((sequence) => sequence.playback?.roomLights() ?? []),
    ],
    objects,
    ...(effects.length && { effects }),
    ...(first?.roomFog && { fog: first.roomFog }),
  }
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
