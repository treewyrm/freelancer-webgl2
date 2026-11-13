/**
 * The effects a host places on things, kept by key and run as the game walks them:
 * `EffectTypeBucketWalk` and `FParticleEffect::TickDraw` (`0x4f8a20`), `Start` and `Kill`, in
 * `src/freelancer/Client/particle_effect.cpp`. Each frame the host says where every effect is; the
 * frame says what it saw; then each steps as the game would have. Pure, no GL.
 */
import type { Matrix4 } from '@treewyrm/freelancer/math'
import { viewMatrix } from './camera.js'
import { RETAIL_EFFECT_TYPES, type EffectViewOptions, type PlacedEffect } from './effect-view.js'
import type { DynamicEffect } from './dynamic.js'
import { RETAIL_SPACE_LIMITS, type SpaceEffect, type SpaceFrame, type SpaceScene } from './space.js'

const f = Math.fround

/** One effect where it is this frame. */
export interface EffectPlacement {
  /** Names its instance across frames: the first frame a key is placed starts it. */
  key: unknown
  /** Starts its `[Effect]` afresh: the instance, its textures and its type. */
  start: () => DynamicEffect
  /** Its world transform, which it steps at and is tested by. */
  world: Matrix4
  /** `SetIntensity`'s value, its `sparam`. 0 when absent. */
  sparam?: number
  watched?: PlacedEffect['watched']
  generic?: boolean
  /**
   * Its owner let go (`FParticleEffect::Kill`, `0x4f84d0`): from the first frame that says so its
   * emitters stop and it has at most a second left. Where it goes then is still the host's.
   */
  released?: boolean
}

interface Held {
  effect: SpaceEffect
  world: Matrix4
  sparam: number
  /** The `ALCHEMY_LOD` blend its last view gave. */
  lod: number
  /** `+0x78`, from its type at `Start` (`0x4f830f`): above 0, counted down as it's walked. */
  runTime: number
  /** When it started: a type's walk is newest first (`EffectTypeListLink`). */
  serial: number
  released: boolean
  /** Destroyed unseen, run out or played out: the key starts nothing while it's still placed. */
  ended: boolean
}

/** Ended: held so its key starts nothing, its instance released. */
const end = (held: Held): void => {
  held.ended = true
  held.effect.instance.release()
}

export class PlacedEffects {
  #held = new Map<unknown, Held>()
  readonly #of = new WeakMap<SpaceEffect, Held>()
  #serial = 0

  /**
   * This frame's effects for `SpaceScene.effects`, newest first. A key not placed again is dropped,
   * and one that has ended stays out for as long as it's placed: the game destroys an effect it no
   * longer sees, and nothing starts it again (`0x4f789f`).
   */
  place(
    placements: readonly EffectPlacement[],
    { effectTypes = [] }: EffectViewOptions = {},
  ): SpaceEffect[] {
    const next = new Map<unknown, Held>()
    const placed: Held[] = []

    for (const { key, start, world, sparam = 0, watched, generic, released } of placements) {
      let held = this.#held.get(key) ?? next.get(key)

      if (!held) {
        const effect = start()
        const runTime =
          effectTypes[effect.type]?.runTime ?? RETAIL_EFFECT_TYPES[effect.type]?.runTime

        held = {
          effect,
          world,
          sparam,
          lod: 1,
          runTime: runTime ?? -1,
          serial: this.#serial++,
          released: false,
          ended: false,
        }
      }

      next.set(key, held)
      if (held.ended) continue
      held.world = world
      held.sparam = sparam

      if (released && !held.released) {
        held.released = true
        held.effect.instance.stop()
        // `0x4f8680`: under 0 or over 1, a second; a NaN is kept.
        if (held.runTime < 0 || held.runTime > 1) held.runTime = 1
      }

      const { instance, texture, type, visible } = held.effect

      held.effect = {
        instance,
        texture,
        type,
        ...(visible && { visible }),
        position: { x: world.w.x, y: world.w.y, z: world.w.z },
        ...(watched && { watched }),
        ...(generic && { generic }),
      }
      this.#of.set(held.effect, held)
      placed.push(held)
    }

    // One no longer placed is destroyed (`0x4f789f`), its share of the pools with it.
    for (const [key, held] of this.#held)
      if (!next.has(key) && !held.ended) held.effect.instance.release()

    this.#held = next
    return placed.sort((a, b) => b.serial - a.serial).map(({ effect }) => effect)
  }

  /**
   * After the frame, each placed effect as the walk leaves it: unseen and not `EXIST_OFFSCREEN`, it's
   * destroyed. Otherwise its run time counts down and it ends at 0, or once its effect has; then it
   * steps by `scene.step`, held to `effectMaxStep`, at its view's LOD, unless it's unseen and its type
   * isn't `UPDATE_OFFSCREEN` (`0x4f8ae9`). Not walked (`hold`), nothing happens to it.
   */
  step(scene: SpaceScene, { effectViews }: Pick<SpaceFrame, 'effectViews'>): void {
    const { effects = [], camera, effectView, limits } = scene
    const most = limits?.effectMaxStep ?? RETAIL_SPACE_LIMITS.effectMaxStep
    const dt = Math.min(scene.step ?? 0, most)
    const view = viewMatrix(camera)
    const types = effectView?.effectTypes ?? []

    effects.forEach((effect, at) => {
      const held = this.#of.get(effect)
      if (!held || held.ended) return

      const seen = effectViews[at]
      if (seen?.fate === 'hold') return
      if (seen?.fate === 'die') return end(held)

      if (held.runTime > 0) {
        held.runTime = f(held.runTime - dt)
        if (held.runTime <= 0) return end(held)
      }

      if (held.effect.instance.finished) return end(held)
      if (seen) held.lod = seen.lod

      const updates =
        types[effect.type]?.updateOffscreen ?? RETAIL_EFFECT_TYPES[effect.type]?.updateOffscreen
      if (seen?.fate === 'run' && !updates) return
      held.effect.instance.advance(dt, {
        placement: held.world,
        view,
        sparam: held.sparam,
        lod: held.lod,
      })
    })
  }

  /** Every effect held, released: for a host done with them all. */
  release(): void {
    for (const held of this.#held.values()) if (!held.ended) end(held)
    this.#held.clear()
  }

  /** Whether a key's effect has ended, or `undefined` where it isn't held. */
  ended(key: unknown): boolean | undefined {
    return this.#held.get(key)?.ended
  }
}
