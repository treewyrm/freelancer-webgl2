import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import type { Camera } from './camera.js'
import { Clouds, RING_CLOUD_VISIBILITY, type CloudSettings } from './clouds.js'
import { textureShape } from './ring.js'

/** MSVC's `rand()` from seed 1, so each run is the same. */
const msvcRand = () => {
  let state = 1

  return () => {
    state = (Math.imul(state, 214013) + 2531011) >>> 0
    return (state >>> 16) & 0x7fff
  }
}

const texture = { name: 'rock_wisps', width: 256, height: 256 } as Texture
// `ew05_ring.ini`'s `[Clouds]`.
const settings: CloudSettings = {
  puffCount: 40,
  puffRadius: 80,
  colorA: { x: 175 / 255, y: 150 / 255, z: 1 },
  colorB: { x: 200 / 255, y: 200 / 255, z: 1 },
  maxAlpha: 1,
  shapes: [0, 1, 2, 3].map((at) =>
    textureShape(texture, { x: (at % 2) * 0.5, y: 0.5, w: 0.5, h: 0.5 }),
  ),
  weights: [3, 1, 1, 1],
  drift: 1,
  maxDistance: 800,
  nearFade: [175, 300],
}

const camera: Camera = {
  position: { x: 0, y: 0, z: 0 },
  orientation: Matrix3.identity,
  fovh: 35,
  near: 3,
  far: 21000,
}

const make = (overrides: Partial<CloudSettings> = {}) =>
  new Clouds(
    { ...settings, ...overrides },
    { visibility: RING_CLOUD_VISIBILITY, random: msvcRand() },
  )

test("its sphere is half max_distance and a puff's radius, set ahead so the near fade's cone fits", () => {
  const clouds = make()

  assert.equal(clouds.radius, 480)

  // tan 35°: 480 · 0.8 / tan - 175 is 373.4, under √(480² - 273.2²), so it holds; less 480 and plus 175.
  const tan = Math.tan(0.6108652551968893)
  const a = Math.fround((480 * Math.fround(0.8)) / tan - 175)

  assert.ok(Math.abs(clouds.reach - (a + 175 - 480)) < 1e-3, `${clouds.reach}`)
})

test('each puff is 0.8 to 1.2 of puff_radius, coloured between A and B, its shape by weight', () => {
  const clouds = make()

  assert.equal(clouds.puffs.length, 40)

  for (const { size, color } of clouds.puffs) {
    assert.ok(size >= 64 && size <= 96, `${size}`)

    const t = (color.x - settings.colorA!.x) / (settings.colorB!.x - settings.colorA!.x)

    assert.ok(t >= 0 && t <= 1)

    const g = settings.colorA!.y + (settings.colorB!.y - settings.colorA!.y) * t

    assert.ok(Math.abs(color.y - g) < 1e-5)
  }

  // Weighted 3, 1, 1, 1: about half the first.
  const first = clouds.puffs.filter(({ shape }) => shape === 0).length

  assert.ok(first > 12 && first < 28, `${first}`)
})

const inBand = () => 1

test('the camera in the owner draws all within budget; out of it, nothing', () => {
  const clouds = make()

  clouds.update(camera, 1 / 60, 1, inBand)
  assert.ok(clouds.draw(camera, { cut: true, holds: inBand }))
  assert.equal(clouds.active, 40)

  const gone = make()

  gone.update(camera, 1 / 60, 0, inBand)
  assert.equal(gone.draw(camera, { cut: true, holds: inBand }), undefined)
  assert.equal(gone.active, 0)
})

test('a puff respawns on the sphere about a point ahead, kept only where the owner holds it', () => {
  const clouds = make()
  const ahead = clouds.reach + clouds.radius
  // Seeded about the origin, the puffs mostly fall outside a sphere this far off, and respawn on it.
  const far: Camera = { ...camera, position: { x: 0, y: 0, z: 100000 } }

  clouds.update(far, 0, 1, inBand)

  const centre: Vector3 = { x: 0, y: 0, z: 100000 - ahead }

  for (const { position, active } of clouds.puffs) {
    if (!active) continue

    const distance = Math.hypot(position.x - centre.x, position.y - centre.y, position.z - centre.z)

    assert.ok(Math.abs(distance - clouds.radius) < 0.05, `${distance}`)
  }

  // Nowhere held, and too little seen to spawn without asking: none comes back.
  const empty = make()

  empty.update(far, 0, 0.8, () => 0)
  assert.equal(empty.active, 0)
})

test('a puff deep in an exclusion zone counts, but is hidden: on respawn and on a cut', () => {
  const far: Camera = { ...camera, position: { x: 0, y: 0, z: 100000 } }
  // Every point is 0.95 into a zone: past 0.9, all hidden, though they fill the budget.
  const deep = make()

  deep.update(far, 0, 1, inBand, () => 0.95)
  assert.ok(deep.active > 0)
  assert.ok(deep.puffs.every(({ active, hidden }) => !active || hidden))
  assert.equal(deep.draw(far, { holds: inBand, excluded: () => 0.95 }), undefined)

  // At 0.9 exactly, as a float, the zone's immersion is, none is.
  const edge = make()

  edge.update(far, 0, 1, inBand, () => Math.fround(0.9))
  assert.ok(edge.puffs.some(({ active, hidden }) => active && !hidden))

  // A cut places them afresh, hiding the same way.
  const cut = make()

  cut.update(camera, 0, 1, inBand)
  cut.draw(camera, { cut: true, holds: inBand, excluded: () => 0.95 })
  assert.ok(cut.puffs.every(({ hidden }) => hidden))
})

test('nearer than near_fade_distance nothing draws, and toward its far end it fades in', () => {
  const clouds = make({ maxAlpha: 1 })

  clouds.update(camera, 1 / 60, 1, inBand)

  const draw = clouds.draw(camera, { cut: true, holds: inBand })!
  const vertices = new Float32Array(draw.mesh.vertices.buffer)

  for (let at = 0; at < draw.count; at += 6) {
    const depth = -vertices[at * 6 + 2]!
    const alpha = draw.mesh.vertices[at * 24 + 15]!

    assert.ok(depth >= 175, `${depth}`)

    if (depth < 300)
      assert.ok(alpha <= Math.trunc(((depth - 175) / 125) * 255) + 1, `${depth}: ${alpha}`)
  }
})

test('drawn as retail draws them: unlit and blended over both sides, the alpha test at 5', () => {
  const clouds = make()

  clouds.update(camera, 1 / 60, 1, inBand)

  const draw = clouds.draw(camera, { cut: true, holds: inBand })!

  assert.deepEqual(
    [draw.unlit, draw.colorVertex, draw.blend, draw.cull, draw.depthWrite, draw.depthFunc],
    [true, true, true, 'none', false, 'lequal'],
  )
  assert.deepEqual([draw.alphaFunction, draw.alphaReference], ['greater', 5])
  assert.equal(draw.texture?.entry, texture)

  // Unturned, the kept up of (1, 1, 0) lays each square on its corner: C0 to C1 runs along (1, -1).
  const vertices = new Float32Array(draw.mesh.vertices.buffer)
  const dx = vertices[6]! - vertices[0]!
  const dy = vertices[7]! - vertices[1]!

  assert.ok(Math.abs(dx + dy) < 1e-3 && dx > 0, `${dx}, ${dy}`)
})

test("a lightning flash adds its colour to a puff's while its clock runs", () => {
  const lit = make({
    maxAlpha: 1,
    lightning: { color: { x: 1, y: 0, z: 0 }, intensity: 1, gap: 0.01, duration: 10 },
  })
  for (let frame = 0; frame < 30; frame++) lit.update(camera, 1 / 60, 1, inBand)

  const draw = lit.draw(camera, { cut: false, holds: inBand })!
  const plain = make({ maxAlpha: 1 })
  for (let frame = 0; frame < 30; frame++) plain.update(camera, 1 / 60, 1, inBand)

  const red = (d: typeof draw) =>
    Math.max(...Array.from({ length: d.count }, (_, at) => d.mesh.vertices[at * 24 + 14]!))

  assert.ok(red(draw) > red(plain.draw(camera, { cut: false, holds: inBand })!))
})

test('fired, the first shown puff flashes on the next step instead of after its wait', () => {
  const flashed = (clouds: Clouds) => clouds.puffs.filter(({ timer }) => timer >= 0).length
  const lightning = { color: { x: 1, y: 0, z: 0 }, intensity: 1, gap: 1000, duration: 10 }
  const clouds = make({ maxAlpha: 1, lightning })

  clouds.update(camera, 1 / 60, 1, inBand)
  assert.equal(flashed(clouds), 0)

  clouds.fire()
  clouds.update(camera, 1 / 60, 1, inBand)
  assert.equal(flashed(clouds), 1)
})
