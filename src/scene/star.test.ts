import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import type { Camera } from './camera.js'
import type { Draw } from './frame.js'
import { textureShape } from './ring.js'
import { starGlowDraws, starRadius, type Star } from './star.js'

const glow2 = { name: 'glow2', width: 128, height: 128, format: 'rgba32_8888' } as Texture
const suncircle = { name: 'suncircle', width: 64, height: 64, format: 'rgb24_888' } as Texture
const camera: Camera = {
  position: { x: 0, y: 0, z: 0 },
  orientation: Matrix3.identity,
  fovh: 35,
  near: 1,
  far: 20000,
}
const yellow: Star = {
  radius: 3000,
  glow: {
    shape: textureShape(glow2, {}),
    scale: 5,
    innerColor: { x: 1, y: 1, z: 0.9 },
    outerColor: { x: 1, y: 0.8, z: 0.3 },
  },
  center: { shape: textureShape(suncircle, {}), scale: 2, outerColor: { x: 1, y: 1, z: 0.7 } },
}

const positionsOf = (draw: Draw) => {
  const floats = new Float32Array(draw.mesh.vertices.buffer)
  return Array.from({ length: draw.count }, (_, at) => [...floats.slice(at * 6, at * 6 + 3)])
}
const uvsOf = (draw: Draw) => {
  const floats = new Float32Array(draw.mesh.vertices.buffer)
  return Array.from({ length: draw.count }, (_, at) => [...floats.slice(at * 6 + 4, at * 6 + 6)])
}
const coloursOf = (draw: Draw) =>
  Array.from({ length: draw.count }, (_, at) => [
    ...draw.mesh.vertices.slice(at * 24 + 12, at * 24 + 16),
  ])

test("a star's sphere is its larger scale times its radius, the glow's when there's no centre", () => {
  assert.equal(starRadius(yellow), 15000)
  assert.equal(starRadius({ glow: { scale: 2 }, center: { scale: 4 } }), 4000)
  assert.equal(starRadius({ radius: 6000, center: { scale: 0.5 } }), 6000)
  assert.equal(starRadius({}), 1000)
})

test('the glow is a fan about the star, square to the camera, its first corner top left', () => {
  const [glow] = starGlowDraws(yellow, { x: 0, y: 0, z: -100000 }, camera, Matrix4.identity)
  assert.equal(glow!.mesh.primitive, 6)
  // Half a side is radius × scale: 15000. The centre, then the rim from the top left clockwise.
  assert.deepEqual(positionsOf(glow!), [
    [0, 0, -100000],
    [-15000, 15000, -100000],
    [0, 15000, -100000],
    [15000, 15000, -100000],
    [15000, 0, -100000],
    [15000, -15000, -100000],
    [0, -15000, -100000],
    [-15000, -15000, -100000],
    [-15000, 0, -100000],
    [-15000, 15000, -100000],
  ])
  const { u0, v0, u1, v1 } = textureShape(glow2, {})
  const um = Math.fround(Math.fround(u0 + u1) * 0.5)
  const vm = Math.fround(Math.fround(v0 + v1) * 0.5)
  assert.deepEqual(uvsOf(glow!), [
    [um, vm],
    [u0, v0],
    [um, v0],
    [u1, v0],
    [u1, vm],
    [u1, v1],
    [um, v1],
    [u0, v1],
    [u0, vm],
    [u0, v0],
  ])
})

test('the inner colour is at the centre and the outer on the rim, B G R A, truncated to bytes', () => {
  const [glow, centre] = starGlowDraws(
    yellow,
    { x: 0, y: 0, z: -100000 },
    camera,
    Matrix4.identity,
    0.5,
  )
  const colours = coloursOf(glow!)
  // 0.9 · 255 is 229.5, and `ftol` truncates; 0.5 · 255 is 127.
  assert.deepEqual(colours[0], [229, 255, 255, 127])
  for (const rim of colours.slice(1)) assert.deepEqual(rim, [76, 204, 255, 127])
  // The centre's alpha is the square: 0.25 · 255 is 63.75. Absent colours are white.
  assert.deepEqual(coloursOf(centre!)[0], [255, 255, 255, 63])
  assert.deepEqual(coloursOf(centre!)[1], [178, 255, 255, 63])
})

test('a colour over 1 is held to a byte, as St03_starglow writes a green of 80', () => {
  const star: Star = {
    glow: { shape: textureShape(glow2, {}), innerColor: { x: 0.95, y: 80, z: 0.69 } },
  }
  const [glow] = starGlowDraws(star, { x: 0, y: 0, z: -5000 }, camera, Matrix4.identity)
  assert.deepEqual(coloursOf(glow!)[0], [175, 255, 242, 255])
})

test('a texture with alpha blends by it; one without as ONE, INVSRCCOLOR', () => {
  const draws = starGlowDraws(yellow, { x: 0, y: 0, z: -5000 }, camera, Matrix4.identity)
  assert.deepEqual(
    draws.map(({ blendMode }) => blendMode),
    ['alpha', 'screen'],
  )
  for (const draw of draws) {
    assert.equal(draw.depthFunc, 'always')
    assert.equal(draw.depthWrite, false)
    assert.equal(draw.cull, 'none')
    assert.equal(draw.unlit, true)
  }
})

test('the glow is sized by size, and turns about the camera’s up toward the star', () => {
  // A star off to the right: the square faces the camera, so its across runs along -z there.
  const [glow] = starGlowDraws(
    { glow: { shape: textureShape(glow2, {}) } },
    { x: 10000, y: 0, z: 0 },
    camera,
    Matrix4.identity,
    1,
    2,
  )
  const [centre, topLeft] = positionsOf(glow!)
  assert.deepEqual(centre, [10000, 0, 0])
  // Right is the way to it crossed with up: +x × +y is +z. The top left is back along it, and up.
  assert.deepEqual(topLeft, [10000, 2000, -2000])
})

test('a glow without a shape draws nothing, and no centre means one draw', () => {
  assert.deepEqual(starGlowDraws({}, { x: 0, y: 0, z: -1000 }, camera, Matrix4.identity), [])
  const { center: _, ...glowOnly } = yellow
  assert.equal(
    starGlowDraws(glowOnly, { x: 0, y: 0, z: -1000 }, camera, Matrix4.identity).length,
    1,
  )
})
