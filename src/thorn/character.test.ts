import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AnimationScript } from '@treewyrm/freelancer/animation'
import type { Joint } from '@treewyrm/freelancer/compound'
import { Matrix3, Matrix4, Quat, Vector3 } from '@treewyrm/freelancer/math'
import { Mixer } from '#/deformable/mixer.js'
import { mixerCharacters } from './character.js'
import type { Event, Script } from '@treewyrm/freelancer/thn/scene'
import { rotate } from './frame.js'
import { Playback } from './playback.js'

const script = (events: Event[]): Script => ({
  duration: 10,
  entities: [
    { type: 'SCENE', entity_name: 'scene' },
    {
      type: 'DEFORMABLE',
      entity_name: 'man',
      spatialprops: { pos: { x: 0, y: 0, z: 0 } },
      compoundprops: { floor_height: 0.5 },
    },
    { type: 'MARKER', entity_name: 'look', spatialprops: { pos: { x: 0, y: 1.7, z: -5 } } },
    { type: 'MARKER', entity_name: 'step', spatialprops: { pos: { x: 0, y: 2, z: 0 } } },
  ],
  events,
})

test("START_MOTION hands the host its record, defaults filled, and Finish stops it at the event's end", () => {
  const log: string[] = []

  const playback = new Playback(
    script([
      {
        action: 'START_MOTION',
        time: 0,
        duration: 2,
        targets: ['man'],
        animation: 'Sc_MLBODY_STND_IDLE_000LV_XA_07',
        trans_time: 0.5,
        event_flags: 2,
      },
    ]),
    {
      characters: {
        startMotion: (entity, { animation, weight, timeScale, heading, transTime }) => {
          log.push(`start ${entity} ${animation} ${weight} ${timeScale} ${heading} ${transTime}`)
          return true
        },
        stopMotion: (entity) => log.push(`stop ${entity}`),
      },
    },
  )

  playback.start()
  playback.tick(1000)
  assert.equal(playback.motions.length, 1)
  playback.tick(1000)
  assert.deepEqual(log, ['start man Sc_MLBODY_STND_IDLE_000LV_XA_07 1 1 -1 0.5', 'stop man'])
  assert.equal(playback.motions.length, 0)
})

test("START_IK aims from the end effector's bone toward the target, re-sent at every update, from 1 ms", () => {
  const playback = new Playback(
    script([
      {
        action: 'START_IK',
        time: 0,
        duration: 5,
        targets: ['man', 'look'],
        end_effector: 'Bip01 Head',
        count_to_root: 1,
        point_at: 1,
        front: 'Z_AXIS',
      },
    ]),
    { host: { bone: () => Matrix4.translation({ x: 0, y: 1.7, z: 0 }) } },
  )

  playback.start()
  assert.equal(playback.aims.length, 0)
  playback.tick(1)

  const { aim } = playback.aims[0]!

  assert.ok(aim.pointAt)

  const front = rotate(aim.rotation, { x: 0, y: 0, z: 1 })

  assert.ok(Vector3.equal(front, { x: 0, y: 0, z: -1 }, 1e-6))
})

test("a character's floor starts at its record, and a floor animation chases a second entity's height", () => {
  const playback = new Playback(
    script([{ action: 'START_FLR_HEIGHT_ANIM', time: 0, duration: 1, targets: ['man', 'step'] }]),
  )

  playback.start()
  assert.equal(playback.floorOf('man'), 0.5)
  playback.tick(500)
  assert.equal(playback.floorOf('man'), 1.25)
  playback.tick(500)
  assert.equal(playback.floorOf('man'), 2)
})

test('on the mixer, START_MOTION plays the named script, and Finish stops it with no blend-out', () => {
  const slide: Joint = {
    type: 'prismatic',
    position: Vector3.zero,
    offset: Vector3.zero,
    orientation: Matrix3.identity,
    axis: Vector3.y,
    min: -100,
    max: 100,
  }
  const character = new Mixer({
    root: 'Root',
    joints: [{ name: 'Slide', parent: 'Root', joint: slide }],
  })
  const scripts: Record<string, AnimationScript> = {
    sc_rise: {
      name: 'sc_rise',
      maps: [
        {
          type: 'joint',
          parent: 'Root',
          child: 'Slide',
          channel: {
            type: 'angle',
            interval: -1,
            keyframes: [
              { key: 0, value: 0 },
              { key: 2, value: 4 },
            ],
          },
        },
      ],
    },
  }
  const characters = mixerCharacters({
    mixer: (entity) => (entity === 'man' ? character : undefined),
    animation: (name) => scripts[name.toLowerCase()],
  })
  const playback = new Playback(
    script([
      {
        action: 'START_MOTION',
        time: 0,
        duration: 1,
        targets: ['man'],
        animation: 'SC_RISE',
        locked_bone: 'Slide',
      },
    ]),
    { characters },
  )

  playback.start()
  playback.tick(500)
  assert.ok(Math.abs((character.jointState('Slide')?.value ?? NaN) - 1) < 1e-5)
  playback.tick(1000)
  // Stopped at its end with no blend-out: the joint keeps its last value.
  assert.ok(Math.abs((character.jointState('Slide')?.value ?? NaN) - 2) < 1e-5)
})

test('a motion locks its bone even when its play fails, and its finish unlocks it', () => {
  const slide: Joint = {
    type: 'prismatic',
    position: Vector3.zero,
    offset: Vector3.zero,
    orientation: Matrix3.identity,
    axis: Vector3.y,
    min: -100,
    max: 100,
  }
  const character = new Mixer({
    root: 'Root',
    joints: [{ name: 'Slide', parent: 'Root', joint: slide }],
  })
  const rise: AnimationScript = {
    name: 'sc_rise',
    maps: [
      {
        type: 'joint',
        parent: 'Root',
        child: 'Slide',
        channel: {
          type: 'angle',
          interval: -1,
          keyframes: [
            { key: 0, value: 0 },
            { key: 2, value: 4 },
          ],
        },
      },
    ],
  }
  const characters = mixerCharacters({
    mixer: (entity) => (entity === 'man' ? character : undefined),
    animation: () => rise,
  })
  const playback = new Playback(
    script([
      // Started past its channel's end, so the play fails (`TypedTimePlayable`); the lock holds.
      {
        action: 'START_MOTION',
        time: 0,
        duration: 1,
        targets: ['man'],
        animation: 'sc_rise',
        start_time: 10,
        locked_bone: 'Slide',
      },
      { action: 'START_MOTION', time: 0.5, duration: 4, targets: ['man'], animation: 'sc_rise' },
    ]),
    { characters },
  )

  playback.start()
  playback.tick(900)
  assert.equal(character.jointState('Slide')?.value ?? 0, 0)
})

test('START_IK with count_to_root 0 aims nothing', () => {
  let aimed = false
  const characters = mixerCharacters({
    mixer: () =>
      ({
        root: { orientation: Matrix3.identity },
        aim: () => ((aimed = true), 1),
      }) as never,
    animation: () => undefined,
  })
  const aim = {
    pointAt: true,
    countToRoot: 0,
    endEffector: 'Bip01 Head',
    rotation: Matrix4.identity,
  }

  characters.startAim!('man', aim as never)
  assert.equal(aimed, false)
  characters.startAim!('man', { ...aim, countToRoot: 1 } as never)
  assert.equal(aimed, true)
})

test("an aim's scene rotation reaches the joint's world through a turned character, not undone twice", () => {
  const head: Joint = {
    type: 'sphere',
    position: { x: 0, y: 1.6, z: 0 },
    offset: Vector3.zero,
    orientation: Matrix3.identity,
    minX: -Math.PI,
    maxX: Math.PI,
    minY: -Math.PI,
    maxY: Math.PI,
    minZ: -Math.PI,
    maxZ: Math.PI,
  }
  // Turned to face back along -Z, as s004x's Trent and diplomat stand.
  const character = new Mixer({
    root: 'Root',
    joints: [{ name: 'Head', parent: 'Root', joint: head }],
    orientation: Quat.axisAngle({ axis: Vector3.y, angle: Math.PI }),
  })
  const characters = mixerCharacters({ mixer: () => character, animation: () => undefined })
  // The look-at toward +Z, in scene space: `IkSolveSingleJoint` undoes the parent's world from it.
  const toward = Matrix4.identity

  characters.startAim!('man', {
    pointAt: true,
    countToRoot: 1,
    endEffector: 'Head',
    transitionDuration: 0,
    eventFlags: 0,
    rotation: toward,
  } as never)
  character.advance(0.1)

  const local = character.jointState('Head')!.orientation!
  const world = Quat.multiply(character.root.orientation, local)
  const front = rotate(Matrix4.fromTRS(Vector3.zero, world, 1), { x: 0, y: 0, z: 1 })

  assert.ok(front.z > 0.999, `head front ${JSON.stringify(front)}`)
})
