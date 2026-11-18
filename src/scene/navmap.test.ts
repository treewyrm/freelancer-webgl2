import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Draw, Frame } from './frame.js'
import {
  collectNavmapLayer,
  NAVMAP_HALF_EXTENT,
  NAVMAP_VISIBLE,
  NAVMAP_ZOOM_IN,
  navmapFill,
  navmapFillAlpha,
  navmapFillOrder,
  navmapFillTexture,
  navmapGridWorld,
  navmapIconShown,
  navmapIconWorld,
  navmapLane,
  navmapLaneTexture,
  navmapUnit,
  navmapZoom,
  withNavmap,
} from './navmap.js'
import type { Zone } from './nebula.js'

const near = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected}`)

const at = (world: Matrix4, point: Vector3): Vector3 => Matrix4.transformPoint(point, world)

/** A sphere or ellipsoid zone, upright, as `radiusAlong` answers for it. */
const zone = (
  type: Zone['type'],
  position: Vector3,
  radii: Vector3,
  axes: Zone['axes'] = [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 },
  ],
): Zone => ({
  type,
  position,
  radius: Math.max(radii.x, radii.y, radii.z),
  radiusAlong: ({ x, y, z }) =>
    1 / Math.sqrt((x / radii.x) ** 2 + (y / radii.y) ** 2 + (z / radii.z) ** 2),
  size: radii,
  axes,
  surfacePoint: (point) => point,
  holds: () => false,
  meets: () => false,
})

describe('the navmap frame', () => {
  test('is the navmap’s own map at zoom 1, and its zoom-in at 8.6', () => {
    near(navmapZoom(NAVMAP_VISIBLE / 2, 2), 1)
    near(navmapZoom((NAVMAP_VISIBLE * NAVMAP_ZOOM_IN) / 2, 2), 8.6, 1e-3)
    near(navmapUnit(1), NAVMAP_HALF_EXTENT / 0.234)
  })

  test('lays a grid copy so its 8 cells fill the map, or a tenth of each zoomed, −Z up', () => {
    // One texture repeat is 0.48692 model units (`zoomedmap_liberty.3db`).
    const system = navmapGridWorld('system', 2)
    const zoomed = navmapGridWorld('zoomed', 2)

    near(at(system, { x: 0.48692, y: 0, z: 0 }).x, (2 * NAVMAP_VISIBLE) / 2, 100)
    near(at(zoomed, { x: 0.48692, y: 0, z: 0 }).x, (8 * 3387.5) / 2, 10)

    const up = at(system, { x: 0, y: 1, z: 0 })
    const facing = at(system, { x: 0, y: 0, z: 1 })

    assert.ok(up.z < 0 && Math.abs(up.x) < 1e-9, 'the model’s up is the map’s, −Z')
    assert.ok(facing.y > 0, 'the quad faces the camera above')
  })
})

describe('the icons', () => {
  test('are 60 times the solar radius at any zoom, a sun’s 1.2 times that, pinned to ±E/s', () => {
    const icon = { position: { x: 1000, y: 500, z: -2000 }, radius: 800 }
    const world = navmapIconWorld(icon, 2)

    near(Math.hypot(world.x.x, world.x.y, world.x.z), 48_000)
    assert.deepEqual(at(world, { x: 0, y: 0, z: 0 }), { x: 1000, y: 0, z: -2000 })
    near(Math.hypot(navmapIconWorld({ ...icon, sun: true }, 2).x.x), 57_600)

    const far = navmapIconWorld({ ...icon, position: { x: 900_000, y: 0, z: -900_000 } }, 4)

    assert.deepEqual(at(far, { x: 0, y: 0, z: 0 }), { x: 28_000, y: 0, z: -28_000 })
  })

  test('turns a planet’s +X toward the system’s origin', () => {
    for (const position of [
      { x: 50_000, y: 0, z: 0 },
      { x: 0, y: 0, z: -30_000 },
      { x: -20_000, y: 0, z: 20_000 },
    ]) {
      const world = navmapIconWorld({ position, radius: 1, turned: true }, 1)
      const tip = at(world, { x: 1, y: 0, z: 0 })
      const toward = { x: tip.x - position.x, z: tip.z - position.z }
      const length = Math.hypot(position.x, position.z)

      near(toward.x / 60, -position.x / length, 1e-9)
      near(toward.z / 60, -position.z / length, 1e-9)
    }
  })

  test('leaves one under 550 nav units out of the system view, not zoomed in', () => {
    const small = { position: { x: 0, y: 0, z: 0 }, radius: 250 }

    assert.equal(navmapIconShown(small, 2, false), false)
    assert.equal(navmapIconShown(small, 3, false), true)
    assert.equal(navmapIconShown(small, 2, true), true)
  })
})

describe('the fills', () => {
  test('take the first matching bit’s shape, an exclusion’s over all', () => {
    assert.equal(navmapFillTexture(0x40), 'asteroidtest')
    assert.equal(navmapFillTexture(0x800 | 0x2000), 'nav_terrain_ice')
    assert.equal(navmapFillTexture(0x8000), 'dustcloud')
    assert.equal(navmapFillTexture(0x4000 | 0x8000), undefined)
    assert.equal(navmapFillTexture(0x10000 | 0x40), 'dustcloud')
    assert.equal(navmapFillTexture(0x1), undefined)
  })

  test('go nebulae, then terrain by flag value, then exclusions, file order kept in each', () => {
    const zones = [
      { id: 'lava', flags: 0x200 },
      { id: 'hole', flags: 0x10000 },
      { id: 'cloud', flags: 0x8000 },
      { id: 'rock', flags: 0x40 },
      { id: 'other', flags: 0x1 },
      { id: 'rock2', flags: 0x40 },
      { id: 'hole2', flags: 0x20000 | 0x8000 },
    ]

    assert.deepEqual(
      navmapFillOrder(zones).map(({ id }) => id),
      ['cloud', 'rock', 'rock2', 'lava', 'hole', 'hole2'],
    )
  })

  test('fade from 255 in the system view to 86 zoomed in', () => {
    assert.equal(navmapFillAlpha(1), 255)
    assert.equal(navmapFillAlpha(0.3), 255)
    near(navmapFillAlpha(8.6), 86.2, 0.1)
  })

  test('fan 32 rim points about a centre, ragged along X but for an exclusion', () => {
    const rock = navmapFill(
      {
        zone: zone('sphere', { x: 10_000, y: 300, z: 0 }, { x: 5000, y: 5000, z: 5000 }),
        flags: 0x40,
      },
      1,
      255,
    )

    assert.ok(rock)
    assert.equal(rock.texture, 'asteroidtest')
    assert.equal(rock.batch.count, 33)
    assert.equal(rock.batch.indices.length, 96)
    // 10 000 & 0xff is 16: (16 − 128)·32 = −3 584.
    near(rock.batch.vertices[0]!, 10_000 - 3584)
    assert.equal(rock.batch.vertices[1], 0)
    assert.deepEqual(rock.batch.vertices.slice(3, 5), [0.5, 0.5])
    assert.deepEqual(rock.batch.colors.slice(0, 4), [255, 255, 255, 255])

    const hole = navmapFill(
      {
        zone: zone('sphere', { x: 10_000, y: 0, z: 0 }, { x: 5000, y: 5000, z: 5000 }),
        flags: 0x10000,
      },
      1,
      86,
    )

    assert.ok(hole)
    near(hole.batch.vertices[0]!, 10_000)
    assert.deepEqual(hole.batch.colors.slice(0, 4), [0, 0, 0, 86])
    // The first rim point is +Z, the radius away, unjittered: a repeat is 0.09 plane units.
    near(hole.batch.vertices[5 + 2]!, 5000)
    near(hole.batch.vertices[5 + 4]!, 0.5 - 5000 / (0.09 * navmapUnit(1)))
  })

  test('tint a nebula by its fog colour × 1.5, and section an ellipsoid through its centre', () => {
    const cloud = navmapFill(
      {
        zone: zone('ellipsoid', { x: 0, y: 0, z: 0 }, { x: 8000, y: 100, z: 2000 }),
        flags: 0x8000,
        fogColor: { x: 0.8, y: 0.4, z: 0.2 },
      },
      1,
      255,
    )

    assert.ok(cloud)
    // Bytes b, g, r, a.
    assert.deepEqual(cloud.batch.colors.slice(0, 4), [77, 153, 255, 255])

    // Unjittered, as an exclusion is: the section is the ellipsoid's 8 km along X, 2 km along Z.
    const section = navmapFill(
      {
        zone: zone('ellipsoid', { x: 0, y: 0, z: 0 }, { x: 8000, y: 100, z: 2000 }),
        flags: 0x10000,
      },
      1,
      255,
    )!
    const xs = Array.from({ length: 32 }, (_, i) => section.batch.vertices[(i + 1) * 5]!)
    const zs = Array.from({ length: 32 }, (_, i) => section.batch.vertices[(i + 1) * 5 + 2]!)

    near(Math.max(...xs), 8000)
    near(Math.max(...zs), 2000)
  })

  test('leave a box, a cylinder and an unfilled zone out', () => {
    const box = zone('box', { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 })

    assert.equal(navmapFill({ zone: box, flags: 0x40 }, 1, 255), undefined)
    assert.equal(
      navmapFill({ zone: zone('sphere', box.position, box.size), flags: 0 }, 1, 255),
      undefined,
    )
  })
})

describe('the lanes', () => {
  test('cycle 16 frames at 15 a second', () => {
    assert.equal(navmapLaneTexture(0), 'TLRanimated_01')
    assert.equal(navmapLaneTexture(1 / 15 + 1e-9), 'TLRanimated_02')
    assert.equal(navmapLaneTexture(16 / 15 + 1e-9), 'TLRanimated_01')
  })

  test('are a strip opaque along its centre and clear at its edges, narrower zoomed in', () => {
    const lane = navmapLane({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -10_000 }, 1, 1)

    assert.equal(lane.count, 6)
    assert.equal(lane.indices.length, 12)
    assert.deepEqual(
      Array.from({ length: 6 }, (_, i) => lane.colors[i * 4 + 3]),
      [255, 255, 0, 0, 0, 0],
    )
    near(Math.abs(lane.vertices[10]!), 0.003 * navmapUnit(1))

    const zoomed = navmapLane({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -10_000 }, 1, 8.6)

    assert.ok(Math.abs(zoomed.vertices[10]!) < Math.abs(lane.vertices[10]!))
  })
})

describe('the layer', () => {
  const texture = { name: 'dustcloud' } as Texture
  const camera = {
    position: { x: 0, y: 1e6, z: 0 },
    orientation: { x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 0, z: -1 }, z: { x: 0, y: 1, z: 0 } },
    fovh: 35,
    near: 1,
    far: 2e6,
    ortho: { halfWidth: 100_000 },
  }

  test('draws its fills and lanes with no depth, blended over what is there', () => {
    const fill = navmapFill(
      { zone: zone('sphere', { x: 0, y: 0, z: 0 }, { x: 5000, y: 5000, z: 5000 }), flags: 0x8000 },
      1,
      255,
    )!
    const layer = collectNavmapLayer({
      camera,
      aspect: 1,
      fills: [{ batch: fill.batch, texture }],
      lanes: [{ batch: navmapLane({ x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, 1, 1), texture }],
    })

    assert.equal(layer.under.length, 2)
    assert.equal(layer.over.length, 0)

    for (const draw of layer.under) {
      assert.equal(draw.depthFunc, 'always')
      assert.equal(draw.depthWrite, false)
      assert.equal(draw.blend, true)
      assert.equal(draw.blendMode, 'alpha')
      assert.equal(draw.cull, 'none')
    }

    assert.equal(layer.under[0]!.texture?.sampler.wrapU, 'repeat')
  })

  test('lies under a frame’s draws and over them, its end hook last', () => {
    const draw = (name: string) => ({ materialName: name }) as Draw
    const frame = {
      draws: [draw('model'), draw('glass')],
      hooks: [
        { name: 'begin', before: 0 },
        { name: 'opaque', before: 1 },
        { name: 'end', before: 2 },
      ],
      unsupported: ['a'],
    } as unknown as Frame
    const laid = withNavmap(frame, {
      under: [draw('grid'), draw('fill')],
      over: [draw('icon')],
      unsupported: ['b', 'a'],
    })

    assert.deepEqual(
      laid.draws.map(({ materialName }) => materialName),
      ['grid', 'fill', 'model', 'glass', 'icon'],
    )
    assert.deepEqual(
      laid.hooks.map(({ name, before }) => [name, before]),
      [
        ['begin', 0],
        ['opaque', 3],
        ['end', 5],
      ],
    )
    assert.deepEqual(laid.unsupported, ['a', 'b'])
  })
})
