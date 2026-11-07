import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import { AsteroidBillboards, type BillboardField, type BillboardSettings } from './billboards.js'
import type { Camera } from './camera.js'
import { zoneOf } from './nebula.js'
import { textureShape } from './ring.js'

const msvcRand = () => {
  let state = 1
  return () => {
    state = (state * 214013 + 2531011) >>> 0
    return (state >>> 16) & 0x7fff
  }
}
const texture = { name: 'rock_billboards', width: 64, height: 64 } as Texture
const settings: BillboardSettings = {
  shape: textureShape(texture, {}),
  count: 50,
  size: [40, 80],
  startDistance: 400,
}
// A field of 20000 about the camera, so every rock is in it.
const field: BillboardField = {
  zone: zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: 20000 }),
  fillDistance: 200,
  cubeSize: 100,
  diffuse: { x: 1, y: 1, z: 1 },
  ambient: { x: 1, y: 1, z: 1 },
}
const camera: Camera = {
  position: { x: 0, y: 0, z: 0 },
  orientation: Matrix3.identity,
  fovh: 35,
  near: 1,
  far: 21000,
}
const make = (fields: Partial<BillboardSettings> = {}, onField: Partial<BillboardField> = {}) =>
  new AsteroidBillboards(
    { ...settings, ...fields },
    { ...field, ...onField },
    { random: msvcRand() },
  )
const unlit = { ambient: { x: 0, y: 0, z: 0 }, lights: [], lit: false }

test('its sphere stands from start_dist on, as wide as tan 35° lets it; its rocks between their sizes', () => {
  const billboards = make()
  const tan = Math.tan(0.6108652353286743)
  const r = (400 * tan) / (1 - tan)
  assert.equal(billboards.radius, Math.fround(r))
  assert.equal(billboards.ahead, Math.fround(r + 400))
  assert.equal(billboards.fade, Math.fround(r * Math.fround(0.3)))
  // From the cubes' reach, 200, to a cube and a quarter past it.
  assert.deepEqual(billboards.nearFade, [325, 200])
  assert.equal(billboards.rocks.length, 50)
  for (const { half, phase } of billboards.rocks) {
    assert.ok(half >= 20 && half <= 40, `${half}`)
    assert.ok(phase >= 0 && phase < 1)
  }
})

test("an exclusion zone's billboard_count raises the count, and thins rocks to its share", () => {
  const exclusions = [
    {
      zone: zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: -900 }, radius: 300 }),
      billboardCount: 200,
    },
  ]
  const billboards = make({}, { exclusions })
  assert.equal(billboards.rocks.length, 200)
  // The field's own 50 of 200 stand outside it.
  assert.equal(billboards.density, 0.25)
})

test('on a cut every rock is placed in the sphere ahead; each a triangle facing the camera', () => {
  const billboards = make()
  const draws = billboards.draw(camera, unlit, true)
  const centre: Vector3 = { x: 0, y: 0, z: -billboards.ahead }
  for (const { position, visible } of billboards.rocks) {
    assert.ok(visible)
    const away = Math.hypot(position.x - centre.x, position.y - centre.y, position.z - centre.z)
    assert.ok(away <= billboards.radius + 1e-3, `${away}`)
  }
  const triangles = draws.reduce((total, draw) => total + draw.count / 3, 0)
  assert.ok(triangles > 0 && triangles <= 50)
  // Opaque ones first, ALPHAREF 128 with depth writes; then the faded, blended, at 5.
  const [opaque, faded] = draws
  assert.deepEqual(
    [opaque!.blend, opaque!.depthWrite, opaque!.alphaReference, opaque!.cull],
    [false, true, 128, 'none'],
  )
  if (faded)
    assert.deepEqual([faded.blend, faded.depthWrite, faded.alphaReference], [true, false, 5])
  // Each triangle faces the camera: all three corners at the same depth, its tip at the UV's middle.
  const floats = new Float32Array(opaque!.mesh.vertices.buffer)
  const z = [0, 1, 2].map((corner) => floats[corner * 6 + 2]!)
  assert.ok(Math.abs(z[0]! - z[1]!) < 1e-2 && Math.abs(z[0]! - z[2]!) < 1e-2, `${z}`)
  assert.deepEqual([floats[2 * 6 + 4], floats[2 * 6 + 5]], [0.5, 0.5])
})

test('outside the field, or in a zone excluding billboards, a rock is hidden', () => {
  const out = make(
    {},
    { zone: zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: 50000 }, radius: 100 }) },
  )
  // Far from it, nothing at all.
  assert.deepEqual(out.draw(camera, unlit, true), [])
  const exclusions = [
    {
      zone: zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: 20000 }),
      excludeBillboards: true,
    },
  ]
  const excluded = make({}, { exclusions })
  assert.deepEqual(excluded.draw(camera, unlit, true), [])
  assert.ok(excluded.rocks.every(({ visible }) => !visible))
})

test('with no shape nothing draws; unlit, every corner is the tinted diffuse', () => {
  assert.deepEqual(make({ shape: undefined }).draw(camera, unlit, true), [])
  const tinted = make(
    { colorShift: { x: 0.5, y: 1, z: 1 } },
    { diffuse: { x: 1, y: 0.5, z: 0.25 } },
  )
  const [opaque] = tinted.draw(camera, unlit, true)
  // Blue, green, red: 0.25, 0.5 and 0.5 of 255.
  assert.deepEqual([...opaque!.mesh.vertices.slice(12, 15)], [63, 127, 127])
})

test("lit, a light's colour falls on the corner facing it, over the scaled ambient", () => {
  const billboards = make()
  const ambient = { x: 51 / 255, y: 51 / 255, z: 51 / 255 }
  // Shining down -Z, along the look: every direction a step off it takes (cos 45° + 0.5) / 1.5.
  const lights = [{ color: { x: 1, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } }]
  const [opaque] = billboards.draw(camera, { ambient, lights }, true)
  const [b, g, r] = [...opaque!.mesh.vertices.slice(12, 15)]
  assert.deepEqual([b, g], [51, 51])
  const weight = (Math.SQRT1_2 + 0.5) / 1.5
  assert.ok(Math.abs(r! - Math.trunc((0.2 + weight) * 255)) <= 1, `${r}`)
})
