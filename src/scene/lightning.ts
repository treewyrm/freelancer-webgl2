/**
 * A nebula's lightning: `[BackgroundLightning]` flashes its fog's colour, which deep inside is the clear
 * colour, and `[DynamicLightning]` flashes a light at the camera. `FNebulaEffect::FillFogRgb` and
 * `NebulaAmbientTick` in `src/freelancer/Client/cli_nebula.cpp`.
 */
import type { Vector3 } from '@treewyrm/freelancer/math'
import type { SpaceLight } from './light.js'
import { clampByte } from './retail.js'

/** `[BackgroundLightning]`, each key over what `FNebulaEffect`'s constructor sets. */
export interface BackgroundLightningSettings {
  /** `gap`: about how long between flashes, from 0.8 to 1.5 of it. */
  gap: number
  /** `duration`: how long a flash lasts. None at all at 0 or less. */
  duration: number
  /** `color` over 255: added to the fog's, by up to `intensity`. */
  color: Vector3
  intensity: number
}

/** `[DynamicLightning]`, each key over what `FNebulaEffect`'s constructor sets. */
export interface DynamicLightningSettings {
  /** `gap`: about how long between flashes, from 0.8 to 1.5 of it. */
  gap: number
  /** `duration`: how long a flash lasts. No light at all at 0 or less. */
  duration: number
  /** `color` over 255, by up to the intensity. */
  color: Vector3
  /** `ambient_intensity`. */
  ambientIntensity: number
  /** `intensity_increase`: added while the background flashes too. */
  intensityIncrease: number
}

/** Checked in `Freelancer-original.exe`, `0x504b06` to `0x504b42`: every nebula flashes unless told not to. */
export const RETAIL_BACKGROUND_LIGHTNING: Readonly<BackgroundLightningSettings> = {
  gap: 10,
  duration: 0.5,
  color: { x: 0.25, y: 0.25, z: 0.25 },
  intensity: 1,
}

/** Checked in `Freelancer-original.exe`, `0x504b4e` to `0x504b8a`. */
export const RETAIL_DYNAMIC_LIGHTNING: Readonly<DynamicLightningSettings> = {
  gap: 3,
  duration: 0.5,
  color: { x: 1, y: 1, z: 1 },
  ambientIntensity: 0.25,
  intensityIncrease: 0.75,
}

/** What retail's light (`Load`, `0x50604f` on) is besides its colour and direction. */
const DYNAMIC_RANGE = 500000

interface LightState {
  direction: Vector3
  /** 0 to 255. */
  color: Vector3
  on: boolean
}

/** `rand()`'s range: whole numbers from 0 to 32767. */
export type Random = () => number

const RAND_SCALE = Math.fround(3.0517578125e-5)
const f = Math.fround

// Kept below 1, as `ParseFogSection` keeps the fog's.
const below = (value: number) => (value < 1 ? value : 1)
const byte = clampByte

/**
 * One nebula's lightning timers, which the host keeps for as long as the nebula exists.
 * `collectSpaceFrame` advances them as retail does: the light on every frame by the scene's `step`,
 * and the background only on a frame the camera is deep in the nebula. Retail draws from the game's
 * one `rand()`, so its flashes can't be matched, only their kind.
 */
export class NebulaLightning {
  readonly background: BackgroundLightningSettings
  readonly dynamic: DynamicLightningSettings
  readonly random: Random
  // `+0x1c`, `Update`'s step, which `FillFogRgb` reads too.
  #step = 0
  // `+0x258`: below 0 counts up to the next flash, above 0 through one.
  #backgroundTimer: number
  // `+0x26c`: the background flashed on its last call.
  #flashing = false
  // `+0x27c`, and the light, which exists only with a positive duration.
  #dynamicTimer = -1
  #light: LightState | undefined
  #position: Vector3 = { x: 0, y: 0, z: 0 }

  constructor(
    settings: {
      background?: Partial<BackgroundLightningSettings>
      dynamic?: Partial<DynamicLightningSettings>
    } = {},
    random: Random = () => Math.floor(Math.random() * 0x8000),
  ) {
    this.background = { ...RETAIL_BACKGROUND_LIGHTNING, ...settings.background }
    this.dynamic = { ...RETAIL_DYNAMIC_LIGHTNING, ...settings.dynamic }
    this.random = random

    // `gap` starts the first wait at its full length; without it, `Load`'s -1.
    const gap = settings.background?.gap

    this.#backgroundTimer = gap === undefined ? -1 : -gap

    // Down -Z from the constructor's identity, and off.
    if (this.dynamic.duration > 0)
      this.#light = {
        direction: { x: 0, y: 0, z: -1 },
        color: { x: 255, y: 255, z: 255 },
        on: false,
      }
  }

  /** A flash on the next step rather than after its wait, for an editor: retail has no such call. */
  fire(kind: 'background' | 'dynamic'): void {
    if (kind === 'background') this.#backgroundTimer = 0
    else this.#dynamicTimer = 0
  }

  /** `FNebulaEffect::Update`'s part, each frame: `depth` is its `+0x294`, where `eye` is. */
  update(step: number, depth: number, eye: Vector3): void {
    this.#step = step

    const light = this.#light
    if (!light) return
    // Out of it, off. Part way in, as it was.
    if (!(depth > 0)) light.on = false
    if (!(depth >= 1)) return
    this.#position = eye
    this.#tick(light)
  }

  // `NebulaAmbientTick` (`0x5097c0`).
  #tick(light: LightState): void {
    const { gap, duration, color, ambientIntensity, intensityIncrease } = this.dynamic
    const previous = this.#dynamicTimer
    const timer = this.#step + previous

    this.#dynamicTimer = f(timer)

    if (!(previous > 0)) {
      if (!(timer > 0)) return
    } else if (timer > duration) {
      // The next flash's wait, and its direction: the third number lands in x.
      this.#dynamicTimer = f((this.random() * RAND_SCALE * f(0.7) - 1.5) * f(gap))

      const first = this.random() * RAND_SCALE
      const second = this.random() * RAND_SCALE
      const third = this.random() * RAND_SCALE
      const z = first + first - 1
      const y = second + second - 1
      const x = third + third - 1
      const inverse = f(1 / Math.sqrt(z * z + y * y + x * x))

      light.direction = { x: f(x * inverse), y: f(y * inverse), z: f(f(z) * inverse) }
      light.on = false
      return
    }

    const intensity = this.#flashing
      ? f(f(ambientIntensity) + f(intensityIncrease))
      : f(ambientIntensity)
    const first = f(this.random() * RAND_SCALE)
    const flicker = this.random() * first * intensity * RAND_SCALE
    const red = below(f(flicker * f(color.x)))
    const green = below(f(flicker * f(color.y)))
    const blue = below(flicker * f(color.z))

    light.color = {
      x: byte(f(red * 255)),
      y: byte(f(green * 255)),
      z: byte(blue * 255),
    }
    light.on = true
  }

  /** Its light while it flashes: directional, at the camera, after the system's own. */
  get light(): SpaceLight | undefined {
    const light = this.#light
    if (!light?.on) return undefined
    return {
      type: 'directional',
      position: this.#position,
      direction: light.direction,
      color: light.color,
      range: DYNAMIC_RANGE,
    }
  }

  /** `FillFogRgb`: `base`, the fog's colour, or a flash over it, `update`'s step later. */
  fogColor(base: Vector3): Vector3 {
    const { gap, duration, color, intensity } = this.background
    if (duration <= 0) return base

    const previous = this.#backgroundTimer
    const timer = this.#step + previous

    this.#backgroundTimer = f(timer)
    this.#flashing = false

    if (previous > 0) {
      this.#flashing = true

      if (timer > duration)
        this.#backgroundTimer = f((this.random() * RAND_SCALE * f(0.7) - 1.5) * f(gap))
    } else if (timer > 0) this.#flashing = true

    if (!this.#flashing) return base

    const first = f(this.random() * RAND_SCALE)
    const scale = this.random() * f(intensity) * first * RAND_SCALE

    return {
      x: below(f(scale * f(color.x) + base.x)),
      y: below(f(f(scale * f(color.y)) + base.y)),
      z: below(f(f(scale * f(color.z)) + base.z)),
    }
  }
}
