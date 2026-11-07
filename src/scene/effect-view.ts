/**
 * Whether the game draws an effect, keeps running it unseen, or ends it: `EffectTypeBucketWalk` and
 * `FParticleEffect::UpdateVisibility` (`0x4f86c0`) in `src/freelancer/Client/`. Pure, no GL.
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { Camera } from './camera.js'
import { findNebula, type NebulaState, type SpaceField, type SpaceNebula } from './nebula.js'

/** An `[EffectType]` row, each key over its built-in one. */
export interface EffectType {
  priority: number
  /** `generic_priority`, for an effect drawn through its generic appearance. */
  genericPriority: number
  /** `lod_type`: which `[EffectLOD]` row, 1 to 6. 0 is none. */
  lodType: number
  radius: number
  /** `visibility = EXIST_OFFSCREEN`: unseen, it runs on instead of ending. */
  existOffscreen: boolean
  /** `pbubble`: past near, how far it shows narrows from far by `generic_effect_perf`. */
  pbubble: { near: number; far: number }
  /**
   * `run_time`: seconds it runs before it ends, counted down as it's walked (`0x4f8a57`). Under 0,
   * until its effect ends; killed, at most 1 more (`0x4f8680`).
   */
  runTime: number
}

// Nickname order, which `SpaceEffect.type` indexes: priority, generic priority, lod type, radius,
// EXIST_OFFSCREEN, pbubble near and far.
// prettier-ignore
const ROWS: readonly (readonly [number, number, number, number, 0 | 1, number, number])[] = [
  [0, 0, 0, 10, 0, 100, 500], [1, 0.5, 3, 10, 0, 100, 500], [1, 0.5, 4, 50, 1, 100, 500],
  [1, 0.5, 5, 100, 1, 100, 500], [0, 0, 3, 10, 0, 100, 500], [1, 0.5, 4, 50, 0, 100, 500],
  [0, 0, 6, 7.5, 0, 100, 500], [0, 0, 6, 7.5, 0, 100, 500], [0, 0, 6, 5, 0, 100, 500],
  [1, 0.5, 6, 7.5, 0, 100, 500], [0.5, 0.5, 2, 100, 1, 100, 500], [1, 0.5, 2, 15, 1, 100, 500],
  [1, 0.5, 5, 50, 1, 100, 500], [0.5, 0.5, 6, 7.5, 0, 100, 500], [1, 0.5, 4, 20, 0, 100, 500],
  [1, 0.5, 6, 7.5, 0, 100, 500], [1, 0.5, 4, 20, 0, 100, 500], [0.5, 0.5, 6, 7.5, 0, 100, 500],
  [1, 0.5, 5, 100, 0, 100, 500], [0.5, 0.5, 3, 5, 0, 100, 500], [0.5, 0.5, 6, 7.5, 0, 100, 500],
  [0.5, 0.5, 4, 20, 1, 100, 500], [0.5, 0.5, 5, 20, 1, 100, 500], [0.5, 0.5, 3, 5, 1, 100, 500],
  [0, 0, 3, 5, 1, 100, 500], [1, 0.5, 1, 100, 1, 100, 500], [1, 0.5, 1, 100, 1, 500, 2000],
  [0.5, 0.5, 6, 7.5, 1, 100, 500], [0.5, 0.5, 6, 25, 1, 250, 1000], [0, 0, 6, 7.5, 1, 100, 500],
  [1, 0.5, 3, 5, 0, 100, 500], [1, 0.5, 4, 100, 0, 500, 1500], [1, 0.5, 5, 100, 1, 100, 500],
  [1, 0.5, 5, 500, 1, 1000, 5000], [1, 0.5, 5, 500, 1, 1000, 5000], [0.5, 0.5, 0, 500, 1, 100, 500],
  [1, 1, 0, 500, 1, 100, 500], [1, 0.5, 0, 0, 1, 100, 500], [1, 0.5, 0, 0, 1, 1000, 2500],
  [0.5, 0.5, 0, 50, 1, 100, 500], [1, 0.5, 0, 50, 1, 100, 500], [0.5, 0.5, 4, 50, 0, 100, 500],
  [0.5, 0.5, 4, 50, 1, 100, 500], [0, 0, 5, -1, 0, 100, 500], [1, 0.5, 2, 15, 1, 100, 500],
  [1, 1, 0, -1, 1, 100, 500], [1, 1, 0, -1, 1, 100, 500],
]

// `run_time` by row: 15, or -1 where it lasts (`.data` `0x612a80`, `+0x18` of each row).
const NO_RUN_TIME = new Set([
  10, 11, 12, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 42,
  44, 45, 46,
])

/** Each row's nickname, which an `[Effect]`'s `effect_type` and an `[EffectType]` name. */
export const EFFECT_TYPE_NAMES: readonly string[] = [
  'EFT_NONE',
  'EFT_EXPLOSION_SMALL',
  'EFT_EXPLOSION_MEDIUM',
  'EFT_EXPLOSION_LARGE',
  'EFT_EXPLOSION_DEBRIS',
  'EFT_EXPLOSION_SHIP',
  'EFT_EXPLOSION_MISSILE',
  'EFT_EXPLOSION_MINE',
  'EFT_MUZZLE_FLASH',
  'EFT_MUZZLE_LARGE_FLASH',
  'EFT_MISSILE_DRIVE',
  'EFT_WEAPON_PROJ',
  'EFT_WEAPON_LARGE_PROJ',
  'EFT_WEAPON_IMPACT',
  'EFT_WEAPON_LARGE_IMPACT',
  'EFT_WEAPON_COUNTER_MEASURE',
  'EFT_WEAPON_MINE',
  'EFT_DAMAGE_HULL',
  'EFT_DAMAGE_LARGE_SHIELD',
  'EFT_DAMAGE_SHIELD',
  'EFT_DAMAGE_CRUISE',
  'EFT_DAMAGE_SMOKE',
  'EFT_DAMAGE_LARGE_SMOKE',
  'EFT_DEBRIS_TRAIL',
  'EFT_ENGINE_CONTRAIL',
  'EFT_ENGINE_TRAIL',
  'EFT_ENGINE_LARGE_TRAIL',
  'EFT_ENGINE_FIRE',
  'EFT_ENGINE_LARGE_FIRE',
  'EFT_ENGINE_THRUSTER',
  'EFT_EQUIP_CLOAK',
  'EFT_EQUIP_LARGE_CLOAK',
  'EFT_EQUIP_ATTACHED',
  'EFT_EQUIP_ATTACHED_LARGE',
  'EFT_EQUIP_ATTACHED_INSANELY_LARGE',
  'EFT_MISC_DUST',
  'EFT_MOTION_DUST',
  'EFT_JUMP_EFFECTS',
  'EFT_JUMP_GATE_EFFECTS',
  'EFT_LANE_ACTIVE',
  'EFT_LANE_TUBE',
  'EFT_LANE_SHIP',
  'EFT_LANE_SHIP_TRAVEL',
  'EFT_CUSTOM_EFFECTS',
  'EFT_CODE_PROJ_EFFECT',
  'EFT_TRACTORBEAM',
  'EFT_FLASHLIGHT',
]

/**
 * An `effect_type` or `[EffectType]` nickname as `SpaceEffect.type` takes it: case and all, as
 * `EffectTypeIndexFromName` (`0x4fd500`) compares. `undefined` for a name not in the table.
 */
export const effectTypeIndex = (name: string): number | undefined => {
  const at = EFFECT_TYPE_NAMES.indexOf(name)
  return at < 0 ? undefined : at
}

const LOD_TYPE_NAMES = ['trail', 'weapon', 'small', 'medium', 'large', 'small_distant']

/**
 * An `[EffectType]`'s `lod_type`, `EFT_LOD_TRAIL` to `EFT_LOD_SMALL_DISTANT`, as 1 to 6: any case
 * (`LoadEffectTypeSection`). `undefined` for any other, which leaves the row's as it was.
 */
export const effectLodType = (name: string): number | undefined => {
  const at = LOD_TYPE_NAMES.findIndex((lod) => `eft_lod_${lod}` === name.toLowerCase())
  return at < 0 ? undefined : at + 1
}

/**
 * An `[EffectLOD]`'s `type`, `lod_type_trail` to `lod_type_small_distant`, as the row of
 * `effectLods` it fills, 1 to 6: any case (`LoadEffectLodSection`, `0x42dae0`).
 */
export const effectLodRow = (name: string): number | undefined => {
  const at = LOD_TYPE_NAMES.findIndex((lod) => `lod_type_${lod}` === name.toLowerCase())
  return at < 0 ? undefined : at + 1
}

/** `EFT_NONE` to `EFT_FLASHLIGHT`, the table `[EffectType]` overlays (`.data` `0x612a68`). */
export const RETAIL_EFFECT_TYPES: readonly Readonly<EffectType>[] = ROWS.map(
  ([priority, genericPriority, lodType, radius, existOffscreen, near, far], index) => ({
    priority,
    genericPriority,
    lodType,
    radius,
    existOffscreen: existOffscreen === 1,
    pbubble: { near, far },
    runTime: NO_RUN_TIME.has(index) ? -1 : 15,
  }),
)

/** An `[EffectLOD]` row: how large on screen, in pixels, it fades in over, and the least it shows at. */
export interface EffectLodSizes {
  maxLodScreenSize: number
  minLodScreenSize: number
  minScreenSize: number
}

/** What the retail effect is drawn under, besides the camera. */
export interface EffectViewOptions {
  /** The `generic_effect_perf` option, 0 to 1. 1 when absent: every priority shows, to `pbubble`'s far. */
  effectDetail?: number
  /** Over `RETAIL_EFFECT_TYPES`, by index. */
  effectTypes?: readonly (Partial<EffectType> | undefined)[]
  /** `[EffectLOD]` rows by `lod_type`, 1 to 6. None when absent, as the static initialiser's -1s. */
  effectLods?: readonly (EffectLodSizes | undefined)[]
  /** The viewport's width in pixels, which the LOD's screen size reads. No LOD when absent. */
  viewportWidth?: number
}

/** A placed effect, as the view test asks of it. */
export interface PlacedEffect {
  type: number
  /** Where it is: its world transform's translation. */
  position: Vector3
  /** Drawn through its `[Effect]`'s generic appearance, which has its own priority. */
  generic?: boolean
  /** The ship or solar it's on. */
  watched?: {
    position: Vector3
    /** Its cloak, 0 to 1. At 1 the effect hides. */
    cloak?: number
    /** The nebula it was last in, tried first. */
    nebula?: SpaceNebula
  }
}

/**
 * `draw`: seen. `run`: unseen, and `EXIST_OFFSCREEN`. `die`: unseen, and frozen in place to end.
 * `hold`: not walked this frame, so neither drawn nor stepped, as in a gate tunnel.
 */
export interface EffectView {
  fate: 'draw' | 'run' | 'die' | 'hold'
  /** The `ALCHEMY_LOD` blend, 0 to 1, for its next step's `lod`. */
  lod: number
}

// `EffectLodRowBlend` (`0x42da00`): undefined when it's too small to show.
const lodBlend = (row: EffectLodSizes, radius: number, distance: number, xScale: number) => {
  if (distance < 1e-5) return 1
  const size = (radius / distance) * xScale
  if (!(size > row.minScreenSize)) return undefined
  const blend = (size - row.minLodScreenSize) / (row.maxLodScreenSize - row.minLodScreenSize)
  if (blend > 1) return 1
  return Math.fround(blend < 0 ? 0 : blend)
}

/** The camera's place in the frame: its view, its nebula, and the system's nebulae. */
export interface EffectViewFrame {
  camera: Camera
  aspect: number
  view: Matrix4
  field?: SpaceField
  nebulae: readonly NebulaState[]
}

/**
 * `UpdateVisibility` and what `EffectTypeBucketWalk` does with it. The game keeps last frame's answer
 * where it doesn't test, but clears it once an effect draws, so that answer is taken as unseen.
 */
export const viewEffect = (
  { type, position, generic = false, watched }: PlacedEffect,
  { camera, aspect, view, field, nebulae }: EffectViewFrame,
  { effectDetail = 1, effectTypes = [], effectLods = [], viewportWidth }: EffectViewOptions = {},
): EffectView => {
  const info: EffectType = { ...RETAIL_EFFECT_TYPES[type]!, ...effectTypes[type] }
  const unseen: EffectView = { fate: info.existOffscreen ? 'run' : 'die', lod: 1 }
  const perf = Math.fround(1 - effectDetail)

  if (watched) {
    if ((watched.cloak ?? 0) >= 1) return unseen
    if (field) {
      const within = findNebula(nebulae, watched.position, watched.nebula)
      if (!within) {
        if (field.enclosure === 2) return unseen
      } else {
        if (within.state !== field.state) return unseen
        // `G_FieldRadiusSq`: the fog's end in the edge or core, and 0 from outside.
        const radius = field.enclosure === 0 ? 0 : field.state.end
        const dx = Math.fround(position.x - camera.position.x)
        const dy = Math.fround(position.y - camera.position.y)
        const dz = Math.fround(position.z - camera.position.z)
        if (dz * dz + dy * dy + dx * dx > Math.fround(radius * radius)) return unseen
      }
    }
  }

  if (!((generic ? info.genericPriority : info.priority) >= perf)) return unseen
  const { radius } = info
  const at = Matrix4.transformPoint(position, view)
  const depth = Math.fround(-at.z)
  if (!(camera.near < Math.fround(depth + radius))) return unseen
  const { near, far } = info.pbubble
  if (!((far - near) * (1 - perf) + near > depth - radius)) return unseen

  let lod = 1
  const row = info.lodType > 0 && info.lodType < 7 ? effectLods[info.lodType] : undefined
  if (row && viewportWidth !== undefined) {
    // `XScale`, half the viewport over tan(fovx½).
    const xScale = Math.fround(viewportWidth / 2 / Math.tan((camera.fovh * Math.PI) / 180))
    const blend = lodBlend(row, radius, depth, xScale)
    if (blend === undefined) return { ...unseen, lod: 0 }
    lod = blend
  }

  // The side planes, as `ClassifySphere` has them.
  const tanX = Math.tan((camera.fovh * Math.PI) / 180)
  const tanY = tanX / aspect
  const sideX = (Math.abs(at.x) + tanX * at.z) / Math.hypot(1, tanX)
  const sideY = (Math.abs(at.y) + tanY * at.z) / Math.hypot(1, tanY)
  const seen = sideX <= radius && sideY <= radius
  return seen ? { fate: 'draw', lod } : { ...unseen, lod }
}
