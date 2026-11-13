import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Material } from '@treewyrm/freelancer/material'
import { Matrix3, Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import {
  Primitive,
  type VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import { EffectInstance } from '#/alchemy/effect.js'
import { emitter, sceneOf as fixtureScene } from '#/alchemy/fixtures.js'
import { RETAIL_FLARE_LIGHT } from './flare.js'
import { FlashLight } from './flashlight.js'
import type { Frame, SceneModel } from './frame.js'
import {
  collectRoomFrame,
  lightRoomObject,
  lightScore,
  pickRoomLights,
  type RoomLight,
  type RoomObject,
  type RoomScene,
} from './room.js'

const reference: VMeshRef = {
  meshId: 1,
  vertexStart: 0,
  vertexCount: 3,
  indexStart: 0,
  indexCount: 3,
  groupStart: 0,
  groupCount: 1,
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
  boundingSphere: { center: { x: 0, y: 0, z: 0 }, radius: 1 },
}

const mesh: VMeshData = {
  name: 'mesh',
  version: 1,
  primitive: Primitive.TriangleList,
  format: 0x112 as VertexFormat,
  groups: [{ materialId: 7, vertexStart: 0, vertexEnd: 2, elementCount: 3, padding: 0 }],
  indices: new Uint16Array([0, 1, 2]),
  vertices: new Uint8Array(96),
}

const modelOf = (name: string, z: number, fields: Partial<Material> = {}): SceneModel => ({
  parts: [{ reference, world: Matrix4.translation({ x: 0, y: 0, z }) }],
  mesh: () => mesh,
  material: () => ({ name, type: 'DcDt', ...fields }),
  texture: () => undefined,
})

// Straight ahead of the camera, which looks down -Z from the origin, `distance` away.
const objectOf = (name: string, distance = 10, fields: Partial<RoomObject> = {}): RoomObject => ({
  model: modelOf(name, -distance),
  position: { x: 0, y: 0, z: -distance },
  ...fields,
})

const sceneOf = (objects: RoomObject[], fields: Partial<RoomScene> = {}): RoomScene => ({
  camera: {
    position: { x: 0, y: 0, z: 0 },
    orientation: Matrix3.identity,
    fovh: 30,
    near: 1,
    far: 1000,
  },
  aspect: 1,
  lights: [],
  objects,
  ...fields,
})

const names = ({ draws }: Frame) => draws.map(({ materialName }) => materialName)

const ORIGIN: Vector3 = { x: 0, y: 0, z: 0 }
const DOWN: Vector3 = { x: 0, y: -1, z: 0 }

const point = (x: number, range: number, fields: Partial<RoomLight> = {}): RoomLight => ({
  color: { x: 1, y: 1, z: 1 },
  direction: DOWN,
  position: { x, y: 0, z: 0 },
  range,
  group: 0,
  ...fields,
})

test('a light scores 3 directional, else 2 less its distance squared over its range squared', () => {
  assert.equal(lightScore({ color: ORIGIN, direction: DOWN }, ORIGIN), 3)
  assert.equal(lightScore(point(5, 10), ORIGIN), 2 - 25 / 100)
  // No range, not picked; out of range, picked all the same.
  assert.equal(lightScore(point(5, 0), ORIGIN), undefined)
  assert.equal(lightScore(point(20, 10), ORIGIN), 2 - 4)
})

test('a spot outside its half cone scores the cosine for the 2', () => {
  // Shining down from 10 above: the origin is on its axis, the point 10 across is 45° off.
  const spot = (phi: number): RoomLight => ({
    ...point(0, 100),
    position: { x: 0, y: 10, z: 0 },
    spot: { theta: phi / 2, phi, falloff: 1 },
  })
  const across = { x: 10, y: 0, z: 0 }

  assert.equal(lightScore(spot(Math.PI / 4), ORIGIN), Math.fround(2 - 100 / 10000))

  // Phi is the full angle: 60° holds 30° about its axis, and 45° off takes the cosine.
  const outside = lightScore(spot(Math.PI / 3), across)!

  assert.equal(outside, Math.fround(Math.fround(10 / Math.sqrt(200)) - 200 / 10000))
  assert.equal(lightScore(spot((Math.PI * 2) / 3), across), Math.fround(2 - 200 / 10000))
})

test("an object takes its group's four best lights, a later one before an equal one", () => {
  const lights = [
    point(1, 10, { color: { x: 1, y: 0, z: 0 } }),
    point(9, 10),
    point(2, 10, { group: 3 }),
    point(1, 10, { color: { x: 0, y: 1, z: 0 } }),
    point(5, 10),
    point(3, 10),
    point(7, 10),
  ]
  const picked = pickRoomLights(lights, ORIGIN, 0)

  assert.deepEqual(
    picked.map(({ position, color }) => [position!.x, color.x]),
    [
      [1, 0],
      [1, 1],
      [3, 1],
      [5, 1],
    ],
  )
  assert.equal('group' in picked[0]!, false)
  assert.deepEqual(
    pickRoomLights(lights, ORIGIN, 3).map(({ position }) => position!.x),
    [2],
  )
})

test('a light with a black diffuse still lights, its ambient and all', () => {
  // `li01_01_bar`'s `ambi_LtG09_SET_Amb_Drct`: no diffuse, a 0.31 ambient. Retail applies it (`s004x_bar`).
  const black = { x: 0, y: 0, z: 0 }
  const lights = [
    point(1, 10, { color: black }),
    point(2, 10),
    point(3, 10),
    point(4, 10),
    point(5, 10),
  ]

  assert.deepEqual(
    pickRoomLights(lights, ORIGIN, 0).map(({ position }) => position!.x),
    [1, 2, 3, 4],
  )
})

test("an object's ambient: the room's, its scene's, black when hidden, as bytes", () => {
  const room = { lights: [point(1, 10)], ambient: { x: 51, y: 102, z: 300 } }
  const lit = lightRoomObject(room, objectOf('a'))

  // 300 keeps its low byte, as `GfSetSceneAmbient` stores it.
  assert.deepEqual(lit.ambient, { x: 0.2, y: 0.4, z: 44 / 255 })
  assert.equal(lit.lights.length, 1)
  assert.deepEqual(
    lightRoomObject(room, objectOf('a', 10, { ambient: { x: 255, y: 0, z: 0 } })).ambient,
    {
      x: 1,
      y: 0,
      z: 0,
    },
  )
  assert.deepEqual(lightRoomObject(room, objectOf('a', 10, { visible: false })).ambient, ORIGIN)
  assert.deepEqual(lightRoomObject({ lights: [] }, objectOf('a')).ambient, { x: 1, y: 1, z: 1 })
  assert.deepEqual(lightRoomObject(room, objectOf('a', 10, { lit: false })).lights, [])
})

test('the fog reaches an object unless it says not', () => {
  const fog = { color: ORIGIN, start: 0, end: 100, mode: 'exp' as const, density: 0.01 }

  assert.equal(lightRoomObject({ lights: [], fog }, objectOf('a')).fog, fog)
  assert.equal(
    lightRoomObject({ lights: [], fog }, objectOf('a', 10, { fog: false })).fog,
    undefined,
  )
  assert.equal(lightRoomObject({ lights: [] }, objectOf('a')).fog, undefined)
})

test('objects draw by signed layer, in the order made within one', () => {
  const frame = collectRoomFrame(
    sceneOf([
      objectOf('zero a'),
      objectOf('two', 10, { layer: 2 }),
      objectOf('minus one', 10, { layer: 255 }),
      objectOf('zero b'),
      objectOf('minus two', 10, { layer: -2 }),
    ]),
  )

  assert.deepEqual(names(frame), ['minus two', 'minus one', 'zero a', 'zero b', 'two'])
})

test('glass waits for every object, far before near, and keeps its own object’s light', () => {
  const glass = (name: string, distance: number, layer: number, x: number) =>
    objectOf(name, distance, {
      layer,
      model: modelOf(name, -distance, { type: 'DcDtOcOt', opacity: 0.5 }),
      ambient: { x, y: 0, z: 0 },
    })
  const frame = collectRoomFrame(
    sceneOf([
      glass('near', 10, -1, 255),
      objectOf('solid', 20, { layer: 1 }),
      glass('far', 50, 0, 51),
    ]),
  )

  assert.deepEqual(names(frame), ['solid', 'far', 'near'])
  assert.deepEqual(
    frame.draws.map(({ sceneAmbient }) => sceneAmbient?.x),
    [1, 0.2, 1],
  )
})

test("each draw carries its object's lights and fog; the frame's are white and none", () => {
  const fog = { color: ORIGIN, start: 0, end: 100 }
  const frame = collectRoomFrame(
    sceneOf([objectOf('lit'), objectOf('unfogged', 10, { fog: false, lightGroup: 1 })], {
      lights: [point(0, 100)],
      fog,
    }),
  )
  const [lit, unfogged] = frame.draws

  assert.equal(lit!.lights!.length, 1)
  assert.equal(lit!.fog, fog)
  assert.deepEqual(unfogged!.lights, [])
  assert.equal(unfogged!.fog, undefined)
  assert.deepEqual(frame.ambient, { x: 1, y: 1, z: 1 })
  assert.deepEqual(frame.lights, [])
})

test("a starsphere keeps the sky's white and no lights", () => {
  const sky = objectOf('sky', 10, { model: { ...modelOf('sky', 0), sky: 'starsphere' } })
  const [draw] = collectRoomFrame(sceneOf([sky], { ambient: ORIGIN })).draws

  assert.deepEqual(draw!.sceneAmbient, { x: 1, y: 1, z: 1 })
  assert.equal(draw!.lightless, true)
})

test("effects walk objects' by layer, then the scripts'", () => {
  const order: string[] = []
  const { scene } = fixtureScene([{ node: emitter('emitter') }])

  const running = (name: string) => ({
    instance: new EffectInstance(scene),
    texture: () => undefined,
    visible: () => {
      order.push(name)
      return true
    },
  })

  collectRoomFrame(
    sceneOf(
      [
        objectOf('a', 10, { effects: [running('a flame')] }),
        objectOf('b', 10, { layer: -1, effects: [running('b left'), running('b right')] }),
      ],
      { effects: [running('psys')] },
    ),
  )
  assert.deepEqual(order, ['b left', 'b right', 'a flame', 'psys'])
})

const shadowed = (
  name: string,
  fading: boolean,
  height: number,
  fields: Partial<RoomObject> = {},
) =>
  objectOf(name, 10, {
    shadow: {
      fading,
      floor: 0,
      world: Matrix4.translation({ x: 0, y: height, z: -10 }),
      ...(fading && { bounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 1, z: 1 } } }),
    },
    ...fields,
  })

test('a shadow draws just before its object, and only with the room’s shadows on', () => {
  const objects = [objectOf('plain'), shadowed('ship', true, 10), shadowed('pilot', false, 0)]
  const shadows = { texture: {} as Texture }

  assert.deepEqual(names(collectRoomFrame(sceneOf(objects, { shadows }))), [
    'plain',
    'efxshadow',
    'ship',
    'efxshadow',
    'pilot',
  ])
  assert.deepEqual(names(collectRoomFrame(sceneOf(objects))), ['plain', 'ship', 'pilot'])
})

test('a fixed shadow takes the scale the last fading one left, and the frame passes it on', () => {
  const shadows = { texture: {} as Texture, scale: 3 }

  const width = (frame: Frame, at: number) => {
    const floats = new Float32Array(frame.draws[at]!.mesh.vertices.buffer)

    return floats[2 * 6]! - floats[0]!
  }

  const first = collectRoomFrame(sceneOf([shadowed('pilot', false, 0)], { shadows }))

  assert.ok(Math.abs(width(first, 0) - 1.12 * 3) < 1e-5)
  assert.equal(first.shadowScale, 3)

  const after = collectRoomFrame(
    sceneOf([shadowed('ship', true, 10), shadowed('pilot', false, 0)], { shadows }),
  )

  assert.ok(Math.abs(after.shadowScale - 0.96) < 1e-6)
  assert.ok(Math.abs(width(after, 2) - 1.12 * 0.96) < 1e-5)
})

test('a shadow is fogged as the object before it left the device', () => {
  const fog = { color: ORIGIN, start: 0, end: 100 }
  const shadows = { texture: {} as Texture }
  const frame = collectRoomFrame(
    sceneOf(
      [
        shadowed('first', false, 0),
        objectOf('unfogged', 10, { fog: false }),
        shadowed('second', false, 0),
      ],
      { shadows, fog },
    ),
  )

  assert.deepEqual(names(frame), ['efxshadow', 'first', 'unfogged', 'efxshadow', 'second'])
  assert.equal(frame.draws[0]!.fog, fog)
  assert.equal(frame.draws[3]!.fog, undefined)
})

test("flashlights draw after the glass's flush: objects' by layer, then the room's, with textures", () => {
  const light = (x: number) => {
    const made = FlashLight.fromLight({ ...RETAIL_FLARE_LIGHT, color: { x: 1, y: 0, z: 0 } })

    made.world = Matrix4.translation({ x, y: 0, z: -10 })
    return made
  }

  const textures = { shine: {} as Texture, bulb: {} as Texture }
  const glass = objectOf('glass', 10, {
    model: modelOf('glass', -10, { type: 'DcDtOcOt', opacity: 0.5 }),
    flashlights: [light(1)],
  })
  const prop = objectOf('prop', 10, { layer: -1, flashlights: [light(2)] })
  const frame = collectRoomFrame(
    sceneOf([glass, prop], { flashlights: [light(3)], flashlightTextures: textures }),
  )
  const firstX = (draw: Frame['draws'][number]) => new Float32Array(draw.mesh.vertices.buffer)[0]

  assert.deepEqual(names(frame), [
    'prop',
    'glass',
    'shine',
    'bulb',
    'shine',
    'bulb',
    'shine',
    'bulb',
  ])
  // The prop's layer comes first, then the glass's, then the room's: each quad's first corner is
  // its light's x less its size of 1.
  assert.deepEqual(
    frame.draws.slice(2).map((draw) => firstX(draw)! + 1),
    [2, 2, 1, 1, 3, 3],
  )
  assert.deepEqual(names(collectRoomFrame(sceneOf([glass, prop]))), ['prop', 'glass'])
})

test("an object's flashlights stop at 32", () => {
  const many = Array.from({ length: 40 }, () =>
    FlashLight.fromLight({ ...RETAIL_FLARE_LIGHT, color: { x: 1, y: 0, z: 0 } }),
  )
  const frame = collectRoomFrame(
    sceneOf([objectOf('prop', 10, { flashlights: many })], {
      flashlightTextures: { shine: {} as Texture, bulb: {} as Texture },
    }),
  )

  assert.equal(frame.draws[1]!.count, 32 * 6)
})

test("with a viewport, a part covering under a pixel of the room camera isn't drawn", () => {
  const objects = [objectOf('near', 10), objectOf('speck', 990)]
  const viewport = { width: 640, height: 480 }

  assert.deepEqual(names(collectRoomFrame(sceneOf(objects, { viewport }))), ['near'])
  assert.deepEqual(names(collectRoomFrame(sceneOf(objects))), ['near', 'speck'])
})
