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

/** `EFT_NONE` to `EFT_FLASHLIGHT`, the table `[EffectType]` overlays (`.data` `0x612a68`). */
export const RETAIL_EFFECT_TYPES: readonly Readonly<EffectType>[] = ROWS.map(
  ([priority, genericPriority, lodType, radius, existOffscreen, near, far]) => ({
    priority,
    genericPriority,
    lodType,
    radius,
    existOffscreen: existOffscreen === 1,
    pbubble: { near, far },
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

/** `draw`: seen. `run`: unseen, and `EXIST_OFFSCREEN`. `die`: unseen, and frozen in place to end. */
export interface EffectView {
  fate: 'draw' | 'run' | 'die'
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
