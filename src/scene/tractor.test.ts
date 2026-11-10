import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import { viewMatrix, type Camera } from './camera.js'
import type { Draw } from './frame.js'
import {
  lookMatrixYup,
  RETAIL_TRACTOR_LIMITS,
  tractorDraws,
  type TractorArm,
  type TractorBeam,
  type TractorLimits,
} from './tractor.js'

const texture = { name: 'line' } as Texture

// Looking down -Z from the origin.
const camera: Camera = {
  position: { x: 0, y: 0, z: 0 },
  orientation: Matrix3.identity,
  fovh: 45,
  near: 1,
  far: 20000,
}

// `ge_s_tractor_01`, as `misc_equip.ini` writes it.
const beam = (arms: TractorArm[], source: Vector3 = { x: 0, y: 0, z: -100 }): TractorBeam => ({
  source,
  maxLength: 1500,
  color: { x: 178.5, y: 178.5, z: 255 },
  arms,
})

// No stray: each point on its line, each arc on its sphere.
const STILL: Partial<TractorLimits> = { jitter: 0, endJitter: 0 }

const drawsOf = (
  tractors: TractorBeam[],
  limits: Partial<TractorLimits> = STILL,
  random = () => 0x4000,
  at = camera,
): Draw[] =>
  tractorDraws(tractors, texture, { camera: at, aspect: 1, view: viewMatrix(at), random, limits })

const floatsOf = ({ mesh }: Draw) => new Float32Array(mesh.vertices.buffer)
const vertexCount = ({ mesh }: Draw) => mesh.vertices.length / 24
const point = (draw: Draw, at: number): Vector3 => {
  const floats = floatsOf(draw)
  return { x: floats[at * 6]!, y: floats[at * 6 + 1]!, z: floats[at * 6 + 2]! }
}
const uv = (draw: Draw, at: number) => [...floatsOf(draw).slice(at * 6 + 4, at * 6 + 6)]
const bytes = ({ mesh }: Draw, at: number) => [...mesh.vertices.slice(at * 24 + 12, at * 24 + 16)]
// Each quad's centre, the mean of its four corners.
const centre = (draw: Draw, quad: number): Vector3 => {
  const corners = [0, 1, 2, 3].map((corner) => point(draw, quad * 4 + corner))
  const mean = (key: 'x' | 'y' | 'z') => corners.reduce((sum, c) => sum + c[key], 0) / 4
  return { x: mean('x'), y: mean('y'), z: mean('z') }
}
const near = (a: Vector3, b: Vector3, within = 1e-3) =>
  Math.abs(a.x - b.x) <= within && Math.abs(a.y - b.y) <= within && Math.abs(a.z - b.z) <= within

// Short of the loot: the tip at 23 along +X, the loot far past it.
const short: TractorArm = {
  tip: { x: 23, y: 0, z: -100 },
  loot: { x: 200, y: 0, z: -100 },
  radius: 5,
}

test('a beam short of its loot is floor(length / 5) + 1 quads from the source to the tip', () => {
  const [draw] = drawsOf([beam([short])])
  assert.ok(draw)
  assert.equal(vertexCount(draw), 5 * 4)
  assert.equal(draw.count, 5 * 6)
  // Each segment is 23 / 5 long, its quad about the segment's middle.
  for (let quad = 0; quad < 5; quad++)
    assert.ok(near(centre(draw, quad), { x: (23 / 5) * (quad + 0.5), y: 0, z: -100 }))
  assert.ok(near(point(draw, 4 * 4 + 2), { x: 23 + (23 / 5 / 2) * 0.25, y: 0, z: -100 }))
})

test("a beam's quad is a diamond turned to the eye, half as wide as long, the whole texture", () => {
  const [draw] = drawsOf([beam([short])])
  const step = 23 / 5
  // Along: back to the segment's start by a half and a quarter more; across, in the eye's plane.
  const mid = { x: step / 2, y: 0, z: -100 }
  assert.ok(near(point(draw!, 0), { ...mid, x: mid.x - (step / 2) * 1.25 }))
  assert.ok(near(point(draw!, 2), { ...mid, x: mid.x + (step / 2) * 1.25 }))
  const side = point(draw!, 1)
  assert.ok(Math.abs(Math.hypot(side.x - mid.x, side.y, side.z + 100) - (step / 4) * 1.25) < 1e-4)
  assert.ok(Math.abs(side.z + 100) < 1e-4, 'across is square to the line of sight')
  assert.deepEqual(
    [0, 1, 2, 3].map((corner) => uv(draw!, corner)),
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  )
  assert.deepEqual([...draw!.mesh.indices.slice(0, 6)], [0, 1, 2, 0, 2, 3])
})

test("a tractor's colour is its bytes kept whole, then over 255 and back", () => {
  const [draw] = drawsOf([beam([short])])
  // 178.5 is 178 kept, which no byte loses on the way back. As D3D's B, G, R, A.
  assert.deepEqual(bytes(draw!, 0), [255, 178, 178, 255])
  assert.deepEqual(bytes(draw!, 7), [255, 178, 178, 255])
  const [wrapped] = drawsOf([{ ...beam([short]), color: { x: 256, y: 511.9, z: 0 } }])
  assert.deepEqual(bytes(wrapped!, 0), [0, 255, 0, 255], 'only the low byte is kept')
})

test('the drawn state is the effects walk’s: added, unculled, unlit, no depth writes', () => {
  const [draw] = drawsOf([beam([short])])
  assert.equal(draw!.materialName, 'line')
  assert.equal(draw!.blendMode, 'add')
  assert.equal(draw!.cull, 'none')
  assert.equal(draw!.depthWrite, false)
  assert.equal(draw!.depthFunc, 'lequal')
  assert.equal(draw!.unlit, true)
  assert.equal(draw!.transient, true)
})

// The tip 2 past the loot's shell: its radius 10 is 2 to the beam, the shell at 98 along +X.
const into: TractorArm = {
  tip: { x: 100, y: 0, z: -100 },
  loot: { x: 100, y: 0, z: -100 },
  radius: 10,
}

test("a tip past the loot's shell stops the beam on it, and five arcs spark off it", () => {
  const [draw] = drawsOf([beam([into])])
  const lineQuads = Math.floor(98 / 5) + 1
  // The beam's last point is the shell's.
  assert.ok(
    near(
      point(draw!, (lineQuads - 1) * 4 + 2),
      { x: 98 + (98 / 20 / 2) * 0.25, y: 0, z: -100 },
      1e-2,
    ),
  )
  const arcQuads = vertexCount(draw!) / 4 - lineQuads
  assert.ok(arcQuads >= 5, `${arcQuads}`)
  // Each arc keeps to the sphere through the beam's end about 0.3 back from the loot's centre.
  const about = { x: 100 - 0.3, y: 0, z: -100 }
  for (let quad = lineQuads; quad < lineQuads + arcQuads; quad++) {
    const at = centre(draw!, quad)
    const reach = Math.hypot(at.x - about.x, at.y - about.y, at.z - about.z)
    assert.ok(reach <= 1.7 + 1e-3 && reach > 1.7 * 0.7, `${reach}`)
  }
})

test('a tip short of the shell has no sparks, and the end strays only in +x and +y', () => {
  const random = () => 32767
  const [draw] = drawsOf([beam([short])], { jitter: 0 }, random)
  // `0.5` both ways at the most `rand()` gives; z keeps the tip's.
  const last = point(draw!, 4 * 4 + 2)
  const step = Math.hypot(23.5, 0.5) / 5
  const along = { x: 23.5 / Math.hypot(23.5, 0.5), y: 0.5 / Math.hypot(23.5, 0.5) }
  const back = (step / 2) * 0.25
  assert.ok(near(last, { x: 23.5 + along.x * back, y: 0.5 + along.y * back, z: -100 }))
})

test('the arms drawn stop at eleven', () => {
  const [draw] = drawsOf([beam(Array.from({ length: 14 }, () => short))])
  assert.equal(vertexCount(draw!), 11 * 5 * 4)
})

test('a tractor whose reach the camera sees none of is not drawn', () => {
  assert.deepEqual(drawsOf([beam([short], { x: 0, y: 0, z: 2000 })]), [])
  // Behind, but its reach of 1500 crosses the near plane.
  assert.equal(drawsOf([beam([short], { x: 0, y: 0, z: 1000 })]).length, 1)
})

test('a beam past 16-bit indices goes on in another draw', () => {
  // Off the line of sight, which leaves a beam no side to turn its quads by.
  const far: TractorArm = {
    tip: { x: 10, y: 0, z: -90000 },
    loot: { x: 10, y: 0, z: -95000 },
    radius: 1,
  }
  const draws = drawsOf([{ ...beam([far], { x: 10, y: 0, z: -100 }), maxLength: 100000 }])
  assert.equal(draws.length, 2)
  const quads = draws.reduce((sum, draw) => sum + vertexCount(draw) / 4, 0)
  assert.equal(quads, Math.floor(89900 / 5) + 1)
  assert.ok(draws.every((draw) => vertexCount(draw) <= 0x10000))
})

test('a beam down the line of sight has no quads, as its side is nothing', () => {
  const along: TractorArm = {
    tip: { x: 0, y: 0, z: -200 },
    loot: { x: 0, y: 0, z: -900 },
    radius: 1,
  }
  assert.deepEqual(drawsOf([beam([along])]), [])
})

test('each tractor is its own draw, in the order given', () => {
  const draws = drawsOf([beam([short]), beam([short, short])])
  assert.deepEqual(
    draws.map((draw) => vertexCount(draw)),
    [20, 40],
  )
})

test("LookMatrixYup's third column is the way back, the rest square to it", () => {
  const [x, y, z] = lookMatrixYup([3, 4, 12])
  assert.deepEqual(
    z.map((value) => Math.round(value * 1e6) / 1e6),
    [-3 / 13, -4 / 13, -12 / 13].map((value) => Math.round(value * 1e6) / 1e6),
  )
  const dot = (a: number[], b: number[]) => a.reduce((sum, value, at) => sum + value * b[at]!, 0)
  for (const [a, b] of [
    [x, y],
    [y, z],
    [x, z],
  ] as const)
    assert.ok(Math.abs(dot(a, b)) < 1e-6)
  for (const column of [x, y, z]) assert.ok(Math.abs(Math.hypot(...column) - 1) < 1e-6)
  // Straight along y, the up is from (0, 0, 1).
  assert.deepEqual(lookMatrixYup([0, 2, 0])[1], [0, 0, 1])
})

test('the retail limits are the decomp’s constants', () => {
  assert.equal(RETAIL_TRACTOR_LIMITS.width, 5)
  assert.equal(RETAIL_TRACTOR_LIMITS.arms, 11)
  assert.equal(RETAIL_TRACTOR_LIMITS.sparks, 5)
  assert.equal(RETAIL_TRACTOR_LIMITS.sparkSpread, Math.fround(Math.PI * 0.8))
})
