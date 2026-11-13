/**
 * Space dust: up to three effects held 60 ahead of the camera. The system's `[Dust]`, the dust of
 * the smallest zone around that point, and the zone's before it, fading. `SpaceDust`
 * (`src/freelancer/Client/space_dust.cpp`, `FUN_0054beb0`), and what `FParticleEffect` does with
 * them as the effect walk steps them (`particle_effect.cpp`). The host starts an effect by name.
 * The streaks are `FLDustAppearance`'s, in `#/alchemy`. Pure, no GL.
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import { viewMatrix, type Camera } from './camera.js'
import type { EffectView } from './effect-view.js'
import { immersion, type Zone } from './nebula.js'
import type { SpaceEffect } from './space.js'

const f = Math.fround

/** A zone with a `spacedust`, which sets its `0x200000` property. */
export interface DustZone {
  zone: Zone
  /** Its `edge_fraction`, 0 when absent. */
  edgeFraction?: number
  /** `spacedust`: an `[Effect]` nickname. Empty as written empty. */
  dust: string
  /** `spacedust_maxparticles`, 0 when absent, which takes 50. */
  maxParticles?: number
}

/** A started dust effect: what a `SpaceEffect` is but where it is. */
export type DustEffect = Omit<SpaceEffect, 'position' | 'watched'>

/** The options `SpaceDustUpdate` reads. */
export interface DustOptions {
  /** `space_dust_detail` from `PerfOptions.ini`, 1 when absent (`DAT_00614080`). */
  detail?: number
  /** Game option `0x19`, on when absent. Off, each frame drops every dust effect first. */
  background?: boolean
  /** Each effect type's `run_time`, by index: how long a killed one winds down. -1 when absent. */
  runTimes?: readonly (number | undefined)[]
}

/** `SpaceDustUpdate`'s numbers, which a mod can patch. */
export interface DustLimits {
  /** `DAT_00614084`: the dust's frame, along the camera's Z. */
  offset: number
  /** `DAT_005c8930`: zone dust runs only above this detail. */
  detailThreshold: number
  /** `DAT_005d3e94`: a zone dust's intensity for each of its particles. */
  intensityPerParticle: number
  /** `0x54c013`: a zone's particles when it writes none. */
  defaultZoneParticles: number
  /** `DAT_005c75f0`: a fading dust at or under this intensity is killed. */
  fadeCutoff: number
  /** `FUN_0054bde0`: the system dust's particles at full and at no detail. */
  systemParticles: { full: number; none: number }
  /** `DAT_005e08f8`: the system dust's intensity for each of those. */
  systemIntensityPerParticle: number
  /** `SpaceEffectsDrawFrame` (`0x4f7600`): the most one walk steps an effect by. */
  maxStep: number
}

export const RETAIL_DUST_LIMITS: Readonly<DustLimits> = {
  offset: -60,
  detailThreshold: f(0.75),
  intensityPerParticle: f(0.002),
  defaultZoneParticles: 50,
  fadeCutoff: 1e-5,
  systemParticles: { full: 80, none: 30 },
  systemIntensityPerParticle: 0.002,
  maxStep: f(0.1),
}

/** One `FParticleEffect` the dust holds, or held. */
interface Held {
  effect: DustEffect
  /** `LocalXform` as last placed: none until the first. */
  placement?: DustFrame
  /** `SetIntensity`'s, held to [0, 1]: its `sparam`. */
  intensity: number
  /** In its type's walk (`EffectTypeListLink`), which only placing or killing does. */
  linked: boolean
  /** `Flags08` bit 2: it's left the walk, or will at its next. */
  dead: boolean
  /** `+0x78`: under 0 it lasts; killed, 1 at most, and counted down as it's walked. */
  runTime: number
  /** The `ALCHEMY_LOD` blend its last view gave. */
  lod: number
  /** When it was linked: a type's walk is newest first. */
  serial: number
}

/** A dust effect in the frame's walk, and when it joined it. */
export interface DustEffectAt {
  effect: SpaceEffect
  serial: number
}

let linkedSoFar = 0

/** Where the dust is: its world, and its point. */
export interface DustFrame {
  world: Matrix4
  position: Vector3
}

/**
 * `GetSmallestZoneWithPropertiesAt(point, 0x200000)` (`0x633b620`): the zone with the least
 * `GetRadius` that holds the point, the first of equals. Retail asks its zone tree, whose order
 * isn't read; this takes the order given, so only equal radii can differ.
 */
export const smallestDustZone = (
  zones: readonly DustZone[],
  point: Vector3,
): DustZone | undefined => {
  let best: DustZone | undefined
  let least = 1e20

  for (const candidate of zones) {
    const { radius } = candidate.zone
    if (!(radius < least) || !candidate.zone.holds(point)) continue
    best = candidate
    least = radius
  }

  return best
}

/** Dead, and its instance released: out of the walk, its share of the pools given back. */
const end = (held: Held): void => {
  held.dead = true
  held.effect.instance.release()
}

export class SpaceDust {
  /** `[Dust] spacedust`, empty when the system has none. */
  readonly system: string
  /** Starts the `[Effect]` of a nickname: none when there's no such archetype. */
  readonly start: (name: string) => DustEffect | undefined
  readonly limits: Readonly<DustLimits>
  #system: Held | undefined
  /** `DAT_006797b8`'s particles at full and at no detail: 80 and 30 once a `[Dust]` is read. */
  #systemParticles: { full: number; none: number }
  /** `DAT_00679790`: the zone dust's name, compared as the string cache interns it. */
  #zoneName = ''
  #zone: Held | undefined
  #zoneParticles = 0
  #fading: Held | undefined
  #fadingParticles = 0
  /** Killed, and winding down where they were last placed. */
  #ending: Held[] = []

  /**
   * `FUN_0054bde0`, from `StarSysLoadIni`'s `[Dust]`: a system with no such section passes none, and
   * its particles stay 0.
   */
  constructor(
    system: string | undefined,
    start: (name: string) => DustEffect | undefined,
    limits: Partial<DustLimits> = {},
  ) {
    this.system = system ?? ''
    this.start = start
    this.limits = { ...RETAIL_DUST_LIMITS, ...limits }
    this.#systemParticles =
      system === undefined ? { full: 0, none: 0 } : { ...this.limits.systemParticles }
  }

  /** `ParticleEffect::Start`: nothing to hold when there's no archetype. */
  #create(name: string, runTimes: DustOptions['runTimes']): Held | undefined {
    const effect = this.start(name)
    if (!effect) return undefined
    return {
      effect,
      intensity: 0,
      linked: false,
      dead: false,
      runTime: runTimes?.[effect.type] ?? -1,
      lod: 1,
      serial: 0,
    }
  }

  /**
   * `FUN_0054bdc0` and `FParticleEffect::Kill` (`0x4f84d0`): its emitters stop, its run time is held
   * to 1, and it's linked if it wasn't, to end in the walk. One never placed has made nothing, and
   * goes at once.
   */
  #kill(held: Held | undefined): void {
    if (!held || held.dead) return
    if (!held.placement) return end(held)
    held.effect.instance.stop()
    if (held.runTime < 0 || held.runTime > 1) held.runTime = 1
    this.#link(held)
    this.#ending.push(held)
  }

  /** `EffectTypeListLink` (`0x4f7af0`): pushed to its type's front, unless linked or dead. */
  #link(held: Held): void {
    if (held.linked || held.dead) return
    held.linked = true
    held.serial = ++linkedSoFar
  }

  /** `PlaceDustEffect`: at the dust's frame, at an intensity held to [0, 1], and linked. */
  #place(held: Held, placement: DustFrame, intensity: number): void {
    held.placement = placement
    held.intensity = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity
    this.#link(held)
  }

  #dropZones(): void {
    this.#kill(this.#fading)
    this.#fading = undefined
    this.#kill(this.#zone)
    this.#zone = undefined
    this.#zoneName = ''
    this.#zoneParticles = 0
    this.#fadingParticles = 0
  }

  /** Every effect it holds, released at once: for a host done with this dust. */
  release(): void {
    for (const held of [this.#system, this.#zone, this.#fading, ...this.#ending])
      if (held && !held.dead) end(held)

    this.#system = this.#zone = this.#fading = undefined
    this.#ending = []
  }

  /**
   * The dust's frame: the camera's, `offset` along its Z (`FUN_0054c320`). That axis is the
   * orientation's third column, `(x.z, y.z, z.z)`.
   */
  frame({ position, orientation }: Camera): DustFrame {
    const along = this.limits.offset
    const point = {
      x: f(f(orientation.x.z * along) + position.x),
      y: f(f(orientation.y.z * along) + position.y),
      z: f(f(orientation.z.z * along) + position.z),
    }

    return { world: Matrix4.fromRotationTranslation(orientation, point), position: point }
  }

  /**
   * `SpaceDustUpdate` (`FUN_0054beb0`) from `StarSysUpdate`, then each linked effect stepped as the
   * walk does, by at most `maxStep`. Zone dust runs only above the detail threshold: the zone is the
   * smallest of `zones` that holds the dust's point, its intensity its particles over 500 times
   * its immersion there. A new name hands the old effect to the fading slot, which runs at the
   * rest of that immersion until it's under `fadeCutoff`. The system's dust starts on the first
   * update and is placed from the next, at 80 particles over 500, or toward 30 as detail falls.
   */
  update(
    camera: Camera,
    step: number,
    zones: readonly DustZone[],
    { detail = 1, background = true, runTimes }: DustOptions = {},
  ): void {
    const limits = this.limits

    // No early return: what's dropped is started again below, each frame (`0x54becb`).
    if (!background && (this.#system || this.#zone || this.#fading)) {
      this.#dropZones()
      this.#kill(this.#system)
      this.#system = undefined
    }

    const placement = this.frame(camera)
    const point = placement.position

    if (detail > limits.detailThreshold) {
      const found = smallestDustZone(zones, point)
      const name = found?.dust ?? ''
      const particles = found ? found.maxParticles || limits.defaultZoneParticles : 0
      const blend = found ? f(immersion(found.zone, found.edgeFraction ?? 0, point)) : 1

      // `StringAlloc` interns without case, so the pointers compare that way.
      if (name.toLowerCase() !== this.#zoneName.toLowerCase()) {
        this.#zoneName = name
        this.#kill(this.#fading)
        this.#fading = this.#zone
        this.#fadingParticles = this.#zoneParticles
        this.#zone = name ? this.#create(name, runTimes) : undefined
      }

      this.#zoneParticles = particles

      if (this.#fading) {
        const fade = this.#fadingParticles * limits.intensityPerParticle * (1 - blend)

        if (!(fade <= limits.fadeCutoff)) this.#place(this.#fading, placement, f(fade))
        else {
          this.#kill(this.#fading)
          this.#fading = undefined
        }
      }

      if (this.#zone) {
        const level = this.#zoneParticles * limits.intensityPerParticle * blend

        this.#place(this.#zone, placement, f(level))
      }
    } else this.#dropZones()

    if (this.#system) {
      const { full, none } = this.#systemParticles
      const level = ((1 - detail) * none + full * detail) * limits.systemIntensityPerParticle

      this.#place(this.#system, placement, f(level))
    } else if (this.system) this.#system = this.#create(this.system, runTimes)

    this.#run(camera, step)
  }

  /** Every effect held or ending, linked and alive. */
  #walked(): Held[] {
    const held = [this.#fading, this.#zone, this.#system, ...this.#ending]

    return held.filter((each): each is Held => !!each && each.linked && !each.dead)
  }

  /**
   * `FParticleEffect::TickDraw` (`0x4f8a20`): a run time above 0 counts down, and at or under 0
   * the effect ends unstepped. Otherwise it steps where it was placed, and ends once its effect
   * has (`IsAlive`).
   */
  #run(camera: Camera, step: number): void {
    const dt = step > this.limits.maxStep ? this.limits.maxStep : step
    const view = viewMatrix(camera)

    for (const held of this.#walked()) {
      if (held.runTime > 0) {
        held.runTime = f(held.runTime - dt)

        if (held.runTime <= 0) {
          end(held)
          continue
        }
      }

      held.effect.instance.advance(dt, {
        sparam: held.intensity,
        lod: held.lod,
        ...(held.placement && { placement: held.placement.world }),
        view,
      })
      if (held.effect.instance.finished) end(held)
    }

    this.#ending = this.#ending.filter(({ dead }) => !dead)
  }

  /** The effects for the frame's walk, newest linked first, each where it was last placed. */
  effects(): DustEffectAt[] {
    return this.#walked()
      .sort((a, b) => b.serial - a.serial)
      .map((held) => ({
        effect: {
          ...held.effect,
          ...(held.placement && { position: held.placement.position }),
        },
        serial: held.serial,
      }))
  }

  /**
   * What the frame's view test made of `effects()`, in its order. Unseen and not
   * `EXIST_OFFSCREEN`, an effect is frozen and dead, and isn't placed again (`0x4f789f`).
   */
  viewed(views: readonly (EffectView | undefined)[]): void {
    this.#walked()
      .sort((a, b) => b.serial - a.serial)
      .forEach((held, at) => {
        const view = views[at]
        if (!view) return
        held.lod = view.lod
        if (view.fate === 'die') end(held)
      })
    this.#ending = this.#ending.filter(({ dead }) => !dead)
  }
}
