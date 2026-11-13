import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import type { AdvanceOptions, EffectInstance } from '#/alchemy/effect.js'
import type { Camera } from './camera.js'
import type { EffectView } from './effect-view.js'
import { PlacedEffects, type EffectPlacement } from './placed.js'
import type { SpaceScene } from './space.js'

const f = Math.fround
// `EFT_EXPLOSION_SMALL` ends unseen and runs 15 s; `EFT_EQUIP_ATTACHED` exists off screen, unstepped;
// `EFT_ENGINE_TRAIL` steps there too.
const SMALL = 1
const ATTACHED = 32
const TRAIL = 25

const camera: Camera = {
  position: { x: 0, y: 0, z: 0 },
  orientation: Matrix3.identity,
  fovh: 35,
  near: 1,
  far: 21000,
}

interface Run {
  steps: { dt: number; sparam?: number; lod?: number }[]
  stopped: number
  finished: boolean
  released: number
}

/** A recording effect of a type, and what became of each one started. */
const recorder = () => {
  const runs: Run[] = []

  const starter = (type: number) => (): ReturnType<EffectPlacement['start']> => {
    const run: Run = { steps: [], stopped: 0, finished: false, released: 0 }

    runs.push(run)

    const instance = {
      advance: (dt: number, { sparam, lod }: AdvanceOptions = {}) =>
        run.steps.push({ dt, sparam, lod }),
      stop: () => run.stopped++,
      release: () => run.released++,
      get finished() {
        return run.finished
      },
    } as unknown as EffectInstance

    return { instance, texture: () => undefined, type }
  }

  return { runs, starter }
}

const at = (z: number) => Matrix4.translation({ x: 0, y: 0, z })

/** One frame: placed, seen as `fates` say in the order placed, then stepped by `step`. */
const frame = (
  effects: PlacedEffects,
  placements: EffectPlacement[],
  fates: (EffectView['fate'] | undefined)[],
  step = 0.05,
) => {
  const placed = effects.place(placements)
  const scene: SpaceScene = {
    camera,
    aspect: 1,
    ambient: { x: 0, y: 0, z: 0 },
    lights: [],
    objects: [],
    effects: placed,
    step,
  }
  // The frame's views follow `scene.effects`, newest first: map each back to its placement.
  const order = placed.map((effect) =>
    placements.findIndex(({ world }) => world.w.z === effect.position!.z),
  )

  effects.step(scene, {
    effectViews: order.map((index) => {
      const fate = fates[index]

      return fate && { fate, lod: 0.5 }
    }),
  })
  return placed
}

test('a key keeps its instance; the newest is first; one not placed again is dropped', () => {
  const { runs, starter } = recorder()
  const effects = new PlacedEffects()
  const a = { key: 'a', start: starter(ATTACHED), world: at(-10) }
  const b = { key: 'b', start: starter(ATTACHED), world: at(-20) }

  frame(effects, [a], ['draw'])

  const both = frame(effects, [a, b], ['draw', 'draw'])

  assert.equal(runs.length, 2)
  assert.deepEqual(
    both.map(({ position }) => position!.z),
    [-20, -10],
  )
  assert.equal(runs[0]!.steps.length, 2)
  frame(effects, [b], ['draw'])
  assert.equal(effects.ended('a'), undefined)
  frame(effects, [a, b], ['draw', 'draw'])
  assert.equal(runs.length, 3, 'placed again, it starts afresh')
})

test('unseen and not EXIST_OFFSCREEN, it is destroyed and stays out while placed', () => {
  const { runs, starter } = recorder()
  const effects = new PlacedEffects()
  const a = { key: 'a', start: starter(SMALL), world: at(-10) }

  frame(effects, [a], ['die'])
  assert.equal(runs[0]!.steps.length, 0)
  assert.equal(effects.ended('a'), true)
  assert.deepEqual(frame(effects, [a], []), [])
  assert.equal(runs.length, 1)
})

test('unseen, it steps only if its type is UPDATE_OFFSCREEN; held, nothing happens', () => {
  const { runs, starter } = recorder()
  const effects = new PlacedEffects()
  const attached = { key: 'a', start: starter(ATTACHED), world: at(-10) }
  const trail = { key: 't', start: starter(TRAIL), world: at(-20) }

  frame(effects, [attached, trail], ['run', 'run'])
  assert.equal(runs[0]!.steps.length, 0)
  assert.deepEqual(runs[1]!.steps, [{ dt: 0.05, sparam: 0, lod: 0.5 }])
  frame(effects, [attached, trail], ['hold', 'hold'])
  assert.equal(runs[1]!.steps.length, 1)
})

test('its step is held to 0.1, and a run time of 15 ends it as it is walked', () => {
  const { runs, starter } = recorder()
  const effects = new PlacedEffects()
  const a = { key: 'a', start: starter(SMALL), world: at(-10), sparam: 0.25 }

  frame(effects, [a], ['draw'], 1)
  assert.deepEqual(runs[0]!.steps[0], { dt: f(0.1), sparam: 0.25, lod: 0.5 })

  let frames = 1

  while (!effects.ended('a')) {
    frame(effects, [a], ['draw'], 1)
    frames++
  }

  // 150 steps of 0.1 count 15 down; the walk that reaches 0 doesn't step.
  assert.ok(frames >= 150 && frames <= 151, `${frames}`)
  assert.equal(runs[0]!.steps.length, frames - 1)
})

test('played out, it ends; let go, its emitters stop once and it has a second left', () => {
  const { runs, starter } = recorder()
  const effects = new PlacedEffects()
  const a = { key: 'a', start: starter(ATTACHED), world: at(-10) }

  frame(effects, [a], ['draw'])
  runs[0]!.finished = true
  frame(effects, [a], ['draw'])
  assert.equal(effects.ended('a'), true)

  const b = { key: 'b', start: starter(ATTACHED), world: at(-20) }

  frame(effects, [{ ...b, released: true }], ['draw'], 0.1)
  frame(effects, [{ ...b, released: true }], ['draw'], 0.1)
  assert.equal(runs[1]!.stopped, 1)

  let frames = 2

  while (!effects.ended('b')) {
    frame(effects, [{ ...b, released: true }], ['draw'], 0.1)
    frames++
  }

  assert.ok(frames >= 10 && frames <= 11, `${frames}`)
})

test('one no longer placed, or destroyed unseen, is released; release gives back the rest', () => {
  const { runs, starter } = recorder()
  const effects = new PlacedEffects()
  const a = { key: 'a', start: starter(ATTACHED), world: at(-10) }
  const b = { key: 'b', start: starter(SMALL), world: at(-20) }
  const c = { key: 'c', start: starter(ATTACHED), world: at(-30) }

  frame(effects, [a, b, c], ['draw', 'die', 'draw'])
  assert.deepEqual(
    runs.map(({ released }) => released),
    [0, 1, 0],
  )
  frame(effects, [c], ['draw'])
  assert.deepEqual(
    runs.map(({ released }) => released),
    [1, 1, 0],
  )
  effects.release()
  assert.deepEqual(
    runs.map(({ released }) => released),
    [1, 1, 1],
  )
})
