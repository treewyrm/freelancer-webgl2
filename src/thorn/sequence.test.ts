import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix4 } from '@treewyrm/freelancer/math'
import type { Entity, Event, Script } from '@treewyrm/freelancer/thn/scene'
import { positionOf } from './frame.js'
import { anchoredFrame, readSetScript, Sequence, SequenceManager } from './sequence.js'

const marker = (name: string, x = 0, flags?: string[]): Entity => ({
  type: 'MARKER',
  entity_name: name,
  ...(flags && { flags }),
  spatialprops: { pos: { x, y: 0, z: 0 } },
})

const script = (duration: number, entities: Entity[] = [], events: Event[] = []): Script => ({
  duration,
  entities: [{ type: 'SCENE', entity_name: 'scene' }, ...entities],
  events,
})

test('entries play one after another, each as its script runs out', () => {
  const sequence = new Sequence([{ script: script(1) }, { script: script(1) }])

  sequence.play()
  assert.equal(sequence.update(1000), false)
  assert.equal(sequence.current, 1)
  assert.equal(sequence.update(1000), true)
  assert.equal(sequence.done, true)
})

test('a decision loops until answered, then takes its branch: accept skips declines, decline skips accepts', () => {
  const make = () =>
    new Sequence([
      { script: script(1), kind: 1 },
      { script: script(1), kind: 2 },
      { script: script(1), kind: 3 },
      { script: script(1), kind: 0 },
    ])
  const accepted = make()

  accepted.play()
  accepted.update(1000)
  assert.equal(accepted.current, 0)
  accepted.answer(true)
  accepted.update(16)
  assert.equal(accepted.current, 1)
  accepted.update(1000)
  assert.equal(accepted.current, 3)

  const declined = make()

  declined.play()
  declined.answer(false)
  declined.update(16)
  assert.equal(declined.current, 2)
})

test('a skip runs a cinematic out to its end, stopping before a decision', () => {
  const sequence = new Sequence(
    [
      { script: script(5) },
      { script: script(5) },
      { script: script(5), kind: 1 },
      { script: script(5), kind: 2 },
    ],
    { cinematic: true, skippable: true },
  )

  sequence.play()
  sequence.skip()
  sequence.update(16)
  assert.equal(sequence.current, 2)
  // The decision itself plays from its start.
  assert.equal(sequence.playback!.clock, 16)
})

test("a REFERENCE marker follows the exporting ambient scene's live marker, writes and all", () => {
  const manager = new SequenceManager()
  const ambient = manager.add(
    new Sequence([{ script: script(10, [marker('seat', 5)]) }], { loop: true, exported: true }),
  )
  const cutscene = manager.add(
    new Sequence(
      [
        {
          script: script(
            10,
            [marker('seat', 0, ['REFERENCE']), marker('mover')],
            [
              {
                action: 'START_SPATIAL_PROP_ANIM',
                time: 0,
                duration: 1,
                targets: ['seat'],
                spatialprops: { pos: { x: 9, y: 0, z: 0 } },
              },
            ],
          ),
        },
      ],
      {},
      () => ({ resolve: (type, name) => manager.find(type, name) }),
    ),
  )

  manager.update(1000)
  assert.deepEqual(positionOf(ambient.playback!.frameOf('seat')!), { x: 9, y: 0, z: 0 })
  assert.deepEqual(positionOf(cutscene.playback!.frame(1)), { x: 9, y: 0, z: 0 })
})

test('the set script is data: props by category, cameras that are setpoints too, and its shadow source', () => {
  const set = readSetScript(
    script(0, [
      {
        type: 'COMPOUND',
        entity_name: 'room',
        template_name: 'li_bar',
        flags: ['LIT_DYNAMIC'],
        userprops: { category: 'Room' },
      },
      { type: 'COMPOUND', entity_name: 'nocategory' },
      {
        type: 'CAMERA',
        entity_name: 'Camera_0',
        cameraprops: { fovh: 25, nearplane: 1, farplane: 900 },
      },
      marker('Zs/NPC/Bartender/01/A/Stand', 3),
      {
        type: 'LIGHT',
        entity_name: 'LtShadowSource',
        spatialprops: { pos: { x: 0, y: 10, z: 0 } },
        lightprops: { type: 'L_POINT', on: 'N', diffuse: { x: 1, y: 1, z: 1 } },
      },
      { type: 'LIGHT', entity_name: 'off', lightprops: { type: 'L_POINT', on: 'N' } },
    ]),
  )

  assert.deepEqual(
    set.props.map(({ template, main, lit }) => [template, main, lit]),
    [['li_bar', true, true]],
  )
  assert.deepEqual(
    set.cameras.map(({ name, fovh }) => [name, fovh]),
    [['Camera_0', 25]],
  )
  assert.deepEqual(
    set.setpoints.map(({ name }) => name),
    ['Camera_0', 'Zs/NPC/Bartender/01/A/Stand'],
  )
  assert.deepEqual(set.shadow?.position, { x: 0, y: 10, z: 0 })
  assert.equal(set.lights.length, 0)
})

test("a room character's script is anchored so its actor stands on the setpoint, at floor height", () => {
  const fidget = script(1, [
    {
      type: 'DEFORMABLE',
      entity_name: 'Char_vendor',
      spatialprops: { pos: { x: 2, y: 0.9, z: -1 } },
      compoundprops: { floor_height: 0.5 },
    },
  ])
  const C = anchoredFrame(Matrix4.translation({ x: 10, y: 0, z: 0 }), fidget)

  assert.deepEqual(positionOf(Matrix4.multiply(C, Matrix4.translation({ x: 2, y: 0.5, z: -1 }))), {
    x: 10,
    y: 0,
    z: 0,
  })
})
