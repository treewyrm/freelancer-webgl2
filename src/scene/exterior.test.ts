import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, Quat, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import { viewMatrix, type Camera } from './camera.js'
import { NebulaExterior, type ExteriorSettings } from './exterior.js'
import { nebulaState, zoneOf, type SpaceNebula } from './nebula.js'
import { textureShape } from './ring.js'

const texture = {
  name: 'generic_exterior',
  width: 128,
  height: 128,
  format: 'rgba32_8888',
} as Texture
const shape = textureShape(texture, { x: 0, y: 0, w: 0.5, h: 0.5 })
const zone = zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: 1000 })
const settings: ExteriorSettings = {
  shapes: [shape],
  bitRadius: 100,
  color: { x: 40 / 255, y: 30 / 255, z: 90 / 255 },
  planeSlices: 3,
  minBits: 4,
  maxBits: 8,
  equatorBias: 0.5,
}

// The MSVC `rand()`, seeded with 1: the bits' spin and nothing that's checked here.
const msvcRand = () => {
  let state = 1

  return () => {
    state = (state * 214013 + 2531011) >>> 0
    return (state >>> 16) & 0x7fff
  }
}

const exteriorOf = (fields: Partial<ExteriorSettings> = {}, detail = 1) =>
  new NebulaExterior({ ...settings, ...fields }, zone, { random: msvcRand(), detail })
const length = ({ x, y, z }: Vector3) => Math.hypot(x, y, z)
const close = (actual: number, expected: number, within = 1e-3) =>
  assert.ok(Math.abs(actual - expected) <= within, `${actual} is not ${expected}`)

test('bits stand on rings of latitude, 4, 8 and 4, and two caps, pulled in from the surface', () => {
  const { bits } = exteriorOf()

  assert.equal(bits.length, 18)
  // 0.75 of a bit's radius in from 1000.
  for (const bit of bits) close(length(bit.position), 925)

  // The rings' heights: `equator_bias` 0.5 spreads them half way to where a cosine of ±0.5 would.
  const heights = [-0.25, 0, 0.25].map((cos) => 925 * cos)

  bits.slice(0, 4).forEach((bit) => close(bit.position.y, heights[0]!))
  bits.slice(4, 12).forEach((bit) => close(bit.position.y, heights[1]!))
  bits.slice(12, 16).forEach((bit) => close(bit.position.y, heights[2]!))
  // The first ring starts on +x; past the middle a ring turns half a step, π / 4.
  close(bits[0]!.position.z, 0)

  const last = bits[12]!.position

  close(Math.atan2(last.z, last.x), Math.PI / 4)
  close(bits[16]!.position.y, 925)
  close(bits[17]!.position.y, -925)
  // No variation: all the same size.
  for (const bit of bits) assert.equal(bit.radius, 100)
})

test('with no equator_bias, every ring is on the equator', () => {
  const { bits } = exteriorOf({ equatorBias: undefined })
  for (const bit of bits.slice(0, 16)) close(bit.position.y, 0)
})

test('the Nebula option thins the bits, shrinks them and fades them', () => {
  const half = exteriorOf({}, 0.5)

  // Density 0.5 · 0.35 + 0.5: 8 makes 5, 4 makes 3; 3 + 5 + 3 and the caps.
  assert.equal(half.bits.length, 13)
  // Eased: 1 - 0.25, so 0.25 · 0.707 + 0.75 of the radius.
  close(half.bits[0]!.radius, 100 * (0.25 * 0.707 + 0.75))
  assert.equal(exteriorOf({}, 0.04).bits.length, 0)
  assert.equal(exteriorOf({ planeSlices: 0 }).bits.length, 0)
})

// Looking down -Z, or with `back`, turned round to +Z.
const BACK = Matrix3.fromQuaternion(Quat.axisAngle({ axis: { x: 0, y: 1, z: 0 }, angle: Math.PI }))
const cameraAt = (position: Vector3, back = false): Camera => ({
  position,
  orientation: back ? BACK : Matrix3.identity,
  fovh: 60,
  near: 1,
  far: 250000,
})
const nebulaOf = (exterior: NebulaExterior): SpaceNebula => ({
  zone,
  fog: { distance: 1000, color: { x: 10 / 255, y: 7 / 255, z: 30 / 255 } },
  exterior,
})

const drawFrom = (exterior: NebulaExterior, eye: Vector3, back = false) => {
  const camera = cameraAt(eye, back)
  const state = nebulaState(nebulaOf(exterior), eye)

  exterior.update(eye, 0, state.depth, true)
  return exterior.draw(state, camera, viewMatrix(camera), 1, viewMatrix(camera))
}

test('turned to the camera, each bit stands square to the way to it', () => {
  const exterior = exteriorOf()
  const eye = { x: 0, y: 0, z: 5000 }

  drawFrom(exterior, eye)

  for (const { position, axis } of exterior.bits) {
    const to = { x: eye.x - position.x, y: eye.y - position.y, z: eye.z - position.z }

    // Only one far off a quarter turns.
    assert.ok(Math.abs(axis.x * to.x + axis.y * to.y + axis.z * to.z) / length(to) <= 0.25 + 1e-6)
  }
})

test('only the near half draws, far to near, each its radius about its place', () => {
  const exterior = exteriorOf()
  const eye = { x: 0, y: 0, z: 5000 }
  const draw = drawFrom(exterior, eye)!
  const floats = new Float32Array(draw.mesh.vertices.buffer)
  const count = draw.reference.vertexCount / 4

  // Of the 16 on rings, those with z ≥ 0, and the caps, which stand edge-on and fade.
  const centres = Array.from({ length: count }, (_, quad) => {
    const at = (corner: number, axis: number) => floats[(quad * 4 + corner) * 6 + axis]!

    return {
      x: (at(0, 0) + at(2, 0)) / 2,
      y: (at(0, 1) + at(2, 1)) / 2,
      z: (at(0, 2) + at(2, 2)) / 2,
    }
  })
  for (const centre of centres) assert.ok(centre.z >= -1e-3, `${centre.z}`)

  // Sorted far to near.
  const distances = centres.map((c) => Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z))

  for (let at = 1; at < distances.length; at++)
    assert.ok(distances[at - 1]! >= distances[at]! - 10, `${distances}`)

  // Each corner is the radius along both of its axes: √2 of it from its centre.
  const corner = { x: floats[0]!, y: floats[1]!, z: floats[2]! }

  close(
    Math.hypot(corner.x - centres[0]!.x, corner.y - centres[0]!.y, corner.z - centres[0]!.z),
    100 * Math.SQRT2,
    0.05,
  )
  // The colour, at the opacity.
  assert.deepEqual(
    [...draw.mesh.vertices.slice(12, 16)],
    [90, 30, 40, Math.trunc(Math.fround(0.75) * 255)],
  )
  assert.deepEqual(
    [draw.depthFunc, draw.depthWrite, draw.cull, draw.blendMode, draw.alphaReference],
    ['always', false, 'none', 'alpha', 4],
  )
})

test("fogged in the nebula's colour from its surface, to twenty times as far past its span", () => {
  const eye = { x: 0, y: 0, z: 5000 }
  const draw = drawFrom(exteriorOf(), eye)!

  // 4000 from the surface: the fog's start, and (4000 · 20 / 1000 + 1) · 1000 past it.
  assert.equal(draw.fog!.start, 4000)
  assert.equal(draw.fog!.end, 4000 + 81 * 1000)
  assert.deepEqual(draw.fog!.color, { x: 10 / 255, y: 7 / 255, z: 30 / 255 })
})

test('a texture with no alpha adds the colour times the alpha', () => {
  const opaque = textureShape({ ...texture, format: 'rgb24_888' } as Texture, {})
  const draw = drawFrom(exteriorOf({ shapes: [opaque] }), { x: 0, y: 0, z: 5000 })!

  assert.equal(draw.blendMode, 'add')

  const a = Math.fround(0.75)

  assert.deepEqual(
    [...draw.mesh.vertices.slice(12, 16)],
    [90, 30, 40].map((c) => Math.trunc(Math.fround((c / 255) * a) * 255)).concat(255),
  )
})

test('none out of view, nor deep in; over the second half of the depth they fade', () => {
  // Looking away: the zone is behind the camera.
  const behind = exteriorOf()
  const camera = cameraAt({ x: 0, y: 0, z: -5000 })
  const state = nebulaState(nebulaOf(behind), camera.position)

  assert.equal(behind.draw(state, camera, viewMatrix(camera), 1, viewMatrix(camera)), undefined)
  assert.equal(drawFrom(exteriorOf(), { x: 0, y: 0, z: 10 }), undefined)

  // 750 into its fog of 1000 from 1000: three quarters deep, so half the opacity.
  const eye = { x: 0, y: 0, z: 250 }
  const exterior = exteriorOf()
  const fading = nebulaState(nebulaOf(exterior), eye)

  close(fading.depth, 0.75)
  // Looking down -Z from in it, every bit ahead is on its far side, so none draws; turned round, the
  // near side does, at half.
  assert.equal(drawFrom(exterior, eye), undefined)

  const draw = drawFrom(exterior, eye, true)!
  const alphas = Array.from(
    { length: draw.reference.vertexCount / 4 },
    (_, q) => draw.mesh.vertices[q * 96 + 15]!,
  )

  assert.ok(alphas.length > 0)
  assert.ok(
    alphas.every((a) => a <= Math.trunc(Math.fround(0.75) * 0.5 * 255)),
    `${alphas}`,
  )
  assert.ok(alphas.includes(Math.trunc(Math.fround(Math.fround(0.75) * 0.5) * 255)), `${alphas}`)
})
