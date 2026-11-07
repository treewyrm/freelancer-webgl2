import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import { viewMatrix, type Camera } from './camera.js'
import {
  starCorona,
  starFlare,
  starIntensity,
  sunEffectQuality,
  sunLeastLod,
  updateStar,
  type CoronaView,
  type RayHit,
} from './corona.js'
import type { Draw } from './frame.js'
import { textureShape } from './ring.js'
import type { Star } from './star.js'

const spike = { name: 'LensGlowSpike', width: 128, height: 128, format: 'rgba32_8888' } as Texture
const camera: Camera = {
  position: { x: 0, y: 0, z: 0 },
  orientation: Matrix3.identity,
  fovh: 35,
  near: 1,
  far: 20000,
}
const viewOf = (fields: Partial<CoronaView> = {}): Omit<CoronaView, 'visibility'> => ({
  camera,
  view: viewMatrix(camera),
  width: 1024,
  height: 768,
  leastLod: 0,
  ...fields,
})
const starOf = (): Star => ({
  radius: 1000,
  lensGlow: {
    shape: textureShape(spike, {}),
    innerColor: { x: 1, y: 1, z: 1 },
    outerColor: { x: 1, y: 0.5, z: 0.2 },
  },
})
// XScale is 512 / tan 35°, 731.2: a radius of 1000 is 7.3 pixels at 100000, under the first LOD's 8.
const FAR = { x: 0, y: 0, z: -100000 }
const NEAR = { x: 0, y: 0, z: -10000 }

const alphasOf = (draw: Draw) =>
  Array.from({ length: draw.count }, (_, at) => draw.mesh.vertices[at * 24 + 15]!)
const pointsOf = (draw: Draw) => {
  const floats = new Float32Array(draw.mesh.vertices.buffer)
  return Array.from({ length: draw.count }, (_, at) => [floats[at * 6]!, floats[at * 6 + 1]!])
}

test('the SunEffect option is times 1.33333, held to 1, and leaves the corona its fewest LODs', () => {
  assert.equal(sunEffectQuality(0.5), Math.fround(0.666665))
  assert.equal(sunEffectQuality(1), 1)
  assert.equal(sunLeastLod(1), 0)
  assert.equal(sunLeastLod(sunEffectQuality(0.5)), 2)
  assert.equal(sunLeastLod(0), 5)
})

test('a small sun is a fan about its centre on screen, at half its samples’ alpha', () => {
  const star = starOf()
  updateStar(star, 0.1)
  const draws = starCorona(star, FAR, false, viewOf())
  assert.equal(draws.length, 1)
  const [fan] = draws
  assert.equal(fan!.mesh.primitive, 6)
  assert.equal(fan!.count, 14)
  assert.equal(fan!.blendMode, 'alphaAdd')
  // The middle of a 1024 by 768 screen, and the rim radius_scale × pixel scale out, y down.
  const points = pointsOf(fan!)
  assert.deepEqual(points[0], [512, 384])
  const pixelScale = Math.fround(512 / Math.tan(Math.fround(35 * Math.fround(Math.PI / 180))))
  const scale = Math.fround(Math.fround(2 * Math.fround(pixelScale * 0.01)))
  assert.ok(Math.abs(points[1]![0]! - (512 + scale)) < 1e-3, `${points[1]}`)
  assert.ok(Math.abs(points[4]![1]! - (384 - scale)) < 1e-3, `${points[4]}`)
  assert.deepEqual(alphasOf(fan!), Array(14).fill(127))
})

test('a ray blocked by something big enough on screen fades the samples by the glow’s fade', () => {
  const blocker: RayHit = { position: { x: 0, y: 0, z: -500 }, radius: 50 }
  const star = starOf()
  updateStar(star, 0.1)
  // 0.1 of a fade of 0.25 a frame: 1, then 0.6, then 0.2.
  const rayHits = () => [blocker]
  const view = viewOf({ rayHits })
  assert.equal(alphasOf(starCorona(star, FAR, false, view)[0]!)[0], 76)
  assert.equal(alphasOf(starCorona(star, FAR, false, view)[0]!)[0], 25)
  // Clear again, it comes back as fast.
  assert.equal(alphasOf(starCorona(star, FAR, false, viewOf())[0]!)[0], 76)
})

test('its own solar, a shield, the cockpit’s ship and what is small on screen never block', () => {
  const own = {}
  const player = {}
  const hits: RayHit[] = [
    { object: own, position: { x: 0, y: 0, z: -500 }, radius: 50 },
    { object: player, position: { x: 0, y: 0, z: -500 }, radius: 50 },
    { position: { x: 0, y: 0, z: -500 }, radius: 50, shield: true },
    // 731 / 50000 · 5 is 0.07 pixels, against the sun's 7.3 × 0.65.
    { position: { x: 0, y: 0, z: -50000 }, radius: 5 },
  ]
  const star = starOf()
  updateStar(star, 0.1)
  const draws = starCorona(star, FAR, false, viewOf({ rayHits: () => hits, own, player }))
  assert.deepEqual(alphasOf(draws[0]!), Array(14).fill(127))
})

test('only six hits a ray are looked at', () => {
  const small: RayHit = { position: { x: 0, y: 0, z: -50000 }, radius: 5 }
  const big: RayHit = { position: { x: 0, y: 0, z: -500 }, radius: 50 }
  const star = starOf()
  updateStar(star, 0.1)
  const draws = starCorona(
    star,
    FAR,
    false,
    viewOf({ rayHits: () => [...Array(6).fill(small), big] }),
  )
  assert.equal(alphasOf(draws[0]!)[0], 127)
})

test('a near sun samples a ring between its centre and rim: a band of triangles, then a fan', () => {
  const star = starOf()
  updateStar(star, 0.1)
  const draws = starCorona(star, NEAR, false, viewOf())
  assert.deepEqual(
    draws.map(({ mesh, count }) => [mesh.primitive, count]),
    [
      [4, 72],
      [6, 14],
    ],
  )
  // The inner ring is half way, in the colour half way from inner to outer.
  const [band] = draws
  const colour = [...band!.mesh.vertices.slice(12, 15)]
  assert.deepEqual(colour, [153, 191, 255])
})

test('the fewest LODs the option allows stand in for the near sun’s', () => {
  const star = starOf()
  updateStar(star, 0.1)
  assert.equal(starCorona(star, NEAR, false, viewOf({ leastLod: 3 })).length, 1)
})

test('a zone across the line eases the corona out over its 2 s, and past it nothing draws', () => {
  const star = starOf()
  updateStar(star, 0.5)
  // A quarter hidden: the alpha's half of 255 times 0.75.
  assert.equal(alphasOf(starCorona(star, FAR, true, viewOf())[0]!)[0], 95)
  assert.equal(starIntensity(star).zoneOcclusion, 0.25)
  for (let at = 0; at < 3; at++) starCorona(star, FAR, true, viewOf())
  assert.deepEqual(starCorona(star, FAR, true, viewOf()), [])
})

test('behind the camera nothing draws and its samples fade, which the flare follows', () => {
  const star = starOf()
  const behind = { x: 0, y: 0, z: 100000 }
  updateStar(star, 0.1)
  // To 0.6, then noted as such before going on to 0.2.
  assert.deepEqual(starCorona(star, behind, false, viewOf()), [])
  assert.deepEqual(starCorona(star, behind, false, viewOf()), [])
  // Toward 0.6 by 0.1 a frame, its fade-out of 1 s.
  updateStar(star, 0.1)
  assert.equal(starIntensity(star).intensity, Math.fround(0.9))
})

test('the flare’s intensity follows what the corona showed, by the star’s own fades', () => {
  const star: Star = { ...starOf(), intensityFade: { fadeIn: 1, fadeOut: 0.5 } }
  const rayHits = () => [{ position: { x: 0, y: 0, z: -500 }, radius: 50 }]
  // Each frame: the update, then the draw. The draw notes what showed before it samples.
  for (let at = 0; at < 4; at++) {
    updateStar(star, 0.1)
    starCorona(star, FAR, false, viewOf({ rayHits }))
  }
  // Shown 1, 0.6, 0.2 and 0 at each draw, which the next update follows by 0.2 at most: 1, 1, 0.8,
  // 0.6, then 0.4.
  updateStar(star, 0.1)
  const f = Math.fround
  const step = f(f(0.1) / 0.5)
  assert.equal(starIntensity(star).intensity, f(f(f(1 - step) - step) - step))
})

test('without a shape it draws nothing, yet still samples', () => {
  const star: Star = { radius: 1000 }
  updateStar(star, 0.1)
  const rayHits = () => [{ position: { x: 0, y: 0, z: -500 }, radius: 50 }]
  assert.deepEqual(starCorona(star, FAR, false, viewOf({ rayHits })), [])
  starCorona(star, FAR, false, viewOf({ rayHits }))
  updateStar(star, 0.1)
  assert.ok(starIntensity(star).intensity < 1)
})

const stripe = { name: 'stripe_flare', width: 64, height: 64, format: 'rgba32_8888' } as Texture
const hexagon = { name: 'hexagon', width: 64, height: 64, format: 'rgb24_888' } as Texture
const spineOf = (length: number) => ({
  length,
  width: 2,
  innerColor: { x: 1, y: 1, z: 1 },
  outerColor: { x: 0.5, y: 0.5, z: 1 },
  alpha: 0.5,
})
const spiny = (lengths: number[]): Star => ({
  ...starOf(),
  spines: { shape: textureShape(stripe, {}), spines: lengths.map(spineOf) },
})
const xyOf = (draw: Draw, at: number) => {
  const floats = new Float32Array(draw.mesh.vertices.buffer)
  return [floats[at * 6]!, floats[at * 6 + 1]!]
}

test('spines draw before the corona, spread round from the right, anticlockwise on screen', () => {
  const star = spiny([10, 10, 10, 10])
  updateStar(star, 0.1)
  const draws = starCorona(star, FAR, false, viewOf())
  assert.deepEqual(
    draws.map(({ materialName }) => materialName),
    ['spines', 'corona'],
  )
  const [spines] = draws
  // Three quads a spine, two triangles a quad.
  assert.equal(spines!.count, 4 * 3 * 6)
  assert.equal(spines!.blendMode, 'alphaAdd')
  // The first spine's tip, its -w side, is right of the sun by its length times the pixel scale,
  // 7.31, and half its width up; the second's is above it and half its width left.
  const pixelScale = Math.fround(731.2 / 100)
  const [tipX, tipY] = xyOf(spines!, 9)
  assert.ok(Math.abs(tipX! - 512 - 10 * pixelScale) < 0.05, `${tipX}`)
  assert.ok(Math.abs(tipY! - (384 - 1 * pixelScale)) < 0.05, `${tipY}`)
  const [upX, upY] = xyOf(spines!, 12 + 9)
  assert.ok(Math.abs(upX! - (512 - 1 * pixelScale)) < 0.05, `${upX}`)
  assert.ok(Math.abs(upY! - (384 - 10 * pixelScale)) < 0.05, `${upY}`)
})

test("a spine fades in from nothing at its base to its alpha, with what's seen about it", () => {
  const star = spiny([10, 10, 10, 10])
  updateStar(star, 0.1)
  const [spines] = starCorona(star, FAR, false, viewOf())
  const alphas = alphasOf(spines!)
  // Base, inner ring, inner ring, base; then the rest at 0.5 of 255, every sample seen.
  assert.deepEqual(alphas.slice(0, 4), [0, 127, 127, 0])
  assert.deepEqual(alphas.slice(4, 12), Array(8).fill(127))
})

test('long spines draw with the sun off screen, past where its corona would', () => {
  const star = spiny([100, 100, 100, 100])
  updateStar(star, 0.1)
  // 100 pixels left of the screen: past the corona's 50, within the spines' 731.
  const off = { x: -(612 / 731.2) * 100000, y: 0, z: -100000 }
  assert.deepEqual(
    starCorona(star, off, false, viewOf()).map(({ materialName }) => materialName),
    ['spines'],
  )
})

const flared = (): Star => ({
  ...starOf(),
  lensFlare: {
    shape: textureShape(hexagon, {}),
    minRadius: 10,
    maxRadius: 150,
    beads: [{ along: 0.5, size: 1, color: { x: 1, y: 0.5, z: 0 }, alpha: 0.5 }],
  },
})

test('the flare lies along the line from the sun through the middle, three times its length', () => {
  const star = flared()
  updateStar(star, 0.1)
  // 200 pixels right of the middle: the bead's centre is 1.5 times that the other way.
  const right = { x: (200 / 731.2) * 100000, y: 0, z: -100000 }
  starCorona(star, right, false, viewOf())
  const flare = starFlare(star, { view: viewMatrix(camera), width: 1024, height: 768 })!
  assert.equal(flare.blendMode, 'alphaAdd')
  assert.equal(flare.count, 6)
  const [x0, y0] = xyOf(flare, 0)
  const [x1] = xyOf(flare, 1)
  // The pixel scale, 7.3, held to the least 10: a square 20 across about 511.5 - 1.5 · 200.5.
  const sunX = 512 + 200
  const centre = (1023 / 2 - sunX) * 3 * 0.5 + sunX
  assert.ok(Math.abs((x0! + x1!) / 2 - centre) < 0.05, `${x0} ${x1}`)
  assert.ok(Math.abs(x1! - x0! - 20) < 0.05, `${x1! - x0!}`)
  // The sun is at 384 against a middle of 383.5.
  assert.ok(Math.abs(y0! - (383.25 - 10)) < 0.05, `${y0}`)
  // Far enough from the middle not to fade: half its alpha, in its colour.
  assert.deepEqual([...flare.mesh.vertices.slice(12, 16)], [0, 127, 255, 127])
})

test('the flare fades as the sun nears the middle, and goes with the sun behind or a zone', () => {
  const star = flared()
  updateStar(star, 0.1)
  // 51.15 pixels off is a tenth of 1023 in all, so a quarter of the way at 25.6 is a quarter faded.
  const near = { x: (25.575 / 731.2) * 100000, y: 0, z: -100000 }
  starCorona(star, near, false, viewOf())
  const frame = { view: viewMatrix(camera), width: 1024, height: 768 }
  const alpha = starFlare(star, frame)!.mesh.vertices[15]!
  assert.ok(alpha < 20, `${alpha}`)
  starCorona(star, { x: 0, y: 0, z: 100000 }, false, viewOf())
  assert.equal(starFlare(star, frame), undefined)
  // A zone closes over its 2 s, then the flare is gone though the sun is ahead.
  updateStar(star, 1)
  for (let at = 0; at < 2; at++) starCorona(star, FAR, true, viewOf())
  assert.equal(starFlare(star, frame), undefined)
})
