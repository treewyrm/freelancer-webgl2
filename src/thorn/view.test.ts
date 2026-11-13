import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix4, Vector3 } from '@treewyrm/freelancer/math'
import type { Entity, Event, Script } from '@treewyrm/freelancer/thn/scene'
import { replay } from './playback.js'
import { cameraOf, Letterbox, ViewTable } from './view.js'

const near = (a: Vector3 | undefined, b: Vector3, e = 1e-5) =>
  assert.ok(a && Vector3.equal(a, b, e), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`)

const camera = (name: string, x: number, fovh = 25): Entity => ({
  type: 'CAMERA',
  entity_name: name,
  spatialprops: { pos: { x, y: 0, z: 0 } },
  cameraprops: { fovh, hvaspect: 1.85, nearplane: 1, farplane: 1000 },
})

const script = (events: Event[]): Script => ({
  duration: 10,
  entities: [
    { type: 'SCENE', entity_name: 'scene' },
    { type: 'MONITOR', entity_name: 'monitor' },
    camera('one', 1),
    camera('two', 2, 40),
  ],
  events,
})

const cut = (time: number, to: string): Event => ({
  action: 'SET_CAMERA',
  time,
  targets: ['monitor', to],
})

test('a cut copies the camera onto the monitor, which then follows it, and the last cut wins', () => {
  const moveTwo: Event = {
    action: 'START_SPATIAL_PROP_ANIM',
    time: 2,
    duration: 1,
    targets: ['two'],
    spatialprops: { pos: { x: 12, y: 0, z: 0 } },
  }
  const before = replay(script([cut(0, 'one'), moveTwo, cut(1, 'two')]), 500)

  assert.equal(before.linkedCamera('monitor'), 'one')
  near(Matrix4.transformPoint(Vector3.zero, before.view('monitor')!.world), { x: 1, y: 0, z: 0 })
  assert.equal(before.view('monitor')!.fovh, 25)

  const after = replay(script([cut(0, 'one'), moveTwo, cut(1, 'two')]), 2500)

  assert.equal(after.linkedCamera('monitor'), 'two')
  near(Matrix4.transformPoint(Vector3.zero, after.view('monitor')!.world), { x: 7, y: 0, z: 0 })
  assert.equal(after.view('monitor')!.fovh, 40)
  // A cut is never active: its duration means nothing.
  assert.ok(after.active.every(({ action }) => action !== 'SET_CAMERA'))
})

test("a camera animation's keys land by position: aspect on near, near on far, far on aspect", () => {
  const playback = replay(
    script([
      cut(0, 'one'),
      {
        action: 'START_CAMERA_PROP_ANIM',
        time: 0,
        duration: 1,
        targets: ['one'],
        cameraprops: { fovh: 45, aspect: 3, near: 500, far: 2 },
      },
    ]),
    500,
  )
  const { fovh, near: nearPlane, far, aspect } = playback.view('monitor')!

  assert.equal(fovh, 35)
  assert.equal(nearPlane, 2)
  assert.equal(far, 750)
  assert.equal(aspect, Math.fround(1.925))
})

test("a camera animation with a second camera chases that camera's live slots", () => {
  const playback = replay(
    script([
      cut(0, 'one'),
      {
        action: 'START_CAMERA_PROP_ANIM',
        time: 0,
        duration: 1,
        targets: ['one', 'two'],
        cameraprops: { fovh: 0 },
      },
    ]),
    1000,
  )

  assert.equal(playback.view('monitor')!.fovh, 40)
})

test('the view is the renderer camera at the monitor, in the world through C', () => {
  const C = Matrix4.translation({ x: 0, y: 100, z: 0 })
  const playback = replay(script([cut(0, 'two')]), 0, { frame: C })
  const view = cameraOf(playback.view('monitor')!)

  near(view.position, { x: 2, y: 100, z: 0 })
  assert.equal(view.fovh, 40)
  assert.equal(view.near, 1)
})

test('a monitor takes the view only over a strictly lower priority; freeing re-elects, ties to the lowest', () => {
  const table = new ViewTable()
  const room = table.register(0, true)

  assert.equal(table.active, room)
  assert.equal(table.register(0, false), 1)
  assert.equal(table.register(0, true), 2)
  assert.equal(table.active, room)

  const landing = table.register(1, true)

  assert.equal(table.active, landing)
  table.release(landing!)
  assert.equal(table.active, room)
  table.release(room!)
  assert.equal(table.active, 2)
  table.release(2)
  assert.equal(table.active, undefined)
})

test('the letterbox slides in over a third of a second to a 1.85:1 picture, the horizontal angle held', () => {
  const box = new Letterbox()
  const surface = { width: 1024, height: 768 }

  assert.equal(box.bar(surface), 0)
  box.aim(1)
  assert.equal(box.step(0.1), true)
  assert.equal(box.amount, Math.fround(0.3))
  box.step(0.3)
  assert.equal(box.amount, 1)
  assert.equal(box.animating, false)

  // (768 − 1024 / 1.85) / 2 = 107.24…, rounded half up.
  const { top, viewport, aspect } = box.view(surface)

  assert.equal(top, 107)
  assert.deepEqual(viewport, { width: 1024, height: 554 })
  assert.equal(aspect, 1024 / 554)
  box.aim(0, 3, true)
  assert.equal(box.amount, 0)
})
