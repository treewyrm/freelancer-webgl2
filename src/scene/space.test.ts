import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Material } from '@treewyrm/freelancer/material'
import { Matrix3, Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { TextureEntry } from '@treewyrm/freelancer/texture'
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
import { collectSpaceFrame, type SpaceField, type SpaceObject, type SpaceScene } from './space.js'

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
  assert.equal(near!.depthFunc, 'less')
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

const NEBULA = {}
const fieldOf = (enclosure: 0 | 1 | 2, fields: Partial<SpaceField> = {}): SpaceField => ({
  nebula: NEBULA,
  enclosure,
  radius: 700,
  far: 3000,
  ...fields,
})
const inField = (enclosure: number) => ({ field: { nebula: NEBULA, enclosure } })

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
  const objects = [objectOf('main', 400), objectOf('in field', 300, inField(0.5))]
  const field = fieldOf(0)
  assert.deepEqual(collected(objects, { field }), ['in field', 'main'])
  assert.deepEqual(collected(objects, { field, limits: { nearDistance: 350 } }), [
    'main',
    'in field',
  ])
  // How deep in another nebula still draws.
  const other = objectOf('deep', 300, { field: { nebula: {}, enclosure: 0.5 } })
  assert.deepEqual(collected([other], { field }), [])
  assert.deepEqual(collected([other], { field, limits: { otherFieldDepth: 0.75 } }), ['deep'])
})

test('outside a field, what is in it drains before the main list, unless near', () => {
  const objects = [
    objectOf('main', 900),
    objectOf('in field', 300, inField(0.5)),
    objectOf('near in field', 100, inField(0.5)),
  ]
  // At 100 it left the field's list for the main one, where it's nearest of all.
  assert.deepEqual(collected(objects, { field: fieldOf(0) }), ['in field', 'main', 'near in field'])
})

test('outside a field, what is fully in it is hidden, and so is another nebula past a quarter', () => {
  const field = fieldOf(0)
  assert.deepEqual(collected([objectOf('core', 300, inField(1))], { field }), [])
  const other = (enclosure: number) => ({ field: { nebula: {}, enclosure } })
  assert.deepEqual(collected([objectOf('deep', 300, other(0.5))], { field }), [])
  assert.deepEqual(collected([objectOf('shallow', 300, other(0.25))], { field }), ['shallow'])
})

test('outside a field a nomad object in it draws only near: list 4 is never walked', () => {
  const nomad = { nomad: true, ...inField(0.5) }
  const field = fieldOf(0)
  assert.deepEqual(collected([objectOf('nomad', 300, nomad)], { field }), [])
  assert.deepEqual(collected([objectOf('nomad', 100, nomad)], { field }), ['nomad'])
})

test('in a field its edge drains main lists first, then its own and its nomads', () => {
  const objects = [
    objectOf('in field', 300, inField(0.5)),
    objectOf('main', 900),
    objectOf('nomad', 400, { nomad: true }),
    objectOf('nomad in field', 300, { nomad: true, ...inField(0.5) }),
    objectOf('near', 100),
  ]
  // Near, in a field or not, joins the field's list once the camera is in one.
  assert.deepEqual(collected(objects, { field: fieldOf(1) }), [
    'main',
    'nomad',
    'in field',
    'near',
    'nomad in field',
  ])
})

test('at its edge, what it fully holds shows only within its radius', () => {
  const field = fieldOf(1)
  assert.deepEqual(collected([objectOf('held', 600, inField(1))], { field }), ['held'])
  assert.deepEqual(collected([objectOf('held', 800, inField(1))], { field }), [])
})

test('in its core: no sky, no far list, only what it holds, and its own far plane', () => {
  const sky = [{ ...modelOf('stars', 0), sky: 'starsphere' as const }]
  const objects = [
    objectOf('held', 300, inField(0.5)),
    objectOf('out', 300),
    objectOf('solar', 30000, { solar: { large: true } }),
  ]
  const frame = collectSpaceFrame(sceneOf(objects, { sky, field: fieldOf(2) }))
  assert.deepEqual(names(frame), ['held'])
  assert.deepEqual(frame.projection, projectionMatrix({ ...sceneOf([]).camera, far: 3000 }, 1))
  // A far beyond the system's is cut back.
  const wide = collectSpaceFrame(sceneOf([], { field: fieldOf(2, { far: 90000 }) }))
  assert.deepEqual(wide.projection, projectionMatrix({ ...sceneOf([]).camera, far: 21000 }, 1))
})

test('the sky draws before the far list', () => {
  const sky = [{ ...modelOf('stars', 0), sky: 'starsphere' as const }]
  const solar = objectOf('solar', 30000, { solar: { large: true } })
  assert.deepEqual(collected([solar, objectOf('ship', 100)], { sky }), ['stars', 'solar', 'ship'])
})

test('a far solar in any nebula is left out', () => {
  const solar = objectOf('solar', 30000, { solar: { large: true }, ...inField(0.1) })
  assert.deepEqual(collected([solar]), [])
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
