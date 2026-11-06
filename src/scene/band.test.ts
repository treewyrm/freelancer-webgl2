import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Quat } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import { AsteroidBand, type BandField, type BandSettings } from './band.js'
import { textureShape } from './ring.js'

const f = Math.fround
const shape = textureShape({ name: 'belt', width: 64, height: 64 } as Texture, {})

// `asteroid_inside`'s band: a sphere of 5000 at (0, 0, -4000), 3000 in from its surface.
const field: BandField = {
  position: { x: 0, y: 0, z: -4000 },
  orientation: Quat.identity,
  size: { x: 5000, y: 0, z: 0 },
  diffuse: { x: f(220 / 255), y: f(220 / 255), z: f(180 / 255) },
  ambient: { x: f(120 / 255), y: f(120 / 255), z: f(120 / 255) },
  ambientIncrease: { x: 70, y: 40, z: 30 },
}
const settings: BandSettings = {
  shape,
  renderParts: 6,
  height: 5000,
  offset: { distance: 3000 },
  fade: [1, 1.35, 15, 17],
  textureAspect: 1,
  vertIncrease: 2,
}

/** Each quad of a draw: its two ends' U, colour bytes (B, G, R, A) and top Y. */
const quadsOf = (band: AsteroidBand, piece: number) => {
  const draw = band.pieceDraw(piece)
  if (!draw) return []
  const floats = new Float32Array(draw.mesh.vertices.buffer)
  const bytes = draw.mesh.vertices
  return Array.from({ length: draw.count / 6 }, (_, quad) => {
    const at = (vertex: number) => quad * 6 + vertex
    const colour = (vertex: number) => [...bytes.slice(at(vertex) * 24 + 12, at(vertex) * 24 + 16)]
    return {
      u: [floats[at(0) * 6 + 4], floats[at(2) * 6 + 4]],
      v: [0, 1, 2, 3, 4, 5].map((vertex) => floats[at(vertex) * 6 + 5]),
      a: floats.slice(at(0) * 6, at(0) * 6 + 3),
      b: floats.slice(at(2) * 6, at(2) * 6 + 3),
      colours: [colour(0), colour(2)],
    }
  })
}

test("the ring's points: the zone's girth over the texture's width, times vert_increase", () => {
  const band = new AsteroidBand(settings, field)
  // (5000 + 5000) π / (1.15 · 5000) is 5.46: 5 segments, two points each.
  assert.equal(band.points.length, 10)
  assert.equal(band.halfHeight, 2500)
  // From angle 0 along +X, turning toward +Z: 2000 out, the offset taken from the size.
  assert.deepEqual(band.points[0]!.position, { x: 2000, y: 0, z: -4000 })
  const { x, z } = band.points[1]!.position
  assert.ok(Math.abs(x - 1618.034) < 1e-3 && Math.abs(z - -2824.4299) < 1e-3)
  // Normals point out, level whatever the zone's tilt.
  for (const { position, normal } of band.points) {
    const out = Math.hypot(position.x, position.z + 4000)
    assert.ok(Math.abs(normal.x - position.x / out) < 1e-6, `${normal.x}`)
    assert.ok(Math.abs(normal.z - (position.z + 4000) / out) < 1e-6)
    assert.equal(normal.y, 0)
  }
})

test('render_parts is held to half the points, each piece a run from where the last ended', () => {
  const band = new AsteroidBand(settings, field)
  assert.deepEqual(
    band.pieces.map(({ first, last }) => [first, last]),
    [
      [0, 2],
      [2, 4],
      [4, 6],
      [6, 8],
      [8, 10],
    ],
  )
  // An even run's centre is between its middle point and the next, as retail picks it
  // (`0x54ce17`): here points 1 and 2, not point 1. Its sphere reaches its farther end, point 0.
  const [piece] = band.pieces
  const [one, two, zero] = [1, 2, 0].map((at) => band.points[at]!.position)
  assert.deepEqual(piece!.center, {
    x: f(f(one!.x + two!.x) * 0.5),
    y: 0,
    z: f(f(one!.z + two!.z) * 0.5),
  })
  const reach = (p: { x: number; z: number }) =>
    f(Math.hypot(f(piece!.center.x - p.x), 0, f(piece!.center.z - p.z)))
  assert.equal(piece!.radius, Math.max(reach(zero!), reach(two!)))
  // Without render_parts, one piece of the whole ring.
  assert.deepEqual(
    new AsteroidBand({ ...settings, renderParts: undefined }, field).pieces.map(
      ({ first, last }) => [first, last],
    ),
    [[0, 10]],
  )
})

test('a point fades in past the first two distances and out past the last two, in heights', () => {
  const band = new AsteroidBand({ ...settings, renderParts: 1 }, field)
  // Facing it squarely from outside, 6000 off: between 5000 and 6750 of a 5000 high band.
  band.update({ x: 8000, y: 0, z: -4000 })
  const [quad] = quadsOf(band, 0).filter(({ a }) => a[0] === 2000 && a[2] === -4000)
  const squared = 6000 * 6000
  const fade = f((squared - f(5000 * 5000)) / (f(6750 * 6750) - f(5000 * 5000)))
  assert.equal(quad!.colours[0]![3], Math.trunc(f(fade * 255)))
  // From 80000 off, past 75000: fading out.
  band.update({ x: 82000, y: 0, z: -4000 })
  const [far] = quadsOf(band, 0).filter(({ a }) => a[0] === 2000 && a[2] === -4000)
  const out = f((f(85000 * 85000) - 80000 * 80000) / (f(85000 * 85000) - f(75000 * 75000)))
  assert.equal(far!.colours[0]![3], Math.trunc(f(out * 255)))
})

test('edge-on, a point fades below a cosine of 0.5 and is gone below 0.3', () => {
  const band = new AsteroidBand({ ...settings, renderParts: 1 }, field)
  const point = band.points[0]!.position
  // 10000 off, at 66° and then 75° from point 0's normal (+X).
  const at = (degrees: number) => {
    const angle = (degrees * Math.PI) / 180
    band.update({
      x: point.x + 10000 * Math.cos(angle),
      y: 0,
      z: point.z + 10000 * Math.sin(angle),
    })
    const quad = quadsOf(band, 0).find(({ a }) => a[0] === 2000 && a[2] === -4000)
    return quad?.colours[0]![3]
  }
  const cos66 = f(Math.cos((66 * Math.PI) / 180))
  assert.equal(at(66), Math.trunc(f(f(f(cos66 - f(0.3)) * 1) * 5) * 255))
  // At 75° the quad from point 0 is transparent, but its other end may hold it.
  const seventyFive = at(75)
  assert.ok(seventyFive === undefined || seventyFive === 0)
})

test('a point faded out past the far end keeps the side it was last seen from', () => {
  const band = new AsteroidBand({ ...settings, renderParts: 1 }, field)
  // Seen from inside the ring, from the centre: every point is seen from behind.
  band.update({ x: 0, y: 6000, z: -4000 })
  // Then from beyond the outer distance on +X: nothing is updated but the fade.
  band.update({ x: 100000, y: 0, z: -4000 })
  assert.equal(band.pieceDraw(0), undefined)
})

test('the bake: ambient raised and tinted, each light softened 0.75 round the back, held under 1', () => {
  const band = new AsteroidBand({ ...settings, renderParts: 1 }, field)
  const light = { x: -0.6, y: 0, z: -0.8 }
  band.bake({
    ambient: { x: 40, y: 40, z: 50 },
    found: 1,
    lights: [{ direction: light, color: { x: 1, y: 1, z: 1 } }],
  })
  assert.ok(band.isBaked)
  // From outside along +X, point 0 (normal +X) shows its front.
  band.update({ x: 10000, y: 0, z: -4000 })
  const quad = quadsOf(band, 0).find(({ a }) => a[0] === 2000 && a[2] === -4000)!
  const ambient = f(f(f(f(40 * 0.003921569) + f(70 / 255)) * f(120 / 255)) * 1)
  const t = (0.75 - light.x) / 1.75
  const red = f(ambient + 1 * f(220 / 255) * t)
  assert.equal(quad.colours[0]![2], Math.trunc(f(Math.min(red, 1) * 255)))
  // With no light found, nothing is baked: the front stays white.
  const unlit = new AsteroidBand({ ...settings, renderParts: 1 }, field)
  unlit.bake({ ambient: { x: 40, y: 40, z: 50 }, found: 0, lights: [] })
  assert.ok(!unlit.isBaked)
})

test('a piece draws quads turned away first, U stepping by vert_increase, V 1 at the top', () => {
  const band = new AsteroidBand(settings, field)
  // From outside on +Z: piece 4 runs from point 8 round to point 0.
  band.update({ x: 0, y: 0, z: 20000 })
  const quads = quadsOf(band, 4)
  assert.ok(quads.length > 0)
  for (const { u, v, a } of quads) {
    assert.ok((u[0] === 0 && u[1] === 0.5) || (u[0] === 0.5 && u[1] === 1), `${u}`)
    assert.deepEqual(v, [1, 0, 0, 0, 1, 1])
    assert.equal(a[1], 2500)
  }
  // Top and bottom stand half the height either side of the ring.
  const draw = band.pieceDraw(4)!
  const floats = new Float32Array(draw.mesh.vertices.buffer)
  assert.deepEqual([floats[1], floats[7]], [2500, -2500])
  assert.deepEqual(
    [draw.depthFunc, draw.depthWrite, draw.cull, draw.alphaReference],
    ['always', false, 'none', 5],
  )
})

test('cull mode 1 drops the faces turned away, 2 those turned toward', () => {
  const eye = { x: 0, y: 0, z: 20000 }
  const counts = [0, 1, 2].map((cullMode) => {
    const band = new AsteroidBand({ ...settings, cullMode }, field)
    band.update(eye)
    return band.pieces.map((_, piece) => quadsOf(band, piece).length)
  })
  const sum = (list: number[]) => list.reduce((a, b) => a + b, 0)
  assert.ok(sum(counts[1]!) < sum(counts[0]!))
  assert.ok(sum(counts[2]!) < sum(counts[0]!))
  // Seen from +Z, the near pieces (0 and 1, on +Z) face the camera, the far ones (3) away.
  assert.equal(counts[2]![3], counts[0]![3])
  assert.equal(counts[1]![3], 0)
})

test('without a shape a band draws nothing', () => {
  const band = new AsteroidBand({ ...settings, shape: undefined }, field)
  band.update({ x: 0, y: 0, z: 20000 })
  assert.equal(band.pieceDraw(3), undefined)
})
