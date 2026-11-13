import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AngleChannel, AnimationScript, MotionChannel } from '@treewyrm/freelancer/animation'
import type { Joint, JointState } from '@treewyrm/freelancer/compound'
import { Matrix3, Quat, Vector3, Vector4 } from '@treewyrm/freelancer/math'
import { EASE, fadeWeight, Mixer, MotionFlag, type MixerJoint } from './mixer.js'
import { turnY } from './player.js'

const near = (actual: number, expected: number, epsilon = 1e-5) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not ${expected}`)

const nearQuat = (actual: Quat | undefined, expected: Quat, epsilon = 1e-5) => {
  assert.ok(actual)

  const sign = Math.sign(
    actual.x * expected.x + actual.y * expected.y + actual.z * expected.z + actual.w * expected.w,
  )
  for (const key of ['x', 'y', 'z', 'w'] as const) near(actual[key] * sign, expected[key], epsilon)
}

const slide: Joint = {
  type: 'prismatic',
  position: Vector3.zero,
  offset: Vector3.zero,
  orientation: Matrix3.identity,
  axis: Vector3.y,
  min: -100,
  max: 100,
}

const head: Joint = {
  type: 'sphere',
  position: { x: 0, y: 1, z: 0 },
  offset: Vector3.zero,
  orientation: Matrix3.identity,
  minX: -Math.PI,
  maxX: Math.PI,
  minY: -Math.PI,
  maxY: Math.PI,
  minZ: -Math.PI,
  maxZ: Math.PI,
}

const JOINTS: MixerJoint[] = [
  { name: 'Slide', parent: 'Root', joint: slide },
  { name: 'Head', parent: 'Root', joint: head },
]

const mixer = (options: Partial<ConstructorParameters<typeof Mixer>[0]> = {}) =>
  new Mixer({ root: 'Root', joints: JOINTS, ...options })

const ramp = (from: number, to: number, length: number): AngleChannel => ({
  type: 'angle',
  interval: -1,
  keyframes: [
    { key: 0, value: from },
    { key: length, value: to },
  ],
})

const constant = (value: number, length = 1) => ramp(value, value, length)

const turn = (orientation: Quat, length = 1): MotionChannel => ({
  type: 'motion',
  interval: -1,
  orientation: 'quaternion',
  keyframes: [
    { key: 0, orientation },
    { key: length, orientation },
  ],
})

const slideScript = (channel: AngleChannel, name = 'slide'): AnimationScript => ({
  name,
  maps: [{ type: 'joint', parent: 'Root', child: 'Slide', channel }],
})

const value = (mix: Mixer, name = 'Slide') => mix.jointState(name)?.value

describe('ease', () => {
  test('is ½(1 − cos(i · 3.14159 / 255)) as floats, whole at 255 (`FUN_0661d050`)', () => {
    const view = new DataView(new ArrayBuffer(8))

    view.setFloat64(0, 3.14159 / 255)
    assert.equal(view.getBigUint64(0), 0x3f893b352540c735n)
    assert.equal(EASE[0], 0)
    assert.equal(EASE[255], 1)
    assert.equal(EASE[128], Math.fround((1 - Math.cos((128 * 3.14159) / 255)) * 0.5))
    assert.equal(EASE.length, 256)
  })

  test('steps by the floored 255th of the fade, and a fade of no length is whole', () => {
    assert.equal(fadeWeight(0.5, 1), EASE[127])
    assert.equal(fadeWeight(0.999, 1), EASE[254])
    assert.equal(fadeWeight(0.25, 0.5), EASE[127])
    assert.equal(fadeWeight(3, 0), 1)
  })
})

describe('fade in', () => {
  test('a transition fades from a snapshot of the joint, then drops it', () => {
    const mix = mixer()

    mix.start(slideScript(constant(1)), { transTime: 1, eventFlags: MotionFlag.Loop })
    mix.advance(0.25)
    assert.equal(value(mix), EASE[63])
    mix.advance(0.75)
    assert.equal(value(mix), 1)
  })

  test('a transition of 0 replaces: every script on the joint stops', () => {
    const mix = mixer()
    const a = mix.start(slideScript(constant(1)), { eventFlags: MotionFlag.Loop })!

    mix.advance(0.1)
    assert.equal(value(mix), 1)

    const b = mix.start(slideScript(constant(2)), { eventFlags: MotionFlag.Loop })!

    assert.equal(mix.playing(a), false)
    mix.advance(0.1)
    assert.equal(value(mix), 2)
    mix.stop(b)
    mix.advance(0.1)
    assert.equal(value(mix), 2, 'nothing on the joint, so it keeps its last value')
  })

  test('without keep-beneath, a finished fade stops what it faded from', () => {
    const mix = mixer()
    const a = mix.start(slideScript(constant(1)), { eventFlags: MotionFlag.Loop })!

    mix.advance(0.1)

    const b = mix.start(slideScript(constant(2)), { transTime: 0.5, eventFlags: MotionFlag.Loop })!

    mix.advance(0.25)
    assert.equal(value(mix), Math.fround((2 - 1) * EASE[127]! + 1))
    mix.advance(0.25)
    assert.equal(value(mix), 2)
    assert.equal(mix.playing(a), false)
    mix.stop(b)
    mix.advance(0.1)
    assert.equal(value(mix), 2)
  })

  test('with keep-beneath, what is beneath plays on and shows at Finish, no fade', () => {
    const mix = mixer()
    const a = mix.start(slideScript(constant(1)), { eventFlags: MotionFlag.Loop })!

    mix.advance(0.1)

    const flags = MotionFlag.Loop | MotionFlag.KeepBeneath
    const b = mix.start(slideScript(constant(2)), { transTime: 0.5, eventFlags: flags })!

    mix.advance(0.5)
    assert.equal(value(mix), 2)
    assert.equal(mix.playing(a), true)
    mix.stop(b)
    mix.advance(0.1)
    assert.equal(value(mix), 1)
  })

  test('keep-beneath over nothing still drops the snapshot', () => {
    const mix = mixer()
    const flags = MotionFlag.Loop | MotionFlag.KeepBeneath
    const a = mix.start(slideScript(constant(1)), { transTime: 0.5, eventFlags: flags })!

    mix.advance(0.5)
    mix.stop(a)
    mix.advance(0.1)
    assert.equal(value(mix), 1, 'no snapshot of 0 beneath to show')
  })
})

describe('end of a script', () => {
  test('alone, it holds its last frame and leaves the joint', () => {
    const mix = mixer()
    const a = mix.start(slideScript(ramp(0, 1, 1)))!

    mix.advance(1.5)
    assert.equal(value(mix), 1)
    assert.equal(mix.playing(a), false)
    mix.advance(1)
    assert.equal(value(mix), 1)
  })

  test('under a fade, it holds its last value while the fade runs on', () => {
    const mix = mixer()

    mix.start(slideScript(ramp(0, 1, 0.2)), { transTime: 1 })
    mix.advance(0.3)
    assert.equal(value(mix), EASE[76])
    mix.advance(0.7)
    assert.equal(value(mix), 1)
  })

  test('on top of something kept, it fades back over the joint’s last transition', () => {
    const mix = mixer()
    const a = mix.start(slideScript(constant(1)), { eventFlags: MotionFlag.Loop })!

    mix.advance(0.1)
    mix.start(slideScript(constant(2)), { transTime: 0.5, eventFlags: MotionFlag.KeepBeneath })
    mix.advance(0.5)
    assert.equal(value(mix), 2)
    mix.advance(0.5)
    assert.equal(value(mix), 2, 'the fade back starts at its first step')
    mix.advance(0.25)
    assert.equal(value(mix), Math.fround((1 - 2) * EASE[127]! + 2))
    mix.advance(0.25)
    assert.equal(value(mix), 1)
    assert.equal(mix.playing(a), true)
  })
})

describe('Finish mid-fade', () => {
  test('what a fade reads from becomes a snapshot of the joint', () => {
    const mix = mixer()
    const a = mix.start(slideScript(constant(1)), { eventFlags: MotionFlag.Loop })!

    mix.advance(0.1)
    mix.start(slideScript(constant(3)), { transTime: 1, eventFlags: MotionFlag.Loop })
    mix.advance(0.5)

    const snapshot = value(mix)!

    assert.equal(snapshot, Math.fround(2 * EASE[127]! + 1))
    mix.stop(a)
    mix.advance(0.25)
    assert.equal(value(mix), Math.fround((3 - snapshot) * EASE[191]! + snapshot))
  })

  test('what a fade goes to takes what it faded from with it, and the joint holds', () => {
    const mix = mixer()
    const a = mix.start(slideScript(constant(1)), { eventFlags: MotionFlag.Loop })!

    mix.advance(0.1)

    const b = mix.start(slideScript(constant(3)), { transTime: 1, eventFlags: MotionFlag.Loop })!

    mix.advance(0.5)

    const held = value(mix)

    mix.stop(b)
    assert.equal(mix.playing(a), false)
    mix.advance(0.25)
    assert.equal(value(mix), held)
  })
})

describe('clock', () => {
  test('a loop wraps each channel with its overshoot', () => {
    const mix = mixer()

    mix.start(slideScript(ramp(0, 1, 1)), { eventFlags: MotionFlag.Loop })
    mix.advance(1.25)
    assert.equal(value(mix), 0.25)
  })

  test('backwards plays from the end marker down, and loops from the end', () => {
    const mix = mixer()

    mix.start(slideScript(ramp(0, 1, 1)), {
      startTime: -1,
      eventFlags: MotionFlag.Backwards | MotionFlag.Loop,
    })
    mix.advance(0.25)
    assert.equal(value(mix), 0.75)
    mix.advance(1)
    assert.equal(value(mix), 0.75)
  })

  test('backwards from 0 runs out at once', () => {
    const mix = mixer()
    const a = mix.start(slideScript(ramp(0.5, 1, 1)), { eventFlags: MotionFlag.Backwards })!

    mix.advance(0.25)
    assert.equal(value(mix), 0.5)
    assert.equal(mix.playing(a), false)
  })

  test('a bounce turns round at the end', () => {
    const mix = mixer()

    mix.start(slideScript(ramp(0, 1, 1)), { eventFlags: MotionFlag.Bounce })
    mix.advance(1.25)
    assert.equal(value(mix), 0.75)
    mix.advance(0.25)
    assert.equal(value(mix), 0.5)
  })

  test('time_scale is a speed, its sign ignored', () => {
    const mix = mixer()

    mix.start(slideScript(ramp(0, 1, 1)), { timeScale: -2, eventFlags: MotionFlag.Loop })
    mix.advance(0.25)
    assert.equal(value(mix), 0.5)
  })

  test('start_time is seconds in, and past a channel’s end the script does not start', () => {
    const mix = mixer()

    mix.start(slideScript(ramp(0, 1, 1)), { startTime: 0.5, eventFlags: MotionFlag.Loop })
    mix.advance(0.25)
    assert.equal(value(mix), 0.75)
    assert.equal(mix.start(slideScript(ramp(0, 1, 1)), { startTime: 1.5 }), undefined)
  })
})

describe('weight', () => {
  test('is an amplitude: a float scales', () => {
    const mix = mixer()

    mix.start(slideScript(constant(2)), { weight: 0.5, eventFlags: MotionFlag.Loop })
    mix.advance(0.1)
    assert.equal(value(mix), 1)
  })

  test('is an amplitude: a rotation goes part way from the identity', () => {
    const mix = mixer()
    const quarter = turnY(Math.PI / 2)

    mix.start(
      {
        name: 'look',
        maps: [{ type: 'joint', parent: 'Root', child: 'Head', channel: turn(quarter) }],
      },
      { weight: 0.5, eventFlags: MotionFlag.Loop },
    )
    mix.advance(0.1)
    nearQuat(mix.jointState('Head')?.orientation, Quat.nlerp(Quat.identity, quarter, 0.5))
  })

  test('applies again over the fade in', () => {
    const mix = mixer()

    mix.start(slideScript(constant(2)), { weight: 0.5, transTime: 1, eventFlags: MotionFlag.Loop })
    mix.advance(0.25)
    assert.equal(value(mix), Math.fround(0.5 * Math.fround(1 * EASE[63]!)))
  })
})

describe('binding', () => {
  test('a joint map binds by child and parent, and to a joint of its shape', () => {
    const mix = mixer()
    const wrongParent: AnimationScript = {
      name: 'x',
      maps: [{ type: 'joint', parent: 'Other', child: 'Slide', channel: constant(1) }],
    }
    const wrongShape: AnimationScript = {
      name: 'y',
      maps: [{ type: 'joint', parent: 'Root', child: 'Head', channel: constant(1) }],
    }
    const a = mix.start(wrongParent)!
    const b = mix.start(wrongShape)!

    mix.advance(0.1)
    assert.equal(mix.playing(a), false)
    assert.equal(mix.playing(b), false)
    assert.equal(value(mix), 0)
  })

  test('a locked joint is left be by scripts started later', () => {
    const mix = mixer()

    mix.lock('Slide')
    mix.start(slideScript(constant(1)), { eventFlags: MotionFlag.Loop })
    mix.advance(0.1)
    assert.equal(value(mix), 0)
    mix.unlock('Slide')
    mix.start(slideScript(constant(1)), { eventFlags: MotionFlag.Loop })
    mix.advance(0.1)
    assert.equal(value(mix), 1)
  })
})

const walk = (to: Vector3, { height = 0.9, rooted = true } = {}): AnimationScript => ({
  name: 'walk',
  ...(rooted ? { height } : {}),
  maps: [
    {
      type: 'object',
      object: 'Root',
      channel: {
        type: 'motion',
        interval: -1,
        position: 'vector',
        orientation: 'quaternion',
        keyframes: [
          { key: 0, position: { x: 0, y: 0.1, z: 0 }, orientation: Quat.identity },
          { key: 1, position: to, orientation: Quat.identity },
        ],
      },
    },
  ],
})

const nearVector = (actual: Vector3, expected: Vector3, epsilon = 1e-5) => {
  near(actual.x, expected.x, epsilon)
  near(actual.y, expected.y, epsilon)
  near(actual.z, expected.z, epsilon)
}

describe('root', () => {
  test('stands at Root height plus its own y over the floor, from where it was', () => {
    const mix = mixer({ position: { x: 5, y: 0, z: 7 } })

    mix.setFloor(2)
    mix.start(walk({ x: 0, y: 0.1, z: 1 }), { eventFlags: MotionFlag.Loop })
    mix.advance(0.5)
    nearVector(mix.root.position, { x: 5, y: 3, z: 7.5 })
  })

  test('set position keeps x and z, and discards y', () => {
    const mix = mixer()

    mix.start(walk({ x: 0, y: 0.1, z: 1 }), { eventFlags: MotionFlag.Loop })
    mix.advance(0.5)
    mix.setRootPosition({ x: 1, y: 100, z: 2 })
    nearVector(mix.root.position, { x: 1, y: 1, z: 2 })
    mix.advance(0.25)
    nearVector(mix.root.position, { x: 1, y: 1, z: 2.25 })
  })

  test('a loop carries the walk on from where the cycle ended', () => {
    const mix = mixer()

    mix.start(walk({ x: 0, y: 0.1, z: 1 }), { eventFlags: MotionFlag.Loop })
    mix.advance(1.25)
    nearVector(mix.root.position, { x: 0, y: 1, z: 1.25 })
  })

  test('the floor moves the root by what puts it over the new floor', () => {
    const mix = mixer()

    mix.start(walk({ x: 0, y: 0.1, z: 1 }), { eventFlags: MotionFlag.Loop })
    mix.advance(0.5)
    mix.setFloor(3)
    mix.advance(0)
    nearVector(mix.root.position, { x: 0, y: 4, z: 0.5 })
  })

  test('heading turns the walk; none keeps the root’s own yaw', () => {
    const turned = mixer()

    turned.start(walk({ x: 0, y: 0.1, z: 1 }), {
      heading: Math.PI / 2,
      eventFlags: MotionFlag.Loop,
    })
    turned.advance(0.5)
    nearVector(turned.root.position, { x: 0.5, y: 1, z: 0 })
    nearQuat(turned.root.orientation, turnY(Math.PI / 2))

    const tilted = Quat.multiply(turnY(0.3), Quat.axisAngle({ axis: Vector3.x, angle: 0.4 }))
    const kept = mixer({ orientation: tilted })

    kept.start(walk({ x: 0, y: 0.1, z: 1 }), { eventFlags: MotionFlag.Loop })
    kept.advance(0.5)
    nearQuat(kept.root.orientation, turnY(0.3), 1e-4)
  })

  test('a script with no Root height keeps the root’s height over the floor', () => {
    const mix = mixer({ position: { x: 0, y: 1.5, z: 0 } })

    mix.start(walk({ x: 0, y: 0, z: 1 }, { rooted: false }), { eventFlags: MotionFlag.Loop })
    mix.advance(0.5)
    near(mix.root.position.y, 1.5 + 0.05)
  })

  test('set orientation turns the root about where it stands', () => {
    const mix = mixer()

    mix.start(walk({ x: 0, y: 0.1, z: 1 }), { eventFlags: MotionFlag.Loop })
    mix.advance(0.5)
    mix.setRootOrientation(turnY(Math.PI / 2))
    nearVector(mix.root.position, { x: 0, y: 1, z: 0.5 })
    mix.advance(0.25)
    nearVector(mix.root.position, { x: 0.25, y: 1, z: 0.5 })
    nearQuat(mix.root.orientation, turnY(Math.PI / 2))
  })

  test('a root turned every frame from its own read-back stays a rotation', () => {
    // THN writes a character's orientation each frame from what it read back (s002xe's Lonnigan,
    // 49.47 s on). A length off by float noise must not square itself away to nothing.
    const mix = mixer()
    const step = turnY(0.002)

    mix.start(walk({ x: 0, y: 0.1, z: 1 }), { eventFlags: MotionFlag.Loop })
    mix.setRootOrientation(Vector4.multiplyScalar(turnY(0.3), 1 - 1e-6) as Quat)

    for (let frame = 0; frame < 600; frame++) {
      mix.setRootOrientation(Quat.multiply(step, mix.root.orientation))
      mix.advance(1 / 60)
    }

    const { x, y, z, w } = mix.root.orientation

    assert.ok(Math.abs(Math.hypot(x, y, z, w) - 1) < 1e-5, `length ${Math.hypot(x, y, z, w)}`)
    nearQuat(mix.root.orientation, turnY(0.3 + 600 * 0.002), 1e-4)
  })
})

describe('aim', () => {
  const lookScript = (orientation: Quat): AnimationScript => ({
    name: 'look',
    maps: [{ type: 'joint', parent: 'Root', child: 'Head', channel: turn(orientation) }],
  })
  const headOf = (mix: Mixer): JointState | undefined => mix.jointState('Head')

  test('sets the joint’s world rotation, its parent’s undone', () => {
    const mix = mixer({ orientation: turnY(0.5) })
    const aim = mix.aim('Head', { target: turnY(1) })!

    mix.advance(0.1)
    nearQuat(headOf(mix)?.orientation, turnY(0.5))
    mix.setAimTarget(aim, turnY(0.2))
    mix.advance(0.1)
    nearQuat(headOf(mix)?.orientation, turnY(-0.3))
  })

  test('locks the joint: a second aim fails, a script leaves it be, until it stops', () => {
    const mix = mixer()
    const aim = mix.aim('Head', { target: turnY(1) })!

    assert.equal(mix.aim('Head', { target: turnY(2) }), undefined)

    const look = mix.start(lookScript(turnY(-1)), { eventFlags: MotionFlag.Loop })!

    mix.advance(0.1)
    assert.equal(mix.playing(look), false)
    nearQuat(headOf(mix)?.orientation, turnY(1))
    mix.stopAim(aim)
    mix.advance(0.1)
    nearQuat(headOf(mix)?.orientation, turnY(1), 1e-6)
    assert.ok(mix.aim('Head', { target: turnY(2) }) !== undefined)
  })

  test('fades in over its transition; stopped with keep-beneath, fades back to the script', () => {
    const mix = mixer()

    mix.start(lookScript(Quat.identity), { eventFlags: MotionFlag.Loop })
    mix.advance(0.1)

    const aim = mix.aim('Head', {
      target: turnY(1),
      transitionDuration: 0.5,
      eventFlags: MotionFlag.KeepBeneath,
    })!

    mix.advance(0.25)
    nearQuat(headOf(mix)?.orientation, Quat.nlerp(Quat.identity, turnY(1), EASE[127]!))
    mix.advance(0.25)
    nearQuat(headOf(mix)?.orientation, turnY(1))
    mix.stopAim(aim)
    mix.advance(0.1)
    nearQuat(headOf(mix)?.orientation, turnY(1), 1e-6)
    mix.advance(0.25)
    nearQuat(headOf(mix)?.orientation, Quat.nlerp(turnY(1), Quat.identity, EASE[127]!))
    mix.advance(0.25)
    nearQuat(headOf(mix)?.orientation, Quat.identity)
  })

  test('refuses a joint that is not a sphere', () => {
    assert.equal(mixer().aim('Slide', { target: Quat.identity }), undefined)
  })
})
