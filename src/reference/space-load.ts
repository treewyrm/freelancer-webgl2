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
import { beamArchetype, type BeamArchetype, type BeamSection } from '#/scene/beam.js'
import type { TractorBeam } from '#/scene/tractor.js'
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
import {
  Clouds,
  NEBULA_CLOUD_VISIBILITY,
  RING_CLOUD_VISIBILITY,
  type CloudSettings,
  type CloudVisibility,
} from '#/scene/clouds.js'
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
import { AsteroidBillboards, type BillboardSettings } from '#/scene/billboards.js'
import { DynamicAsteroids, type DynamicEffect, type DynamicSettings } from '#/scene/dynamic.js'
import { SpaceDust, type DustZone } from '#/scene/dust.js'
import { NebulaExterior, type ExteriorSettings } from '#/scene/exterior.js'
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
import {
  RETAIL_TUNNEL,
  RETAIL_TUNNEL_LAYER,
  type TunnelLayer,
  type TunnelSettings,
} from '#/scene/tunnel.js'
import { skyLayers, type SpaceEffect, type SpaceObject, type SpaceScene } from '#/scene/space.js'
import { starRadius, type Star, type StarGlow } from '#/scene/star.js'
import type { Hitbox, HitboxSurface } from '#/scene/hitbox.js'
import type { FlareBead, LensGlow, StarLensFlare, StarSpine, StarSpines } from '#/scene/corona.js'
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

/**
 * An archetype's collision shapes, as the game builds its body: a `.sph` solar's ball of
 * `solar_radius`, or its `.sur`'s root part at `world` and each `!fxd` part at its model part's.
 */
const hitboxOf = async (
  section: Section,
  model: RigidModel,
  world: Matrix4,
  read: ReadAsset,
  jointState?: PlaceOptions['jointState'],
): Promise<Hitbox | undefined> => {
  const archetype = pathOf(strings(section, 'DA_archetype')[0]!)
  if (/\.sph$/i.test(archetype)) {
    const radius = numbers(section, 'solar_radius')[0] ?? 0
    return radius > 0 ? { ball: radius } : undefined
  }
  const parts = readSurfaceLibrary(
    BufferView.from(await read(archetype.replace(/\.[^.]+$/, '.sur'))),
  )
  const nodes =
    model.type === 'compound'
      ? [...partTransforms(model as CompoundNode<RigidPart>, world, jointState)]
      : []
  const frameOf = (id: number) => nodes.find(([node]) => getResourceId(node.name) === id)?.[1]
  // The root's part is the model's root's, or the file's first.
  const rootId = model.type === 'compound' ? getResourceId(model.name) : undefined
  const root = parts.find(({ id }) => id === rootId) ?? parts[0]!
  const surfaces: HitboxSurface[] = [{ surface: root, world }]
  for (const part of parts) {
    if (part === root || part.fixed) continue
    const frame = frameOf(part.id)
    if (frame) surfaces.push({ surface: part, world: frame })
  }
  return { surfaces }
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
  /** More ships than the player's, unturned, each engine's effects at its `sparam`. For the bench. */
  ships?: {
    ship: string
    engine: string
    position: readonly [number, number, number]
    sparam: number
  }[]
  /** `[Effect]`s by nickname, each started again when it finishes. For the bench. */
  extraEffects?: { nickname: string; position: readonly [number, number, number] }[]
}

export interface LoadedSystem extends SpaceScene {
  /**
   * Steps the placed effects a frame, seen from `camera` (the scene's when absent), as the host does
   * between frames. The dust, clouds and the fields' rocks step in `collectSpaceFrame`.
   */
  tick: (dt: number, camera?: Camera) => void
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
      ...(number('run_time') !== undefined ? { runTime: number('run_time')! } : {}),
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

/**
 * `FX/beam_effects.ini` as `FUN_0042e850` reads it, by nickname folded, with `code_beam` from
 * `effect_shapes.ini`. A section's kind is its header; the keys are `FUN_0042e4a0`'s.
 */
export const loadBeamEffects = async (
  read: ReadAsset,
): Promise<{ beams: Map<string, BeamArchetype>; texture: Texture }> => {
  const beams = new Map<string, BeamArchetype>()
  for (const section of Document.read(await read('FX/beam_effects.ini'))) {
    const header = section.name.toLowerCase()
    if (header !== 'beamspear' && header !== 'beambolt') continue
    const nickname = strings(section, 'nickname')[0]
    if (!nickname) continue
    const color = (key: string) => {
      const values = numbers(section, key)
      return values.length ? { color: vector(values) } : {}
    }
    const number = (key: string) => numbers(section, key)[0]
    const fields: Partial<BeamSection> = {}
    const set = <K extends keyof BeamSection>(key: K, value: BeamSection[K] | undefined) => {
      if (value !== undefined) fields[key] = value
    }
    set('tipColor', color('tip_color').color)
    set('tailColor', color('tail_color').color)
    set('coreColor', color('core_color').color)
    set('secCoreColor', color('sec_core_color').color)
    set('outerColor', color('outter_color').color)
    set('secOuterColor', color('sec_outter_color').color)
    set('tipLength', number('tip_length'))
    set('tailLength', number('tail_length'))
    set('coreLength', number('core_length'))
    set('coreWidth', number('core_width'))
    set('secCoreWidth', number('sec_core_width'))
    set('headWidth', number('head_width'))
    set('flashSize', number('flash_size'))
    set('headBrightness', number('head_brightness'))
    set('trailBrightness', number('trail_brightness'))
    set('headTexture', strings(section, 'head_texture')[0])
    set('trailTexture', strings(section, 'trail_texture')[0])
    beams.set(
      nickname.toLowerCase(),
      beamArchetype({ kind: header === 'beamspear' ? 'spear' : 'bolt', ...fields }),
    )
  }
  return { beams, texture: await shapeOf(read, 'code_beam') }
}

/**
 * Every `[Tractor]` in `EQUIPMENT/misc_equip.ini`, by nickname folded: its `max_length` and `color`
 * as written, for a `TractorBeam`, with `line` from `effect_shapes.ini`. A colour not written is
 * `FCliTractor`'s 255 each.
 */
export const loadTractors = async (
  read: ReadAsset,
): Promise<{
  tractors: Map<string, Pick<TractorBeam, 'maxLength' | 'color'>>
  texture: Texture
}> => {
  const tractors = new Map<string, Pick<TractorBeam, 'maxLength' | 'color'>>()
  for (const section of Document.read(await read('EQUIPMENT/misc_equip.ini'))) {
    if (section.name.toLowerCase() !== 'tractor') continue
    const nickname = strings(section, 'nickname')[0]
    if (!nickname) continue
    const color = numbers(section, 'color')
    tractors.set(nickname.toLowerCase(), {
      maxLength: numbers(section, 'max_length')[0] ?? 0,
      color: color.length ? vector(color) : { x: 255, y: 255, z: 255 },
    })
  }
  return { tractors, texture: await shapeOf(read, 'line') }
}

/**
 * `FX/gate_tunnel.ini` as `GateTunnelIniLoad` (`0x4fe1c0`) reads it, by nickname folded: each
 * `[layer]` joins the `[gate_tunnel]` before it, two at most. A colour is three whole bytes over 255.
 */
export const loadGateTunnels = async (read: ReadAsset): Promise<Map<string, TunnelSettings>> => {
  const tunnels = new Map<string, TunnelSettings>()
  const byte = (value: number) => Math.fround(Math.trunc(value) * Math.fround(1 / 255))
  const color = (section: Section, name: string, fallback: Vector3): Vector3 => {
    const values = numbers(section, name)
    return values.length ? vector(values.map(byte)) : fallback
  }
  let current: { nickname: string; settings: TunnelSettings; layers: TunnelLayer[] } | undefined
  for (const section of Document.read(await read('FX/gate_tunnel.ini'))) {
    const number = (name: string, fallback: number) => {
      const value = section.getValue(name)?.value
      return value === undefined ? fallback : Math.fround(Number(value))
    }
    const kind = section.name.toLowerCase()
    if (kind === 'gate_tunnel') {
      const base = RETAIL_TUNNEL
      const layers: TunnelLayer[] = []
      current = {
        nickname: (section.getNickname() ?? 'default').toLowerCase(),
        layers,
        settings: {
          writeDepth: number('write_depth_buffer', 1) !== 0,
          controlPoints: Math.trunc(number('num_spline_control_points', base.controlPoints)),
          range: {
            x: number('x_range', base.range.x),
            y: number('y_range', base.range.y),
            z: number('z_range', base.range.z),
          },
          minRadius: number('min_radius', base.minRadius),
          maxRadius: number('max_radius', base.maxRadius),
          farRadiusFactor: number('far_radius_factor', base.farRadiusFactor),
          minSpeed: number('min_speed', base.minSpeed),
          maxSpeed: number('max_speed', base.maxSpeed),
          timeToMaxSpeed: number('time_to_max_speed', base.timeToMaxSpeed),
          tSteps: number('num_t_steps', base.tSteps),
          sSteps: number('num_s_steps', base.sSteps),
          minRotation: number('min_rotation', base.minRotation),
          maxRotation: number('max_rotation', base.maxRotation),
          minRgb: color(section, 'min_rgb', base.minRgb),
          maxRgb: color(section, 'max_rgb', base.maxRgb),
          layers,
        },
      }
      tunnels.set(current.nickname, current.settings)
    } else if (kind === 'layer' && current && current.layers.length < 2) {
      const base = RETAIL_TUNNEL_LAYER
      const name = strings(section, 'texture')[0]
      const texture = name === undefined ? undefined : await shapeOf(read, name.toLowerCase())
      current.layers.push({
        ...(texture && { texture }),
        color: color(section, 'color', base.color),
        nearAlpha: number('near_alpha', base.nearAlpha),
        farAlpha: number('far_alpha', base.farAlpha),
        radiusFactor: number('radius_factor', base.radiusFactor),
        uOffset: number('u_offset', base.uOffset),
        vOffset: number('v_offset', base.vOffset),
        du: number('du', base.du),
        dv: number('dv', base.dv),
        vScale: number('v_scale', base.vScale),
      })
    }
  }
  return tunnels
}

/** A `[JumpGateEffect]`'s keys the tunnel's frame reads. */
export interface JumpDescriptor {
  /** `jump_tunnel`, folded: a `[gate_tunnel]`. */
  tunnel?: string
  /** `jump_ambient` and `jump_background_color`, each value truncated to a byte. */
  ambient: Vector3
  background: Vector3
}

/**
 * `FX/jumpeffect.ini` as `JumpEffectIniLoad` (`0x5020a0`) reads it, by nickname folded. Its record
 * outlives each section and only the names are cleared, so a section without `jump_ambient` or
 * `jump_background_color` keeps the one before's.
 */
export const loadJumpEffects = async (read: ReadAsset): Promise<Map<string, JumpDescriptor>> => {
  const found = new Map<string, JumpDescriptor>()
  const byte = (value: number) => Math.trunc(value) & 0xff
  let ambient: Vector3 = { x: 0, y: 0, z: 0 }
  let background: Vector3 = { x: 0, y: 0, z: 0 }
  for (const section of Document.read(await read('FX/jumpeffect.ini'))) {
    if (section.name.toLowerCase() !== 'jumpgateeffect') continue
    const ambientValues = numbers(section, 'jump_ambient')
    if (ambientValues.length) ambient = vector(ambientValues.map(byte))
    const backgroundValues = numbers(section, 'jump_background_color')
    if (backgroundValues.length) background = vector(backgroundValues.map(byte))
    const tunnel = strings(section, 'jump_tunnel')[0]?.toLowerCase()
    const nickname = section.getNickname()?.toLowerCase()
    if (nickname) found.set(nickname, { ...(tunnel && { tunnel }), ambient, background })
  }
  return found
}

/**
 * Where a gate's tunnel starts: its archetype's `jump_out_hp` in the world, a lab object standing
 * unturned at `position` (`FJumpShipEffect`, `0x503635`). Identity when it has none, as retail.
 */
export const jumpOutFrame = async (
  read: ReadAsset,
  archetype: string,
  position: Vector3,
): Promise<Matrix4> => {
  const section = (await sectionsOf(read, ['SOLAR/solararch.ini'])).get(archetype.toLowerCase())!
  const name = strings(section, 'jump_out_hp')[0]
  const model = readRigidModel(
    Directory.read(await read(pathOf(strings(section, 'DA_archetype')[0]!))),
  )
  const point = name === undefined ? undefined : hardpoint(model, name)
  return point ? Matrix4.multiply(Matrix4.translation(position), point) : Matrix4.identity
}

// Where the `[VisEffect]`s of what reference systems carry are: `freelancer.ini` lists them all.
const ALE_TABLES = [
  'FX/ENGINES/engines_ale.ini',
  'FX/MISC/misc_ale.ini',
  'FX/SPACE/space_ale.ini',
  'FX/EXPLOSIONS/explosions_ale.ini',
]
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
  /** 0 at rest, as the engines are unless the host says otherwise. */
  sparam: number
  /** Started again once it finishes, as a battle keeps making explosions. */
  repeat?: () => SpaceEffect
}

interface EffectTables {
  effects: Map<string, Section>
  visuals: Map<string, Section>
  pools: EffectPools
}

/** An `[Effect]`'s `[VisEffect]` file and textures, read once: each call starts it afresh. */
const effectSource = async (
  nickname: string,
  tables: EffectTables,
  read: ReadAsset,
): Promise<() => DynamicEffect> => {
  const section = tables.effects.get(nickname.toLowerCase())!
  const visual = tables.visuals.get(strings(section, 'vis_effect')[0]!.toLowerCase())!
  const alchemy = readAlchemy(Directory.read(await read(pathOf(strings(visual, 'alchemy')[0]!))))!
  const nodes = new Map<number, Node>()
  for (const node of alchemy.nodes.nodes)
    nodes.set(getResourceId(getNodeName(node) ?? '', true), node)
  const resolve = (crc: number) => nodes.get(crc)
  const crc = Number(visual.getValue('effect_crc')!.value) | 0
  const found = alchemy.effects.effects.find(({ name }) => (getResourceId(name, true) | 0) === crc)!
  const lookup = lookupOver(alchemy.effects.effects, resolve)
  const textures = (
    await Promise.all(
      strings(visual, 'textures').map(async (path) => [
        ...readTextureLibrary(Directory.read(await read(pathOf(path)))),
      ]),
    )
  ).flat()
  const type = effectTypeIndex(strings(section, 'effect_type')[0]!)!
  const texture = (name: string) =>
    textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
  return () => ({
    instance: new EffectInstance(buildEffect(found, resolve), { lookup, pools: tables.pools }),
    texture,
    type,
  })
}

/** An `[Effect]` started where `world` holds it. */
const startEffect = async (
  nickname: string,
  world: Matrix4,
  on: Vector3,
  tables: EffectTables,
  read: ReadAsset,
  { sparam = 0, repeat = false }: { sparam?: number; repeat?: boolean } = {},
): Promise<Placed> => {
  const source = await effectSource(nickname, tables, read)
  const position = { x: world.w.x, y: world.w.y, z: world.w.z }
  const start = (): SpaceEffect => ({ ...source(), position, watched: { position: on } })
  return { effect: start(), world, on, sparam, ...(repeat && { repeat: start }) }
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

/**
 * A `[star]` of `solar\StarArch.ini`, as `FStarSphere::Load` (`0x511020`) reads it: the first
 * `star_glow`, `lens_glow`, `spines` and `lens_flare` that name a section, the last `star_center`, `radius` and the fades.
 */
const loadStar = async (read: ReadAsset, nickname: string): Promise<Star> => {
  const path = 'solar\\stararch.ini'
  const shapes = await loadShapes(read, [path])
  const sections = [...Document.read(await read(pathOf(path)))]
  const named = (kind: string, name: string) =>
    sections.find(
      (section) =>
        section.name.toLowerCase() === kind &&
        section.getNickname()?.toLowerCase() === name.toLowerCase(),
    )
  // `StarGlowLoadFromIni` (`0x50c950`): the shape by name, the colours as written.
  const glowOf = (name: string): StarGlow | undefined => {
    const section = named('star_glow', name)
    if (!section) return undefined
    const glow: StarGlow = {}
    for (const { name: key, numbers, strings } of linesOf(section)) {
      if (key === 'shape') {
        const shape = shapes.get(strings[0]!.toLowerCase())
        if (shape) glow.shape = shape
      }
      if (key === 'scale') glow.scale = numbers[0]!
      if (key === 'inner_color') glow.innerColor = vector(numbers)
      if (key === 'outer_color') glow.outerColor = vector(numbers)
    }
    return glow
  }
  // `LensGlowLoadFromIni` (`0x50d420`).
  const lensGlowOf = (name: string): LensGlow | undefined => {
    const section = named('lens_glow', name)
    if (!section) return undefined
    const glow: LensGlow = {}
    for (const { name: key, numbers, strings } of linesOf(section)) {
      if (key === 'shape') {
        const shape = shapes.get(strings[0]!.toLowerCase())
        if (shape) glow.shape = shape
      }
      if (key === 'radius_scale') glow.radiusScale = numbers[0]!
      if (key === 'inner_color') glow.innerColor = vector(numbers)
      if (key === 'outer_color') glow.outerColor = vector(numbers)
      if (key === 'glow_fade_in_seconds') glow.fadeIn = numbers[0]!
      if (key === 'glow_fade_out_seconds') glow.fadeOut = numbers[0]!
      if (key === 'interior_tween') glow.interiorTween = numbers[0]!
      if (key === 'interior_ray_tween') glow.interiorRayTween = numbers[0]!
      if (key === 'max_lod') glow.maxLod = Math.trunc(numbers[0]!)
    }
    return glow
  }
  // `SpinesLoadFromIni` (`0x50fba0`): each `spine` its length, width, colours and alpha.
  const spinesOf = (name: string): StarSpines | undefined => {
    const section = named('spines', name)
    if (!section) return undefined
    const spines: StarSpines = { spines: [] }
    const list: StarSpine[] = []
    for (const { name: key, numbers, strings } of linesOf(section)) {
      if (key === 'shape') {
        const shape = shapes.get(strings[0]!.toLowerCase())
        if (shape) spines.shape = shape
      }
      if (key === 'radius_scale') spines.radiusScale = numbers[0]!
      if (key === 'min_radius') spines.minRadius = numbers[0]!
      if (key === 'max_radius') spines.maxRadius = numbers[0]!
      if (key === 'spine') {
        const [length, width, r0, g0, b0, r1, g1, b1, alpha] = numbers
        list.push({
          length: length!,
          width: width!,
          innerColor: { x: r0!, y: g0!, z: b0! },
          outerColor: { x: r1!, y: g1!, z: b1! },
          alpha: alpha!,
        })
      }
    }
    return { ...spines, spines: list }
  }
  // `LensFlareLoadFromIni` (`0x50f3a0`): each `bead` how far along, how big, its colour and alpha.
  const lensFlareOf = (name: string): StarLensFlare | undefined => {
    const section = named('lens_flare', name)
    if (!section) return undefined
    const flare: StarLensFlare = { beads: [] }
    const beads: FlareBead[] = []
    for (const { name: key, numbers, strings } of linesOf(section)) {
      if (key === 'shape') {
        const shape = shapes.get(strings[0]!.toLowerCase())
        if (shape) flare.shape = shape
      }
      if (key === 'min_radius') flare.minRadius = numbers[0]!
      if (key === 'max_radius') flare.maxRadius = numbers[0]!
      if (key === 'bead') {
        const [along, size, r, g, b, alpha] = numbers
        beads.push({ along: along!, size: size!, color: { x: r!, y: g!, z: b! }, alpha: alpha! })
      }
    }
    return { ...flare, beads }
  }
  const section = named('star', nickname)
  if (!section) throw new Error(`no star ${nickname}`)
  const star: Star = {}
  // An intensity fade of 0 is held to 1e-7; a zone occlusion fade lands there too, unheld.
  const tiny = Math.fround(1e-7)
  for (const { name: key, numbers, strings } of linesOf(section)) {
    const value = numbers[0]!
    if (key === 'intensity_fade_in' || key === 'zone_occlusion_fade_in')
      star.intensityFade = {
        ...star.intensityFade,
        fadeIn: key === 'intensity_fade_in' && value === 0 ? tiny : value,
      }
    if (key === 'intensity_fade_out' || key === 'zone_occlusion_fade_out')
      star.intensityFade = {
        ...star.intensityFade,
        fadeOut: key === 'intensity_fade_out' && value === 0 ? tiny : value,
      }
    if (key === 'spines' && !star.spines) {
      const spines = spinesOf(strings[0]!)
      if (spines) star.spines = spines
    }
    if (key === 'lens_flare' && !star.lensFlare) {
      const flare = lensFlareOf(strings[0]!)
      if (flare) star.lensFlare = flare
    }
    if (key === 'lens_glow' && !star.lensGlow) {
      const glow = lensGlowOf(strings[0]!)
      if (glow) star.lensGlow = glow
    }
    if (key === 'radius') star.radius = numbers[0]!
    if (key === 'star_glow' && !star.glow) {
      const glow = glowOf(strings[0]!)
      if (glow) star.glow = glow
    }
    if (key === 'star_center') {
      const center = glowOf(strings[0]!)
      if (center) star.center = center
      else delete star.center
    }
  }
  return star
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
  const cloudsOf = (section: Section) => cloudsFrom(section, shapes, RING_CLOUD_VISIBILITY, random)
  return {
    ...buildRing(ring, zone, { highDetailTextures }),
    ...(clouds.length ? { clouds: clouds.map(cloudsOf) } : {}),
  }
}

/**
 * `[Clouds]` keys, as `FUN_00550240` reads them, for a ring or a nebula. With no `lightning_duration`
 * a puff never flashes (`+0xa0`, 0).
 */
const cloudsFrom = (
  section: Section,
  shapes: ReadonlyMap<string, TextureShape>,
  visibility: CloudVisibility,
  random: () => number,
): Clouds => {
  const value = (key: string, at = 0) => {
    const found = section.getValue(key, at)
    return found === undefined ? undefined : Number(found.value)
  }
  const colorOf = (key: string) => {
    const found = section.getValues(key)
    if (!found) return undefined
    const [x, y, z] = found.map(({ value }) => Math.fround(Number(value) / 255))
    return { x: x!, y: y!, z: z! }
  }
  const colors = section.properties
    .filter(({ name }) => /^puff_color[ab]$/i.test(name))
    .slice(0, 2)
    .map(({ values }) => {
      const [x, y, z] = values.map(({ value }) => Math.fround(Number(value) / 255))
      return { x: x!, y: y!, z: z! }
    })
  const duration = value('lightning_duration')
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
    ...(duration
      ? {
          lightning: {
            color: colorOf('lightning_color') ?? { x: 0, y: 0, z: 0 },
            ...(value('lightning_intensity') !== undefined
              ? { intensity: value('lightning_intensity')! }
              : {}),
            gap: value('lightning_gap') ?? 0,
            duration,
          },
        }
      : {}),
  }
  return new Clouds(settings, { visibility, random })
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
  // `GetSize` keeps what's written, a missing value 0, and a sphere's pitch turns its axes.
  const written = {
    size: { x: found.size[0] ?? 0, y: found.size[1] ?? 0, z: found.size[2] ?? 0 },
    orientation,
  }
  const zone =
    found.shape === 'SPHERE'
      ? zoneOf({ type: 'sphere', center, radius: a }, written)
      : zoneOf({ type: 'ellipsoid', center, orientation, radii: { x: a, y: b, z: c } }, written)
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
  random: () => number,
): Promise<SpaceNebula> => {
  const { zone, edgeFraction } = zoneFor(system, zoneName)
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
  let burnthrough: SpaceNebula['burnthrough']
  const exclusions: NebulaExclusion[] = []
  const background: { duration?: number } = {}
  const dynamic: { duration?: number } = {}
  const shapes = new Map<string, TextureShape>()
  const clouds: Section[] = []
  let fillName: string | undefined
  // `[Exterior]`'s keys, as `ParseExteriorSection` reads them: at most eight shapes, by name.
  const exterior: { shapes: string[]; numbers: Record<string, number[]> } = {
    shapes: [],
    numbers: {},
  }
  for (const section of Document.read(await read(pathOf(file)))) {
    const kind = section.name.toLowerCase()
    if (kind === 'texturepanels')
      for (const [key, value] of await loadShapes(read, strings(section, 'file')))
        shapes.set(key, value)
    if (kind === 'clouds') clouds.push(section)
    for (const { name, numbers, strings } of linesOf(section)) {
      if (kind === 'exterior' && name === 'fill_shape') fillName = strings[0]!.toLowerCase()
      if (kind === 'exterior' && name === 'shape' && exterior.shapes.length < 8)
        exterior.shapes.push(strings[0]!.toLowerCase())
      else if (kind === 'exterior') exterior.numbers[name] = numbers
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
      if (kind === 'nebulalight' && name === 'sun_burnthrough_intensity')
        burnthrough = { ...burnthrough, intensity: numbers[0]! }
      if (kind === 'nebulalight' && name === 'sun_burnthrough_scaler')
        burnthrough = { ...burnthrough, scaler: numbers[0]! }
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
  // A name the shapes don't hold finds nothing, as `FShapeDB::Find` warns and gives null.
  const fill = fillName === undefined ? undefined : shapes.get(fillName)
  const value = (key: string) => exterior.numbers[key]?.[0]
  const color = exterior.numbers['color']
  const settings: ExteriorSettings = {
    shapes: exterior.shapes.map((name) => shapes.get(name)),
    ...(exterior.numbers['shape_weights'] && {
      weights: exterior.numbers['shape_weights'].slice(0, exterior.shapes.length),
    }),
    // Uninitialised in retail when absent; every retail file has both.
    bitRadius: value('bit_radius') ?? 0,
    color: color
      ? {
          x: Math.fround(color[0]! / 255),
          y: Math.fround(color[1]! / 255),
          z: Math.fround(color[2]! / 255),
        }
      : { x: 0, y: 0, z: 0 },
    ...(value('bit_radius_random_variation') !== undefined && {
      radiusVariation: value('bit_radius_random_variation')!,
    }),
    // `plane_slices`, `min_bits` and `max_bits` are truncated to integers.
    ...(value('plane_slices') !== undefined && { planeSlices: Math.trunc(value('plane_slices')!) }),
    ...(value('min_bits') !== undefined && { minBits: Math.trunc(value('min_bits')!) }),
    ...(value('max_bits') !== undefined && { maxBits: Math.trunc(value('max_bits')!) }),
    ...(value('equator_bias') !== undefined && { equatorBias: value('equator_bias')! }),
    ...(value('move_bit_percent') !== undefined && { moveBitPercent: value('move_bit_percent')! }),
    ...(value('opacity') !== undefined && { opacity: value('opacity')! }),
  }
  return {
    zone,
    fog,
    ...(ambient ? { ambient } : {}),
    ...(burnthrough && { burnthrough }),
    exclusions,
    lightning: new NebulaLightning({ background, dynamic }),
    ...(fill ? { fill } : {}),
    exterior: new NebulaExterior(settings, zone, { random }),
    ...(clouds.length && {
      clouds: clouds.map((section) => cloudsFrom(section, shapes, NEBULA_CLOUD_VISIBILITY, random)),
    }),
    ...(edgeFraction && { edgeFraction }),
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
  random: () => number,
  tables: EffectTables,
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
  let billboards: BandRecord | undefined
  /** Each `[DynamicAsteroids]`: its keys, its `asteroid` and its `zone`, the last named. */
  const dynamics: { numbers: Record<string, number[]>; asteroid?: string; zone?: string }[] = []
  /** Each exclusion's zone shape, as `exclude_dynamic_asteroids` reads it. */
  const exclusionShapes: string[] = []
  for (const section of Document.read(await read(pathOf(file)))) {
    const kind = section.name.toLowerCase()
    if (kind === 'texturepanels')
      for (const [key, value] of await loadShapes(read, strings(section, 'file')))
        shapes.set(key, value)
    const record: BandRecord | undefined =
      kind === 'band' || kind === 'exclusionband' ? { numbers: {} } : undefined
    if (kind === 'band') band = record
    if (kind === 'exclusionband') exclusionBands.push(record!)
    if (kind === 'asteroidbillboards') billboards = { numbers: {} }
    if (kind === 'dynamicasteroids') dynamics.push({ numbers: {} })
    for (const line of linesOf(section)) {
      if (kind === 'dynamicasteroids') {
        const dynamic = dynamics.at(-1)!
        dynamic.numbers[line.name] = line.numbers
        if (line.name === 'asteroid') dynamic.asteroid = line.strings[0]!
        if (line.name === 'zone') dynamic.zone = line.strings[0]!
      }
      if (record) {
        record.numbers[line.name] = line.numbers
        if (line.name === 'shape') record.shape = line.strings[0]!
        if (line.name === 'offset_dist') record.offset = { distance: line.numbers[0]! }
        if (line.name === 'offset_percent') record.offset = { percent: line.numbers[0]! }
        if (line.name === 'zone') record.zone = line.strings[0]!
      }
      if (kind === 'asteroidbillboards') {
        billboards!.numbers[line.name] = line.numbers
        if (line.name === 'shape') billboards!.shape = line.strings[0]!
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
          exclusionShapes.push(
            system.zones!.find(
              ({ nickname }) => nickname.toLowerCase() === line.strings[0]!.toLowerCase(),
            )!.shape,
          )
        }
        if (line.name === 'empty_cube_frequency' && exclusions.length)
          exclusions[exclusions.length - 1] = {
            ...exclusions.at(-1)!,
            emptyFrequency: line.numbers[0]!,
          }
        // Each truncated, and taken only above 0 (`062a4f0b`, `062a4f40`).
        const whole = Math.trunc(line.numbers[0] ?? 0)
        if (line.name === 'exclude_billboards' && exclusions.length && whole > 0)
          exclusions[exclusions.length - 1] = { ...exclusions.at(-1)!, excludeBillboards: true }
        if (line.name === 'billboard_count' && exclusions.length && whole > 0)
          exclusions[exclusions.length - 1] = { ...exclusions.at(-1)!, billboardCount: whole }
        // Only a sphere's or an ellipsoid's (`062a4f81`).
        if (
          line.name === 'exclude_dynamic_asteroids' &&
          exclusions.length &&
          whole > 0 &&
          ['SPHERE', 'ELLIPSOID'].includes(exclusionShapes.at(-1)!)
        )
          exclusions[exclusions.length - 1] = {
            ...exclusions.at(-1)!,
            excludeDynamicAsteroids: true,
          }
      }
    }
  }
  const cubeSize = Math.trunc(keys['cube_size']?.[0] ?? 400)
  const half = cubeSize * 0.5
  const clamp = (value: number) => Math.min(Math.max(value, -1), 1)
  const libraries: Directory[] = []
  const asteroids: CubeAsteroid[] = []
  /** An archetype's top level, its libraries kept for the field's lookups. */
  const topLevel = async (name: string) => {
    const section = asteroidArchetypes.get(name.toLowerCase())!
    const root = Directory.read(await read(pathOf(strings(section, 'DA_archetype')[0]!)))
    libraries.push(root)
    for (const path of strings(section, 'material_library'))
      libraries.push(Directory.read(await read(pathOf(path))))
    const model = readRigidModel(root)
    const source = model.type === 'rigid' ? model.part : undefined
    if (!source) return undefined
    const level = source.type === 'multilevel' ? source.levels[0]! : source
    return {
      mesh: getMesh(readVMeshLibrary(root), level.reference.meshId)!,
      reference: level.reference,
    }
  }
  for (const { name, numbers } of lines) {
    const found = await topLevel(name)
    if (!found) continue
    const [, x = 0, y = 0, z = 0, ax = 0, ay = 0, az = 0] = numbers
    asteroids.push({
      ...found,
      offset: {
        x: Math.fround(half * Math.fround(clamp(x))),
        y: Math.fround(half * Math.fround(clamp(y))),
        z: Math.fround(half * Math.fround(clamp(z))),
      },
      orientation: entryOrientation(ax, ay, az),
    })
  }
  const merged = mergeCube(asteroids)!
  // `CliDynamicAsteroidParseIni`: each section's archetype, its whole top level at its own frame.
  const rockModels = await Promise.all(
    dynamics.map(async ({ asteroid }) => {
      const found = asteroid === undefined ? undefined : await topLevel(asteroid)
      return (
        found &&
        mergeCube([{ ...found, offset: { x: 0, y: 0, z: 0 }, orientation: Matrix4.identity }])
      )
    }),
  )
  // Each archetype's `particle_effect`, which its rocks start as they're placed.
  const rockEffects = await Promise.all(
    dynamics.map(async ({ asteroid }) => {
      const section = asteroid && asteroidArchetypes.get(asteroid.toLowerCase())
      const nickname = section && strings(section, 'particle_effect')[0]
      return nickname ? await effectSource(nickname, tables, read) : undefined
    }),
  )
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
  const fillDistance = Math.trunc(keys['fill_dist']?.[0] ?? 1200)
  const billboardsOf = ({ numbers, shape }: BandRecord) => {
    const one = (key: string) => numbers[key]?.[0]
    const size = numbers['size']
    const shift = numbers['color_shift']
    const found = shape === undefined ? undefined : shapes.get(shape.toLowerCase())
    const settings: BillboardSettings = {
      ...(found && { shape: found }),
      ...(one('count') !== undefined && { count: Math.trunc(one('count')!) }),
      ...(size && {
        size: (size[1]! < size[0]! ? [size[1]!, size[0]!] : [size[0]!, size[1]!]) as [
          number,
          number,
        ],
      }),
      ...(one('start_dist') !== undefined && { startDistance: one('start_dist')! }),
      ...(one('fade_dist_percent') !== undefined && { fadePercent: one('fade_dist_percent')! }),
      ...(one('ambient_intensity') !== undefined && {
        ambientIntensity: one('ambient_intensity')!,
      }),
      ...(shift && { colorShift: { x: shift[0]!, y: shift[1]!, z: shift[2]! } }),
    }
    return new AsteroidBillboards(
      settings,
      { zone, edgeFraction, fillDistance, cubeSize, diffuse, ambient, exclusions },
      { random },
    )
  }
  const lookups = {
    material: (id: number) => getMaterial(materials, id),
    texture: (name: string) =>
      textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase()),
  }
  const dynamic = dynamics.flatMap(({ numbers, zone: own }, at) => {
    const model = rockModels[at]
    if (!model) return []
    const one = (key: string) => numbers[key]?.[0]
    const shift = numbers['color_shift']
    const settings: DynamicSettings = {
      ...(one('count') !== undefined && { count: one('count')! }),
      ...(one('placement_radius') !== undefined && { placementRadius: one('placement_radius')! }),
      ...(one('max_velocity') !== undefined && { maxVelocity: one('max_velocity')! }),
      ...(one('max_angular_velocity') !== undefined && {
        maxAngularVelocity: one('max_angular_velocity')!,
      }),
      ...(shift && { colorShift: { x: shift[0]!, y: shift[1]!, z: shift[2]! } }),
    }
    // A `zone` that isn't found is an error, and the field's is used (`0x521130`).
    const named =
      own !== undefined &&
      system.zones!.some(({ nickname }) => nickname.toLowerCase() === own.toLowerCase())
    const placed = named ? zoneFor(system, own!) : { zone, edgeFraction }
    const rocks = new DynamicAsteroids(
      settings,
      { ...placed, diffuse, ambient, exclusions },
      { random, ...(rockEffects[at] && { effect: rockEffects[at] }) },
    )
    return [{ rocks, model: { ...model, ...lookups } }]
  })
  return {
    zone,
    edgeFraction,
    cubeSize,
    fillDistance,
    ...(keys['empty_cube_frequency'] ? { emptyFrequency: keys['empty_cube_frequency'][0]! } : {}),
    ...(keys['max_alpha'] ? { maxAlpha: keys['max_alpha'][0]! } : {}),
    rotations: cubeRotations(degrees),
    exclusions,
    cube: { ...merged, ...lookups },
    diffuse,
    ambient,
    ...(ambientIncrease ? { ambientIncrease } : {}),
    ...(band ? { band: bandOf(band) } : {}),
    ...(billboards && { billboards: billboardsOf(billboards) }),
    ...(dynamic.length && { dynamic }),
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

/**
 * A ship's `[Cockpit] mesh`, from its `cockpit` file in `shiparch.ini` (`FirstPersonCameraLoad`), and
 * the mesh's root bounding sphere, local. The host places it, as `FirstPersonCameraUpdate` does.
 */
export const loadCockpit = async (read: ReadAsset, ship: string, camera: Camera) => {
  const section = (await sectionsOf(read, ['SHIPS/shiparch.ini'])).get(ship.toLowerCase())!
  const file = Document.read(await read(pathOf(strings(section, 'cockpit')[0]!)))
  const mesh = strings(file.getSection('Cockpit')!, 'mesh')[0]!
  const place = await loadModelFile(read, mesh, camera)
  const { center, radius } = place(Matrix4.identity).parts[0]!.reference.boundingSphere
  return { place, sphere: { center, radius } }
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
    ships,
    extraEffects,
  }: SystemOptions,
): Promise<LoadedSystem> => {
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
  // A retail system's objects take theirs from all three.
  const loadouts = await sectionsOf(read, [
    'SOLAR/loadouts.ini',
    'SHIPS/loadouts.ini',
    'SHIPS/loadouts_special.ini',
  ])
  /**
   * A loadout's items, each with its hardpoint when it has one, in the order it lists them: the
   * object's own, or else its archetype's.
   */
  const loadoutOf = (section: Section, loadout = strings(section, 'loadout')[0]) => {
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
    loadout?: string,
  ) => {
    const attached: SceneModel[] = []
    for (const { item, point } of loadoutOf(section, loadout)) {
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
    loadout?: string,
  ): SpaceFlare[] =>
    loadoutOf(section, loadout).flatMap(({ item, point }) => {
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
  const animate = async (
    section: Section,
    loadout?: string,
  ): Promise<PlaceOptions['jointState']> => {
    const names = loadoutOf(section, loadout).flatMap(({ item }) =>
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
  for (const { archetype: nickname, position, star: starName, loadout } of system.objects) {
    const { section, model, lists, place } = await archetype(nickname)
    const at = vector(position)
    const type = String(section.getValue('type')!.value).toUpperCase()
    const star = starName === undefined ? undefined : await loadStar(read, starName)
    // A sun has no surface to sort by: `planet` is a sphere with no star (`TypeBits & 7`).
    const planet = SPHERE_TYPES.has(type) && !star
    // A sun's is its glow's (`StarSphereMaxGlowScale`), a planet's its instance's extent
    // (`FClientSolarGameobj::Slot178`), the sphere's own.
    const sphere = star
      ? { center: at, radius: starRadius(star) }
      : planet && model.type === 'sphere'
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
    const jointState = await animate(section, loadout)
    const attached = await attach(model, section, Matrix4.translation(at), jointState, loadout)
    const flares = flaresOf(model, section, Matrix4.translation(at), jointState, loadout)
    const hitbox = await hitboxOf(section, model, Matrix4.translation(at), read, jointState)
    objects.push({
      model: place(Matrix4.translation(at), jointState),
      ...(attached.length ? { attached } : {}),
      ...(flares.length ? { flares } : {}),
      position: at,
      sphere,
      solar: { large: extent > 200, extent, planet },
      ...(star && { star }),
      ...(hitbox && { hitbox }),
      // `systemIni` writes every `[Object]` before any `[Nebula]`: no solar finds one.
      ...(system.nebulae?.length ? { nebula: null } : {}),
      ...(range > 0 ? { lodRange: range } : {}),
    })
  }

  const tables: EffectTables = {
    effects: await sectionsOf(read, ['FX/effects.ini', 'FX/effects_explosion.ini']),
    visuals: await sectionsOf(read, ALE_TABLES),
    pools: createPools(),
  }
  const placed: Placed[] = []

  // A solar's loadout: each `[AttachedFX]` on its hardpoint, as the loadout lists them.
  for (const { archetype: nickname, position, loadout } of system.objects) {
    const section = archetypes.get(nickname.toLowerCase())!
    const { model } = await archetype(nickname)
    for (const { item: fx, point } of loadoutOf(section, loadout)) {
      if (fx?.name.toLowerCase() !== 'attachedfx' || !point) continue
      const at = vector(position)
      const world = Matrix4.multiply(Matrix4.translation(at), hardpoint(model, point)!)
      placed.push(await startEffect(strings(fx, 'particles')[0]!, world, at, tables, read))
    }
  }

  /**
   * A ship at `position`, unturned, with its pilot and its engine's nozzles, each with its
   * `flame_effect` and a trail: `trail_effect_player` for the player's (`CliEngineAttachExhaustEffects`,
   * `0x528980`), `trail_effect` for another's.
   */
  const addShip = async (
    nickname: string,
    engineNickname: string | undefined,
    position: Vector3,
    trail: 'trail_effect_player' | 'trail_effect',
    sparam: number,
  ) => {
    const hull = await archetype(nickname)
    const world = Matrix4.translation(position)
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
    const engine = engineNickname ? equipment.get(engineNickname.toLowerCase()) : undefined
    const nozzles = ['HpEngine01', 'HpEngine02', 'HpEngine03', 'HpEngine04'].flatMap((name) => {
      const at = hardpoint(hull.model, name)
      return at ? [Matrix4.multiply(world, at)] : []
    })
    if (engine)
      for (const nozzle of nozzles)
        for (const key of ['flame_effect', trail]) {
          const effect = strings(engine, key)[0]
          if (effect)
            placed.push(await startEffect(effect, nozzle, position, tables, read, { sparam }))
        }

    const range = lodRange(sources(hull.model), hull.lists, { detail })
    const distanceRender = hull.section.getValue('distance_render')
    objects.push({
      model: hull.place(world),
      position,
      sphere: await bodySphere(hull.section, position, read),
      ...(pilot ? { pilot } : {}),
      hitbox: (await hitboxOf(hull.section, hull.model, world, read))!,
      ...(range > 0 ? { lodRange: range } : {}),
      ...(distanceRender ? { distanceRender: Number(distanceRender.value) } : {}),
    })
  }

  const playerEngine = system.player.equipment.find(
    (nickname) => equipment.get(nickname.toLowerCase())?.name.toLowerCase() === 'engine',
  )
  // At rest: no throttle, so every `sparam` is 0 (`FCliEngineEquipFx::Update`).
  await addShip(system.player.ship, playerEngine, ship, 'trail_effect_player', 0)
  for (const other of ships ?? [])
    await addShip(other.ship, other.engine, vector(other.position), 'trail_effect', other.sparam)
  for (const { nickname, position } of extraEffects ?? [])
    placed.push(
      await startEffect(
        nickname,
        Matrix4.translation(vector(position)),
        vector(position),
        tables,
        read,
        {
          repeat: true,
        },
      ),
    )

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
  const view = viewMatrix(camera)
  const stepEffects = (dt: number, from: Camera = camera) => {
    const view = viewMatrix(from)
    for (const { effect, world: placement, sparam, repeat } of placed) {
      if (repeat && effect.instance.finished) effect.instance = repeat().instance
      effect.instance.advance(dt, { placement, view, sparam })
    }
  }
  for (let step = 0; step < (effectSeconds ?? 0) * effectRate; step++) stepEffects(1 / effectRate)

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
  // The dust's effects, read once: each zone's and the system's, by name without case.
  const dustNames = [
    ...(system.dust ? [system.dust] : []),
    ...(system.zones ?? []).flatMap(({ spacedust }) => (spacedust ? [spacedust.effect] : [])),
  ]
  const dustSources = new Map(
    await Promise.all(
      dustNames.map(
        async (name) => [name.toLowerCase(), await effectSource(name, tables, read)] as const,
      ),
    ),
  )
  const dust = new SpaceDust(system.dust, (name) => dustSources.get(name.toLowerCase())?.())
  const dustZones: DustZone[] = (system.zones ?? []).flatMap(({ nickname, spacedust }) => {
    if (!spacedust) return []
    const { zone, edgeFraction } = zoneFor(system, nickname)
    return [
      {
        zone,
        edgeFraction,
        dust: spacedust.effect,
        ...(spacedust.maxParticles !== undefined && { maxParticles: spacedust.maxParticles }),
      },
    ]
  })
  // From entering the system, on the effects' clock: the camera at rest all along.
  for (let frame = 0; frame < (effectSeconds ?? 0) * effectRate; frame++)
    dust.update(camera, 1 / effectRate, dustZones)

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
    tick: stepEffects,
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
    ...(dustNames.length && { dust, dustZones }),
    rings,
    shine: { texture: await shapeOf(read, 'shine') },
    asteroids: await Promise.all(
      (system.asteroids ?? []).map(({ file, zone }) =>
        loadField(read, system, file, zone, rand, tables),
      ),
    ),
    nebulae: await Promise.all(
      (system.nebulae ?? []).map(({ file, zone }) =>
        loadNebula(read, system, file, zone, camera, rand),
      ),
    ),
  }
}
