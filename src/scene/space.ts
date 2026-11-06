/**
 * A system's frame as the game orders it: `SpaceObjDrawPass` (`0x51c200`), in
 * `src/freelancer/Client/space_scene_obj_draw.cpp`. Pure, no GL. Objects join one of five lists, each
 * drains far to near, and the batcher flushes after every object.
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import { collectEffect, type EffectDraw } from '#/alchemy/draw.js'
import {
  viewEffect,
  type EffectView,
  type EffectViewOptions,
  type PlacedEffect,
} from './effect-view.js'
import { ringImmersion, ringPieceDraw, type PlanetRing, type RingPiece } from './ring.js'
import { fieldCubes, nearFieldFraction, type SpaceAsteroidField } from './asteroids.js'
import { flareQuads, type FrameRect, type ScreenQuad, type SpaceFlare } from './flare.js'
import type { AsteroidBand } from './band.js'
import { fogOverlayDraw } from './overlay.js'
import {
  directionalLightsAt,
  lightObject,
  lightSet,
  systemAmbient,
  type SpaceLight,
} from './light.js'
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
  type Zone,
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
    /**
     * In `G_LargeSolars` (`0x540d18`), `extent` over 200 and type bit 7 clear: no
     * `solarQueryRange` limit.
     */
    large?: boolean
    /**
     * `CObject::Radius`: the engine's extent of its instance, the root part's top level, not its
     * `.sur`. `sphere`'s radius when absent.
     */
    extent?: number
    /** Planet or moon, `TypeBits & 7` with no star sphere: sorted by its surface, not its centre. */
    planet?: boolean
  }
  /**
   * A ship's `pilot_mesh`, placed at its `HpPilot` less the pilot's own `HpConnect`
   * (`AttachPilotMesh`, `0x544380`). Drawn before the model, only where it reflects (`0x546087`).
   * The game's option 0x1d turns it off, so the host decides.
   */
  pilot?: SceneModel
  /**
   * Equipment with a model, each hung on its hardpoint by `attachJoint` and placed with its own
   * archetype's lists. The engine joins it as the last child of the part holding the hardpoint, so
   * it draws after that part's subtree (`ConnectInstanceChild`, `RenderInstance`); here, after the
   * whole model, in the order given. Only the order within the object can differ: batched glass
   * still waits for its flush, but an unbatched draw on a part with later siblings goes after them.
   */
  attached?: readonly SceneModel[]
  /**
   * Its lights' flares, in the order its effect list holds them. They join the frame only when it
   * draws at the first tier (`GameobjSweepEffectList`), and only then do they blink.
   */
  flares?: readonly SpaceFlare[]
  /** The archetype's `nomad`: goes three lists up, after everything of its kind (`0x51f5b7`). */
  nomad?: boolean
  /** The archetype's `distance_render`. Past it, it stops reflecting, and `lodRange` may apply. */
  distanceRender?: number
  /** The archetype's `LodPick`, the largest of its `LODranges`. Past it, it draws nothing. */
  lodRange?: number
  /**
   * The nebula it was last in, which retail keeps and tries first. It matters only where nebulae
   * overlap, and none do in retail. The first that holds it when absent. `null` for none at all: a
   * solar finds its nebula once, as its `[Object]` is read (`FUN_005485c0`), so one listed before
   * the system's `[Nebula]` sections has none (`asteroid_nebula`'s plant).
   */
  nebula?: SpaceNebula | null
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
  /**
   * The star sphere's layers, in the order to draw them: those `skyLayers` names. Each stands at its
   * `instanceExtent` centre, as `StarSphereLoadLayer` (`0x552fd0`) moves it.
   */
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
  /**
   * Seconds since the last frame, which each nebula's lightning advances by, and each drawn light's
   * blink, held to 0.1. 0 when absent.
   */
  step?: number
  /** The camera cut to this frame, as it does entering a system: clouds are placed afresh. */
  cut?: boolean
  /** Its asteroid fields, in the order the system lists them. */
  asteroids?: readonly SpaceAsteroidField[]
  /** Its planets' rings, which the effects option shows (`0x25`). */
  rings?: readonly PlanetRing[]
  /** The viewport in pixels, which flares are sized and clipped in. No flares when absent. */
  viewport?: { width: number; height: number }
  /** `fx/efx.txm`'s `shine`, from `[Texture]` in `effect_shapes.ini`, and its frame. */
  shine?: { texture: Texture; frame?: FrameRect }
}

/** A `[Background]` key: `basic_stars`, `complex_stars` or `nebulae`. */
export type SkyLayer = 'basic' | 'complex' | 'nebulae'

/**
 * The layers that draw, in order, at the `star_sphere` option: never both kinds of stars
 * (`StarSphereApplyDetail`, `0x552cd0`; `StarSphereRender`, `0x552ea0`). Strictly above each step.
 */
export const skyLayers = (detail: number): SkyLayer[] =>
  detail > 0.75
    ? ['complex', 'nebulae']
    : detail > 0.5
      ? ['basic', 'nebulae']
      : detail > 0.001
        ? ['nebulae']
        : []

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
  /** How far short of the draw range a ring piece goes to the far list (`0x5d3d24`). */
  ringFarMargin: number
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
  ringFarMargin: 5000,
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

/** A ring's piece, a draw node of its own kind (`PTR_LAB_005dc06c`). */
interface ListedPiece {
  ring: PlanetRing
  piece: RingPiece
  key: number
}

/** A field's band piece, a draw node of the field's kind (`0x005dc034`). */
interface ListedBand {
  band: AsteroidBand
  piece: number
  key: number
}

const BLACK: Vector3 = { x: 0, y: 0, z: 0 }

/**
 * A one-piece band's key (`0x51babc`): how far past its zone's surface the camera is, squared, by a
 * length from one Newton step of the `0x5f3759df` estimate; within a quarter of the range, that.
 */
const bandSurfaceKey = (zone: Zone, eye: Vector3, nearSquared: number): number => {
  const f = Math.fround
  const dx = f(zone.position.x - eye.x)
  const dy = f(zone.position.y - eye.y)
  const dz = f(zone.position.z - eye.z)
  const sum = dy * dy + dz * dz + dx * dx
  const bits = new DataView(new ArrayBuffer(4))
  bits.setFloat32(0, sum, true)
  bits.setInt32(0, 0x5f3759df - (bits.getInt32(0, true) >> 1), true)
  const estimate = bits.getFloat32(0, true)
  const length = f((1.5 - estimate * estimate * sum * 0.5) * estimate * sum)
  const inverse = 1 / length
  const surface = zone.radiusAlong({ x: f(dx * inverse), y: f(dy * inverse), z: f(dz * inverse) })
  const key = length <= surface ? nearSquared : f((length - surface) * (length - surface))
  return key < nearSquared ? nearSquared : key
}

const withoutEnvironment = ({ environment: _, ...model }: SceneModel): SceneModel => model

/**
 * An attachment under its object's `envmap_material`, which the game sets on the object's instance
 * (`SetAppearanceInstanceValue`) and its children draw with: the cube is found in the object's.
 */
const underOwn =
  (owner: SceneModel) =>
  ({ environment: _, ...model }: SceneModel): SceneModel => {
    const { environment } = owner
    if (!environment) return model
    const folded = environment.toLowerCase()
    return {
      ...model,
      environment,
      texture: (name) =>
        name.toLowerCase() === folded ? owner.texture(name) : model.texture(name),
    }
  }

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
  viewport,
  shine,
  rings = [],
  cut = false,
  asteroids = [],
}: SpaceScene): SpaceFrame => {
  const resolved = { ...RETAIL_SPACE_LIMITS, ...limits }
  const {
    leastFarClip,
    rangeMargin,
    farListPlane,
    solarQueryRange,
    nearDistance,
    otherFieldDepth,
    ringFarMargin,
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

  const lists: (Listed | ListedPiece | ListedBand)[][] = Array.from(
    { length: LIST_COUNT },
    () => [],
  )
  for (const object of objects) {
    const dx = object.position.x - eye.x
    const dy = object.position.y - eye.y
    const dz = object.position.z - eye.z
    const squared = dx * dx + dy * dy + dz * dz

    // A small solar comes from a query about the camera (`BspPartition::QuerySphere`, its radius and
    // the range), and the rest from lists that have no such limit.
    if (object.solar && !object.solar.large) {
      // Which radius the object DB's bucket holds isn't read: taken as `extent`, as `large` is.
      const reach = (object.solar.extent ?? object.sphere.radius) + solarQueryRange
      if (squared >= reach * reach) continue
    }

    const within =
      object.nebula === null ? undefined : findNebula(states, object.position, object.nebula)
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
  // `TexturePanelsUpdateAll`, in the system's tick: each ring's clouds by how far in the camera is.
  const ringVisibility = rings.map((ring) => {
    const visibility = Math.fround(ringImmersion(ring, eye))
    for (const clouds of ring.clouds ?? [])
      clouds.update(given, step, visibility, (point) => ringImmersion(ring, point))
    return visibility
  })
  // `EnqueueTexturePanelPieces` (`0x51be10`): each piece the view's sphere test keeps, near ones by
  // how far past their radius, far ones by distance. Retail makes eight pieces of every ring, so its
  // one-piece branch, keyed by the zone's surface, is never reached and isn't built.
  const ringReach = Math.fround((range - ringFarMargin) * (range - ringFarMargin))
  for (const ring of rings)
    for (const piece of ring.pieces) {
      const center = Matrix4.transformPoint(piece.center, view)
      if (classifySphere(center, piece.radius, camera, aspect) < 3) continue
      const dx = piece.center.x - eye.x
      const dy = piece.center.y - eye.y
      const dz = piece.center.z - eye.z
      const squared = dx * dx + dz * dz + dy * dy
      if (squared > ringReach) {
        lists[FAR]!.push({ ring, piece, key: Math.fround(squared) })
        continue
      }
      const radius = piece.radius * piece.radius
      lists[MAIN]!.push({ ring, piece, key: Math.fround(squared < radius ? 0 : squared - radius) })
    }
  // `CliAsteroidUpdate` moves each band's fade to the camera, and the first frame bakes its light at
  // its own zone.
  // Then `SpaceObjDrawPass` (`0x51ba40`) lists its pieces: one keyed by the zone's surface, or each
  // the view keeps by distance, those within a quarter of the range nearest first.
  const lighting = lightSet(flashes.length ? [...lights, ...flashes] : lights)
  const rangeSquared = Math.fround(range * range)
  const quarter = range * 0.25
  const nearSquared = Math.fround(quarter * quarter)
  for (const asteroid of asteroids) {
    const { band, exclusionBands = [], zone } = asteroid
    if (band) band.update(eye)
    // `CliAsteroidUpdate`: every exclusion band is held under how near the field the camera is.
    const fraction = exclusionBands.length ? nearFieldFraction(asteroid, eye, 1000) : 0
    for (const exclusion of exclusionBands) exclusion.update(eye, fraction)
    // Its pieces numbered through, its own band's first (`FUN_00524740`, `FUN_00522850`).
    const numbered = [...(band ? [band] : []), ...exclusionBands].flatMap((owner) =>
      owner.pieces.map((piece, at) => ({ owner, piece, at })),
    )
    for (const { owner } of numbered)
      if (!owner.isBaked)
        owner.bake({ ambient, ...directionalLightsAt(lighting, owner.position, time) })
    if (numbered.length === 1) {
      const key = bandSurfaceKey(zone, eye, nearSquared)
      lists[key < rangeSquared ? MAIN : FAR]!.push({ band: numbered[0]!.owner, piece: 0, key })
      continue
    }
    for (const {
      owner,
      piece: { center, radius },
      at,
    } of numbered) {
      if (classifySphere(Matrix4.transformPoint(center, view), radius, camera, aspect) < 3) continue
      const dx = center.x - eye.x
      const dy = center.y - eye.y
      const dz = center.z - eye.z
      let squared = dz * dz + dx * dx + dy * dy
      if (rangeSquared < squared) {
        lists[FAR]!.push({ band: owner, piece: at, key: Math.fround(squared) })
        continue
      }
      // `DAT_005dc028`: 0.05f widened to a double.
      if (nearSquared > squared) squared = (nearSquared - squared) * Math.fround(0.05) + nearSquared
      lists[MAIN]!.push({ band: owner, piece: at, key: Math.fround(squared) })
    }
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

  const linked: SpaceFlare[] = []
  const farProjection = projectionMatrix(farCamera, aspect)
  /**
   * `CliAsteroidTickOne`'s cubes. The field is lit once, at a point 100 behind the camera with a
   * radius of 250 (`CliAsteroidAmbientPass`), its ambient raised by `ambient_increase`; each cube
   * then sets only the material's colours and its fade, over the material's own stages, and is
   * drawn whole with no part test (`AsteroidUploadMesh`, `AsteroidDrawCube`).
   */
  const drawField = (asteroid: SpaceAsteroidField) => {
    const cubes = fieldCubes(asteroid, given, aspect)
    if (!cubes.length) return
    const frame = Matrix4.fromRotationTranslation(given.orientation, eye)
    const point = Matrix4.transformPoint({ x: 0, y: 0, z: 100 }, frame)
    // Fogged and lit by the nebula only with `contains_fog_zone`, and the camera in its field.
    const nebula =
      asteroid.containsFogZone && field && field.enclosure !== 0 ? field.state : undefined
    const lit = lightObject(
      lighting,
      { x: Math.fround(point.x), y: Math.fround(point.y), z: Math.fround(point.z) },
      250,
      ambient,
      time,
      nebula?.nebula.ambient && { ambient: nebula.nebula.ambient, factor: nebula.depth },
    )
    const raise = asteroid.ambientIncrease ?? { x: 0, y: 0, z: 0 }
    const byte = (value: number, increase: number) =>
      Math.min(Math.round(value * 255) + Math.trunc(increase), 255) / 255
    const sceneAmbient = {
      x: byte(lit.ambient.x, raise.x),
      y: byte(lit.ambient.y, raise.y),
      z: byte(lit.ambient.z, raise.z),
    }
    const fog = nebula && fogOf(nebula.start, fogEnd(nebula, point), nebula.nebula.fog.color)
    const fading = (asteroid.maxAlpha ?? 1) < 1
    const { diffuse, ambient: tint } = asteroid
    for (const { position, orientation, alpha } of cubes) {
      const first = draws.length
      const world = Matrix4.multiply(Matrix4.translation(position), orientation)
      const { mesh, reference, ...lookups } = asteroid.cube
      collectModel(
        { ...lookups, mesh: () => mesh, parts: [{ reference, world, mesh }] },
        camera,
        aspect,
        view,
        time,
        draws,
        queued,
        unsupported,
        unregistered,
        resolved,
        true,
      )
      for (let index = first; index < draws.length; index++) {
        const blended = alpha < 1
        draws[index] = {
          ...draws[index]!,
          diffuse: [diffuse.x, diffuse.y, diffuse.z, alpha],
          // With lighting on and no fade, its own ambient; fading, the diffuse.
          ambient: fading ? diffuse : tint,
          emissive: { x: 0, y: 0, z: 0 },
          // A fading field clears the lights and sets a white ambient (`0x5237f4`).
          lights: fading ? [] : lit.lights,
          sceneAmbient: fading ? { x: 1, y: 1, z: 1 } : sceneAmbient,
          depthFunc: 'lequal',
          depthWrite: !fading,
          blend: blended,
          blendMode: 'alpha',
          alphaFunction: 'greater',
          alphaReference: blended ? 5 : 127,
          ...(fog ? { fog } : {}),
        }
      }
    }
  }
  for (const at of !field || field.enclosure === 0 ? OUTSIDE_ORDER : INSIDE_ORDER) {
    const onFarList = at === FAR
    const passCamera = onFarList ? farCamera : camera
    for (const listed of lists[at]!) {
      const first = draws.length
      if ('band' in listed) {
        const draw = listed.band.pieceDraw(listed.piece)
        if (draw) draws.push({ ...draw, projection: farProjection })
        continue
      }
      if ('ring' in listed) {
        const draw = ringPieceDraw(listed.ring, listed.piece)
        if (!draw) continue
        draws.push(
          onFarList
            ? { ...draw, depthFunc: 'always', depthWrite: false, projection: farProjection }
            : draw,
        )
        continue
      }
      const { object, picked, within } = listed
      if (object.pilot && picked.tier === 0)
        collectModel(
          object.pilot,
          passCamera,
          aspect,
          view,
          time,
          draws,
          queued,
          unsupported,
          unregistered,
          resolved,
        )
      // `GameobjSweepEffectList` links its lights at the first tier, each to the bucket's front.
      if (picked.tier === 0 && object.flares) linked.unshift(...[...object.flares].reverse())
      // `GameobjSubmitDrawRetail`: only the first tier arms the reflection. What's attached is drawn
      // in the same `RenderInstance`, under the same flags and the object's reflection.
      for (const model of [object.model, ...(object.attached ?? []).map(underOwn(object.model))])
        collectModel(
          picked.tier === 0 ? model : withoutEnvironment(model),
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
      // `DrainMeshAndAsteroids` (`0x51f956`) sets `ZFUNC` 4 for the near lists and leaves it, where
      // RP8's default is 2. No material sets 2, so what would have kept the default reads 4.
      if (!onFarList)
        for (let index = first; index < draws.length; index++)
          if (draws[index]!.depthFunc === 'less')
            draws[index] = { ...draws[index]!, depthFunc: 'lequal' }
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
    // `DrainMeshAndAsteroids` in a field: the main lists, then the fog overlay, then the field's own.
    if (at === NOMAD_OFFSET + MAIN && field && field.enclosure !== 0) {
      const overlay = fogOverlayDraw(field.state, view, viewport)
      if (overlay) draws.push(overlay)
    }
    // `CliAsteroidTickFields`: outside a field after the main list and the rings' clouds, inside one
    // after its own list.
    if (
      (at === MAIN && (!field || field.enclosure === 0)) ||
      (at === FIELD && field && field.enclosure !== 0)
    )
      for (const asteroid of asteroids) drawField(asteroid)
    // `DrainMeshAndAsteroids` outside a field: the main list, then every ring's clouds while the
    // camera is in it (`TexturePanelsDrawAll`, `DrawPanels`). In a field, no ring's clouds draw.
    if (at === MAIN && (!field || field.enclosure === 0))
      rings.forEach((ring, index) => {
        if (!(ringVisibility[index]! > 0)) return
        for (const clouds of ring.clouds ?? []) {
          const draw = clouds.draw(given, { cut, holds: (point) => ringImmersion(ring, point) })
          if (draw) draws.push(draw)
        }
      })
  }

  // Bucket `0x2e`'s walk, after the other effects: each light blinks, then queues its flare, and the
  // batch draws once they're all queued (`SpaceEffectsDrawFrame`, `ScreenQuadFlush`).
  const quads: ScreenQuad[] = []
  if (linked.length && viewport && !shine) unsupported.add('texture shine')
  const blinkStep = Math.min(Math.fround(step), Math.fround(0.1))
  for (const { light, world, blink } of linked) {
    blink?.tick(blinkStep)
    const brightness = blink?.brightness ?? 1
    if (brightness < 0 || !viewport || !shine) continue
    quads.push(
      ...flareQuads(light, world, brightness, {
        camera,
        view,
        aspect,
        ...viewport,
        ...(shine.frame ? { frame: shine.frame } : {}),
      }),
    )
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
    ...(quads.length && shine && { screenQuads: [{ texture: shine.texture, quads }] }),
    unsupported: [...unsupported],
    unregistered: [...unregistered],
  }
}
