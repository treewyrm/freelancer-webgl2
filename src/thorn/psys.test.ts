import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Matrix4 } from '@treewyrm/freelancer/math'
import type { Event, Script } from '@treewyrm/freelancer/thn/scene'
import type { EffectInstance } from '#/alchemy/effect.js'
import { Playback } from './playback.js'

/** Records what thorn hands an effect: each step, its placement, and its sparam. */
const recorder = () => {
  const made: { template: string; steps: { dt: number; at: number; sparam: number }[] }[] = []

  const createEffect = (_entity: string, template: string) => {
    const record = { template, steps: [] as { dt: number; at: number; sparam: number }[] }

    made.push(record)

    const instance = {
      context: { sparam: 0 },
      advance(dt: number, { placement }: { placement?: Matrix4 } = {}) {
        record.steps.push({ dt, at: placement?.w.x ?? Number.NaN, sparam: instance.context.sparam })
      },
    }

    return instance as unknown as EffectInstance
  }

  return { made, createEffect }
}

const script = (events: Event[]): Script => ({
  duration: 10,
  entities: [
    { type: 'SCENE', entity_name: 'scene' },
    {
      type: 'PSYS',
      entity_name: 'fx',
      template_name: 'gf_smoke',
      spatialprops: { pos: { x: 1, y: 0, z: 0 } },
    },
    { type: 'MARKER', entity_name: 'mover' },
  ],
  events,
})

test('START_PSYS makes a new instance at its time, steps it by dt then 0, and kills it at its end', () => {
  const { made, createEffect } = recorder()
  const playback = new Playback(
    script([{ action: 'START_PSYS', time: 0.5, duration: 1, targets: ['fx'] }]),
    {
      createEffect,
    },
  )

  playback.start()
  playback.tick(400)
  assert.equal(made.length, 0)
  playback.tick(200)
  assert.equal(made[0]!.template, 'gf_smoke')
  assert.equal(playback.effects.length, 1)
  // Started at 500 inside this tick: one step to 600, then the closing 0.
  assert.deepEqual(
    made[0]!.steps.map(({ dt }) => dt),
    [Math.fround(0.1), 0],
  )
  playback.tick(1000)
  assert.equal(playback.effects.length, 0)
})

test("an effect is placed at thorn's frame as it stands after the tick's attaches, C never applied", () => {
  const { made, createEffect } = recorder()
  const playback = new Playback(
    script([
      { action: 'START_PSYS', time: 0, duration: 5, targets: ['fx'] },
      {
        action: 'START_SPATIAL_PROP_ANIM',
        time: 0,
        duration: 1,
        targets: ['mover'],
        spatialprops: { pos: { x: 10, y: 0, z: 0 } },
      },
      {
        action: 'ATTACH_ENTITY',
        time: 0,
        duration: 5,
        targets: ['fx', 'mover'],
        flags: ['POSITION'],
      },
    ]),
    {
      createEffect,
      frame: {
        x: { x: 1, y: 0, z: 0, w: 0 },
        y: { x: 0, y: 1, z: 0, w: 0 },
        z: { x: 0, y: 0, z: 1, w: 0 },
        w: { x: 50, y: 0, z: 0, w: 1 },
      },
    },
  )

  playback.start()
  playback.tick(500)

  const last = made[0]!.steps.at(-1)!

  // The closing step by 0 carries the frame this tick wrote; the one before, the last update's.
  assert.equal(last.dt, 0)
  assert.equal(last.at, 5)
  assert.equal(made[0]!.steps.at(-2)!.at, 0)
})

test("sparam animates from the host's cache, reaches an effect only while one runs, and a new one starts at 0", () => {
  const { made, createEffect } = recorder()
  const playback = new Playback(
    script([
      {
        action: 'START_PSYS_PROP_ANIM',
        time: 0,
        duration: 0,
        targets: ['fx'],
        psysprops: { sparam: 0.8 },
      },
      { action: 'START_PSYS', time: 1, duration: 5, targets: ['fx'] },
      {
        action: 'START_PSYS_PROP_ANIM',
        time: 2,
        duration: 1,
        targets: ['fx'],
        psysprops: { sparam: 0 },
      },
    ]),
    { createEffect },
  )

  playback.start()
  playback.tick(1500)
  // The set at 0 is lost: the effect started at its default.
  assert.equal(made[0]!.steps.at(-1)!.sparam, 0)
  playback.tick(1000)
  // From the cache's 0.8 toward 0, halfway.
  assert.equal(made[0]!.steps.at(-1)!.sparam, Math.fround(0.4))
})

test('without a priority, script_particles off gives an effect no host, so START_PSYS never runs', () => {
  const { made, createEffect } = recorder()
  const playback = new Playback(
    script([{ action: 'START_PSYS', time: 0, duration: 5, targets: ['fx'] }]),
    {
      createEffect,
      spawn: { rtc: [{ name: 'script_particles', threshold: 0.5 }], slider: 0.2 },
    },
  )

  playback.start()
  playback.tick(1000)
  assert.equal(made.length, 0)
  assert.equal(playback.active.length, 0)
})
