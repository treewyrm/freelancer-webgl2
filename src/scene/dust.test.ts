import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, type Vector3 } from '@treewyrm/freelancer/math'
import type { AdvanceOptions, EffectInstance } from '#/alchemy/effect.js'
import type { Camera } from './camera.js'
import { SpaceDust, smallestDustZone, type DustEffect, type DustZone } from './dust.js'
import { zoneOf } from './nebula.js'

const f = Math.fround
const MISC = 35
const MOTION = 36
const STEP = 1 / 60
// Looking down -Z from the origin: the dust stands at (0, 0, -60).
const camera: Camera = {
  position: { x: 0, y: 0, z: 0 },
  orientation: Matrix3.identity,
  fovh: 35,
  near: 1,
  far: 21000,
}
const at = (z: number): Camera => ({ ...camera, position: { x: 0, y: 0, z } })

interface Started {
  name: string
  steps: { dt: number; sparam?: number; at?: Vector3 }[]
  stopped: boolean
  ended: boolean
}

/** Starts a recording effect for any name but `missing`: `dust` as motion dust, others misc. */
const recorder = () => {
  const started: Started[] = []
  const start = (name: string): DustEffect | undefined => {
    if (name === 'missing') return undefined
    const record: Started = { name, steps: [], stopped: false, ended: false }
    started.push(record)
    const instance = {
      advance: (dt: number, { sparam, placement }: AdvanceOptions = {}) =>
        record.steps.push({ dt, sparam, ...(placement && { at: placement.w }) }),
      stop: () => {
        record.stopped = true
      },
      get finished() {
        return record.ended
      },
    } as unknown as EffectInstance
    return { instance, texture: () => undefined, type: name === 'dust' ? MOTION : MISC }
  }
  const last = (name: string) => started.filter((each) => each.name === name).at(-1)!
  return { started, start, last }
}

const sphere = (dust: string, radius: number, fields: Partial<DustZone> = {}): DustZone => ({
  zone: zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: 0 }, radius }),
  dust,
  ...fields,
})

test('the dust stands 60 along the camera’s Z, turned as it is', () => {
  const dust = new SpaceDust('dust', () => undefined)
  const turned: Camera = {
    ...camera,
    position: { x: 10, y: 20, z: 30 },
    orientation: Matrix3.fromQuaternion({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }),
  }
  const { position } = dust.frame(turned)
  const z = turned.orientation.z
  assert.deepEqual(position, {
    x: f(f(z.x * -60) + 10),
    y: f(f(z.y * -60) + 20),
    z: f(f(z.z * -60) + 30),
  })
})

test("the system's dust starts on the first update and is placed from the next, at 80 over 500", () => {
  const { started, start } = recorder()
  const dust = new SpaceDust('dust', start)
  dust.update(camera, STEP, [])
  assert.equal(started.length, 1)
  assert.deepEqual(started[0]!.steps, [])
  assert.deepEqual(dust.effects(), [])
  dust.update(camera, STEP, [])
  assert.deepEqual(started[0]!.steps, [
    { dt: STEP, sparam: f(80 * 0.002), at: { x: 0, y: 0, z: -60, w: 1 } },
  ])
  const [walked] = dust.effects()
  assert.equal(walked!.effect.type, MOTION)
  assert.deepEqual(walked!.effect.position, { x: 0, y: 0, z: -60 })
  assert.equal(started.length, 1)
})

test('space_dust_detail takes the system dust from 80 particles toward 30', () => {
  const sparamAt = (detail: number) => {
    const { started, start } = recorder()
    const dust = new SpaceDust('dust', start)
    dust.update(camera, STEP, [], { detail })
    dust.update(camera, STEP, [], { detail })
    return started[0]!.steps[0]!.sparam
  }
  assert.equal(sparamAt(0), f(30 * 0.002))
  assert.equal(sparamAt(0.5), f(55 * 0.002))
})

test('a system with no [Dust], or no such effect, has none', () => {
  const { started, start } = recorder()
  const none = new SpaceDust(undefined, start)
  none.update(camera, STEP, [])
  none.update(camera, STEP, [])
  assert.equal(started.length, 0)
  const missing = new SpaceDust('missing', start)
  missing.update(camera, STEP, [])
  missing.update(camera, STEP, [])
  assert.deepEqual(missing.effects(), [])
})

test("a zone's dust runs where the dust's point is, not the camera, at its particles over 500", () => {
  const { started, start, last } = recorder()
  const dust = new SpaceDust(undefined, start)
  const zone = {
    ...sphere('icedust', 100),
    zone: zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: -100 }, radius: 50 }),
  }
  // The camera is outside it; 60 ahead is in.
  dust.update(camera, STEP, [zone])
  assert.equal(started.length, 1)
  assert.equal(last('icedust').steps[0]!.sparam, f(50 * f(0.002)))
  const many = new SpaceDust(undefined, start)
  many.update(camera, STEP, [{ ...zone, dust: 'debrisdust', maxParticles: 250 }])
  assert.equal(last('debrisdust').steps[0]!.sparam, f(250 * f(0.002)))
  // `SetIntensity` holds it to 1.
  const most = new SpaceDust(undefined, start)
  most.update(camera, STEP, [{ ...zone, dust: 'golddust', maxParticles: 600 }])
  assert.equal(last('golddust').steps[0]!.sparam, 1)
})

test('the smallest zone holding the point wins, the first of equals', () => {
  const big = sphere('big', 1000)
  const small = sphere('small', 100)
  const twin = sphere('twin', 100)
  const point = { x: 0, y: 0, z: -60 }
  assert.equal(smallestDustZone([big, small, twin], point), small)
  assert.equal(smallestDustZone([twin, small, big], point), twin)
  assert.equal(smallestDustZone([sphere('tiny', 10), big], point), big)
  assert.equal(smallestDustZone([sphere('tiny', 10)], point), undefined)
})

test('in its edge, a zone’s dust is scaled by its immersion, and the last one fades by the rest', () => {
  const { start, last } = recorder()
  const dust = new SpaceDust(undefined, start)
  const outer = sphere('asteroiddust', 10000)
  // Edge fraction 0.5 over 200: full within 100, the point at 160 of 200 is 0.4 in.
  const inner = sphere('icedust', 200, { edgeFraction: 0.5, maxParticles: 100 })
  dust.update(at(-1000), STEP, [outer])
  dust.update(at(-100), STEP, [outer, inner])
  const blend = f((1 - f(160 / 200)) / 0.5)
  assert.equal(last('icedust').steps[0]!.sparam, f(100 * f(0.002) * blend))
  assert.equal(last('asteroiddust').steps[1]!.sparam, f(50 * f(0.002) * (1 - blend)))
  assert.equal(dust.effects().length, 2)
  // Deeper in, the fading one reaches 0 and is killed.
  dust.update(at(0), STEP, [outer, inner])
  assert.equal(last('asteroiddust').stopped, true)
})

test('leaving every zone kills its dust: it stops, stays put, and ends within a second', () => {
  const { start, last } = recorder()
  const dust = new SpaceDust(undefined, start)
  const zone = sphere('icedust', 1000)
  dust.update(camera, STEP, [zone])
  dust.update(at(5000), 0.25, [zone])
  const ice = last('icedust')
  assert.equal(ice.stopped, true)
  // Still walked where it was last placed, by at most 0.1 a step.
  assert.deepEqual(ice.steps.at(-1), {
    dt: f(0.1),
    sparam: f(0.1),
    at: { x: 0, y: 0, z: -60, w: 1 },
  })
  assert.deepEqual(dust.effects()[0]!.effect.position, { x: 0, y: 0, z: -60 })
  for (let frame = 0; frame < 8; frame++) dust.update(at(5000), 0.1, [zone])
  assert.equal(ice.steps.length, 10)
  // Its run time, held to 1, reaches 0 on the tenth step of 0.1 and ends it unstepped.
  dust.update(at(5000), 0.1, [zone])
  assert.equal(ice.steps.length, 10)
  assert.deepEqual(dust.effects(), [])
})

test('a killed effect whose own effect ends first goes then', () => {
  const { start, last } = recorder()
  const dust = new SpaceDust(undefined, start)
  const zone = sphere('icedust', 1000)
  dust.update(camera, STEP, [zone])
  dust.update(at(5000), STEP, [zone])
  last('icedust').ended = true
  dust.update(at(5000), STEP, [zone])
  assert.deepEqual(dust.effects(), [])
})

test('a zone of the same dust, in any case, keeps the effect running', () => {
  const { started, start } = recorder()
  const dust = new SpaceDust(undefined, start)
  dust.update(camera, STEP, [sphere('IceDust', 1000)])
  dust.update(camera, STEP, [sphere('icedust', 500)])
  assert.equal(started.length, 1)
  dust.update(camera, STEP, [sphere('golddust', 500)])
  assert.equal(started.length, 2)
})

test('at or under 0.75 detail zone dust is dropped; the system’s runs on', () => {
  const { start, last } = recorder()
  const dust = new SpaceDust('dust', start)
  const zone = sphere('icedust', 1000)
  dust.update(camera, STEP, [zone])
  dust.update(camera, STEP, [zone])
  dust.update(camera, STEP, [zone], { detail: 0.75 })
  assert.equal(last('icedust').stopped, true)
  assert.equal(last('dust').stopped, false)
  assert.equal(last('dust').steps.at(-1)!.sparam, f((0.25 * 30 + 80 * 0.75) * 0.002))
})

test('with the background option off, each frame drops the dust and starts it again', () => {
  const { started, start } = recorder()
  const dust = new SpaceDust('dust', start)
  const zone = sphere('icedust', 1000)
  dust.update(camera, STEP, [zone], { background: false })
  dust.update(camera, STEP, [zone], { background: false })
  dust.update(camera, STEP, [zone], { background: false })
  const ice = started.filter(({ name }) => name === 'icedust')
  const system = started.filter(({ name }) => name === 'dust')
  // Each zone dust is placed once, then killed to wind down; the system's is never placed.
  assert.equal(ice.length, 3)
  assert.deepEqual(
    ice.map(({ stopped }) => stopped),
    [true, true, false],
  )
  assert.equal(system.length, 3)
  assert.ok(system.every(({ steps }) => steps.length === 0))
})

test('the walk is newest linked first, and an unseen one not off screen dies', () => {
  const { start } = recorder()
  const dust = new SpaceDust('dust', start)
  const zone = sphere('icedust', 1000)
  dust.update(camera, STEP, [zone])
  dust.update(camera, STEP, [zone])
  assert.deepEqual(
    dust.effects().map(({ effect }) => effect.type),
    [MOTION, MISC],
  )
  dust.viewed([
    { fate: 'die', lod: 1 },
    { fate: 'run', lod: 0.5 },
  ])
  dust.update(camera, STEP, [zone])
  // Dead, the system's isn't linked again.
  assert.deepEqual(
    dust.effects().map(({ effect }) => effect.type),
    [MISC],
  )
})

test("a type's run time counts down as it's walked, killed or not", () => {
  const { start, last } = recorder()
  const dust = new SpaceDust(undefined, start)
  const zone = sphere('icedust', 1000)
  const runTimes = []
  runTimes[MISC] = 0.25
  dust.update(camera, 0.1, [zone], { runTimes })
  dust.update(camera, 0.1, [zone], { runTimes })
  assert.equal(last('icedust').steps.length, 2)
  dust.update(camera, 0.1, [zone], { runTimes })
  assert.equal(last('icedust').steps.length, 2)
  assert.deepEqual(dust.effects(), [])
})
