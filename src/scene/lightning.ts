/**
 * A nebula's `[BackgroundLightning]`: the flashes of its fog's colour, which deep inside is the clear
 * colour. `FNebulaEffect::FillFogRgb` in `src/freelancer/Client/cli_nebula.cpp`.
 */
import type { Vector3 } from '@treewyrm/freelancer/math'

/** `[BackgroundLightning]`, each key over what `FNebulaEffect`'s constructor sets. */
export interface LightningSettings {
  /** `gap`: about how long between flashes, from 0.8 to 1.5 of it. */
  gap: number
  /** `duration`: how long a flash lasts. None at all at 0 or less. */
  duration: number
  /** `color` over 255: added to the fog's, by up to `intensity`. */
  color: Vector3
  intensity: number
}

/** Checked in `Freelancer-original.exe`, `0x504b06` to `0x504b42`: every nebula flashes unless told not to. */
export const RETAIL_LIGHTNING: Readonly<LightningSettings> = {
  gap: 10,
  duration: 0.5,
  color: { x: 0.25, y: 0.25, z: 0.25 },
  intensity: 1,
}

/** `rand()`'s range: whole numbers from 0 to 32767. */
export type Random = () => number

const RAND_SCALE = Math.fround(3.0517578125e-5)
const f = Math.fround

/**
 * One nebula's flash timer, which the host keeps for as long as the nebula exists. `collectSpaceFrame`
 * advances it by the scene's `step` on each frame the camera is deep in the nebula, as retail's draw
 * does, and nowhere else. Retail draws from the game's one `rand()`, so its flashes can't be matched,
 * only their kind.
 */
export class BackgroundLightning {
  readonly settings: LightningSettings
  readonly random: Random
  // `+0x258`: below 0 counts up to the next flash, above 0 through one.
  #timer: number

  constructor(
    settings: Partial<LightningSettings> = {},
    random: Random = () => Math.floor(Math.random() * 0x8000),
  ) {
    this.settings = { ...RETAIL_LIGHTNING, ...settings }
    this.random = random
    // `gap` starts the first wait at its full length; without it, `Load`'s -1.
    this.#timer = settings.gap === undefined ? -1 : -settings.gap
  }

  /** `FillFogRgb`: `base`, the fog's colour, or a flash over it, after `step` seconds more. */
  fogColor(base: Vector3, step: number): Vector3 {
    const { gap, duration, color, intensity } = this.settings
    if (duration <= 0) return base
    const previous = this.#timer
    const timer = step + previous
    this.#timer = f(timer)
    let flashing = false
    if (previous > 0) {
      flashing = true
      if (timer > duration) this.#timer = f((this.random() * RAND_SCALE * f(0.7) - 1.5) * f(gap))
    } else if (timer > 0) flashing = true
    if (!flashing) return base

    const first = f(this.random() * RAND_SCALE)
    const scale = this.random() * f(intensity) * first * RAND_SCALE
    // Kept below 1, as `ParseFogSection` keeps the fog's.
    const below = (value: number) => (value < 1 ? value : 1)
    return {
      x: below(f(scale * f(color.x) + base.x)),
      y: below(f(f(scale * f(color.y)) + base.y)),
      z: below(f(f(scale * f(color.z)) + base.z)),
    }
  }
}
