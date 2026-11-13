/** Which detail level a part draws: `rendcomp.dll`'s selector, and an archetype's INI over `Switch2`. */
import { Matrix4 } from '@treewyrm/freelancer/math'
import type { MeshSource } from '@treewyrm/freelancer/rigid'
import type { VMeshPart } from '@treewyrm/freelancer/vmesh'
import { viewMatrix, type Camera } from './camera.js'

/** One level-of-detail list an archetype writes: its own `LODranges`, or a `[LOD]` block's. */
export interface LodList {
  /** The part a `[LOD]` block is for, by name. Absent on the section's own list. */
  obj?: string
  /** As written, at most eight. */
  ranges: readonly number[]
  /** `MinSpecLOD`: the levels low detail skips. 1 when absent, but 0 under three ranges. */
  minSpecLod?: number
}

/** The `level_of_detail` option, 0 to 1. At 0.75, the default here, it changes nothing. */
export interface LodDetail {
  detail?: number
}

// `Freelancer-original.exe` `0x5c7410`, about tan 35°, which an INI value is multiplied by as it is
// written, and `0x5c7478`, past which the far clamp holds a range.
const RANGE_SCALE = 0.700208
const FAR_CUTOFF = 15000

/** `ApplyLevelOfDetail` (`0x5b4560`): low detail below 0.75, and the scale the far clamp tests. */
export const lodScale = (detail: number): { low: boolean; scale: number } => {
  const low = detail < 0.75
  const scale = low ? detail * (4 / 3) * 0.5 + 0.5 : (detail - 0.75) * 4 + 1

  return { low, scale: Math.fround(scale) }
}

/**
 * `ApplyArchLodRanges` (`0x401ed0`) for one part with `count` levels: each level's end, in the INI's
 * unit, from the first list with no `obj` or with its name, and the largest range it walked. The
 * levels low detail skips end at 0; the walk stops at a negative range. Nothing when no list matches.
 */
const walkRanges = (
  count: number,
  name: string,
  lists: readonly LodList[],
  detail: number,
): { ends: (number | undefined)[]; largest: number } | undefined => {
  if (count === 0) return undefined

  const folded = name.toLowerCase()
  const list = lists.find(({ obj }) => obj === undefined || obj.toLowerCase() === folded)
  if (!list) return undefined

  const { low, scale } = lodScale(detail)
  // Past what's written, the terminator: -1.
  const range = (at: number) => list.ranges[at] ?? -1
  const ends: (number | undefined)[] = Array.from({ length: count }, () => undefined)

  // The cap is the first list's, whichever matched.
  const head = lists[0]!
  const minSpec = head.minSpecLod ?? (head.ranges.length < 3 ? 0 : 1)
  const cap = low ? Math.min(minSpec, count) : 0
  let applied = 0

  for (; applied < cap; applied++) {
    if (range(applied + 1) < 0) break
    ends[applied] = 0
  }

  if (applied >= count) return { ends, largest: -1 }

  // At high detail a near list's far ranges are held at 15000, its level added.
  const farClamp = range(count) < FAR_CUTOFF && scale * range(count) > FAR_CUTOFF
  let largest = Math.max(-1, range(applied))

  for (let level = applied; level < count; level++) {
    let end = range(level + 1)
    if (!(end >= 0)) break
    if (farClamp && end * scale > FAR_CUTOFF) end = level + FAR_CUTOFF
    largest = Math.max(largest, Math.fround(end))
    ends[level] = Math.fround(RANGE_SCALE * end)
  }

  return { ends, largest }
}

const levelCount = (source: MeshSource): number =>
  source.type === 'vmeshpart' ? 1 : (source.ranges ?? [0, NaN]).length - 1

/**
 * The archetype's `LodPick` (`ComputeLodPickThis`, `0x4021b0`): the largest range any part's list
 * walked, past which the object draws nothing. -1 when none did. A single model's part is `Root`.
 */
export const lodRange = (
  parts: readonly { source: MeshSource; name: string }[],
  lists: readonly LodList[],
  { detail = 0.75 }: LodDetail = {},
): number => {
  let largest = -1

  for (const { source, name } of parts) {
    const walked = walkRanges(levelCount(source), name, lists, detail)
    if (walked) largest = Math.max(largest, walked.largest)
  }

  return largest
}

// A bare `VMeshPart` is one level (`0x6c33fe0`).
const BARE = [0, 1e6]

/**
 * Each level's end, in `Switch2`'s unit. The first list with no `obj` or with this part's name
 * overwrites the model's own entry by entry, as far as it reaches and no further (`0x401ed0`), and a
 * negative value ends it. With no `Switch2` the game's floats are uninitialised: `NaN`, which no metric
 * reaches. `lists` are in matching order, `[LOD]` blocks first.
 */
export const levelEnds = (
  source: MeshSource,
  name: string,
  lists: readonly LodList[] = [],
  { detail = 0.75 }: LodDetail = {},
): number[] => {
  const switches = source.type === 'vmeshpart' ? BARE : (source.ranges ?? [0, NaN])
  const ends = switches.slice(1)
  const walked = walkRanges(ends.length, name, lists, detail)

  return walked ? ends.map((end, at) => walked.ends[at] ?? end) : ends
}

/**
 * `LodSetPick` (`0x6c32040`): the first level whose end reaches the metric. Only ends are read, so a
 * level ending under the one before it is never chosen. Past the last, the part draws nothing.
 */
export const levelAt = (
  source: MeshSource,
  metric: number,
  ends: readonly number[],
): VMeshPart | undefined => {
  const level = ends.findIndex((end) => end >= metric)
  if (level < 0) return undefined
  return source.type === 'vmeshpart' ? source : source.levels[level]
}

export const largestAxis = ({ x, y, z }: Matrix4): number =>
  Math.max(Math.hypot(x.x, x.y, x.z), Math.hypot(y.x, y.y, y.z), Math.hypot(z.x, z.y, z.z)) || 1

/**
 * `FRenderManager::RenderInstance`: view depth of the part's centre, not its distance, times
 * tan(fovx½), over the largest axis of the matrix given to the draw. So it widens with the view. The
 * centre being the top level's bounding sphere is inferred (`IEngine +0x88`). Threshold is 1 in a room
 * (`room_control.cpp`); space's isn't read yet.
 */
export const levelMetric = (
  source: MeshSource,
  part: Matrix4,
  transform: Matrix4,
  camera: Camera,
): number => {
  const first = source.type === 'vmeshpart' ? source : source.levels[0]
  const centre = first?.reference.boundingSphere.center ?? { x: 0, y: 0, z: 0 }
  const { z } = Matrix4.transformPoint(centre, Matrix4.multiply(viewMatrix(camera), part))

  return (Math.abs(z) * Math.tan((camera.fovh * Math.PI) / 180)) / largestAxis(transform)
}
