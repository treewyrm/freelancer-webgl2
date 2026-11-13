import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix4, Vector3 } from '@treewyrm/freelancer/math'
import type { Entity, Event, Script } from '@treewyrm/freelancer/thn/scene'
import { lightOf, NO_FOG, roomFogOf } from './light.js'
import { replay } from './playback.js'
import { renderTypeOf, roomEntities, rtcEnabled, spawns } from './room.js'

const close = (a: number, b: number, e = 1e-5) => assert.ok(Math.abs(a - b) <= e, `${a} ≠ ${b}`)
const near = (a: Vector3 | undefined, b: Vector3, e = 1e-5) =>
  assert.ok(a && Vector3.equal(a, b, e), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`)

const spot: Entity = {
  type: 'LIGHT',
  entity_name: 'spot',
  lt_grp: 2,
  spatialprops: {
    pos: { x: 1, y: 2, z: 3 },
    orient: { x: { x: 0, y: 0, z: -1 }, y: { x: 0, y: 1, z: 0 }, z: { x: 1, y: 0, z: 0 } },
  },
  lightprops: {
    on: 'Y',
    color: { x: 255, y: 0, z: 0 },
    diffuse: { x: 0.5, y: 0.5, z: 0.5 },
    specular: { x: 0, y: 0, z: 0 },
    ambient: { x: 0.2, y: 0.1, z: 0 },
    direction: { x: 0, y: 0, z: 1 },
    range: 50,
    cutoff: 40,
    type: 'L_SPOT',
    theta: 20,
    atten: { x: 1, y: 0, z: 0 },
  },
}

const script = (entities: Entity[], events: Event[] = []): Script => ({
  duration: 10,
  entities: [
    { type: 'SCENE', entity_name: 'scene', ambient: { x: 40, y: 50, z: 60 } },
    ...entities,
  ],
  events,
})

test('a light block with a type takes its D3D values; theta and cutoff become radians', () => {
  const light = lightOf(spot.type === 'LIGHT' ? spot.lightprops : undefined)

  assert.equal(light.type, 2)
  close(light.theta, (20 * Math.PI) / 180)
  close(light.phi, (40 * Math.PI) / 180)
  // `color` reaches nothing once there is a type.
  near(light.diffuse, { x: 0.5, y: 0.5, z: 0.5 })
})

test('with no type, the legacy keys make the light: a negative cutoff a point, colour its diffuse', () => {
  const light = lightOf({ color: { x: 255, y: 51, z: 0 }, cutoff: -1, range: 10 })

  assert.equal(light.type, 1)
  near(light.diffuse, { x: 1, y: 0.2, z: 0 })
  assert.equal(light.range, 20)
  near(light.atten, { x: 1, y: 0, z: 0.04 })
})

test("the room's light shines along its frame's turn of direction, at thorn's position, C not applied", () => {
  const playback = replay(script([spot]), 0, { frame: Matrix4.translation({ x: 100, y: 0, z: 0 }) })
  const [light] = playback.roomLights()

  assert.equal(light!.group, 2)
  near(light!.position, { x: 1, y: 2, z: 3 })
  // The typed orient holds rows, so its third column, local Z, is scene −X.
  near(light!.direction, { x: -1, y: 0, z: 0 })
  near(light!.ambient, { x: 0.2, y: 0.1, z: 0 })
  close(light!.spot!.phi, (40 * Math.PI) / 180)
})

test('a light animation lerps by u, unclamped, and turns off only at the end; its type never changes the room light', () => {
  const events: Event[] = [
    {
      action: 'START_LIGHT_PROP_ANIM',
      time: 0,
      duration: 1,
      targets: ['spot'],
      lightprops: { diffuse: { x: 1, y: 1, z: 1 }, on: 'N', type: 'L_POINT' },
    },
  ]
  const half = replay(script([spot], events), 500)

  near(half.roomLights()[0]!.color, { x: 0.75, y: 0.75, z: 0.75 })
  assert.ok(half.roomLights()[0]!.spot)

  const done = replay(script([spot], events), 1000)

  assert.equal(done.roomLights().length, 0)
})

test('fog starts off whatever the scene writes, and a fog animation sets it, mode and on at the end', () => {
  const foggy: Script = {
    ...script([]),
    entities: [
      {
        type: 'SCENE',
        entity_name: 'scene',
        fog: { fogon: 'Y', fogmode: 'F_LINEAR', fogend: 100 },
      },
    ],
    events: [
      {
        action: 'START_FOG_PROP_ANIM',
        time: 0,
        duration: 2,
        targets: ['scene'],
        fogprops: {
          fogon: 'Y',
          fogmode: 'F_LINEAR',
          fogcolor: { x: 255, y: 101, z: 0 },
          fogstart: 10,
          fogend: 110,
        },
      },
    ],
  }

  assert.equal(replay(foggy, 0).roomFog, undefined)

  const shared = { state: NO_FOG }

  replay(foggy, 1000, { fog: shared })
  assert.equal(shared.state.on, false)
  assert.deepEqual(shared.state.color, { x: 127, y: 50, z: 0 })
  assert.equal(shared.state.end, 55)

  const done = replay(foggy, 2000, { fog: shared })

  assert.deepEqual(done.roomFog, {
    color: { x: 1, y: 101 / 255, z: 0 },
    start: 10,
    end: 110,
    mode: 'linear',
    density: 0,
  })
  assert.equal(roomFogOf(shared.state, false), undefined)
  assert.equal(
    replay(foggy, 2000, { fog: { state: NO_FOG }, fogEnabled: false }).roomFog,
    undefined,
  )
})

test('the slider gates by priority, set at or above, set_less below; a missing name is on', () => {
  const rtc = [
    { name: 'Monitor_Moving', threshold: 0.51 },
    { name: 'monitor_static', threshold: 0.51, less: true },
    { name: 'script_particles', threshold: 0.17 },
  ]

  assert.equal(rtcEnabled(rtc, 1, 'monitor_moving'), true)
  assert.equal(rtcEnabled(rtc, 1, 'Monitor_Static'), false)
  assert.equal(rtcEnabled(rtc, 0.2, 'Monitor_Static'), true)
  assert.equal(rtcEnabled(rtc, 0, 'unheard_of'), true)

  const psys: Entity = { type: 'PSYS', entity_name: 'fx' }

  assert.equal(spawns(psys, { rtc, slider: 0.1 }), false)
  assert.equal(
    spawns({ ...psys, userprops: { Priority: 'monitor_moving' } }, { rtc, slider: 0.6 }),
    true,
  )
})

test("the player's ship takes black ambient whatever its flags", () => {
  const ship = (template: string, category: string) =>
    roomEntities(
      replay(
        script([
          {
            type: 'COMPOUND',
            entity_name: 'ship',
            template_name: template,
            flags: ['LIT_AMBIENT'],
            userprops: { category },
          },
        ]),
        0,
      ),
    )[0]!.object.visible

  assert.equal(ship('PlayerShip', 'Spaceship'), false)
  assert.equal(ship('ge_fighter', 'Spaceship'), true)
  assert.equal(ship('PlayerShip', 'Prop'), true)
})

test('a compound carries its flags, layer, light group, render type and scene ambient onto its room object', () => {
  const playback = replay(
    script([
      {
        type: 'COMPOUND',
        entity_name: 'sky',
        template_name: 'skydome_x',
        srt_grp: -100,
        lt_grp: 3,
        usr_flg: 3,
        flags: ['LIT_AMBIENT'],
        userprops: { category: 'Prop', NoFog: 'Y' },
      },
      { type: 'COMPOUND', entity_name: 'ref', flags: ['REFERENCE'] },
      {
        type: 'DEFORMABLE',
        entity_name: 'man',
        usr_flg: 1,
        flags: ['LIT_DYNAMIC'],
        userprops: { running_lights: 'true' },
      },
    ]),
    0,
  )
  const [sky, man] = roomEntities(playback)

  assert.equal(sky!.template, 'skydome_x')
  assert.equal(sky!.category, 'Prop')
  assert.equal(sky!.sky, 'backdrop')
  assert.deepEqual(sky!.object, {
    position: { x: 0, y: 0, z: 0 },
    layer: -100,
    lightGroup: 3,
    visible: true,
    lit: false,
    fog: false,
    ambient: { x: 40, y: 50, z: 60 },
  })
  assert.equal(man!.template, 'man')
  assert.equal(man!.sky, undefined)
  assert.equal(man!.runningLights, true)
  assert.equal(man!.object.lit, true)
  assert.equal(renderTypeOf({ type: 'COMPOUND', entity_name: 'x', usr_flg: 1 }), 'starsphere')
})
