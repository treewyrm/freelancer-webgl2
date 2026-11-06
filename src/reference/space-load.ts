/**
 * A reference system as a `SpaceScene`, from retail's archetype tables: what a host does with its
 * INI sections. Test-only.
 */
import { getMaterial, readMaterialLibrary } from '@treewyrm/freelancer/material'
import { Document, type Section } from '@treewyrm/freelancer/ini'
import { Matrix3, Matrix4, Quat, type RingShape, type Vector3 } from '@treewyrm/freelancer/math'
import { readRigidModel, type RigidModel } from '@treewyrm/freelancer/rigid'
import { readTextureLibrary, type Texture } from '@treewyrm/freelancer/texture'
import { readSurfaceLibrary } from '@treewyrm/freelancer/surface'
import { Directory } from '@treewyrm/freelancer/utf'
import { BufferView } from '@treewyrm/freelancer/utility'
import { getMesh, readVMeshLibrary } from '@treewyrm/freelancer/vmesh'
import { getJointMatrix, type CompoundNode, type Hardpoint } from '@treewyrm/freelancer/compound'
import {
  getChannelTime,
  getScript,
  readAnimationLibrary,
  sampleChannel,
} from '@treewyrm/freelancer/animation'
import type { RigidPart } from '@treewyrm/freelancer/rigid'
import type { Camera } from '#/scene/camera.js'
import { placeParts, type PlaceOptions, type SceneModel } from '#/scene/frame.js'
import { attachJoint, partTransforms } from '#/scene/hierarchy.js'
import { LightBlink, RETAIL_FLARE_LIGHT, type FlareLight, type SpaceFlare } from '#/scene/flare.js'
import { lodRange, type LodList } from '#/scene/level.js'
import type { Graph, SpaceLight } from '#/scene/light.js'
import { Clouds, RING_CLOUD_VISIBILITY, type CloudSettings } from '#/scene/clouds.js'
import {
  cubeRotations,
  entryOrientation,
  mergeCube,
  type CubeAsteroid,
  type CubeExclusion,
  type SpaceAsteroidField,
} from '#/scene/asteroids.js'
import { AsteroidBand, type BandSettings } from '#/scene/band.js'
import { NebulaLightning } from '#/scene/lightning.js'
import { zoneOf, type NebulaExclusion, type SpaceNebula, type Zone } from '#/scene/nebula.js'
import {
  buildRing,
  ringImmersion,
  textureShape,
  type PlanetRing,
  type RingExterior,
  type TextureShape,
} from '#/scene/ring.js'
import { placeSphere } from '#/scene/sphere.js'
import { skyLayers, type SpaceEffect, type SpaceObject, type SpaceScene } from '#/scene/space.js'
import {
  effectLodRow,
  effectLodType,
  effectTypeIndex,
  type EffectLodSizes,
  type EffectType,
  type EffectViewOptions,
} from '#/scene/effect-view.js'
import { viewMatrix } from '#/scene/camera.js'
import { getResourceId } from '@treewyrm/freelancer'
import { getNodeName, readAlchemy, type Node } from '@treewyrm/freelancer/alchemy'
import { createPools, EffectInstance, type EffectPools } from '#/alchemy/effect.js'
import { buildEffect, lookupOver } from '#/alchemy/tree.js'
import type { ReadAsset } from './load.js'
import { loadSky } from './load.js'
import type { ReferenceSystem } from './systems.js'

const pathOf = (value: string) => value.replaceAll('\\', '/')

const numbers = (section: Section, name: string): number[] =>
  (section.getValues(name) ?? []).map(({ value }) => Number(value))

const strings = (section: Section, name: string): string[] =>
  section.filterProperties(name).map(({ values }) => String(values[0]!.value))

const vector = ([x, y, z]: readonly number[]): Vector3 => ({ x: x!, y: y!, z: z! })

/** Each nicknamed section's `[LOD]` blocks, the sections that follow it, by nickname, folded. */
const lodBlocksOf = async (read: ReadAsset, files: string[]): Promise<Map<string, LodList[]>> => {
  const found = new Map<string, LodList[]>()
  for (const file of files) {
    let owner: LodList[] | undefined
    for (const section of Document.read(await read(file))) {
      if (section.name.toLowerCase() === 'lod') {
        const obj = strings(section, 'obj')[0]
        owner?.push({ ...(obj ? { obj } : {}), ranges: numbers(section, 'LODranges') })
        continue
      }
      const nickname = section.getNickname()?.toLowerCase()
      owner = nickname && !found.has(nickname) ? [] : undefined
      if (owner) found.set(nickname!, owner)
    }
  }
  return found
}

/** Every section of these files, by nickname, folded. */
const sectionsOf = async (read: ReadAsset, files: string[]): Promise<Map<string, Section>> => {
  const found = new Map<string, Section>()
  for (const file of files)
    for (const section of Document.read(await read(file))) {
      const nickname = section.getNickname()
      if (nickname && !found.has(nickname.toLowerCase())) found.set(nickname.toLowerCase(), section)
    }
  return found
}

interface Archetype {
  section: Section
  model: RigidModel
  lists: LodList[]
  /** Builds the model where the host puts it, its parts placed against `camera`. */
  place: (world: Matrix4, jointState?: PlaceOptions['jointState']) => SceneModel
}

const loadArchetype = async (
  section: Section,
  read: ReadAsset,
  camera: Camera,
  detail: number,
  blocks: readonly LodList[] = [],
): Promise<Archetype> => {
  const root = Directory.read(await read(pathOf(strings(section, 'DA_archetype')[0]!)))
  const libraries = await Promise.all(
    strings(section, 'material_library').map(async (path) =>
      Directory.read(await read(pathOf(path))),
    ),
  )
  const meshes = readVMeshLibrary(root)
  const materials = [root, ...libraries].flatMap((library) => [...readMaterialLibrary(library)])
  const textures = [root, ...libraries].flatMap((library) => [...readTextureLibrary(library)])
  const model = readRigidModel(root)
  const ranges = numbers(section, 'LODranges')
  const minSpecLod = section.getValue('MinSpecLOD')
  // `[LOD]` blocks first, then its own.
  const lists: LodList[] = [
    ...blocks,
    ...(ranges.length
      ? [{ ranges, ...(minSpecLod ? { minSpecLod: Number(minSpecLod.value) } : {}) }]
      : []),
  ]
  const environment = strings(section, 'envmap_material')[0]
  const material = (id: number) => getMaterial(materials, id)
  const place = (world: Matrix4, jointState?: PlaceOptions['jointState']): SceneModel => ({
    parts:
      model.type === 'sphere'
        ? placeSphere(model, world, { camera, width: 1024, material })
        : placeParts(model, world, {
            camera,
            lod: lists,
            detail,
            ...(jointState ? { jointState } : {}),
          }),
    mesh: (id) => getMesh(meshes, id),
    material,
    texture: (name) => textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase()),
    ...(environment ? { environment } : {}),
  })
  return { section, model, lists, place }
}

/** The parts `lodRange` walks: each with geometry, by name, a `.3db`'s as `Root`. */
const sources = (model: RigidModel) => {
  if (model.type === 'sphere') return []
  if (model.type !== 'compound')
    return model.type === 'rigid' && model.part ? [{ source: model.part, name: 'Root' }] : []
  const found: {
    source: NonNullable<Extract<RigidPart, { type: 'rigid' }>['part']>
    name: string
  }[] = []
  for (const node of partTransforms(model, Matrix4.identity).keys())
    if (node.part.type === 'rigid' && node.part.part)
      found.push({ source: node.part.part, name: node.name })
  return found
}

/** A hardpoint, wherever in the hierarchy it is, and the frame of the part holding it. */
const findHardpoint = (
  model: RigidModel,
  name: string,
  jointState?: PlaceOptions['jointState'],
): { point: Hardpoint; part: Matrix4 } | undefined => {
  const nodes: [RigidPart, Matrix4][] =
    model.type === 'compound'
      ? [...partTransforms(model as CompoundNode<RigidPart>, Matrix4.identity, jointState)].map(
          ([node, world]) => [node.part, world],
        )
      : [[model, Matrix4.identity]]
  for (const [part, world] of nodes) {
    if (part.type !== 'rigid') continue
    const point = part.hardpoints.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
    if (point) return { point, part: world }
  }
  return undefined
}

/** A hardpoint's frame in the model, wherever in the hierarchy it is. */
const hardpoint = (model: RigidModel, name: string): Matrix4 | undefined => {
  const found = findHardpoint(model, name)
  if (!found) return undefined
  const { point, part } = found
  return Matrix4.multiply(
    part,
    Matrix4.fromRotationTranslation(point.orientation, point.position ?? { x: 0, y: 0, z: 0 }),
  )
}

const SPHERE_TYPES = new Set(['PLANET', 'MOON'])

/**
 * What the game tests an object with, `get_physical_radius_r`: its body's `get_upper_limit_radius`
 * about its centre of mass (`PhySys::GetRadiusR`). Read as the `.sur` root part's radius and mass
 * centre, which is an inference: IVP's limit isn't traced to the file. Unturned, as every object here.
 */
/** A rigid model's root part at its top level. */
const rootLevel = (model: RigidModel) => {
  const root = model.type === 'compound' ? model.part : model
  const source = root.type === 'rigid' ? root.part : undefined
  return source?.type === 'multilevel' ? source.levels[0] : source
}

const bodySphere = async (
  section: Section,
  at: Vector3,
  read: ReadAsset,
): Promise<{ center: Vector3; radius: number }> => {
  const path = pathOf(strings(section, 'DA_archetype')[0]!).replace(/\.[^.]+$/, '.sur')
  const [root] = readSurfaceLibrary(BufferView.from(await read(path)))
  const { massCenter: c, radius } = root!
  return { center: { x: at.x + c.x, y: at.y + c.y, z: at.z + c.z }, radius }
}

export interface SystemOptions {
  camera: Camera
  /** Where the game had moved the player's ship to, which the save only starts it at. */
  ship: Vector3
  /** `level_of_detail` from the run's `PerfOptions.ini`. */
  detail: number
  /** `star_sphere` from it. */
  starSphere: number
  /** How long the effects have run. None when absent. */
  effectSeconds?: number
  /** The game's frame rate, which effects step at. 60 when absent. */
  effectRate?: number
  /** `high_detail_textures` from it. */
  highDetailTextures?: number
  /** `generic_effect_perf` from it. */
  effectDetail?: number
  /** How long a solar's `use_animation` scripts have played. At rest when absent. */
  animationSeconds?: number
}

/** `FX/effect_types.ini` over the built-in table, and `FX/effects.ini`'s `[EffectLOD]` rows. */
const effectViewOf = async (
  read: ReadAsset,
  effectDetail: number | undefined,
): Promise<EffectViewOptions> => {
  const effectTypes: Partial<EffectType>[] = []
  for (const section of Document.read(await read('FX/effect_types.ini'))) {
    const index = effectTypeIndex(section.getNickname() ?? '')
    if (index === undefined) continue
    const value = (name: string, at = 0) => section.getValue(name, at)?.value
    const number = (name: string, at = 0) =>
      value(name, at) === undefined ? undefined : Number(value(name, at))
    const lodType = effectLodType(String(value('lod_type') ?? ''))
    const near = number('pbubble')
    const row: Partial<EffectType> = {
      ...(number('priority') !== undefined ? { priority: number('priority')! } : {}),
      ...(number('generic_priority') !== undefined
        ? { genericPriority: number('generic_priority')! }
        : {}),
      ...(lodType !== undefined ? { lodType } : {}),
      ...(number('radius') !== undefined ? { radius: number('radius')! } : {}),
      ...(value('visibility') !== undefined
        ? { existOffscreen: String(value('visibility')).toUpperCase() === 'EXIST_OFFSCREEN' }
        : {}),
      ...(near !== undefined ? { pbubble: { near, far: number('pbubble', 1)! } } : {}),
    }
    effectTypes[index] = row
  }
  const effectLods: EffectLodSizes[] = []
  for (const section of Document.read(await read('FX/effects.ini'))) {
    if (section.name.toLowerCase() !== 'effectlod') continue
    const row = effectLodRow(String(section.getValue('type')?.value ?? ''))
    if (row === undefined) continue
    const size = (name: string) => Number(section.getValue(name)?.value ?? -1)
    effectLods[row] = {
      maxLodScreenSize: size('max_lod_screen_size'),
      minLodScreenSize: size('min_lod_screen_size'),
      minScreenSize: size('min_screen_size'),
    }
  }
  return {
    ...(effectDetail !== undefined ? { effectDetail } : {}),
    effectTypes,
    effectLods,
    viewportWidth: 1024,
  }
}

/** MSVC's `rand()` from its default seed of 1, so a run is the same each time. */
const msvcRand = (): (() => number) => {
  let state = 1
  return () => {
    state = (Math.imul(state, 214013) + 2531011) >>> 0
    return (state >>> 16) & 0x7fff
  }
}

/** A `tex_shape` of `FX/effect_shapes.ini`, from the `[Texture]` file that names it. */
const shapeOf = async (read: ReadAsset, name: string): Promise<Texture> => {
  for (const section of Document.read(await read('FX/effect_shapes.ini'))) {
    if (!strings(section, 'tex_shape').some((shape) => shape.toLowerCase() === name)) continue
    const library = readTextureLibrary(
      Directory.read(await read(pathOf(strings(section, 'file')[0]!))),
    )
    const found = [...library].find((entry) => entry.name.toLowerCase() === name)
    if (found?.type === 'image') return found
  }
  throw new Error(`no texture shape ${name}`)
}

// Where the `[VisEffect]`s of what reference systems carry are: `freelancer.ini` lists them all.
const ALE_TABLES = ['FX/ENGINES/engines_ale.ini', 'FX/MISC/misc_ale.ini']
const EQUIPMENT = [
  'EQUIPMENT/select_equip.ini',
  'EQUIPMENT/misc_equip.ini',
  'EQUIPMENT/engine_equip.ini',
  'EQUIPMENT/weapon_equip.ini',
  'EQUIPMENT/light_equip.ini',
]

interface Placed {
  effect: SpaceEffect
  world: Matrix4
  /** The ship or solar it's on. */
  on: Vector3
}

/** An `[Effect]` started where `world` holds it, through its `[VisEffect]`'s file and textures. */
const startEffect = async (
  nickname: string,
  world: Matrix4,
  on: Vector3,
  tables: { effects: Map<string, Section>; visuals: Map<string, Section> },
  pools: EffectPools,
  read: ReadAsset,
): Promise<Placed> => {
  const section = tables.effects.get(nickname.toLowerCase())!
  const visual = tables.visuals.get(strings(section, 'vis_effect')[0]!.toLowerCase())!
  const alchemy = readAlchemy(Directory.read(await read(pathOf(strings(visual, 'alchemy')[0]!))))!
  const nodes = new Map<number, Node>()
  for (const node of alchemy.nodes.nodes)
    nodes.set(getResourceId(getNodeName(node) ?? '', true), node)
  const resolve = (crc: number) => nodes.get(crc)
  const crc = Number(visual.getValue('effect_crc')!.value) | 0
  const found = alchemy.effects.effects.find(({ name }) => (getResourceId(name, true) | 0) === crc)!
  const instance = new EffectInstance(buildEffect(found, resolve), {
    lookup: lookupOver(alchemy.effects.effects, resolve),
    pools,
  })
  const textures = (
    await Promise.all(
      strings(visual, 'textures').map(async (path) => [
        ...readTextureLibrary(Directory.read(await read(pathOf(path)))),
      ]),
    )
  ).flat()
  const type = effectTypeIndex(strings(section, 'effect_type')[0]!)!
  const position = { x: world.w.x, y: world.w.y, z: world.w.z }
  return {
    effect: {
      instance,
      texture: (name) => textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase()),
      type,
      position,
      watched: { position: on },
    },
    world,
    on,
  }
}

/**
 * `[TexturePanels]` shapes (`FShapeDB::Load`), key by key: `file` adds a library, `name` or
 * `texture_name` picks a texture from those read so far, `shape_name` cuts all of it until a `dim`
 * says otherwise, and `tex_shape` names a texture that is its own shape. A `[Shape]` cuts one from
 * the current texture by `x`, `y`, `w` and `h`. The first shape of a name is kept.
 */
const loadShapes = async (
  read: ReadAsset,
  paths: readonly string[],
): Promise<Map<string, TextureShape>> => {
  const shapes = new Map<string, TextureShape>()
  const library: Texture[] = []
  const find = (name: string) =>
    library.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
  const add = (name: string, shape: TextureShape) => {
    if (!shapes.has(name.toLowerCase())) shapes.set(name.toLowerCase(), shape)
  }
  for (const path of paths) {
    let texture: Texture | undefined
    let current: string | undefined
    for (const part of Document.read(await read(pathOf(path)))) {
      const kind = part.name.toLowerCase()
      if (kind === 'texture')
        for (const { name, values } of part.properties) {
          const key = name.toLowerCase()
          const value = String(values[0]?.value ?? '')
          if (key === 'file')
            for (const entry of readTextureLibrary(Directory.read(await read(pathOf(value)))))
              if (entry.type === 'image') library.push(entry)
          if (key === 'name' || key === 'texture_name') {
            texture = find(value)
            current = undefined
          }
          if (key === 'shape_name' && texture) {
            current = shapes.has(value.toLowerCase()) ? undefined : value
            if (current) add(current, textureShape(texture, {}))
          }
          if (key === 'tex_shape') {
            texture = undefined
            current = undefined
            const found = find(value)
            if (found) add(value, textureShape(found, {}))
          }
          if (key === 'dim' && texture && current) {
            const [x, y, w, h] = values.map(({ value }) => Number(value))
            shapes.set(current.toLowerCase(), textureShape(texture, { x, y, w, h }))
          }
        }
      else if (kind === 'shape' && texture) {
        const value = (key: string) => Number(part.getValue(key)?.value ?? 0)
        const cut = strings(part, 'name')[0] ?? strings(part, 'shape_name')[0]
        if (cut)
          add(
            cut,
            textureShape(texture, { x: value('x'), y: value('y'), w: value('w'), h: value('h') }),
          )
      }
    }
  }
  return shapes
}

/** A ring file: its `[TexturePanels]` shapes, its `[Exterior]` and its `[Clouds]`. */
const loadRing = async (
  read: ReadAsset,
  file: string,
  zone: RingShape,
  highDetailTextures: number,
  random: () => number,
) => {
  const shapes = new Map<string, TextureShape>()
  const exterior: Record<string, number[] | string> = {}
  const clouds: Section[] = []
  for (const section of Document.read(await read(pathOf(file)))) {
    const name = section.name.toLowerCase()
    if (name === 'texturepanels')
      for (const [key, value] of await loadShapes(read, strings(section, 'file')))
        shapes.set(key, value)
    if (name === 'clouds') clouds.push(section)
    if (name === 'exterior')
      for (const { name: key, values } of section.properties)
        exterior[key.toLowerCase()] = key.toLowerCase().endsWith('shape')
          ? String(values[0]!.value)
          : values.map(({ value }) => Number(value))
  }
  const numbers = (key: string) => exterior[key] as number[] | undefined
  const shape = (key: string) => {
    const name = exterior[key] as string | undefined
    return name === undefined ? undefined : shapes.get(name.toLowerCase())
  }
  const color = numbers('color')
  const tile = numbers('detail_tile')
  const ring: RingExterior = {
    ...(shape('shape') ? { shape: shape('shape')! } : {}),
    ...(shape('detail_shape') ? { detail: shape('detail_shape')! } : {}),
    ...(tile ? { detailTile: [tile[0]!, tile[1]!] as const } : {}),
    ...(color
      ? {
          color: {
            x: Math.fround(color[0]! / 255),
            y: Math.fround(color[1]! / 255),
            z: Math.fround(color[2]! / 255),
          },
        }
      : {}),
    ...(numbers('opacity') ? { opacity: numbers('opacity')![0]! } : {}),
    ...(numbers('num_segments') ? { segments: numbers('num_segments')![0]! } : {}),
    ...(numbers('transition_dist') ? { transitionDistance: numbers('transition_dist')![0]! } : {}),
  }
  // `[Clouds]` keys, as `FUN_00550240` reads them: those a ring file uses.
  const cloudsOf = (section: Section): Clouds => {
    const value = (key: string, at = 0) => {
      const found = section.getValue(key, at)
      return found === undefined ? undefined : Number(found.value)
    }
    const colors = section.properties
      .filter(({ name }) => /^puff_color[ab]$/i.test(name))
      .slice(0, 2)
      .map(({ values }) => {
        const [x, y, z] = values.map(({ value }) => Math.fround(Number(value) / 255))
        return { x: x!, y: y!, z: z! }
      })
    const settings: CloudSettings = {
      puffCount: Math.trunc(value('puff_count') ?? 0),
      shapes: strings(section, 'puff_shape')
        .slice(0, 8)
        .map((name) => shapes.get(name.toLowerCase())),
      ...(value('puff_radius') !== undefined ? { puffRadius: value('puff_radius')! } : {}),
      ...(colors[0] ? { colorA: colors[0] } : {}),
      ...(colors[1] ? { colorB: colors[1] } : {}),
      ...(section.getValue('puff_weights')
        ? { weights: section.getValues('puff_weights')!.map(({ value }) => Number(value)) }
        : {}),
      ...(value('puff_max_alpha') !== undefined ? { maxAlpha: value('puff_max_alpha')! } : {}),
      ...(value('puff_drift') !== undefined ? { drift: value('puff_drift')! } : {}),
      ...(value('max_distance') !== undefined ? { maxDistance: value('max_distance')! } : {}),
      ...(value('near_fade_distance') !== undefined
        ? { nearFade: [value('near_fade_distance')!, value('near_fade_distance', 1)!] as const }
        : {}),
    }
    return new Clouds(settings, { visibility: RING_CLOUD_VISIBILITY, random })
  }
  return {
    ...buildRing(ring, zone, { highDetailTextures }),
    ...(clouds.length ? { clouds: clouds.map(cloudsOf) } : {}),
  }
}

/** A system's zone as the scene's code reads one, and its `edge_fraction`. */
const zoneFor = (
  system: ReferenceSystem,
  nickname: string,
): { zone: Zone; edgeFraction: number } => {
  const found = system.zones!.find(
    (entry) => entry.nickname.toLowerCase() === nickname.toLowerCase(),
  )!
  const [x, y, z] = found.position
  const center = { x, y, z }
  // `EulerMatrix` of a pitch alone: a turn about X.
  const orientation = Quat.axisAngle({
    axis: { x: 1, y: 0, z: 0 },
    angle: (found.pitch * Math.PI) / 180,
  })
  const [a = 0, b = a, c = a] = found.size
  const zone =
    found.shape === 'SPHERE'
      ? zoneOf({ type: 'sphere', center, radius: a })
      : zoneOf({ type: 'ellipsoid', center, orientation, radii: { x: a, y: b, z: c } })
  return { zone, edgeFraction: found.edgeFraction ?? 0 }
}

/** The values of a section's lines, in order, each as numbers or strings. */
const linesOf = (section: Section) =>
  section.properties.map(({ name, values }) => ({
    name: name.toLowerCase(),
    numbers: values.map(({ value }) => Number(value)),
    strings: values.map(({ value }) => String(value)),
  }))

/** A `[Nebula]` file: `[Fog]`, `[NebulaLight]`, `[Exclusion Zones]` and its lightning. */
/** A bare model file, as `ClientMeshHolderLoad` takes one: its own materials and textures. */
const loadModelFile = async (read: ReadAsset, path: string, camera: Camera) => {
  const root = Directory.read(await read(pathOf(path)))
  const meshes = readVMeshLibrary(root)
  const materials = [...readMaterialLibrary(root)]
  const textures = [...readTextureLibrary(root)]
  const model = readRigidModel(root)
  const material = (id: number) => getMaterial(materials, id)
  return (world: Matrix4): SceneModel => ({
    parts: placeParts(model, world, { camera }),
    mesh: (id) => getMesh(meshes, id),
    material,
    texture: (name) => textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase()),
  })
}

/** A system zone's `IZone::GetTransform`: its position, and a pitch alone as `EulerMatrix` turns it. */
const zoneTransform = (system: ReferenceSystem, nickname: string): Matrix4 => {
  const found = system.zones!.find(
    (entry) => entry.nickname.toLowerCase() === nickname.toLowerCase(),
  )!
  const [x, y, z] = found.position
  const turn = Quat.axisAngle({ axis: { x: 1, y: 0, z: 0 }, angle: (found.pitch * Math.PI) / 180 })
  return Matrix4.fromRotationTranslation(Matrix3.fromQuaternion(turn), { x, y, z })
}

const loadNebula = async (
  read: ReadAsset,
  system: ReferenceSystem,
  file: string,
  zoneName: string,
  camera: Camera,
): Promise<SpaceNebula> => {
  const { zone } = zoneFor(system, zoneName)
  // `zone_shell` and the keys after it, by name, shared by every zone naming it.
  const shells = new Map<
    string,
    { path: string; scalar?: number; maxAlpha?: number; tint?: Vector3 }
  >()
  const shellNames: (string | undefined)[] = []
  const zoneNames: string[] = []
  let shell: { scalar?: number; maxAlpha?: number; tint?: Vector3 } | undefined
  let fog: SpaceNebula['fog'] = { color: { x: 0, y: 0, z: 0 } }
  let ambient: Vector3 | undefined
  const exclusions: NebulaExclusion[] = []
  const background: { duration?: number } = {}
  const dynamic: { duration?: number } = {}
  for (const section of Document.read(await read(pathOf(file)))) {
    const kind = section.name.toLowerCase()
    for (const { name, numbers, strings } of linesOf(section)) {
      if (kind === 'fog') {
        if (name === 'near') fog = { ...fog, near: numbers[0]! }
        if (name === 'distance') fog = { ...fog, distance: numbers[0]! }
        if (name === 'color') {
          const [r, g, b] = numbers.map((c) => Math.fround(c / 255))
          fog = { ...fog, color: { x: r!, y: g!, z: b! } }
        }
      }
      if (kind === 'nebulalight' && name === 'ambient') {
        const [r, g, b] = numbers
        ambient = { x: r!, y: g!, z: b! }
      }
      if (kind === 'exclusion zones') {
        if (name === 'exclusion') {
          const found = zoneFor(system, strings[0]!)
          exclusions.push({ zone: found.zone, edgeFraction: found.edgeFraction })
          zoneNames.push(strings[0]!)
          shellNames.push(undefined)
        }
        if (name === 'fog_far' && exclusions.length)
          exclusions[exclusions.length - 1] = { ...exclusions.at(-1)!, fogFar: numbers[0]! }
        if (name === 'zone_shell') {
          shell = undefined
          if (!exclusions.length) continue
          const key = strings[0]!.toLowerCase()
          shellNames[shellNames.length - 1] = key
          shell = shells.get(key) ?? { path: strings[0]! }
          shells.set(key, shell as { path: string })
        }
        if (name === 'shell_scalar' && shell) shell.scalar = Math.max(numbers[0]!, 1)
        if (name === 'max_alpha' && shell) shell.maxAlpha = Math.min(numbers[0]!, 1)
        if (name === 'exclusion_tint' && shell) {
          const [r, g, b] = numbers.map((c) => Math.min(Math.fround(c / 255), 1))
          shell.tint = { x: r!, y: g!, z: b! }
        }
      }
      if (kind === 'backgroundlightning' && name === 'duration') background.duration = numbers[0]!
      if (kind === 'dynamiclightning' && name === 'duration') dynamic.duration = numbers[0]!
    }
  }
  const placed = new Map<string, (world: Matrix4) => SceneModel>()
  for (const [key, { path }] of shells) placed.set(key, await loadModelFile(read, path, camera))
  exclusions.forEach((exclusion, at) => {
    const key = shellNames[at]
    const found = key === undefined ? undefined : shells.get(key)
    if (!found || key === undefined) return
    const { scalar, maxAlpha, tint } = found
    exclusions[at] = {
      ...exclusion,
      shell: {
        place: placed.get(key)!,
        transform: zoneTransform(system, zoneNames[at]!),
        ...(scalar !== undefined ? { scalar } : {}),
        ...(maxAlpha !== undefined ? { maxAlpha } : {}),
        // Uninitialised in retail when absent: white here, the shell's user data's own start.
        tint: tint ?? { x: 1, y: 1, z: 1 },
      },
    }
  })
  return {
    zone,
    fog,
    ...(ambient ? { ambient } : {}),
    exclusions,
    lightning: new NebulaLightning({ background, dynamic }),
  }
}

/**
 * An `[Asteroids]` file's `[Field]`, `[Cube]` and `[Exclusion Zones]` (`CliAsteroid::Load`), its
 * cube merged from each asteroid's top level with its own materials.
 */
const loadField = async (
  read: ReadAsset,
  system: ReferenceSystem,
  file: string,
  zoneName: string,
): Promise<SpaceAsteroidField> => {
  const asteroidArchetypes = await sectionsOf(read, ['SOLAR/asteroidarch.ini'])
  const { zone, edgeFraction } = zoneFor(system, zoneName)
  const keys: Record<string, number[]> = {}
  const degrees: number[][] = [
    [0, 90, 180, 270],
    [0, 90, 180, 270],
    [0, 90, 180, 270],
  ]
  const lines: { name: string; numbers: number[] }[] = []
  const exclusions: CubeExclusion[] = []
  const shapes = new Map<string, TextureShape>()
  interface BandRecord {
    numbers: Record<string, number[]>
    shape?: string
    offset?: BandSettings['offset']
    /** An `[ExclusionBand]`'s `zone`, the last one named. */
    zone?: string
  }
  let band: BandRecord | undefined
  const exclusionBands: BandRecord[] = []
  for (const section of Document.read(await read(pathOf(file)))) {
    const kind = section.name.toLowerCase()
    if (kind === 'texturepanels')
      for (const [key, value] of await loadShapes(read, strings(section, 'file')))
        shapes.set(key, value)
    const record: BandRecord | undefined =
      kind === 'band' || kind === 'exclusionband' ? { numbers: {} } : undefined
    if (kind === 'band') band = record
    if (kind === 'exclusionband') exclusionBands.push(record!)
    for (const line of linesOf(section)) {
      if (record) {
        record.numbers[line.name] = line.numbers
        if (line.name === 'shape') record.shape = line.strings[0]!
        if (line.name === 'offset_dist') record.offset = { distance: line.numbers[0]! }
        if (line.name === 'offset_percent') record.offset = { percent: line.numbers[0]! }
        if (line.name === 'zone') record.zone = line.strings[0]!
      }
      if (kind === 'field') keys[line.name] = line.numbers
      if (kind === 'cube') {
        const axis = ['xaxis_rotation', 'yaxis_rotation', 'zaxis_rotation'].indexOf(line.name)
        if (axis >= 0) degrees[axis] = line.numbers
        if (line.name === 'asteroid') lines.push({ name: line.strings[0]!, numbers: line.numbers })
      }
      if (kind === 'exclusion zones') {
        if (line.name === 'exclusion') {
          const found = zoneFor(system, line.strings[0]!)
          exclusions.push({ zone: found.zone, edgeFraction: found.edgeFraction })
        }
        if (line.name === 'empty_cube_frequency' && exclusions.length)
          exclusions[exclusions.length - 1] = {
            ...exclusions.at(-1)!,
            emptyFrequency: line.numbers[0]!,
          }
      }
    }
  }
  const cubeSize = Math.trunc(keys['cube_size']?.[0] ?? 400)
  const half = cubeSize * 0.5
  const clamp = (value: number) => Math.min(Math.max(value, -1), 1)
  const libraries: Directory[] = []
  const asteroids: CubeAsteroid[] = []
  for (const { name, numbers } of lines) {
    const section = asteroidArchetypes.get(name.toLowerCase())!
    const root = Directory.read(await read(pathOf(strings(section, 'DA_archetype')[0]!)))
    libraries.push(root)
    for (const path of strings(section, 'material_library'))
      libraries.push(Directory.read(await read(pathOf(path))))
    const model = readRigidModel(root)
    const source = model.type === 'rigid' ? model.part : undefined
    if (!source) continue
    const level = source.type === 'multilevel' ? source.levels[0]! : source
    const mesh = getMesh(readVMeshLibrary(root), level.reference.meshId)!
    const [, x = 0, y = 0, z = 0, ax = 0, ay = 0, az = 0] = numbers
    asteroids.push({
      mesh,
      reference: level.reference,
      offset: {
        x: Math.fround(half * Math.fround(clamp(x))),
        y: Math.fround(half * Math.fround(clamp(y))),
        z: Math.fround(half * Math.fround(clamp(z))),
      },
      orientation: entryOrientation(ax, ay, az),
    })
  }
  const merged = mergeCube(asteroids)!
  const materials = libraries.flatMap((library) => [...readMaterialLibrary(library)])
  const textures = libraries.flatMap((library) => [...readTextureLibrary(library)])
  const color = (key: string) => {
    const value = keys[key]
    return (
      value && {
        x: Math.fround(value[0]! / 255),
        y: Math.fround(value[1]! / 255),
        z: Math.fround(value[2]! / 255),
      }
    )
  }
  const tint = color('tint_field')
  const increase = keys['ambient_increase']
  const diffuse = color('diffuse_color') ?? tint ?? { x: 0, y: 0, z: 0 }
  const ambient = color('ambient_color') ?? tint ?? { x: 0, y: 0, z: 0 }
  const ambientIncrease = increase && { x: increase[0]!, y: increase[1]!, z: increase[2]! }
  const bandOf = ({ numbers, shape, offset, zone: own = zoneName }: BandRecord) => {
    const zoneEntry = system.zones!.find(
      ({ nickname }) => nickname.toLowerCase() === own.toLowerCase(),
    )!
    const one = (key: string) => numbers[key]?.[0]
    const shift = numbers['color_shift']
    const fade = numbers['fade']
    const settings: BandSettings = {
      ...(shape && shapes.get(shape.toLowerCase())
        ? { shape: shapes.get(shape.toLowerCase())! }
        : {}),
      ...(one('texture_aspect') !== undefined ? { textureAspect: one('texture_aspect')! } : {}),
      ...(one('height') !== undefined ? { height: one('height')! } : {}),
      ...(offset ? { offset } : {}),
      ...(shift ? { colorShift: { x: shift[0]!, y: shift[1]!, z: shift[2]! } } : {}),
      ...(fade ? { fade: [fade[0]!, fade[1]!, fade[2]!, fade[3]!] as const } : {}),
      ...(one('vert_increase') !== undefined ? { vertIncrease: one('vert_increase')! } : {}),
      ...(one('render_parts') !== undefined ? { renderParts: one('render_parts')! } : {}),
      ...(one('cull_mode') !== undefined ? { cullMode: one('cull_mode')! } : {}),
      ...(one('ambient_intensity') !== undefined
        ? { ambientIntensity: one('ambient_intensity')! }
        : {}),
    }
    const [x, y, z] = zoneEntry.position
    const [a = 0, b = 0, c = 0] = zoneEntry.size
    return new AsteroidBand(settings, {
      position: { x, y, z },
      // `EulerMatrix` of a pitch alone: a turn about X.
      orientation: Quat.axisAngle({
        axis: { x: 1, y: 0, z: 0 },
        angle: (zoneEntry.pitch * Math.PI) / 180,
      }),
      size: { x: a, y: b, z: c },
      diffuse,
      ambient,
      ...(ambientIncrease ? { ambientIncrease } : {}),
    })
  }
  return {
    zone,
    edgeFraction,
    cubeSize,
    fillDistance: Math.trunc(keys['fill_dist']?.[0] ?? 1200),
    ...(keys['empty_cube_frequency'] ? { emptyFrequency: keys['empty_cube_frequency'][0]! } : {}),
    ...(keys['max_alpha'] ? { maxAlpha: keys['max_alpha'][0]! } : {}),
    rotations: cubeRotations(degrees),
    exclusions,
    cube: {
      ...merged,
      material: (id) => getMaterial(materials, id),
      texture: (name) => textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase()),
    },
    diffuse,
    ambient,
    ...(ambientIncrease ? { ambientIncrease } : {}),
    ...(band ? { band: bandOf(band) } : {}),
    // With no zone found (`FDUMP` at `0x520f7a`) retail builds no ring and still counts its pieces,
    // whose positions it then reads from a table it never made: left out here.
    ...(exclusionBands.length
      ? {
          exclusionBands: exclusionBands
            .filter(({ zone: named }) =>
              system.zones!.some(({ nickname }) => nickname.toLowerCase() === named?.toLowerCase()),
            )
            .map(bandOf),
        }
      : {}),
  }
}

export const loadSystem = async (
  system: ReferenceSystem,
  readData: ReadAsset,
  {
    camera,
    ship,
    detail,
    starSphere,
    effectSeconds,
    effectDetail,
    effectRate = 60,
    animationSeconds,
    highDetailTextures,
  }: SystemOptions,
): Promise<SpaceScene> => {
  // The system's own files, which the mount writes to the lab install, read from it first.
  const own = new Map(
    (system.files ?? []).map(({ path, text }) => [pathOf(path).toLowerCase(), text]),
  )
  const read: ReadAsset = async (path) => {
    const text = own.get(path.toLowerCase())
    return text === undefined ? readData(path) : Uint8Array.from(text, (c) => c.charCodeAt(0))
  }
  const archetypes = await sectionsOf(read, ['SOLAR/solararch.ini', 'SHIPS/shiparch.ini'])
  const graphs = await sectionsOf(read, ['igraph.ini'])
  const graph = (name: string): Graph => ({
    points: graphs
      .get(name.toLowerCase())!
      .filterProperties('point')
      .map(({ values }) => [Number(values[0]!.value), Number(values[1]!.value)] as const),
  })
  const archetype = (nickname: string) =>
    loadArchetype(archetypes.get(nickname.toLowerCase())!, read, camera, detail)

  const rand = msvcRand()
  const equipment = await sectionsOf(read, EQUIPMENT)
  const equipmentLods = await lodBlocksOf(read, EQUIPMENT)
  const loadouts = await sectionsOf(read, ['SOLAR/loadouts.ini'])
  /** A loadout's items, each with its hardpoint when it has one, in the order it lists them. */
  const loadoutOf = (section: Section) => {
    const loadout = strings(section, 'loadout')[0]
    if (!loadout) return []
    return loadouts
      .get(loadout.toLowerCase())!
      .filterProperties('equip')
      .map(({ values }) => {
        const [item, point] = values.map(({ value }) => String(value))
        return { item: equipment.get(item!.toLowerCase()), point }
      })
  }

  /**
   * Each item with a model and a hardpoint, hung there as `CNonPhysAttachment::Connect` does, its
   * joints at rest: a turret with nothing to aim at.
   */
  const attach = async (
    model: RigidModel,
    section: Section,
    world: Matrix4,
    jointState: PlaceOptions['jointState'],
  ) => {
    const attached: SceneModel[] = []
    for (const { item, point } of loadoutOf(section)) {
      if (!item || !point || !strings(item, 'DA_archetype').length) continue
      const parent = findHardpoint(model, point, jointState)!
      const nickname = item.getNickname()!.toLowerCase()
      const child = await loadArchetype(item, read, camera, detail, equipmentLods.get(nickname))
      const connect = findHardpoint(child.model, strings(item, 'HP_child')[0]!)!
      const joint = getJointMatrix(attachJoint(parent.point, connect.point))
      attached.push(child.place(Matrix4.multiply(world, Matrix4.multiply(parent.part, joint))))
    }
    return attached
  }

  /**
   * A `[Light]`'s keys as `FCliEQLight` reads them (`0x40ab30`): `inherit` copies its donor whole,
   * and a `color` line seeds `glow_color` while that is still black.
   */
  const flareLightOf = (section: Section): FlareLight => {
    let light: FlareLight = { ...RETAIL_FLARE_LIGHT }
    const triple = (values: readonly { value: unknown }[]) => {
      const [x, y, z] = values.map(({ value }) => Math.fround(Math.fround(Number(value)) / 255))
      return { x: x!, y: y!, z: z! }
    }
    for (const { name, values } of section.properties) {
      const value = Number(values[0]?.value)
      switch (name.toLowerCase()) {
        case 'inherit':
          light = { ...flareLightOf(equipment.get(String(values[0]!.value).toLowerCase())!) }
          break
        case 'color': {
          const color = triple(values)
          const { glowColor: g } = light
          light = { ...light, color, ...(!g.x && !g.y && !g.z ? { glowColor: color } : {}) }
          break
        }
        case 'glow_color':
          light = { ...light, glowColor: triple(values) }
          break
        case 'min_color':
          light = { ...light, minColor: triple(values) }
          break
        case 'bulb_size':
          light = { ...light, bulbSize: value }
          break
        case 'glow_size':
          light = { ...light, glowSize: value }
          break
        case 'avg_delay':
          light = { ...light, avgDelay: value }
          break
        case 'blink_duration':
          light = { ...light, blinkDuration: value }
          break
        case 'flare_cone':
          light = { ...light, flareCone: [value, Number(values[1]!.value)] }
          break
      }
    }
    return light
  }

  /** Its loadout's `[Light]`s, each on its hardpoint and blinking from `random`. */
  const flaresOf = (
    model: RigidModel,
    section: Section,
    world: Matrix4,
    jointState: PlaceOptions['jointState'],
  ): SpaceFlare[] =>
    loadoutOf(section).flatMap(({ item, point }) => {
      if (item?.name.toLowerCase() !== 'light' || !point) return []
      const light = flareLightOf(item)
      const { point: hardpoint, part } = findHardpoint(model, point, jointState)!
      const frame = Matrix4.fromRotationTranslation(
        hardpoint.orientation,
        hardpoint.position ?? { x: 0, y: 0, z: 0 },
      )
      return [
        {
          light,
          world: Matrix4.multiply(world, Matrix4.multiply(part, frame)),
          blink: new LightBlink(light, rand),
        },
      ]
    })

  /**
   * Its `[InternalFX]`s' `use_animation` scripts, each looping from when the solar was made
   * (`CEInternalFX`, `EvalPlayback` with flags 2), as the joint states they give its parts.
   */
  const animate = async (section: Section): Promise<PlaceOptions['jointState']> => {
    const names = loadoutOf(section).flatMap(({ item }) =>
      item?.name.toLowerCase() === 'internalfx' ? strings(item, 'use_animation') : [],
    )
    if (!names.length || animationSeconds === undefined) return undefined
    const library = readAnimationLibrary(
      Directory.read(await read(pathOf(strings(section, 'DA_archetype')[0]!))),
    )
    const maps = names.flatMap((name) => getScript(library, name)?.maps ?? [])
    return (part) => {
      const map = maps.find(
        (entry) => entry.type === 'joint' && entry.child.toLowerCase() === part.name.toLowerCase(),
      )
      if (!map) return undefined
      const time = getChannelTime(map.channel, animationSeconds, 'loop')
      return sampleChannel(map.channel, time, part.joint?.type === 'revolute')
    }
  }

  const objects: SpaceObject[] = []
  for (const { archetype: nickname, position } of system.objects) {
    const { section, model, lists, place } = await archetype(nickname)
    const at = vector(position)
    const type = String(section.getValue('type')!.value).toUpperCase()
    const planet = SPHERE_TYPES.has(type)
    // A planet's is its instance's extent (`FClientSolarGameobj::Slot178`), the sphere's own.
    const sphere =
      planet && model.type === 'sphere'
        ? { center: at, radius: model.radius }
        : await bodySphere(section, at, read)
    const { radius } = sphere
    // `CObject::Radius`, which the engine sets from its instance's extent: the root part's top level
    // (`space_solar_plant`'s 86.8, where its `.sur` is 264.6), or a planet's sphere.
    const extent =
      model.type === 'sphere'
        ? model.radius
        : (rootLevel(model)?.reference.boundingSphere.radius ?? radius)
    const range = lodRange(sources(model), lists, { detail })
    const jointState = await animate(section)
    const attached = await attach(model, section, Matrix4.translation(at), jointState)
    const flares = flaresOf(model, section, Matrix4.translation(at), jointState)
    objects.push({
      model: place(Matrix4.translation(at), jointState),
      ...(attached.length ? { attached } : {}),
      ...(flares.length ? { flares } : {}),
      position: at,
      sphere,
      solar: { large: extent > 200, extent, planet },
      // `systemIni` writes every `[Object]` before any `[Nebula]`: no solar finds one.
      ...(system.nebulae?.length ? { nebula: null } : {}),
      ...(range > 0 ? { lodRange: range } : {}),
    })
  }

  const tables = {
    effects: await sectionsOf(read, ['FX/effects.ini']),
    visuals: await sectionsOf(read, ALE_TABLES),
  }
  const pools = createPools()
  const placed: Placed[] = []

  // A solar's loadout: each `[AttachedFX]` on its hardpoint, as the loadout lists them.
  for (const { archetype: nickname, position } of system.objects) {
    const section = archetypes.get(nickname.toLowerCase())!
    const { model } = await archetype(nickname)
    for (const { item: fx, point } of loadoutOf(section)) {
      if (fx?.name.toLowerCase() !== 'attachedfx' || !point) continue
      const at = vector(position)
      const world = Matrix4.multiply(Matrix4.translation(at), hardpoint(model, point)!)
      placed.push(await startEffect(strings(fx, 'particles')[0]!, world, at, tables, pools, read))
    }
  }

  const hull = await archetype(system.player.ship)
  const world = Matrix4.translation(ship)
  const pilotName = strings(hull.section, 'pilot_mesh')[0]
  let pilot: SceneModel | undefined
  if (pilotName) {
    const simple = await archetype(pilotName)
    // `AttachPilotMesh`: `HpPilot`'s orientation, and its position less `HpConnect`'s, unturned.
    const seat = hardpoint(hull.model, 'HpPilot')!
    const connect = hardpoint(simple.model, 'HpConnect')?.w ?? { x: 0, y: 0, z: 0 }
    const offset = {
      ...seat,
      w: { x: seat.w.x - connect.x, y: seat.w.y - connect.y, z: seat.w.z - connect.z, w: 1 },
    }
    pilot = simple.place(Matrix4.multiply(world, offset))
  }
  // The engine's nozzles, each with its `flame_effect` and the player's `trail_effect_player`
  // (`CliEngineAttachExhaustEffects`, `0x528980`).
  const engine = system.player.equipment
    .map((nickname) => equipment.get(nickname.toLowerCase()))
    .find((section) => section?.name.toLowerCase() === 'engine')!
  const nozzles = ['HpEngine01', 'HpEngine02', 'HpEngine03', 'HpEngine04'].flatMap((name) => {
    const at = hardpoint(hull.model, name)
    return at ? [Matrix4.multiply(world, at)] : []
  })
  for (const nozzle of nozzles)
    for (const key of ['flame_effect', 'trail_effect_player']) {
      const nickname = strings(engine, key)[0]
      if (nickname) placed.push(await startEffect(nickname, nozzle, ship, tables, pools, read))
    }

  const range = lodRange(sources(hull.model), hull.lists, { detail })
  const distanceRender = hull.section.getValue('distance_render')
  objects.push({
    model: hull.place(world),
    position: ship,
    sphere: await bodySphere(hull.section, ship, read),
    ...(pilot ? { pilot } : {}),
    ...(range > 0 ? { lodRange: range } : {}),
    ...(distanceRender ? { distanceRender: Number(distanceRender.value) } : {}),
  })

  const lights: SpaceLight[] = system.lights.map((light) => ({
    type: light.type === 'DIRECTIONAL' ? 'directional' : 'point',
    position: vector(light.position),
    color: vector(light.color),
    range: light.range,
    ...(light.attenuation ? { attenuation: vector(light.attenuation) } : {}),
    ...(light.curve ? { attenuationCurve: graph(light.curve) } : {}),
  }))

  const sky = await Promise.all(
    skyLayers(starSphere).map((layer) =>
      loadSky(pathOf(system.background[layer]).split('/').at(-1)!, read, { space: true }),
    ),
  )
  // At rest: no throttle, so every `sparam` is 0 (`FCliEngineEquipFx::Update`).
  const view = viewMatrix(camera)
  for (let step = 0; step < (effectSeconds ?? 0) * effectRate; step++)
    for (const { effect, world: placement } of placed)
      effect.instance.advance(1 / effectRate, { placement, view, sparam: 0 })

  const rings: PlanetRing[] = await Promise.all(
    system.objects.flatMap(({ ring }) => {
      if (!ring) return []
      const zone = system.zones!.find(({ nickname }) => nickname === ring.zone)!
      const [x, y, z] = zone.position
      const shape: RingShape = {
        type: 'ring',
        center: { x, y, z },
        // `EulerMatrix` of a pitch alone: a turn about X.
        orientation: Quat.axisAngle({
          axis: { x: 1, y: 0, z: 0 },
          angle: (zone.pitch * Math.PI) / 180,
        }),
        radius: zone.size[0]!,
        innerRadius: zone.size[1]!,
        height: zone.size[2]!,
      }
      return [loadRing(read, ring.file, shape, highDetailTextures ?? 1, rand)]
    }),
  )
  // Each ring's clouds from entering the system, a cut, on the effects' clock: the game updates
  // them in its tick and draws them, which keeps their order, while the camera is in the ring.
  for (const ring of rings)
    for (const clouds of ring.clouds ?? [])
      for (let frame = 0; frame < (effectSeconds ?? 0) * effectRate; frame++) {
        const holds = (point: Vector3) => ringImmersion(ring, point)
        const visibility = Math.fround(ringImmersion(ring, camera.position))
        clouds.update(camera, 1 / effectRate, visibility, holds)
        if (visibility > 0) clouds.draw(camera, { cut: frame === 0, holds })
      }

  return {
    camera,
    aspect: 1024 / 768,
    ambient: vector(system.ambient),
    lights,
    objects,
    sky,
    // Newest first within a type, as the game keeps them.
    effects: placed.map(({ effect }) => effect).reverse(),
    effectView: await effectViewOf(read, effectDetail),
    viewport: { width: 1024, height: 768 },
    rings,
    shine: { texture: await shapeOf(read, 'shine') },
    asteroids: await Promise.all(
      (system.asteroids ?? []).map(({ file, zone }) => loadField(read, system, file, zone)),
    ),
    nebulae: await Promise.all(
      (system.nebulae ?? []).map(({ file, zone }) => loadNebula(read, system, file, zone, camera)),
    ),
  }
}
