/** Which level a character's part draws: `FCharacterObject::PickLods`, over `[DetailSwitchTable]`. Pure. */
import type { Level } from '@treewyrm/freelancer/deformable'

/** A `bodyparts.ini` group's table: `switch = percent, distance` rows, the percent descending. */
export interface SwitchTable {
  rows: readonly (readonly [percent: number, distance: number])[]
  /** Degrees, the whole angle. `RETAIL_SWITCH_FOVX` when the section writes none. */
  fovx?: number
}

/** What a `[DetailSwitchTable]` with no `fovx` reads. A mod patching it passes its own as `fovx`. */
export const RETAIL_SWITCH_FOVX = 40

/** `DetailSwitchTable::get_switch_distance`: linear between rows, clamped at both ends. */
export const switchDistance = ({ rows }: SwitchTable, percent: number): number => {
  const first = rows[0]!
  const last = rows.at(-1)!

  if (percent >= first[0]) return first[1]
  if (percent <= last[0]) return last[1]

  for (let at = 0; at + 1 < rows.length; at++) {
    const [a, b] = [rows[at]!, rows[at + 1]!]

    if (a[0] >= percent && b[0] <= percent)
      return ((percent - a[0]) * (b[1] - a[1])) / (b[0] - a[0]) + a[1]
  }

  return 1
}

const tanDegrees = (degrees: number): number => Math.tan((degrees * Math.PI) / 180)

/** `adjust_distance`: a narrow lens counts as closer, against the table's own. `fovh` is half the angle. */
export const adjustedDistance = (
  { fovx = RETAIL_SWITCH_FOVX }: SwitchTable,
  distance: number,
  fovh: number,
): number => (tanDegrees(fovh) / tanDegrees(fovx / 2)) * distance

/** The first level whose distance reaches this one, or none past the table's far cutoff. */
export const costumeLevel = (
  levels: readonly Level[],
  table: SwitchTable,
  distance: number,
  fovh: number,
): number | undefined => {
  const adjusted = adjustedDistance(table, distance, fovh)

  const level = levels.findIndex(({ fraction }, at) => {
    // The last level's own distance is written over with the table's at 0 (`0x443de1`).
    const reach = switchDistance(table, at === levels.length - 1 ? 0 : fraction * 100)

    return !(reach < adjusted)
  })

  return level < 0 ? undefined : level
}
