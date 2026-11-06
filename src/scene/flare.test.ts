import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import type { Camera } from './camera.js'
import { viewMatrix } from './camera.js'
import { flareQuads, LightBlink, RETAIL_FLARE_LIGHT, type FlareLight } from './flare.js'

// A run of `rand()` results, as the game hands them out.
const sequence =
  (...values: number[]) =>
  () =>
    values.shift() ?? 0

test('a light that never blinks stays at full brightness', () => {
  const blink = new LightBlink(RETAIL_FLARE_LIGHT, sequence(0, 0))
  blink.tick(0.05)
  assert.equal(blink.brightness, 1)
})

test('a blink rises to 1 halfway through its lit part, falls back, then is dark', () => {
  // A `rand()` of 16384 puts the period at exactly `avg_delay`: 0.2 · 0.5 + 0.9 = 1.
  const blink = new LightBlink({ avgDelay: 2, blinkDuration: 1 }, sequence(16384, 0))
  const at = (seconds: number) => {
    blink.tick(seconds)
    return blink.brightness
  }
  // Rate 0.5 a second, duty 0.5 of the period: lit for the first second.
  assert.ok(Math.abs(at(0.25) - 0.5) < 1e-6)
  assert.ok(Math.abs(at(0.25) - 1) < 1e-6)
  assert.ok(Math.abs(at(0.25) - 0.5) < 1e-6)
  assert.equal(at(0.5), 0)
  // Round the period, at 0.25 of the next: the top of the blink again.
  assert.ok(Math.abs(at(1.25) - 1) < 1e-6)
})

test('blink_duration past the period is held to it, so the light is never dark', () => {
  const blink = new LightBlink({ avgDelay: 2, blinkDuration: 3 }, sequence(16384, 0))
  for (let step = 0; step < 40; step++) {
    blink.tick(0.05)
    assert.ok(blink.brightness > 0 || blink.phase === 0, `${blink.phase}`)
  }
})

const camera: Camera = {
  position: { x: 0, y: 0, z: 0 },
  orientation: Matrix3.identity,
  fovh: 45,
  near: 1,
  far: 1000,
}
const screen = { camera, view: viewMatrix(camera), aspect: 1, width: 100, height: 100 }

const white = { x: 1, y: 1, z: 1 }
const light: FlareLight = {
  ...RETAIL_FLARE_LIGHT,
  color: white,
  glowColor: { x: 0.5, y: 0.25, z: 1 },
  bulbSize: 1,
  glowSize: 4,
}

test('a flare is its bulb, then its glow, centred where the light is and sized by its depth', () => {
  // 50 / tan 45° = 50 pixels a unit at unit depth, so at 10 a unit is about 5 pixels.
  const [bulb, glow] = flareQuads(light, Matrix4.translation({ x: 0, y: 0, z: -10 }), 1, screen)
  const depth = Math.fround(-10 + 10 * 0.001)
  const radius = Math.fround(50 / -depth)
  // The rectangle ends on pixel 99, so its centre is 49.5.
  assert.ok(Math.abs(bulb!.x0 - (49.5 - radius)) < 1e-4, `${bulb!.x0}`)
  assert.ok(Math.abs(glow!.x1 - (49.5 + 4 * radius)) < 1e-3, `${glow!.x1}`)
  assert.equal(bulb!.color, 0xffffffff)
  // Colour bytes truncate: 0.5 · 255 is 127, 0.25 · 255 is 63.
  assert.equal(glow!.color, 0xff7f3fff)
  assert.ok(Math.abs(glow!.z - (1 - 1 / -depth)) < 1e-6)
  assert.ok(Math.abs(glow!.rhw - 1 / -depth) < 1e-7)
})

test('screen y runs down, against the view', () => {
  const [bulb] = flareQuads(light, Matrix4.translation({ x: 0, y: 2, z: -10 }), 1, screen)
  assert.ok(bulb!.y1 < 49.5, `${bulb!.y1}`)
})

test('a quad of a pixel or less, or black, or behind the camera, is dropped', () => {
  // At 250 the glow's radius is 0.8 of a pixel, the bulb's 0.2: neither is over 1.
  assert.deepEqual(flareQuads(light, Matrix4.translation({ x: 0, y: 0, z: -250 }), 1, screen), [])
  const [glow, ...rest] = flareQuads(light, Matrix4.translation({ x: 0, y: 0, z: -100 }), 1, screen)
  assert.equal(rest.length, 0)
  assert.equal(glow!.color, 0xff7f3fff)
  assert.deepEqual(flareQuads(light, Matrix4.translation({ x: 0, y: 0, z: -10 }), 0, screen), [])
  assert.deepEqual(flareQuads(light, Matrix4.translation({ x: 0, y: 0, z: 10 }), 1, screen), [])
})

test('a dark blink leaves the bulb at min_color', () => {
  const dim = { ...light, minColor: { x: 0.2, y: 0.2, z: 0.2 } }
  const [bulb] = flareQuads(dim, Matrix4.translation({ x: 0, y: 0, z: -10 }), 0, screen)
  assert.equal(bulb!.color, 0xff333333)
})

test('a quad over the edge is clipped, its texture coordinates with it', () => {
  // The bulb is wholly off the left edge; the glow, from x = -30.58 to 9.46, is cut at 0.
  const [glow, ...rest] = flareQuads(
    light,
    Matrix4.translation({ x: -12, y: 0, z: -10 }),
    1,
    screen,
  )
  assert.equal(rest.length, 0)
  assert.equal(glow!.x0, 0)
  const radius = Math.fround((4 * 50) / Math.fround(10 - 10 * 0.001))
  const centre = 49.5 - 12 * (radius / 4)
  assert.ok(Math.abs(glow!.u0 - (0 - (centre - radius)) / (2 * radius)) < 1e-4, `${glow!.u0}`)
  assert.equal(glow!.u1, 1)
})

test("the glow fades as the light's forward axis turns toward the camera", () => {
  // `CliEquipLightDrawFlare` dots the light's +Z with the way from the camera to the light, so a
  // light pointing away from the camera is full, and one facing it is gone.
  const coned = { ...light, flareCone: [180, 90] as const }
  const turned = (angle: number) =>
    Matrix4.multiply(
      Matrix4.translation({ x: 0, y: 0, z: -10 }),
      Matrix4.fromRotationTranslation(Matrix3.axisAngle({ x: 0, y: 1, z: 0 }, angle)),
    )
  const glowOf = (angle: number) => {
    const quads = flareQuads(coned, turned(angle), 1, screen)
    return quads.length === 2 ? quads[1]!.color & 0xff : 0
  }
  assert.equal(glowOf(Math.PI), 0xff)
  // Side on is the inner cone's 90°: still full.
  assert.ok(glowOf(Math.PI / 2) >= 0xfe, `${glowOf(Math.PI / 2)}`)
  // A quarter turn short of facing it: a dot of -0.707, faded to 0.293 of the way.
  assert.ok(Math.abs(glowOf(Math.PI / 4) - Math.trunc(255 * (1 - Math.SQRT1_2))) <= 1)
  assert.equal(glowOf(0), 0)
})
