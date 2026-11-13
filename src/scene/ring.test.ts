import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Quat, type RingShape } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import { buildRing, ringPieceDraw, textureShape, type RingExterior } from './ring.js'

const texture = { name: 'rings', width: 256, height: 256 } as Texture
const detailTexture = { name: 'detail', width: 64, height: 64 } as Texture

const zone: RingShape = {
  type: 'ring',
  center: { x: 1000, y: 0, z: 0 },
  orientation: Quat.identity,
  radius: 500,
  innerRadius: 300,
  height: 20,
}

const exterior: RingExterior = {
  shape: textureShape(texture, { x: 78, y: 0, w: 8, h: 256 }),
  detail: textureShape(detailTexture, {}),
  detailTile: [25, 5],
  color: { x: 1, y: 0.5, z: 0.25 },
  opacity: 0.7,
  segments: 32,
}

const floatsOf = (vertices: Uint8Array, at: number) =>
  new Float32Array(vertices.buffer, vertices.byteOffset + at * 32, 8)

test("a shape's rectangle is its pixels, a hundredth of one in from each edge", () => {
  const { u0, v0, u1, v1 } = textureShape(texture, { x: 78, y: 0, w: 8, h: 256 })

  assert.equal(u0, Math.fround(78.01 / 256))
  assert.equal(u1, Math.fround(Math.fround(86 - Math.fround(0.01)) / 256))
  assert.equal(v0, Math.fround(Math.fround(0.01) / 256))
  assert.equal(v1, Math.fround(Math.fround(256 - Math.fround(0.01)) / 256))

  // No extent: the whole texture.
  const whole = textureShape(detailTexture, {})

  assert.ok(whole.u0 > 0 && whole.u1 < 1 && Math.abs(whole.u1 - 1) < 1e-3)
})

test('eight pieces share their end segments, the last reaching back round to the first', () => {
  const { pieces } = buildRing(exterior, zone)

  assert.deepEqual(
    pieces.map(({ first, last }) => [first, last]),
    [0, 4, 8, 12, 16, 20, 24, 28].map((first) => [first, first + 4]),
  )
  // Each is a strip of five segments, two vertices apiece.
  assert.equal(pieces[0]!.reference.indexCount, 10)

  // The last piece's last segment is the first's: the same two vertices.
  const last = floatsOf(pieces[7]!.mesh.vertices, 8)
  const first = floatsOf(pieces[0]!.mesh.vertices, 0)

  assert.deepEqual([...last.slice(0, 3)], [...first.slice(0, 3)])
})

test("each segment stands on the zone's two radii, in its frame", () => {
  const { pieces } = buildRing(exterior, zone)
  const at = (piece: number, vertex: number) => [...floatsOf(pieces[piece]!.mesh.vertices, vertex)]

  // Segment 0 is at angle 0: along +Z from the centre, outer then inner.
  assert.deepEqual(at(0, 0).slice(0, 3), [1000, 0, 500])
  assert.deepEqual(at(0, 1).slice(0, 3), [1000, 0, 300])

  // Segment 8 is a quarter turn round, along +X.
  const [x, y, z] = at(2, 0)

  assert.ok(Math.abs(x! - 1500) < 1e-3 && y === 0 && Math.abs(z!) < 1e-3, `${x},${z}`)

  // The piece's sphere wraps its box: a quarter of the band, and above.
  const { center, radius } = pieces[0]!

  assert.ok(center.x > 1000 && center.z > 0 && radius > 100, `${center.x},${center.z},${radius}`)
})

test("even segments take the shape's left edge and odd its right, the detail tiling over both", () => {
  const { pieces } = buildRing(exterior, zone)
  const shape = exterior.shape!
  const uv = (vertex: number) => [...floatsOf(pieces[0]!.mesh.vertices, vertex).slice(4, 8)]

  // Segment 0, outer then inner.
  assert.deepEqual(uv(0), [shape.u0, shape.v0, 0, 0])
  assert.deepEqual(uv(1), [shape.u0, shape.v1, 0, 25])
  // Segment 1: the right edge, and `detail_tile`'s second value, as an integer, for U.
  assert.deepEqual(uv(2), [shape.u1, shape.v0, 5, 0])
  assert.deepEqual(uv(3), [shape.u1, shape.v1, 5, 25])
})

test('the colour and opacity truncate to bytes, and the opacity halves without a detail shape', () => {
  const colour = (ring: RingExterior, options = {}) => {
    const { vertices } = buildRing(ring, zone, options).pieces[0]!.mesh

    return [...vertices.slice(12, 16)]
  }

  // B, G, R, A: 0.25, 0.5, 1 and 0.7 of 255.
  assert.deepEqual(colour(exterior), [63, 127, 255, 178])

  const { detail: _, ...plain } = exterior

  assert.equal(colour(plain)[3], Math.trunc(Math.fround(0.35) * 255))
  // `high_detail_textures` under 0.4 drops it too.
  assert.equal(
    colour(exterior, { highDetailTextures: 0.3 })[3],
    Math.trunc(Math.fround(0.35) * 255),
  )
})

test('a piece draws unlit and blended, both sides, testing depth with LEQUAL and writing none', () => {
  const ring = buildRing(exterior, zone)
  const draw = ringPieceDraw(ring, ring.pieces[0]!)!

  assert.equal(draw.unlit, true)
  assert.equal(draw.colorVertex, true)
  assert.equal(draw.blend, true)
  assert.equal(draw.blendMode, 'alpha')
  assert.equal(draw.cull, 'none')
  assert.equal(draw.depthFunc, 'lequal')
  assert.equal(draw.depthWrite, false)
  assert.equal(draw.texture?.uvSet, 0)
  assert.deepEqual([draw.second?.operation, draw.second?.texture?.uvSet], ['modulate2x', 1])
  // Wrapped, as `0x422410` leaves stage 0.
  assert.equal(draw.texture?.sampler.wrapU, 'repeat')

  const { shape: _, ...bare } = exterior
  const none = buildRing(bare, zone)

  assert.equal(ringPieceDraw(none, none.pieces[0]!), undefined)
})
