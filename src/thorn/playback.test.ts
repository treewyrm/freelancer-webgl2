import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix4, Vector3 } from '@treewyrm/freelancer/math'
import * as thn from '@treewyrm/freelancer/thn'
import * as sceneText from '@treewyrm/freelancer/thn/scene'
import type { Entity, Event, Script } from '@treewyrm/freelancer/thn/scene'
import { eventsOf, flagWord, milliseconds } from './events.js'
import { positionOf, rotate } from './frame.js'
import { connectedFrame, Playback, replay, retailSort } from './playback.js'
import { frameMilliseconds, ScriptRun } from './script.js'

const near = (a: Vector3 | undefined, b: Vector3, e = 1e-5) =>
  assert.ok(a && Vector3.equal(a, b, e), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`)

const at = (frame: Matrix4 | undefined) => positionOf(frame ?? Matrix4.identity)

const marker = (name: string, x = 0, y = 0, z = 0): Entity => ({
  type: 'MARKER',
  entity_name: name,
  spatialprops: { pos: { x, y, z } },
})

const script = (entities: Entity[], events: Event[], duration = 10): Script => ({
  duration,
  entities: [{ type: 'SCENE', entity_name: 'scene' }, ...entities],
  events,
})

/** A spatial animation of `name` toward `pos` over `[time, time + duration]`. */
const move = (name: string, time: number, duration: number, x: number, y = 0, z = 0): Event => ({
  action: 'START_SPATIAL_PROP_ANIM',
  time,
  duration,
  targets: [name],
  spatialprops: { pos: { x, y, z } },
})

test('seconds become milliseconds at single precision, then chopped', () => {
  assert.equal(milliseconds(1.9999), 1999)
  assert.equal(milliseconds(0.7), 700)
  // 4.35 · 1000 is 4349.999… in double, and 4350 once the x87 rounds it to 24 bits.
  assert.equal(milliseconds(4.35), 4350)
})

test('USE_SCRIPT_DURATION is set when there is neither duration nor flags, and flags replace the word', () => {
  const base: Event = { action: 'ATTACH_ENTITY', time: 0, targets: ['a', 'b'] }

  assert.equal(flagWord(base), 1)
  assert.equal(flagWord({ ...base, duration: 1 }), 0)
  assert.equal(flagWord({ ...base, flags: ['POSITION', 'ORIENTATION'] }), 6)
  assert.equal(flagWord({ ...base, flags: ['USE_SCRIPT_DURATION', 'LOOK_AT'] }), 9)
})

test('the factory refuses an unresolved target, and a missing second one where it is needed', () => {
  const events = eventsOf(
    script(
      [marker('a'), marker('b')],
      [
        { action: 'ATTACH_ENTITY', time: 0, targets: ['a'] },
        { action: 'ATTACH_ENTITY', time: 0, targets: ['a', 'nobody'] },
        { action: 'START_PSYS', time: 0, targets: ['nobody'] },
        { action: 'START_PSYS', time: 0, duration: 1, targets: ['a'] },
        { action: 'START_IK', time: 0, targets: ['a', 'b'] },
      ],
    ),
  )

  assert.deepEqual(
    events.map(({ action, start }) => [action, start]),
    [
      ['START_PSYS', 0],
      // IK at 0 starts at 1 ms, after the motions.
      ['START_IK', 1],
    ],
  )
})

test('a path animation onto an entity that is not a path is parsed as an attach', () => {
  const [event] = eventsOf(
    script(
      [marker('a'), marker('b')],
      [
        {
          action: 'START_PATH_ANIMATION',
          time: 0,
          duration: 1,
          targets: ['a', 'b'],
          flags: ['POSITION'],
        },
      ],
    ),
  )

  assert.equal(event!.action, 'ATTACH_ENTITY')
})

test('a spatial animation alone lerps position exactly, whatever the steps', () => {
  const playback = new Playback(script([marker('a')], [move('a', 0, 1, 10)]))

  playback.start()
  playback.tick(250)
  near(at(playback.frameOf('a')), { x: 2.5, y: 0, z: 0 })
  playback.tick(250)
  near(at(playback.frameOf('a')), { x: 5, y: 0, z: 0 })
  playback.tick(5000)
  near(at(playback.frameOf('a')), { x: 10, y: 0, z: 0 })
})

test('a chase arrives on the arc: halfway to 90° in one step is 45°, and the end is exact', () => {
  const q = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }
  const playback = new Playback(
    script(
      [marker('a')],
      [
        {
          action: 'START_SPATIAL_PROP_ANIM',
          time: 0,
          duration: 1,
          targets: ['a'],
          spatialprops: { q_orient: q },
        },
      ],
    ),
  )

  playback.start()
  playback.tick(500)
  near(rotate(playback.frameOf('a')!, { x: 1, y: 0, z: 0 }), {
    x: Math.SQRT1_2,
    y: 0,
    z: -Math.SQRT1_2,
  })
  playback.tick(500)
  near(rotate(playback.frameOf('a')!, { x: 1, y: 0, z: 0 }), { x: 0, y: 0, z: -1 })
})

test('axisrot is relative and incremental, about the scene axis', () => {
  const playback = new Playback(
    script(
      [marker('a')],
      [
        {
          action: 'START_SPATIAL_PROP_ANIM',
          time: 0,
          duration: 1,
          targets: ['a'],
          spatialprops: { axisrot: [360, 'Y_AXIS'] },
        },
      ],
    ),
  )

  playback.start()
  playback.tick(250)
  near(rotate(playback.frameOf('a')!, { x: 1, y: 0, z: 0 }), { x: 0, y: 0, z: -1 })
  playback.tick(250)
  near(rotate(playback.frameOf('a')!, { x: 1, y: 0, z: 0 }), { x: -1, y: 0, z: 0 })
})

test('a child follows its parent in the same instant, whichever was made first', () => {
  // The child's id is lower, so its group comes first by id; the attach emits the parent's ahead.
  const playback = new Playback(
    script(
      [marker('child'), marker('parent')],
      [
        move('parent', 0, 1, 10),
        {
          action: 'ATTACH_ENTITY',
          time: 0,
          duration: 5,
          targets: ['child', 'parent'],
          flags: ['POSITION'],
          offset: { x: 0, y: 1, z: 0 },
        },
      ],
    ),
  )

  playback.start()
  playback.tick(500)
  near(at(playback.frameOf('child')), { x: 5, y: 1, z: 0 })
  assert.deepEqual(
    playback.active.map(({ action }) => action),
    ['START_SPATIAL_PROP_ANIM', 'ATTACH_ENTITY'],
  )
})

test('one jump visits every start and end on the way, so it equals any run of smaller steps', () => {
  // Except a chase after a target that moves, which depends on when it is updated.
  const make = () =>
    new Playback(
      script(
        [marker('a'), marker('b', 0, 0, 5), marker('c')],
        [
          move('a', 0, 2, 10),
          move('b', 0.3, 1, 0, 0, -3),
          {
            action: 'ATTACH_ENTITY',
            time: 0.7,
            duration: 0.6,
            targets: ['c', 'b'],
            flags: ['POSITION', 'PARENT_CHILD'],
          },
          { action: 'START_PSYS', time: 0.45, duration: 0.2, targets: ['a'] },
        ],
      ),
    )
  const once = make()

  once.start()
  once.tick(1800)

  const stepped = make()

  stepped.start()
  for (let n = 0; n < 18; n++) stepped.tick(100)
  for (const name of ['a', 'b', 'c']) near(at(once.frameOf(name)), at(stepped.frameOf(name)), 1e-4)
})

test('an attach writes once more at exactly its end, then holds; a flagged one with no duration writes once', () => {
  const playback = new Playback(
    script(
      [marker('child'), marker('parent'), marker('other')],
      [
        move('parent', 0, 1, 10),
        {
          action: 'ATTACH_ENTITY',
          time: 0,
          duration: 0.5,
          targets: ['child', 'parent'],
          flags: ['POSITION'],
        },
        { action: 'ATTACH_ENTITY', time: 0.25, targets: ['other', 'parent'], flags: ['POSITION'] },
      ],
    ),
  )

  playback.start()
  playback.tick(800)
  near(at(playback.frameOf('child')), { x: 5, y: 0, z: 0 })
  near(at(playback.frameOf('other')), { x: 2.5, y: 0, z: 0 })
})

test('an attach with neither flags nor duration never ends', () => {
  const playback = new Playback(
    script(
      [marker('child'), marker('parent')],
      [
        move('parent', 1, 1, 10),
        { action: 'ATTACH_ENTITY', time: 0, targets: ['child', 'parent'] },
      ],
    ),
  )

  playback.start()
  playback.tick(5000)
  assert.equal(playback.active.length, 1)
})

test('PARENT_CHILD keeps the offset the child had at the start', () => {
  const playback = new Playback(
    script(
      [marker('child', 3, 0, 0), marker('parent', 1, 0, 0)],
      [
        move('parent', 0, 1, 11),
        {
          action: 'ATTACH_ENTITY',
          time: 0,
          duration: 2,
          targets: ['child', 'parent'],
          flags: ['POSITION', 'ORIENTATION', 'PARENT_CHILD'],
          offset: { x: 100, y: 0, z: 0 },
        },
      ],
    ),
  )

  playback.start()
  playback.tick(1000)
  near(at(playback.frameOf('child')), { x: 13, y: 0, z: 0 })
})

test('a path animation travels the path in its frame, with LOOK_AT along the tangent', () => {
  const playback = new Playback(
    script(
      [
        marker('ship'),
        {
          type: 'MOTION_PATH',
          entity_name: 'path',
          spatialprops: { pos: { x: 0, y: 0, z: 100 } },
          pathprops: {
            path_type: 'CV_CROrientationSplinePath',
            flag: 'OPEN',
            points: [
              { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
              { position: { x: 0, y: 0, z: -10 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
            ],
          },
        },
      ],
      [
        {
          action: 'START_PATH_ANIMATION',
          time: 0,
          duration: 2,
          targets: ['ship', 'path'],
          flags: ['POSITION', 'ORIENTATION', 'LOOK_AT'],
          front: 'Z_AXIS',
          offset: { x: 1, y: 0, z: 0 },
        },
      ],
    ),
  )

  playback.start()
  playback.tick(1000)

  const ship = playback.frameOf('ship')!

  near(at(ship), { x: 1, y: 0, z: 95 })
  near(rotate(ship, { x: 0, y: 0, z: 1 }), { x: 0, y: 0, z: -1 })
})

test('past its end a script that does not loop finishes everything; a loop restarts at exactly 0', () => {
  const events = [move('a', 0, 4, 10)]
  const once = new Playback(script([marker('a')], events, 2))

  once.start()
  once.tick(2500)
  assert.equal(once.state, 'done')
  assert.equal(once.active.length, 0)
  near(at(once.frameOf('a')), { x: 6.25, y: 0, z: 0 })

  const looping = new Playback(script([marker('a')], events, 2), { loop: true })

  looping.start()
  looping.tick(2500)
  // Restarted at 0, the overshoot dropped, and no transform restored: it chases on from 6.25.
  assert.equal(looping.clock, 0)
  assert.equal(looping.state, 'looping')
  near(at(looping.frameOf('a')), { x: 6.25, y: 0, z: 0 })
  looping.tick(2000)
  near(at(looping.frameOf('a')), { x: 6.25 + (10 - 6.25) * 0.5, y: 0, z: 0 })
})

test('the game ticks 0 at start, then each frame, and 100 more on the frame that reaches the end', () => {
  const run = new ScriptRun(new Playback(script([marker('a')], [move('a', 0, 4, 10)], 2)))

  assert.equal(run.update(1000), false)
  assert.equal(run.playback.state, 'playing')
  // Lands exactly on the end, so the extra 100 ms runs in the same frame: one more update at 2100,
  // past the end, then every event finished.
  assert.equal(run.update(1000), true)
  assert.equal(run.playback.state, 'done')
  near(at(run.playback.frameOf('a')), { x: 5.25, y: 0, z: 0 })
})

test('a skip is one exact jump to the end', () => {
  const run = new ScriptRun(new Playback(script([marker('a')], [move('a', 0, 2, 10)], 2)))

  run.update(100)
  run.skip()
  assert.equal(run.update(16), true)
  near(at(run.playback.frameOf('a')), { x: 10, y: 0, z: 0 })
})

test("a frame's seconds become whole milliseconds, the rest carried", () => {
  let carry = 0
  const steps: number[] = []

  for (let n = 0; n < 6; n++) {
    const next = frameMilliseconds(carry, 1 / 60)

    steps.push(next.milliseconds)
    carry = next.carry
  }

  // 100 ms every six frames.
  assert.deepEqual(steps, [16, 17, 17, 16, 17, 17])
})

test('the compound hardpoint frame is world space, a deformable bone scene space', () => {
  const C = Matrix4.translation({ x: 100, y: 0, z: 0 })
  const hp = Matrix4.translation({ x: 0, y: 2, z: 0 })
  const playback = new Playback(
    script(
      [
        { type: 'COMPOUND', entity_name: 'ship', spatialprops: { pos: { x: 1, y: 0, z: 0 } } },
        { type: 'DEFORMABLE', entity_name: 'man', spatialprops: { pos: { x: 0, y: 0, z: 1 } } },
        { type: 'PSYS', entity_name: 'fx' },
      ],
      [],
    ),
    { frame: C, host: { hardpoint: () => hp, bone: () => hp } },
  )

  near(at(playback.part(1, 1, 'HpMount')), { x: 101, y: 2, z: 0 })
  near(at(playback.part(1, 2, 'Root')), { x: 101, y: 0, z: 0 })
  assert.equal(playback.part(1, 2, 'wing'), undefined)
  near(at(playback.part(2, 2, 'head')), { x: 0, y: 2, z: 1 })
  near(at(playback.world('ship')), { x: 101, y: 0, z: 0 })
  near(at(playback.world('fx')), { x: 0, y: 0, z: 0 })
})

test("retail's sort keeps equal keys in order up to 16, and sorts above", () => {
  const small = retailSort(
    [3, 1, 3, 2, 1].map((key, index) => ({ key, index })),
    ({ key }) => key,
  )

  assert.deepEqual(
    small.map(({ index }) => index),
    [1, 4, 3, 0, 2],
  )

  const large = retailSort(
    Array.from({ length: 40 }, (_, index) => ({ key: (index * 7) % 5, index })),
    ({ key }) => key,
  )
  for (let n = 1; n < large.length; n++) assert.ok(large[n - 1]!.key <= large[n]!.key)
})

/** The extension's `evaluate.test.ts` cases, read independently from `thorn.dll`: they must agree. */
const twoAttaches = (first: Partial<Event>): Script =>
  script(
    [marker('a', 1, 0, 0), marker('b', 0, 1, 0), marker('child')],
    [
      { action: 'ATTACH_ENTITY', time: 0, targets: ['child', 'a'], ...first } as Event,
      {
        action: 'ATTACH_ENTITY',
        time: 1,
        duration: 1,
        targets: ['child', 'b'],
        flags: ['POSITION'],
      },
    ],
    3,
  )

test('as the extension reads it: a flagged attach without duration ends at its start', () => {
  near(at(replay(twoAttaches({ flags: ['POSITION'] }), 3000).frameOf('child')), {
    x: 0,
    y: 1,
    z: 0,
  })
})

test('as the extension reads it: USE_SCRIPT_DURATION in flags never ends, whatever the duration', () => {
  const playback = replay(
    twoAttaches({ duration: 0.5, flags: ['USE_SCRIPT_DURATION', 'POSITION'] }),
    3000,
  )

  near(at(playback.frameOf('child')), { x: 1, y: 0, z: 0 })
})

test('as the extension reads it: orient triples are the columns of the rotation', () => {
  const read = sceneText.read(
    thn.read(`duration = 1
entities = {{ entity_name = "A", type = MARKER,
  spatialprops = { pos = {0, 0, 0}, orient = {{0, 1, 0}, {-1, 0, 0}, {0, 0, 1}} } }}
events = {}`),
  )
  const frame = replay(read, 0).frameOf('A')!

  near(rotate(frame, { x: 1, y: 0, z: 0 }), { x: 0, y: 1, z: 0 })
  near(rotate(frame, { x: 0, y: 1, z: 0 }), { x: -1, y: 0, z: 0 })
})

test('as the extension reads it: a mount keeps following its hardpoint after something moves it', () => {
  const playback = replay(
    script(
      [
        { type: 'COMPOUND', entity_name: 'ship' },
        { type: 'PSYS', entity_name: 'fx' },
        marker('away', 9, 9, 9),
      ],
      [
        {
          action: 'ATTACH_ENTITY',
          time: 0,
          targets: ['fx', 'ship'],
          flags: ['USE_SCRIPT_DURATION', 'POSITION', 'ORIENTATION'],
          target_type: 'HARDPOINT',
          target_part: 'HpEngine01',
        },
        {
          action: 'ATTACH_ENTITY',
          time: 1,
          duration: 1,
          targets: ['fx', 'away'],
          flags: ['POSITION'],
        },
      ],
      3,
    ),
    3000,
    { host: { hardpoint: () => Matrix4.translation({ x: 0, y: 0, z: 5 }) } },
  )

  near(at(playback.frameOf('fx')), { x: 0, y: 0, z: 5 })
})

test("a connection runs from its start to its end, and the child's hardpoint meets the parent's", () => {
  const playback = new Playback(
    script(
      [
        { type: 'COMPOUND', entity_name: 'arm' },
        { type: 'COMPOUND', entity_name: 'base' },
      ],
      [
        {
          action: 'CONNECT_HARDPOINTS',
          time: 0.5,
          duration: 1,
          targets: ['arm', 'base'],
          hardpoint: 'HpConnect01',
          parent_hardpoint: 'HpMount',
        },
      ],
    ),
  )

  playback.start()
  playback.tick(400)
  assert.equal(playback.connections.length, 0)
  playback.tick(200)
  assert.deepEqual(
    playback.connections.map(({ child, hardpoint, parent, parentHardpoint }) => [
      child,
      hardpoint,
      parent,
      parentHardpoint,
    ]),
    [['arm', 'HpConnect01', 'base', 'HpMount']],
  )
  playback.tick(1000)
  assert.equal(playback.connections.length, 0)

  const parentHp = Matrix4.translation({ x: 0, y: 3, z: 0 })
  const childHp = Matrix4.translation({ x: 1, y: 0, z: 0 })
  const child = connectedFrame(Matrix4.translation({ x: 10, y: 0, z: 0 }), parentHp, childHp)

  near(Matrix4.transformPoint({ x: 1, y: 0, z: 0 }, child), { x: 10, y: 3, z: 0 })
})

test("a connected child is drawn, and answers its hardpoints, where the parent's hardpoint holds it", () => {
  const playback = new Playback(
    script(
      [
        {
          type: 'COMPOUND',
          entity_name: 'cigarette',
          spatialprops: { pos: { x: 0, y: -100, z: 0 } },
        },
        { type: 'DEFORMABLE', entity_name: 'syd', spatialprops: { pos: { x: 10, y: 0, z: 0 } } },
      ],
      [
        {
          action: 'CONNECT_HARDPOINTS',
          time: 0,
          duration: 2,
          targets: ['cigarette', 'syd'],
          hardpoint: 'hprightconnect_cigarette',
          parent_hardpoint: 'hprightconnect',
        },
      ],
    ),
    {
      host: {
        hardpoint: (entity, name) =>
          entity === 'syd' && name === 'hprightconnect'
            ? Matrix4.translation({ x: 0, y: 1, z: 0 })
            : entity === 'cigarette' && name === 'hprightconnect_cigarette'
              ? Matrix4.translation({ x: 0.1, y: 0, z: 0 })
              : entity === 'cigarette' && name === 'hp_tip'
                ? Matrix4.translation({ x: 0.2, y: 0, z: 0 })
                : undefined,
      },
    },
  )

  playback.start()
  playback.tick(500)
  // The hand at (10, 1, 0); the cigarette's own hardpoint on it, so its root 0.1 back along X.
  near(at(playback.world('cigarette')), { x: 9.9, y: 1, z: 0 })
  near(at(playback.part(1, sceneText.data.TARGET_TYPES.HARDPOINT, 'hp_tip')), {
    x: 10.1,
    y: 1,
    z: 0,
  })
  // Thorn's own frame is left where it was: a connect is the engine's link, not thorn's.
  near(at(playback.frameOf('cigarette')), { x: 0, y: -100, z: 0 })
  playback.tick(2000)
  near(at(playback.world('cigarette')), { x: 0, y: -100, z: 0 })
})
