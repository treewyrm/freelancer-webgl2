import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import type { Camera } from './camera.js'
import { RETAIL_FLARE_LIGHT } from './flare.js'
import { coneLevel, FlashLight, flashlightDraws } from './flashlight.js'

const RED = { x: 1, y: 0, z: 0 }
const at = (x: number, y = 0, z = 0) => Matrix4.translation({ x, y, z })
const CAMERA: Camera = {
  position: { x: 0, y: 0, z: 10 },
  orientation: Matrix3.identity,
  fovh: 45,
  near: 1,
  far: 100,
}
const TEXTURES = { shine: { name: 'shine' } as Texture, bulb: { name: 'bulb' } as Texture }

test("a room set's lights share a period, staggered by gap, a quarter of scale for the bulb", () => {
  const set = { color: RED, scale: 2, gap: 1, blink: 1, endpause: 2 }
  const lights = FlashLight.ofSet(set, [at(0), at(1), at(2)])

  // (3 - 1) × 1 + 2 = 4, so each starts a quarter later; the first at -(0 × step).
  assert.deepEqual(
    lights.map(({ blink }) => blink.phase),
    [-0, -0.25, -0.5],
  )
  assert.deepEqual(
    lights.map(({ bulbSize, glowSize }) => [bulbSize, glowSize]),
    [
      [0.5, 2],
      [0.5, 2],
      [0.5, 2],
    ],
  )
  assert.deepEqual(lights[2]!.world, at(2))
  assert.deepEqual(lights[0]!.minColor, { x: 0, y: 0, z: 0 })
})

test('a blink rises to its colour and back over its lit part, and a light not yet started is below black', () => {
  const [first, second] = FlashLight.ofSet(
    { color: RED, scale: 1, gap: 1, blink: 1, endpause: 2 },
    [at(0), at(1)],
  )

  // Period 3, lit a third of it: at half a second the first is at the triangle's peak.
  first!.update(0.5)
  assert.ok(Math.abs(first!.glowColor.x - 1) < 1e-6)
  assert.ok(Math.abs(first!.bulbColor.x - 1) < 1e-6)
  // The second started a third of a period back: still negative.
  second!.update(0.5)
  assert.ok(second!.glowColor.x < 0)
})

test("a [Light] that doesn't blink stays at its colour; its cone comes from degrees", () => {
  const light = FlashLight.fromLight(
    { ...RETAIL_FLARE_LIGHT, color: RED, flareCone: [90, 30] },
    () => 0,
  )

  light.update(1)
  assert.deepEqual(light.glowColor, RED)
  assert.deepEqual(light.bulbColor, RED)
  assert.ok(Math.abs(light.cone.inner - Math.cos(Math.PI / 2)) < 1e-6)
  assert.ok(Math.abs(light.cone.outer - Math.cos(Math.PI / 6)) < 1e-6)
  assert.deepEqual(FlashLight.fromLight(RETAIL_FLARE_LIGHT).cone, { inner: -1, outer: -1 })
})

test('the glow fades as the camera leaves its cone', () => {
  const light = FlashLight.fromLight({ ...RETAIL_FLARE_LIGHT, color: RED, flareCone: [90, 30] })

  // Its Z axis points at the camera on +Z, so it's looked at from behind its own axis.
  light.world = at(0)
  assert.equal(coneLevel(light, { x: 0, y: 0, z: -10 }), 1)
  assert.equal(coneLevel(light, { x: 0, y: 0, z: 10 }), 0)

  const level = coneLevel(light, { x: 10, y: 0, z: -10 })
  const cos45 = Math.SQRT1_2

  assert.ok(Math.abs(level - cos45 / Math.cos(Math.PI / 6)) < 1e-3)
})

test('every glow, then every bulb, as camera-facing quads added, a black one left out', () => {
  const lit = FlashLight.fromLight({
    ...RETAIL_FLARE_LIGHT,
    color: RED,
    bulbSize: 0.5,
    glowSize: 2,
  })

  lit.world = at(5)

  const dark = FlashLight.fromLight(RETAIL_FLARE_LIGHT)
  const draws = flashlightDraws([lit, dark], CAMERA, TEXTURES)

  assert.deepEqual(
    draws.map(({ materialName, count }) => [materialName, count]),
    [
      ['shine', 6],
      ['bulb', 6],
    ],
  )

  const [shine] = draws

  assert.equal(shine!.blendMode, 'add')
  assert.equal(shine!.depthWrite, false)
  assert.equal(shine!.depthFunc, 'lequal')
  assert.equal(shine!.cull, 'none')
  assert.equal(shine!.fog, undefined)

  const floats = new Float32Array(shine!.mesh.vertices.buffer)
  const corner = (vertex: number) => [...floats.subarray(vertex * 6, vertex * 6 + 3)]

  // Centre less right plus up, at (0, 0); then right and up; right and down; left and down.
  assert.deepEqual(corner(0), [3, 2, 0])
  assert.deepEqual(corner(1), [7, 2, 0])
  assert.deepEqual(corner(2), [7, -2, 0])
  assert.deepEqual(corner(5), [3, -2, 0])
  // Red as D3DCOLOR's bytes: blue, green, red, alpha.
  assert.deepEqual([...shine!.mesh.vertices.subarray(12, 16)], [0, 0, 255, 255])
  assert.deepEqual(flashlightDraws([], CAMERA, TEXTURES), [])
})
