/**
 * A system's frame as the game orders it: `SpaceObjDrawPass` (`0x51c200`), in
 * `src/freelancer/Client/space_scene_obj_draw.cpp`. Pure, no GL. Objects join one of five lists, each
 * drains far to near, and the batcher flushes after every object.
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import { collectEffect, type EffectDraw } from '#/alchemy/draw.js'
import {
  viewEffect,
  type EffectView,
  type EffectViewOptions,
  type PlacedEffect,
} from './effect-view.js'
import { lightObject, lightSet, systemAmbient, type SpaceLight } from './light.js'
import {
  findNebula,
  fogEnd,
  fogFar,
  fogOf,
  nebulaState,
  pickField,
  RETAIL_NEBULA_LIMITS,
  type NebulaLimits,
  type SpaceField,
  type SpaceNebula,
  type Within,
} from './nebula.js'
import { classifySphere, projectionMatrix, viewMatrix, type Camera } from './camera.js'
import {
  BLACK_BACKGROUND,
  collectModel,
  flushQueued,
  hooksOf,
  RETAIL_FRAME_LIMITS,
  type Draw,
  type FrameLimits,
  type Frame,
  type Queued,
  type SceneEffect,
  type SceneModel,
} from './frame.js'

export interface SpaceObject {
  model: SceneModel
  /** `get_position`, which its sort distance is from. */
  position: Vector3
  /** `Slot178`, in world space: what it's tested against the view with. */
  sphere: { center: Vector3; radius: number }
  /** Only a solar reaches the far list. Anything else stops at the system's draw range. */
  solar?: {
    /** In `G_LargeSolars`, radius over 200 and type bit 7 clear: no `solarQueryRange` limit. */
    large?: boolean
    /** Planet or moon, `TypeBits & 7` with no star sphere: sorted by its surface, not its centre. */
    planet?: boolean
  }
  /** The archetype's `nomad`: goes three lists up, after everything of its kind (`0x51f5b7`). */
  nomad?: boolean
  /** The archetype's `distance_render`. Past it, it stops reflecting, and `lodRange` may apply. */
  distanceRender?: number
  /** The archetype's `LodPick`, the largest of its `LODranges`. Past it, it draws nothing. */
  lodRange?: number
  /**
   * The nebula it was last in, which retail keeps and tries first. It matters only where nebulae
   * overlap, and none do in retail. The first that holds it when absent.
   */
  nebula?: SpaceNebula
}

/** A space frame, and what became of each of its effects. */
export interface SpaceFrame extends Frame {
  /**
   * In the scene's order: an effect with a `position` is drawn, runs unseen, or ends, as the game
   * would. The host steps it with `lod` next. Undefined for one with no position, which draws.
   */
  effectViews: (EffectView | undefined)[]
}

/** `EffectTypeInfoByIndex`, from `[EffectType]`: the game's walk is by type. */
export interface SpaceEffect extends SceneEffect, Partial<Omit<PlacedEffect, 'type'>> {
  /** `[EffectType]`'s index, `EFT_NONE` 0. With a `position`, the view test decides it. */
  type: number
}

export interface SpaceScene {
  /** Its `far` is ignored: the frame's comes from `farClip`, or the field's. */
  camera: Camera
  aspect: number
  /** `[Ambient] color`, as written: 0 to 255. */
  ambient: Vector3
  /** Its `[LightSource]`s, in file order. */
  lights: readonly SpaceLight[]
  objects: readonly SpaceObject[]
  /** The star sphere's layers, in the order to draw them: basic stars, complex stars, nebulae. */
  sky?: readonly SceneModel[]
  /** `[SystemInfo] space_farclip`, the far plane, past the draw range by `limits.rangeMargin`. */
  farClip?: number
  /** Over `RETAIL_SPACE_LIMITS`, for a mod that patches them. */
  limits?: Partial<SpaceLimits>
  /** Its `[Nebula]`s, in file order: the first that holds a point is the one it's in. */
  nebulae?: readonly SpaceNebula[]
  /** Within a type in the order given, which is newest first in the game (`FUN_004fc920`). */
  effects?: readonly SpaceEffect[]
  /** `[System] space_color`, 0 to 1. Deep in a nebula, its fog's colour instead. */
  background?: Vector3
  time?: number
  /** The options and data the effects' view test reads. */
  effectView?: EffectViewOptions
  /** Seconds since the last frame, which each nebula's lightning advances by. 0 when absent. */
  step?: number
}

/** What retail hardcodes, and a mod can patch. Distances are in world units. */
export interface SpaceLimits extends FrameLimits, NebulaLimits {
  /** A system with no `space_farclip` (`FUN_00410130`). */
  farClip: number
  /** The least far plane a `space_farclip` can set (`FUN_00410150`). */
  leastFarClip: number
  /** How far short of the far plane the draw range ends (`FUN_00410150`). */
  rangeMargin: number
  /** The far list's plane (`DAT_00610534`). */
  farListPlane: number
  /** How far from the camera a small solar is looked for (`DAT_00613ec8`). */
  solarQueryRange: number
  /** Nearer than this, an object leaves its field's list. Retail holds its square (`0x5dc35c`). */
  nearDistance: number
  /** How deep in another nebula an object can be and still draw (`0x5cbf58`). */
  otherFieldDepth: number
}

export const RETAIL_SPACE_LIMITS: Readonly<SpaceLimits> = {
  ...RETAIL_FRAME_LIMITS,
  ...RETAIL_NEBULA_LIMITS,
  farClip: 21000,
  leastFarClip: 1000,
  rangeMargin: 1000,
  farListPlane: 250000,
  solarQueryRange: 10000,
  nearDistance: 200,
  otherFieldDepth: 0.25,
}

const MAIN = 0
const FIELD = 1
const FAR = 2
const NOMAD_OFFSET = 3
const LIST_COUNT = 5

// What `DrainMeshAndAsteroids` walks, after the far list. From outside a field it never walks list 4,
// so a nomad object in that field draws only if it's near enough to leave it (`0x51fa43`).
const OUTSIDE_ORDER = [FAR, FIELD, MAIN, NOMAD_OFFSET + MAIN]
const INSIDE_ORDER = [FAR, MAIN, NOMAD_OFFSET + MAIN, FIELD, NOMAD_OFFSET + FIELD]

// `SpaceEffectsDrawFrame` walks these and not 0x2b (`0x4f7650`, `0x4f76b2`).
const SKIPPED_EFFECT_TYPE = 0x2b

interface Picked {
  rank: 3 | 4
  /** `GameobjPickLodRetail`'s high word: past 0 it doesn't reflect. 2 never reaches here. */
  tier: 0 | 1
}

/** `GameobjPickLodRetail` (`0x539820`): whether it's in view and in range, by its sphere. */
const pick = (
  { sphere, distanceRender = -1, lodRange = -1 }: SpaceObject,
  view: Matrix4,
  camera: Camera,
  aspect: number,
): Picked | undefined => {
  const center = Matrix4.transformPoint(sphere.center, view)
  const rank = classifySphere(center, sphere.radius, camera, aspect)
  if (rank === 1) return undefined
  const squared = center.x * center.x + center.y * center.y + center.z * center.z
  if (distanceRender > 0 && squared < distanceRender * distanceRender) return { rank, tier: 0 }
  if (lodRange > 0 && squared > lodRange * lodRange) return undefined
  return { rank, tier: distanceRender > 0 ? 1 : 0 }
}

/**
 * `FUN_0051f2c0`'s tests on a field, for an object in the draw range: the list it starts in, which
 * nearness can still change, or nothing if the field hides it.
 */
const fieldList = (
  within: Within | undefined,
  squared: number,
  field: SpaceField | undefined,
  otherFieldDepth: number,
): number | undefined => {
  if (!field) return MAIN
  const own = within?.state === field.state
  const value = within?.factor ?? 0
  if (!own && value > otherFieldDepth) return undefined
  const enclosure = own ? value : 0
  if (field.enclosure === 2 && enclosure <= 0) return undefined
  if (field.enclosure === 0 && enclosure >= 1) return undefined
  // `G_FieldRadiusSq`, from the fog's end.
  const radius = field.state.end
  if (field.enclosure === 1 && enclosure >= 1 && squared > Math.fround(radius * radius))
    return undefined
  return enclosure > 0 ? FIELD : MAIN
}

interface Listed {
  object: SpaceObject
  key: number
  picked: Picked
  within?: Within
}

const BLACK: Vector3 = { x: 0, y: 0, z: 0 }

const withoutEnvironment = ({ environment: _, ...model }: SceneModel): SceneModel => model

export const collectSpaceFrame = ({
  camera: given,
  aspect,
  ambient,
  lights,
  objects,
  sky = [],
  farClip,
  limits,
  nebulae = [],
  effects = [],
  background,
  time = 0,
  step = 0,
  effectView,
}: SpaceScene): SpaceFrame => {
  const resolved = { ...RETAIL_SPACE_LIMITS, ...limits }
  const {
    leastFarClip,
    rangeMargin,
    farListPlane,
    solarQueryRange,
    nearDistance,
    otherFieldDepth,
  } = resolved
  const systemFar =
    farClip === undefined
      ? (limits?.farClip ?? RETAIL_SPACE_LIMITS.farClip)
      : Math.max(farClip, leastFarClip)
  const range = systemFar - rangeMargin
  const { position: eye } = given
  const states = nebulae.map((nebula) => nebulaState(nebula, eye, resolved))
  const field = pickField(states, eye, range)
  // `FNebulaEffect::Update`, every nebula's, before the frame. A flashing light joins the system's.
  const flashes: SpaceLight[] = []
  for (const { nebula, depth } of states) {
    nebula.lightning?.update(step, depth, eye)
    const light = nebula.lightning?.light
    if (light) flashes.push(light)
  }
  const inCore = field?.enclosure === 2
  const far = inCore ? Math.min(fogFar(field.state, resolved), systemFar) : systemFar
  const camera: Camera = { ...given, far }
  const farCamera: Camera = { ...given, far: farListPlane }
  const view = viewMatrix(camera)

  const lists: Listed[][] = Array.from({ length: LIST_COUNT }, () => [])
  for (const object of objects) {
    const dx = object.position.x - eye.x
    const dy = object.position.y - eye.y
    const dz = object.position.z - eye.z
    const squared = dx * dx + dy * dy + dz * dz

    // A small solar comes from a query about the camera (`BspPartition::QuerySphere`, its radius and
    // the range), and the rest from lists that have no such limit.
    if (object.solar && !object.solar.large) {
      const reach = object.sphere.radius + solarQueryRange
      if (squared >= reach * reach) continue
    }

    const within = findNebula(states, object.position, object.nebula)
    if (squared >= range * range) {
      // A far object in any nebula, or seen from a core, isn't drawn.
      if (!object.solar || inCore || within) continue
      const picked = pick(object, view, farCamera, aspect)
      if (picked) lists[FAR]!.push({ object, key: squared, picked })
      continue
    }

    const radius = object.solar?.planet ? object.sphere.radius : 0
    const key = squared - radius * radius
    let list = fieldList(within, key, field, otherFieldDepth)
    if (list === undefined) continue
    const picked = pick(object, view, camera, aspect)
    if (!picked) continue
    if (key < nearDistance * nearDistance) list = field && field.enclosure !== 0 ? FIELD : MAIN
    lists[object.nomad ? list + NOMAD_OFFSET : list]!.push({ object, key, picked, within })
  }
  // Retail's sort isn't stable, but equal keys are left in an order the object database decides.
  for (const list of lists) list.sort((a, b) => b.key - a.key)

  const draws: Draw[] = []
  const unsupported = new Set<string>()
  const unregistered = new Set<string>()
  const queued: Queued[] = []

  // A core hides the sky, and the far list has nothing in it then.
  if (!inCore)
    for (const model of sky) {
      collectModel(
        model,
        camera,
        aspect,
        view,
        time,
        draws,
        queued,
        unsupported,
        unregistered,
        resolved,
      )
      flushQueued(queued, draws)
    }

  const farProjection = projectionMatrix(farCamera, aspect)
  const lighting = lightSet(flashes.length ? [...lights, ...flashes] : lights)
  for (const at of !field || field.enclosure === 0 ? OUTSIDE_ORDER : INSIDE_ORDER) {
    const onFarList = at === FAR
    const passCamera = onFarList ? farCamera : camera
    for (const { object, picked, within } of lists[at]!) {
      const first = draws.length
      collectModel(
        // `GameobjSubmitDrawRetail`: only the first tier arms the reflection.
        picked.tier === 0 ? object.model : withoutEnvironment(object.model),
        passCamera,
        aspect,
        view,
        time,
        draws,
        queued,
        unsupported,
        unregistered,
        resolved,
        picked.rank === 4 && picked.tier === 0,
      )
      flushQueued(queued, draws)
      // `GameobjUpdateDrawLighting`, from where it stands and its sphere's radius. A draw with an
      // ambient of its own, an exclusion zone's, keeps it.
      const nebula = within?.state.nebula
      const lit = lightObject(
        lighting,
        object.position,
        object.sphere.radius,
        ambient,
        time,
        nebula?.ambient && { ambient: nebula.ambient, factor: within!.factor },
      )
      // The same call fogs what a nebula holds, and turns fog off for anything else.
      const fog =
        within &&
        fogOf(within.state.start, fogEnd(within.state, object.position), nebula!.fog.color)
      for (let index = first; index < draws.length; index++) {
        const draw = draws[index]!
        draws[index] = {
          ...draw,
          lights: lit.lights,
          sceneAmbient: draw.sceneAmbient ?? lit.ambient,
          ...(fog && { fog }),
        }
      }
      // `ZENABLE 0` around each node (`DrainBucket`), so it neither reads depth nor leaves any.
      if (onFarList)
        for (let index = first; index < draws.length; index++)
          draws[index] = {
            ...draws[index]!,
            depthFunc: 'always',
            depthWrite: false,
            projection: farProjection,
          }
    }
  }

  const effectDraws: EffectDraw[] = []
  // A placed effect is drawn only if seen. What it is otherwise the host learns from `effectViews`.
  const views = effects.map((effect): EffectView | undefined => {
    if (effect.type === SKIPPED_EFFECT_TYPE || !effect.position) return undefined
    const placed = { ...effect, position: effect.position }
    return viewEffect(placed, { camera, aspect, view, field, nebulae: states }, effectView)
  })
  const walked = effects
    .map((effect, at) => ({ effect, at }))
    .filter(
      ({ effect, at }) =>
        effect.type !== SKIPPED_EFFECT_TYPE && (views[at]?.fate ?? 'draw') === 'draw',
    )
    .sort((a, b) => a.effect.type - b.effect.type || a.at - b.at)
  for (const { effect } of walked)
    collectEffect(effect.instance, view, effect.texture, effectDraws, unsupported, effect.visible)

  // `SpaceObjDrawPass` fogs effects to black, so what they add fades out.
  const effectFog =
    field && field.enclosure !== 0
      ? fogOf(field.state.start, fogEnd(field.state, eye), BLACK)
      : undefined
  // Deep enough in, the clear is the fog's colour, which its lightning flashes.
  const deep = field && field.state.depth >= 1 ? field.state.nebula : undefined
  const fogged = deep && (deep.lightning?.fogColor(deep.fog.color) ?? deep.fog.color)

  return {
    background: fogged ? fogOf(0, 0, fogged).color : (background ?? BLACK_BACKGROUND),
    hooks: hooksOf(draws),
    view,
    projection: projectionMatrix(camera, aspect),
    // Each object has its own. What's left over is the sky's: white, and no lights.
    ambient: systemAmbient(ambient),
    lights: [],
    draws,
    effects: effectDraws,
    ...(effectFog && { effectFog }),
    // `SpaceEffectsDrawFrame` (`0x4f7480`) sets `ZFUNC` 4 around every effect.
    effectDepthFunc: 'lequal',
    effectViews: views,
    unsupported: [...unsupported],
    unregistered: [...unregistered],
  }
}
