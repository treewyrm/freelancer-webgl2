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
}

// `Freelancer.exe` `0x5c7410`, which an INI value is multiplied by as it is written.
const TAN_35 = Math.tan((35 * Math.PI) / 180)

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
): number[] => {
  const switches = source.type === 'vmeshpart' ? BARE : (source.ranges ?? [0, NaN])
  const ends = switches.slice(1)
  const folded = name.toLowerCase()
  const list = lists.find(({ obj }) => obj === undefined || obj.toLowerCase() === folded)
  if (!list) return ends
  for (let at = 0; at < ends.length; at++) {
    const end = list.ranges[at + 1]
    if (end === undefined || end < 0) break
    ends[at] = end * TAN_35
  }
  return ends
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
