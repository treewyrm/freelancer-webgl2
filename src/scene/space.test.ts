import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Material } from '@treewyrm/freelancer/material'
import { Matrix3, Matrix4, Quat, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture, TextureEntry } from '@treewyrm/freelancer/texture'
import {
  Primitive,
  type VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import { EffectInstance } from '#/alchemy/effect.js'
import { emitter, sceneOf as fixtureScene } from '#/alchemy/fixtures.js'
import { projectionMatrix } from './camera.js'
import { type Frame, type SceneModel } from './frame.js'
import type { SpaceLight } from './light.js'
import { Clouds, RING_CLOUD_VISIBILITY } from './clouds.js'
import type { SpaceAsteroidField } from './asteroids.js'
import { AsteroidBand } from './band.js'
import { buildRing, textureShape, type PlanetRing } from './ring.js'
import { LightBlink, RETAIL_FLARE_LIGHT, type SpaceFlare } from './flare.js'
import { NebulaLightning } from './lightning.js'
import { zoneOf, type SpaceNebula } from './nebula.js'
import { NebulaExterior } from './exterior.js'
import {
  collectSpaceFrame,
  skyLayers,
  type SpaceLimits,
  type SpaceObject,
  type SpaceScene,
} from './space.js'

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
const objectOf = (
  name: string,
  distance: number,
  fields: Partial<SpaceObject> = {},
): SpaceObject => {
  const position: Vector3 = { x: 0, y: 0, z: -distance }
  return {
    model: modelOf(name, -distance),
    position,
    sphere: { center: position, radius: 1 },
    ...fields,
  }
}

const sceneOf = (objects: SpaceObject[], fields: Partial<SpaceScene> = {}): SpaceScene => ({
  camera: {
    position: { x: 0, y: 0, z: 0 },
    orientation: Matrix3.identity,
    fovh: 30,
    near: 1,
    far: 1,
  },
  aspect: 1,
  ambient: { x: 0, y: 0, z: 0 },
  lights: [],
  objects,
  ...fields,
})

const names = ({ draws }: Frame) => draws.map(({ materialName }) => materialName)
const collected = (objects: SpaceObject[], fields?: Partial<SpaceScene>) =>
  names(collectSpaceFrame(sceneOf(objects, fields)))

test('each list drains far to near, whatever order the host gives', () => {
  const objects = [objectOf('near', 100), objectOf('far', 900), objectOf('middle', 500)]
  assert.deepEqual(collected(objects), ['far', 'middle', 'near'])
})

test('the far plane is space_farclip, or 21000, and the draw range ends 1000 short of it', () => {
  const { projection } = collectSpaceFrame(sceneOf([]))
  const camera = sceneOf([]).camera
  assert.deepEqual(projection, projectionMatrix({ ...camera, far: 21000 }, 1))
  const small = collectSpaceFrame(sceneOf([], { farClip: 5000 }))
  assert.deepEqual(small.projection, projectionMatrix({ ...camera, far: 5000 }, 1))
  // `FUN_00410150` keeps it at 1000 or more.
  const least = collectSpaceFrame(sceneOf([], { farClip: 10 }))
  assert.deepEqual(least.projection, projectionMatrix({ ...camera, far: 1000 }, 1))

  assert.deepEqual(collected([objectOf('ship', 4999)], { farClip: 6000 }), ['ship'])
  assert.deepEqual(collected([objectOf('ship', 5000)], { farClip: 6000 }), [])
})

test('past the range only a solar draws, first, with no depth and on a far plane of 250000', () => {
  const frame = collectSpaceFrame(
    sceneOf([
      objectOf('near', 500),
      objectOf('ship', 30000),
      objectOf('solar', 30000, { solar: { large: true } }),
    ]),
  )
  assert.deepEqual(names(frame), ['solar', 'near'])
  const [solar, near] = frame.draws
  assert.equal(solar!.depthFunc, 'always')
  assert.equal(solar!.depthWrite, false)
  const camera = sceneOf([]).camera
  assert.deepEqual(solar!.projection, projectionMatrix({ ...camera, far: 250000 }, 1))
  // `DrainMeshAndAsteroids` leaves `ZFUNC` 4 for the near lists.
  assert.equal(near!.depthFunc, 'lequal')
  assert.equal(near!.depthWrite, true)
  assert.equal(near!.projection, undefined)
})

test('a large solar far beyond the far plane culls against 250000, and past it is gone', () => {
  const large = { solar: { large: true } }
  assert.deepEqual(collected([objectOf('in', 249000, large)]), ['in'])
  assert.deepEqual(collected([objectOf('out', 251000, large)]), [])
})

test('a small solar comes from a query of 10000 about the camera, reaching its radius', () => {
  const solar = { solar: {} }
  assert.deepEqual(collected([objectOf('solar', 10001, solar)]), [])
  assert.deepEqual(collected([objectOf('solar', 10000, solar)]), ['solar'])
  // A ship has no such limit, only the draw range.
  assert.deepEqual(collected([objectOf('ship', 15000)]), ['ship'])
  assert.deepEqual(collected([objectOf('solar', 15000, { solar: { large: true } })]), ['solar'])
})

test('a planet sorts by its surface, its radius squared off the key', () => {
  const planet = objectOf('planet', 1000, {
    solar: { large: true, planet: true },
    sphere: { center: { x: 0, y: 0, z: -1000 }, radius: 900 },
  })
  // 1000² - 900² puts it nearer than a ship at 500, but a plain solar there stays behind.
  assert.deepEqual(collected([planet, objectOf('ship', 500)]), ['ship', 'planet'])
  const plain = { ...planet, solar: { large: true } }
  assert.deepEqual(collected([plain, objectOf('ship', 500)]), ['planet', 'ship'])
})

test('a nomad object drains after everything else, far to near, on the far list unmoved', () => {
  const nomad = { nomad: true }
  const objects = [
    objectOf('nomad near', 100, nomad),
    objectOf('ship near', 200),
    objectOf('nomad far', 800, nomad),
    objectOf('solar', 30000, { solar: { large: true }, nomad: true }),
  ]
  assert.deepEqual(collected(objects), ['solar', 'ship near', 'nomad far', 'nomad near'])
})

test('each object flushes its batched glass before the next object draws', () => {
  const withGlass = (name: string, distance: number): SpaceObject => {
    const object = objectOf(name, distance)
    return {
      ...object,
      model: {
        ...object.model,
        parts: [{ reference: { ...reference, groupCount: 2 }, world: Matrix4.identity }],
        mesh: () => ({
          ...mesh,
          groups: [mesh.groups[0]!, { ...mesh.groups[0]!, materialId: 8 }],
          indices: new Uint16Array([0, 1, 2, 0, 1, 2]),
        }),
        material: (id) =>
          id === 7
            ? { name: `${name} glass`, type: 'DcDtOcOt', opacity: 0.5 }
            : { name: `${name} hull`, type: 'DcDt' },
      },
    }
  }
  // In a room both queues would wait for the end: `ku_dragon_pair`.
  assert.deepEqual(collected([withGlass('near', 100), withGlass('far', 500)]), [
    'far hull',
    'far glass',
    'near hull',
    'near glass',
  ])
})

test('distance_render ends the reflection and lets LODranges apply; inside it they do not', () => {
  const ship = (distance: number) => {
    const object = objectOf('ship', distance, { distanceRender: 200, lodRange: 100 })
    return { ...object, model: { ...object.model, environment: 'envmapbasic', texture: cube } }
  }
  const cube = (() => ({ type: 'cube' })) as unknown as (name: string) => TextureEntry
  const within = collectSpaceFrame(sceneOf([ship(150)])).draws[0]!
  assert.equal(within.environment, 'envmapbasic')
  // Past `distance_render` it has reached past `lodRange` too.
  assert.deepEqual(collected([ship(250)]), [])
  const wide = objectOf('ship', 250, { distanceRender: 200, lodRange: 500 })
  const past = collectSpaceFrame(
    sceneOf([{ ...wide, model: { ...wide.model, environment: 'envmapbasic', texture: cube } }]),
  ).draws[0]!
  assert.equal(past.environment, undefined)
  assert.deepEqual(collected([objectOf('ship', 600, { lodRange: 500 })]), [])
  assert.deepEqual(collected([objectOf('ship', 400, { lodRange: 500 })]), ['ship'])
})

test('a pilot draws before its ship, under its lights, and only while the ship reflects', () => {
  const ship = (distance: number) =>
    objectOf('ship', distance, { distanceRender: 200, pilot: modelOf('pilot', -distance) })
  assert.deepEqual(collected([ship(150)]), ['pilot', 'ship'])
  assert.deepEqual(collected([ship(250)]), ['ship'])
  const light: SpaceLight = {
    type: 'point',
    position: { x: 0, y: 0, z: -150 },
    color: { x: 255, y: 0, z: 0 },
    range: 100,
  }
  const [pilot, hull] = collectSpaceFrame(sceneOf([ship(150)], { lights: [light] })).draws
  assert.equal(pilot!.lights!.length, 1)
  assert.deepEqual(pilot!.lights, hull!.lights)
})

test('what is attached draws after its object, under its lights, flags and reflection', () => {
  const cube = (() => ({ type: 'cube' })) as unknown as (name: string) => TextureEntry
  const turret = modelOf('turret', -150)
  const ship = (distance: number) => {
    const object = objectOf('ship', distance, {
      distanceRender: 200,
      attached: [turret, modelOf('other', -distance)],
    })
    return { ...object, model: { ...object.model, environment: 'envmapbasic', texture: cube } }
  }
  assert.deepEqual(collected([ship(150)]), ['ship', 'turret', 'other'])
  // The turret's own library has no cube: the object's is used.
  const [, near] = collectSpaceFrame(sceneOf([ship(150)])).draws
  assert.equal(near!.environment, 'envmapbasic')
  assert.ok(near!.environmentTexture)
  const [, far] = collectSpaceFrame(sceneOf([ship(250)])).draws
  assert.equal(far!.environment, undefined)
  // Its part behind the camera still draws when the object's sphere is wholly inside.
  const behind = {
    ...turret,
    parts: [{ reference, world: Matrix4.translation({ x: 0, y: 0, z: 100 }) }],
  }
  assert.deepEqual(collected([objectOf('ship', 100, { attached: [behind] })]), ['ship', 'turret'])
})

test('lights flare after the effects, newest-linked first, only from what drew at the first tier', () => {
  const light = {
    ...RETAIL_FLARE_LIGHT,
    color: { x: 1, y: 1, z: 1 },
    glowColor: { x: 1, y: 1, z: 1 },
    // No bulb, so each light is one quad.
    bulbSize: 0,
    glowSize: 1,
  }
  // Each light tells itself apart by how far right it stands.
  const flareAt = (distance: number, x: number): SpaceFlare => ({
    light,
    world: Matrix4.translation({ x, y: 0, z: -distance }),
  })
  const shine = { texture: {} as Texture }
  const viewport = { width: 1000, height: 1000 }
  const xs = (objects: SpaceObject[], fields: Partial<SpaceScene> = {}) =>
    collectSpaceFrame(sceneOf(objects, { shine, viewport, ...fields })).screenQuads?.[0]?.quads.map(
      ({ x0, x1 }) => Math.round((x0 + x1) / 2),
    )
  const far = objectOf('far', 100, { flares: [flareAt(100, 0), flareAt(100, 5)] })
  const near = objectOf('near', 50, { flares: [flareAt(50, -5)] })
  // `far` drains first and links its two, each to the front, then `near` links its one in front.
  // 866 pixels a unit at unit depth, from a half fov of 30 on a 1000-pixel viewport.
  const scale = 500 / Math.tan(Math.PI / 6)
  const at = (x: number, distance: number) => Math.round(499.5 + (x * scale) / (distance * 0.999))
  assert.deepEqual(xs([near, far]), [at(-5, 50), at(5, 100), at(0, 100)])
  // Past `distance_render`, the second tier: its lights aren't linked.
  const tiered = { ...far, distanceRender: 50 }
  assert.equal(xs([tiered])?.length, undefined)
  // No viewport, no flares; no texture, reported.
  assert.equal(collectSpaceFrame(sceneOf([far], { shine })).screenQuads, undefined)
  assert.deepEqual(collectSpaceFrame(sceneOf([far], { viewport })).unsupported, ['texture shine'])
})

test("a light blinks by the frame's step, held to 0.1, and only while its object draws", () => {
  const light = { ...RETAIL_FLARE_LIGHT, avgDelay: 2, blinkDuration: 1 }
  const blink = () =>
    new LightBlink(
      light,
      (() => {
        const values = [16384, 0]
        return () => values.shift() ?? 0
      })(),
    )
  const drawn = blink()
  const hidden = blink()
  const flare = (b: LightBlink): SpaceFlare => ({ light, world: Matrix4.identity, blink: b })
  const seen = objectOf('seen', 100, { flares: [flare(drawn)] })
  const behind = {
    ...objectOf('behind', 100, { flares: [flare(hidden)] }),
    sphere: { center: { x: 0, y: 0, z: 100 }, radius: 1 },
  }
  collectSpaceFrame(sceneOf([seen, behind], { step: 0.5 }))
  // A rate of 0.5 a second, for 0.1 of a second.
  assert.ok(Math.abs(drawn.phase - 0.05) < 1e-6, `${drawn.phase}`)
  assert.equal(hidden.phase, 0)
})

test("a ring's pieces join the lists: near ones keyed past their radius, far ones on the far plane", () => {
  const shape = textureShape({ name: 'rings', width: 64, height: 64 } as Texture, {})
  // A ring about the camera's line of sight, flat across it, far ahead.
  const ringAt = (distance: number, radius: number, x = 0) =>
    buildRing(
      { shape, segments: 8 },
      {
        type: 'ring',
        center: { x, y: 0, z: -distance },
        orientation: Quat.axisAngle({ axis: { x: 1, y: 0, z: 0 }, angle: Math.PI / 2 }),
        radius,
        innerRadius: radius / 2,
        height: 10,
      },
    )
  const frame = (ring: PlanetRing, objects: SpaceObject[] = []) =>
    collectSpaceFrame(sceneOf(objects, { rings: [ring] }))
  // The draw range, 20000, less 5000: past 15000 a piece goes to the far list, with no depth.
  const far = frame(ringAt(18000, 200))
  assert.equal(far.draws.length, 8)
  assert.ok(far.draws.every((draw) => draw.depthFunc === 'always' && draw.projection))
  const near = frame(ringAt(1000, 200))
  assert.ok(near.draws.every((draw) => draw.depthFunc === 'lequal' && !draw.projection))
  // Sorted far to near with objects: one at 900 draws after every piece, one at 1100 before.
  assert.deepEqual(
    names(frame(ringAt(1000, 200), [objectOf('nearer', 900), objectOf('farther', 1100)])),
    ['farther', ...Array(8).fill('ring'), 'nearer'],
  )
  // Off to one side, half in view: the pieces past the frustum's edge are left out.
  const aside = frame(ringAt(3000, 2000, 2500))
  assert.ok(aside.draws.length > 0 && aside.draws.length < 8, `${aside.draws.length}`)
  // Behind the camera, none.
  assert.equal(frame(ringAt(-3000, 2000)).draws.length, 0)
})

test('what the object sphere misses draws nothing, wholly inside skips each part test', () => {
  assert.deepEqual(
    collected([
      { ...objectOf('behind', 100), sphere: { center: { x: 0, y: 0, z: 100 }, radius: 1 } },
    ]),
    [],
  )
  // Its part is behind the camera, but the sphere says it's in view: `kDrawNoCull`.
  const object = objectOf('inside', 100)
  const moved = {
    ...object,
    model: {
      ...object.model,
      parts: [{ reference, world: Matrix4.translation({ x: 0, y: 0, z: 100 }) }],
    },
  }
  assert.deepEqual(collected([moved]), ['inside'])
  const crossing = { ...moved, sphere: { center: object.position, radius: 90 } }
  assert.deepEqual(collected([crossing]), [])
})

test('a space frame passes the frame limits on to its models', () => {
  const object = objectOf('glass', 100)
  const glass = {
    ...object,
    model: {
      ...object.model,
      material: () => ({ name: 'glass', type: 'GlassMaterial', opacity: 0.5 }),
    },
  }
  const draws = collectSpaceFrame(sceneOf([glass], { limits: { glassLeastAlpha: 0.2 } })).draws
  assert.deepEqual(
    draws.map(({ diffuse }) => diffuse[3]),
    [0.5, 0.5],
  )
})

test('each object is lit by the lights that reach it, and the frame keeps the system ambient', () => {
  const light = {
    type: 'point' as const,
    position: { x: 0, y: 0, z: -100 },
    color: { x: 255, y: 255, z: 255 },
    range: 50,
  }
  const frame = collectSpaceFrame(
    sceneOf([objectOf('near', 100), objectOf('far', 900)], {
      lights: [light],
      ambient: { x: 51, y: 102, z: 153 },
    }),
  )
  const [far, near] = frame.draws
  assert.deepEqual(far!.lights, [])
  assert.equal(near!.lights!.length, 1)
  assert.deepEqual(near!.sceneAmbient, { x: 0.2, y: 0.4, z: 0.6 })
  assert.deepEqual(frame.ambient, { x: 0.2, y: 0.4, z: 0.6 })
  assert.deepEqual(frame.lights, [])
})

// A sphere nebula on the camera's axis, `z` along it: what's in front is negative.
const nebulaAt = (
  z: number,
  radius: number,
  distance: number,
  fields: Partial<SpaceNebula> = {},
): SpaceNebula => ({
  zone: zoneOf({ type: 'sphere', center: { x: 0, y: 0, z }, radius }),
  fog: { distance, color: { x: 0.5, y: 0.25, z: 1 } },
  ...fields,
})

// A box 20 wide around the axis, from `back` to `front`: what's 20 to the side is out of it.
const slabOf = (back: number, front: number, distance: number): SpaceNebula => ({
  zone: zoneOf({
    type: 'box',
    center: { x: 0, y: 0, z: (back + front) / 2 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    size: { x: 20, y: 20, z: back - front },
  }),
  fog: { distance, color: { x: 0, y: 0, z: 0 } },
})

// 100 away, and beside the axis.
const besideOf = (name: string, fields: Partial<SpaceObject> = {}): SpaceObject => {
  const position: Vector3 = { x: 20, y: 0, z: -98 }
  return { ...objectOf(name, 100), position, sphere: { center: position, radius: 1 }, ...fields }
}

// From outside: whatever is 200 to 400 in front is in it, a half at 100 and 300.
const AHEAD = nebulaAt(-200, 150, 100)
// From outside, nearer than `AHEAD`: the one the camera answers to when both are there.
const BEHIND = nebulaAt(150, 20, 100)
// Holds 300 to its middle (a half), and 310 a quarter.
const AROUND_300 = nebulaAt(-260, 60, 40)

test('a mod can change each limit, and what it leaves stays retail', () => {
  const solar = { solar: { large: true } }
  // The default far plane and the margin, so the draw range.
  assert.deepEqual(collected([objectOf('ship', 25000)], { limits: { farClip: 31000 } }), ['ship'])
  assert.deepEqual(
    collected([objectOf('ship', 4500)], { farClip: 5000, limits: { rangeMargin: 100 } }),
    ['ship'],
  )
  // A system's own value still wins over the default, and the least is a limit of its own.
  const camera = sceneOf([]).camera
  const least = collectSpaceFrame(sceneOf([], { farClip: 10, limits: { leastFarClip: 50 } }))
  assert.deepEqual(least.projection, projectionMatrix({ ...camera, far: 50 }, 1))
  // The far list's plane.
  const limits = { farListPlane: 500000 }
  const far = collectSpaceFrame(sceneOf([objectOf('out', 400000, solar)], { limits }))
  assert.deepEqual(names(far), ['out'])
  assert.deepEqual(far.draws[0]!.projection, projectionMatrix({ ...camera, far: 500000 }, 1))
  // How far a small solar is looked for.
  const small = objectOf('solar', 15000, { solar: {} })
  assert.deepEqual(collected([small], { limits: { solarQueryRange: 20000 } }), ['solar'])
  // How near leaves a field's list: at 300 it now joins the main list, behind the main object at 400.
  const objects = [objectOf('main', 400), objectOf('in field', 300)]
  const nebulae = [AROUND_300]
  assert.deepEqual(collected(objects, { nebulae }), ['in field', 'main'])
  assert.deepEqual(collected(objects, { nebulae, limits: { nearDistance: 350 } }), [
    'main',
    'in field',
  ])
  // How deep in another nebula still draws.
  const other = [objectOf('deep', 300)]
  assert.deepEqual(collected(other, { nebulae: [AROUND_300, BEHIND] }), [])
  const deeper = { nebulae: [AROUND_300, BEHIND], limits: { otherFieldDepth: 0.75 } }
  assert.deepEqual(collected(other, deeper), ['deep'])
  // Where its far plane is in a core.
  const core = { nebulae: [nebulaAt(0, 1000, 100)] }
  const clamped = (fields: Partial<SpaceLimits>) =>
    collectSpaceFrame(sceneOf([], { ...core, limits: fields })).projection
  assert.deepEqual(clamped({}), projectionMatrix({ ...camera, far: 5000 }, 1))
  assert.deepEqual(clamped({ nebulaLeastFar: 300 }), projectionMatrix({ ...camera, far: 600 }, 1))
  const margin = { nebulaLeastFar: 300, nebulaFarMargin: 900 }
  assert.deepEqual(clamped(margin), projectionMatrix({ ...camera, far: 1000 }, 1))
  // A fog with no distance of its own.
  const unset = { zone: core.nebulae[0]!.zone, fog: { color: { x: 0, y: 0, z: 0 } } }
  const fallback = { nebulae: [unset], limits: { nebulaLeastFar: 0, nebulaFogDistance: 800 } }
  const fallbackFrame = collectSpaceFrame(sceneOf([], fallback))
  assert.deepEqual(fallbackFrame.projection, projectionMatrix({ ...camera, far: 1300 }, 1))
})

test('outside a field, what is in it drains before the main list, unless near', () => {
  const objects = [objectOf('main', 900), objectOf('in field', 300), objectOf('near in field', 100)]
  // At 100 it left the field's list for the main one, where it's nearest of all.
  assert.deepEqual(collected(objects, { nebulae: [AHEAD] }), ['in field', 'main', 'near in field'])
})

test('outside a field, what is fully in it is hidden, and so is another nebula past a quarter', () => {
  const core = [nebulaAt(-300, 250, 100)]
  assert.deepEqual(collected([objectOf('core', 300)], { nebulae: core }), [])
  const nebulae = [AROUND_300, BEHIND]
  assert.deepEqual(collected([objectOf('deep', 300)], { nebulae }), [])
  assert.deepEqual(collected([objectOf('shallow', 310)], { nebulae }), ['shallow'])
})

test('outside a field a nomad object in it draws only near: list 4 is never walked', () => {
  const nebulae = [AHEAD]
  assert.deepEqual(collected([objectOf('nomad', 300, { nomad: true })], { nebulae }), [])
  assert.deepEqual(collected([objectOf('nomad', 100, { nomad: true })], { nebulae }), ['nomad'])
})

test('in a field its edge drains main lists first, then its own and its nomads', () => {
  const objects = [
    objectOf('in field', 300),
    objectOf('main', 900),
    objectOf('nomad', 400, { nomad: true }),
    objectOf('nomad in field', 300, { nomad: true }),
    besideOf('near'),
  ]
  // Near, in a field or not, joins the field's list once the camera is in one. The fog overlay
  // falls between the main lists and the field's.
  assert.deepEqual(collected(objects, { nebulae: [slabOf(50, -350, 100)] }), [
    'main',
    'nomad',
    'fog overlay',
    'in field',
    'near',
    'nomad in field',
  ])
})

test("a nebula's sheets: outside before its field's list, in its edge after the main lists", () => {
  const filled = (nebula: SpaceNebula, name: string): SpaceNebula => ({
    ...nebula,
    fill: textureShape({ name, width: 64, height: 64 } as Texture, {}),
  })
  // The one the camera answers to, from outside: before its own list, on the far plane, unfogged.
  const ahead = filled(AHEAD, 'ahead')
  const objects = [objectOf('main', 900), objectOf('in field', 300), objectOf('near in field', 100)]
  const outside = collectSpaceFrame(sceneOf(objects, { nebulae: [ahead] }))
  assert.deepEqual(names(outside), ['fill sheets', 'in field', 'main', 'near in field'])
  const sheets = outside.draws[0]!
  const camera = sceneOf([]).camera
  assert.deepEqual(sheets.projection, projectionMatrix({ ...camera, far: 250000 }, 1))
  assert.deepEqual([sheets.depthFunc, sheets.depthWrite, sheets.fog], ['always', false, undefined])

  // Every other is a far node, keyed by the squared distance to its surface: behind's after a solar
  // 30000 off. Ahead's surface is nearer, so the camera still answers to it.
  const solar = objectOf('solar', 30000, { solar: { large: true } })
  const both = collectSpaceFrame(
    sceneOf([solar, ...objects], { nebulae: [ahead, filled(BEHIND, 'behind')] }),
  )
  assert.deepEqual(
    both.draws.map(({ materialName, texture }) =>
      materialName === 'fill sheets' ? texture!.name : materialName,
    ),
    ['solar', 'behind', 'ahead', 'in field', 'main', 'near in field'],
  )

  // In its edge, after the main lists and before the overlay; in its core, none.
  const edge = [objectOf('main', 900), objectOf('in field', 300)]
  const slab = { ...slabOf(50, -350, 100), fill: ahead.fill! }
  assert.deepEqual(collected(edge, { nebulae: [slab] }), [
    'main',
    'fill sheets',
    'fog overlay',
    'in field',
  ])
  const core = { ...slabOf(350, -650, 100), fill: ahead.fill! }
  assert.ok(!collected(edge, { nebulae: [core, ahead] }).includes('fill sheets'))
})

test("a nebula's bits: after its field's list from outside, after the overlay in its edge", () => {
  const shape = textureShape(
    { name: 'bits', width: 64, height: 64, format: 'rgba32_8888' } as Texture,
    {},
  )
  const fill = textureShape({ name: 'fill', width: 64, height: 64 } as Texture, {})
  const withBits = (nebula: SpaceNebula): SpaceNebula => ({
    ...nebula,
    fill,
    exterior: new NebulaExterior(
      { shapes: [shape], bitRadius: 5, color: { x: 1, y: 1, z: 1 }, planeSlices: 1, maxBits: 8 },
      nebula.zone,
    ),
  })
  const objects = [objectOf('main', 900), objectOf('in field', 300)]
  // From outside: its sheets, its list, then its bits, before the main list.
  assert.deepEqual(collected(objects, { nebulae: [withBits(AHEAD)], cut: true }), [
    'fill sheets',
    'in field',
    'nebula exterior',
    'main',
  ])
  // Another, on the far list: its sheets, then its bits.
  const far = withBits(nebulaAt(-30000, 2000, 100))
  const both = collected(objects, { nebulae: [withBits(AHEAD), far], cut: true })
  assert.deepEqual(both.slice(0, 2), ['fill sheets', 'nebula exterior'])
  // In its edge: the main lists, its sheets, the overlay, its bits, then its own list.
  const slab = withBits(slabOf(50, -350, 100))
  assert.deepEqual(collected(objects, { nebulae: [slab], cut: true }), [
    'main',
    'fill sheets',
    'fog overlay',
    'nebula exterior',
    'in field',
  ])
})

test('at its edge, what it fully holds shows only within the fog', () => {
  // The camera is 600 in, short of the fog's 700, which ends 700 away.
  const nebulae = [nebulaAt(-700, 1300, 700)]
  assert.deepEqual(collected([objectOf('held', 600)], { nebulae }), ['fog overlay', 'held'])
  assert.deepEqual(collected([objectOf('held', 800)], { nebulae }), ['fog overlay'])
})

test('in its core: no sky, no far list, only what it holds, and its own far plane', () => {
  const sky = [{ ...modelOf('stars', 0), sky: 'starsphere' as const }]
  const objects = [
    objectOf('held', 300),
    besideOf('out'),
    objectOf('solar', 30000, { solar: { large: true } }),
  ]
  const nebulae = [slabOf(350, -650, 100)]
  const frame = collectSpaceFrame(sceneOf(objects, { sky, nebulae }))
  // The frame the camera reaches the core still draws the overlay, at full; the next doesn't.
  assert.deepEqual(names(frame), ['fog overlay', 'held'])
  assert.deepEqual(collected(objects, { sky, nebulae }), ['held'])
  // The fog ends 100 in, and the least far plane is 5000.
  assert.deepEqual(frame.projection, projectionMatrix({ ...sceneOf([]).camera, far: 5000 }, 1))
  // A far beyond the system's is cut back.
  const wide = collectSpaceFrame(sceneOf([], { nebulae: [nebulaAt(0, 100000, 30000)] }))
  assert.deepEqual(wide.projection, projectionMatrix({ ...sceneOf([]).camera, far: 21000 }, 1))
})

test('what a nebula holds is fogged in its colour, to its depth in it, and nothing else is', () => {
  const frame = collectSpaceFrame(
    sceneOf([objectOf('out', 900), objectOf('in', 300)], { nebulae: [AHEAD] }),
  )
  const named = (name: string) => frame.draws.find(({ materialName }) => materialName === name)
  const [out, held] = [named('out'), named('in')]
  assert.equal(out!.fog, undefined)
  // From 50 out, the fog starts at its surface and is whole a fog distance on. Half in, four
  // times as far.
  assert.deepEqual(held!.fog, { color: { x: 127 / 255, y: 63 / 255, z: 1 }, start: 50, end: 600 })
  assert.equal(frame.effectFog, undefined)
  assert.deepEqual(frame.background, { x: 0, y: 0, z: 0 })
})

test('in a nebula effects are fogged to black, and deep in it the clear is its fog', () => {
  // 600 in, of a fog 700 deep.
  const edge = collectSpaceFrame(sceneOf([], { nebulae: [nebulaAt(-700, 1300, 700)] }))
  const end = Math.fround(700 / Math.fround(600 / 700) ** 2)
  assert.deepEqual(edge.effectFog, { color: { x: 0, y: 0, z: 0 }, start: 0, end })
  assert.deepEqual(edge.background, { x: 0, y: 0, z: 0 })
  const deep = collectSpaceFrame(sceneOf([], { nebulae: [nebulaAt(0, 1000, 100)] }))
  assert.deepEqual(deep.effectFog, { color: { x: 0, y: 0, z: 0 }, start: 0, end: 100 })
  assert.deepEqual(deep.background, { x: 127 / 255, y: 63 / 255, z: 1 })
})

test("deep in a nebula its lightning flashes the clear and lights what's there", () => {
  const lightning = new NebulaLightning({}, () => 0x4000)
  const nebulae = [nebulaAt(0, 1000, 100, { lightning })]
  const at = (step?: number) =>
    collectSpaceFrame(sceneOf([objectOf('held', 300)], { nebulae, step }))
  // With no step the wait never ends.
  const still = at()
  assert.deepEqual(still.background, { x: 127 / 255, y: 63 / 255, z: 1 })
  const held = (frame: Frame) => frame.draws.find(({ materialName }) => materialName === 'held')!
  assert.deepEqual(held(still).lights, [])
  const flashing = at(1.5)
  assert.deepEqual(flashing.background, { x: 143 / 255, y: 79 / 255, z: 1 })
  // A quarter's intensity, by half of a half, down -Z.
  assert.deepEqual(held(flashing).lights, [
    { color: { x: 15 / 255, y: 15 / 255, z: 15 / 255 }, direction: { x: 0, y: 0, z: -1 } },
  ])
})

test("a nebula's ambient pulls the system's towards it, as far as the object is in", () => {
  const nebulae = [nebulaAt(-200, 150, 100, { ambient: { x: 255, y: 0, z: 0 } })]
  const ambient = { x: 51, y: 102, z: 153 }
  const frame = collectSpaceFrame(sceneOf([objectOf('in', 300)], { nebulae, ambient }))
  assert.deepEqual(frame.draws[0]!.sceneAmbient, { x: 153 / 255, y: 51 / 255, z: 77 / 255 })
})

test('star_sphere picks complex or basic stars, never both, and nebulae last', () => {
  assert.deepEqual(skyLayers(1), ['complex', 'nebulae'])
  assert.deepEqual(skyLayers(0.75), ['basic', 'nebulae'])
  assert.deepEqual(skyLayers(0.5), ['nebulae'])
  assert.deepEqual(skyLayers(0.001), [])
})

test('the sky draws before the far list', () => {
  const sky = [{ ...modelOf('stars', 0), sky: 'starsphere' as const }]
  const solar = objectOf('solar', 30000, { solar: { large: true } })
  assert.deepEqual(collected([solar, objectOf('ship', 100)], { sky }), ['stars', 'solar', 'ship'])
})

test('a far solar in any nebula is left out', () => {
  const solar = objectOf('solar', 30000, { solar: { large: true } })
  assert.deepEqual(collected([solar], { nebulae: [nebulaAt(-30000, 50, 100)] }), [])
})

test('effects walk by type, in the order given within one, and 0x2b never', () => {
  const order: string[] = []
  const { scene } = fixtureScene([{ node: emitter('emitter') }])
  const running = (name: string, type: number) => ({
    type,
    instance: new EffectInstance(scene),
    texture: () => undefined,
    visible: () => {
      order.push(name)
      return true
    },
  })
  collectSpaceFrame(
    sceneOf([], {
      effects: [
        running('beam', 0x2c),
        running('skipped', 0x2b),
        running('a', 3),
        running('b', 3),
        running('first', 0),
      ],
    }),
  )
  assert.deepEqual(order, ['first', 'a', 'b', 'beam'])
})

test('with no field and no objects a frame still clears and runs its hooks', () => {
  const frame = collectSpaceFrame(sceneOf([], { background: { x: 0.1, y: 0.2, z: 0.3 } }))
  assert.deepEqual(frame.background, { x: 0.1, y: 0.2, z: 0.3 })
  assert.deepEqual(
    frame.hooks.map(({ name }) => name),
    ['begin', 'opaque', 'end'],
  )
})

test('a placed effect out of view is not drawn, and the frame says what became of each', () => {
  const { scene } = fixtureScene([{ node: emitter('emitter') }])
  const drawn: string[] = []
  const running = (name: string, fields: object = {}) => ({
    type: 0,
    instance: new EffectInstance(scene),
    texture: () => undefined,
    visible: () => (drawn.push(name), true),
    ...fields,
  })
  const frame = collectSpaceFrame(
    sceneOf([], {
      effects: [
        running('behind', { position: { x: 0, y: 0, z: 100 } }),
        running('ahead', { position: { x: 0, y: 0, z: -100 } }),
        running('unplaced'),
      ],
    }),
  )
  assert.deepEqual(drawn, ['ahead', 'unplaced'])
  assert.deepEqual(frame.effectViews, [
    { fate: 'die', lod: 1 },
    { fate: 'draw', lod: 1 },
    undefined,
  ])
})

test("a ring's clouds draw after the main list, only while the camera is in it, and never in a field", () => {
  const texture = { name: 'wisps', width: 64, height: 64 } as Texture
  const shape = textureShape(texture, {})
  // A flat ring about the camera, its band from 50 to 1000 out: the camera stands in its hole
  // unless moved back 500 into the band.
  const ringOf = () => {
    const ring = buildRing(
      { shape, segments: 8 },
      {
        type: 'ring',
        center: { x: 0, y: 0, z: 0 },
        orientation: Quat.identity,
        radius: 1000,
        innerRadius: 50,
        height: 500,
      },
    )
    const clouds = new Clouds(
      { puffCount: 10, puffRadius: 5, shapes: [shape], maxDistance: 100, nearFade: [1, 2] },
      { visibility: RING_CLOUD_VISIBILITY },
    )
    return { ...ring, clouds: [clouds] }
  }
  const inBand = (ring: PlanetRing, fields: Partial<SpaceScene> = {}) =>
    names(
      collectSpaceFrame(
        sceneOf([objectOf('main', 300), objectOf('nomad', 200, { nomad: true })], {
          rings: [ring],
          cut: true,
          ...fields,
        }),
      ),
    ).filter((name) => name !== 'ring')
  const moved = (ring: PlanetRing) => ({
    camera: {
      position: { x: 0, y: 0, z: 500 },
      orientation: Matrix3.identity,
      fovh: 30,
      near: 1,
      far: 1,
    },
    rings: [ring],
  })
  assert.deepEqual(inBand(ringOf(), moved(ringOf())), ['main', 'clouds', 'nomad'])
  // In the hole, well inside its inner edge less the transition: not in it, so no clouds.
  assert.deepEqual(inBand(ringOf()), ['main', 'nomad'])
  // In a nebula's field, none.
  const field = nebulaAt(0, 5000, 100)
  assert.ok(!inBand(ringOf(), { ...moved(ringOf()), nebulae: [field] }).includes('clouds'))
})

/** A field 3000 ahead, of radius 1000, with no cube near: its band and an exclusion band inside. */
const bandedField = (own: boolean, renderParts = 1): SpaceAsteroidField => {
  const position = { x: 0, y: 0, z: -3000 }
  const texture = { name: 'belt', width: 1, height: 1 } as Texture
  const band = (radius: number, offset: number) =>
    new AsteroidBand(
      {
        shape: textureShape(texture, {}),
        vertIncrease: 4,
        renderParts,
        offset: { distance: offset },
        fade: [0.1, 0.2, 100, 110],
      },
      {
        position,
        orientation: Quat.identity,
        size: { x: radius, y: 0, z: 0 },
        diffuse: { x: 1, y: 1, z: 1 },
        ambient: { x: 1, y: 1, z: 1 },
      },
    )
  return {
    zone: zoneOf({ type: 'sphere', center: position, radius: 1000 }),
    cubeSize: 1,
    fillDistance: 0,
    cube: { mesh, reference, material: () => undefined, texture: () => undefined },
    diffuse: { x: 1, y: 1, z: 1 },
    ambient: { x: 1, y: 1, z: 1 },
    ...(own ? { band: band(1000, 0) } : {}),
    // An exclusion zone of 300 about the same centre, its band 500 out from it.
    exclusionBands: [band(300, -500)],
  }
}

/** Each band draw's highest vertex alpha. */
const bandAlphas = (frame: Frame) =>
  frame.draws
    .filter(({ materialName }) => materialName === 'band')
    .map(({ mesh: { vertices } }) =>
      Math.max(...Array.from({ length: vertices.length / 24 }, (_, at) => vertices[at * 24 + 15]!)),
    )

test("an exclusion band is held under how near the field the camera is; the field's own isn't", () => {
  const at = (z: number) =>
    bandAlphas(
      collectSpaceFrame(
        sceneOf([], {
          camera: { ...sceneOf([]).camera, position: { x: 0, y: 0, z } },
          asteroids: [bandedField(true)],
        }),
      ),
    )
  // 500 past the field's surface: half.
  assert.deepEqual(at(-1500).sort(), [127, 255])
  // 1000 past it and more: the exclusion band draws nothing.
  assert.deepEqual(at(-900), [255])
})

test("a field's pieces are numbered through: its own band's, then each exclusion band's", () => {
  // Two pieces, each listed by its own sphere: both draw.
  const frame = collectSpaceFrame(
    sceneOf([], {
      camera: { ...sceneOf([]).camera, position: { x: 0, y: 0, z: -1500 } },
      asteroids: [bandedField(true)],
    }),
  )
  assert.equal(bandAlphas(frame).length, 2)
  // An exclusion band alone, of one piece: the one-piece node, keyed by the field's surface.
  const alone = collectSpaceFrame(
    sceneOf([objectOf('beyond', 2500)], {
      camera: { ...sceneOf([]).camera, position: { x: 0, y: 0, z: -1500 } },
      asteroids: [bandedField(false)],
    }),
  )
  assert.deepEqual(bandAlphas(alone), [127])
  // Keyed 500 out from the zone's surface, squared, but no nearer than a quarter of the range: drawn
  // before what's 1000 off.
  assert.deepEqual(names(alone), ['band', 'beyond'])
})

test("in a nebula's exclusion zone its shell draws, tinted, as clear as the camera is near its edge", () => {
  // A hole of 600 about the camera, its last fifth an edge; the shell's model is one part.
  const hole = zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: 600 })
  const tint = { x: 0.25, y: 0.5, z: 1 }
  const worlds: Matrix4[] = []
  const shellAt = (z: number) => {
    const nebulae = [
      nebulaAt(0, 5000, 100, {
        exclusions: [
          {
            zone: hole,
            edgeFraction: 0.2,
            shell: {
              place: (world) => {
                worlds.push(world)
                return modelOf('shell', 0)
              },
              transform: Matrix4.identity,
              maxAlpha: 0.8,
              tint,
            },
          },
        ],
      }),
    ]
    const frame = collectSpaceFrame(
      sceneOf([], { nebulae, camera: { ...sceneOf([]).camera, position: { x: 0, y: 0, z } } }),
    )
    return frame.draws.find(({ materialName }) => materialName === 'shell')
  }
  // Deep in: (1 - 0.2) · 1.25 is held to 1, times max_alpha.
  const deep = shellAt(0)!
  assert.equal(deep.diffuse[3], Math.fround(0.8))
  assert.deepEqual(deep.ambient, tint)
  assert.deepEqual([deep.lights, deep.sceneAmbient], [[], { x: 1, y: 1, z: 1 }])
  assert.deepEqual([deep.depthWrite, deep.blend, deep.fog], [false, true, undefined])
  // Scaled to the radius over 1000.
  assert.equal(worlds.at(-1)!.x.x, Math.fround(600 * Math.fround(0.001)))
  // 540 out: an immersion of 0.5, so (0.5 - 0.2) · 1.25 of 0.8.
  const edge = shellAt(540)!
  assert.ok(Math.abs(edge.diffuse[3] - 0.375 * 0.8) < 1e-6, `${edge.diffuse[3]}`)
  // Under 0.2 of immersion, it's there but clear; outside the hole, none.
  assert.equal(shellAt(590)!.diffuse[3], 0)
  assert.equal(shellAt(700), undefined)
})
