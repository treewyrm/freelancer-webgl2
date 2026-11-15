import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix4 } from '@treewyrm/freelancer/math'
import type { Entity, Script } from '@treewyrm/freelancer/thn/scene'
import type { SceneModel } from '#/scene/frame.js'
import { positionOf } from './frame.js'
import { readSetScript } from './sequence.js'
import { RoomStage, stageTemplates, type StageSceneHost } from './stage.js'

const marker = (name: string, x = 0, flags?: string[]): Entity => ({
  type: 'MARKER',
  entity_name: name,
  ...(flags && { flags }),
  spatialprops: { pos: { x, y: 0, z: 0 } },
})

const camera = (name: string, x: number): Entity => ({
  type: 'CAMERA',
  entity_name: name,
  spatialprops: { pos: { x, y: 0, z: 0 } },
  cameraprops: { fovh: 30, nearplane: 1, farplane: 500 },
})

const compound = (name: string, category: string | undefined, flags?: string[]): Entity => ({
  type: 'COMPOUND',
  entity_name: name,
  template_name: name.toUpperCase(),
  ...(flags && { flags }),
  ...(category && { userprops: { category } }),
})

const script = (duration: number, entities: Entity[] = []): Script => ({
  duration,
  entities: [{ type: 'SCENE', entity_name: 'scene' }, ...entities],
  events: [],
})

const model: SceneModel = {
  parts: [],
  mesh: () => undefined,
  material: () => undefined,
  texture: () => undefined,
}

test('scene lines start by group, ambient then traffic then once, each behind its setting', () => {
  const [once, ambient, traffic, gated] = [script(1), script(1), script(1), script(1)]
  const stage = new RoomStage({
    scenes: [
      { mode: 'once', script: once },
      { mode: 'ambient', script: ambient },
      { mode: 'traffic', script: traffic },
      { mode: 'ambient', script: gated, setting: 'TRAFFIC_PRIORITY' },
    ],
    spawn: { rtc: [{ name: 'traffic_priority', threshold: 0.51 }], slider: 0.5 },
  })

  assert.deepEqual(
    stage.manager.sequences.map(({ entries }) => entries[0]!.script),
    [ambient, traffic, once],
  )
  assert.deepEqual(
    stage.manager.sequences.map(({ flags, entries }) => [
      flags.exported ?? false,
      flags.loop ?? false,
      entries[0]!.kind ?? 0,
    ]),
    [
      [true, true, 0],
      [false, false, 5],
      [false, false, 0],
    ],
  )
  assert.deepEqual(stage.skipped, ['scene ambient: TRAFFIC_PRIORITY is off'])
})

test("a REFERENCE with nothing exporting it lands on the set script's setpoint", () => {
  const stage = new RoomStage({
    set: readSetScript(script(0, [marker('seat', 4)])),
    scenes: [{ mode: 'once', script: script(10, [marker('seat', 0, ['REFERENCE'])]) }],
  })

  stage.update(16)
  assert.deepEqual(positionOf(stage.manager.sequences[0]!.playback!.frame(1)), {
    x: 4,
    y: 0,
    z: 0,
  })
})

test("a REFERENCE falls back to the set script's last setpoint of its name, ignoring case", () => {
  const stage = new RoomStage({
    set: readSetScript(
      script(0, [
        marker('Zs/NPC/Equipment/01/A/Stand', 1),
        marker('ZS/NPC/EQUIPMENT/01/A/STAND', 4),
      ]),
    ),
    scenes: [
      {
        mode: 'once',
        script: script(10, [marker('Zs/NPC/equipment/01/A/Stand', 0, ['REFERENCE'])]),
      },
    ],
  })
  const playback = stage.manager.sequences[0]!.playback!

  assert.equal(positionOf(playback.world('Zs/NPC/equipment/01/A/Stand')!).x, 4)
})

test("the view is the room's [Camera], else the set script's first", () => {
  const set = readSetScript(script(0, [camera('Camera_0', 1), camera('Camera_1', 2)]))

  assert.equal(new RoomStage({ set, camera: 'Camera_1' }).view(4 / 3).position.x, 2)
  assert.equal(new RoomStage({ set, camera: 'missing' }).view(4 / 3).position.x, 1)
  assert.equal(new RoomStage({ set }).view(4 / 3).fovh, 30)
})

test('a frame asks the host for every prop and spawned compound, and says what it could not get', () => {
  const asked: string[] = []
  const host: StageSceneHost = {
    model: (category, template) => {
      asked.push(`${category} ${template}`)
      return template === 'MISSING' ? undefined : model
    },
  }
  const stage = new RoomStage({
    set: readSetScript(script(0, [compound('room', 'Room'), compound('missing', 'Prop')])),
    scenes: [{ mode: 'ambient', script: script(10, [compound('ship', 'Spaceship')]) }],
    animated: true,
  })

  stage.update(16)

  const { scene, skipped } = stage.scene(host, { aspect: 1 })

  assert.deepEqual(asked, ['Room ROOM', 'Prop MISSING', 'Spaceship SHIP'])
  assert.equal(scene.objects.length, 2)
  assert.deepEqual(skipped, ['prop MISSING: Prop'])

  asked.length = 0
  // Still: an animated room's main prop moves, so it is left out; nothing the scripts spawn either.
  stage.scene(host, { aspect: 1, still: true, playing: false })
  assert.deepEqual(asked, ['Prop MISSING'])
})

test('a character is placed by the host where its playback stands it', () => {
  const placed: [string, Matrix4][] = []
  const stage = new RoomStage({
    scenes: [
      {
        mode: 'ambient',
        script: script(10, [
          {
            type: 'DEFORMABLE',
            entity_name: 'barkeep',
            template_name: 'li_bartender',
            spatialprops: { pos: { x: 3, y: 0, z: 0 } },
          },
        ]),
      },
    ],
  })

  stage.update(16)

  const { scene } = stage.scene(
    {
      model: () => undefined,
      character: (entity, world) => {
        placed.push([entity, world])
        return [model, model]
      },
    },
    { aspect: 1 },
  )

  assert.equal(placed[0]![0], 'barkeep')
  assert.equal(placed[0]![1].w.x, 3)
  assert.equal(scene.objects.length, 2)
})

test('the templates a room can ask for: its props and every compound but a REFERENCE, each once', () => {
  const set = readSetScript(script(0, [compound('room', 'Room')]))

  assert.deepEqual(
    stageTemplates(set, [
      script(1, [compound('ship', 'Spaceship'), compound('room', 'Room', ['REFERENCE'])]),
      script(1, [compound('SHIP', 'Spaceship'), compound('nocategory', undefined)]),
    ]),
    [
      { category: 'Room', template: 'ROOM' },
      { category: 'Spaceship', template: 'SHIP' },
    ],
  )
})
