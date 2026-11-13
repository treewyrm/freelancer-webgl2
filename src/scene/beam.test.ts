import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import {
  beamArchetype,
  beamBatch,
  beamDraw,
  BeamEffect,
  beamView,
  lookMatrix,
  type BeamBatch,
  type BeamSeen,
} from './beam.js'
import type { Camera } from './camera.js'

const f = Math.fround
const texture = { name: 'code_beam' } as Texture

// `default_beam_spear`'s keys, as `FX/beam_effects.ini` writes them.
const SPEAR = beamArchetype({
  kind: 'spear',
  tipLength: 5,
  tailLength: 75,
  headWidth: 2,
  coreWidth: 1.5,
  tipColor: { x: 247, y: 179, z: 51 },
  coreColor: { x: 250, y: 200, z: 100 },
  outerColor: { x: 247, y: 179, z: 51 },
  tailColor: { x: 200, y: 180, z: 0 },
  headBrightness: 1,
  trailBrightness: 0.85,
  headTexture: 'star',
  trailTexture: 'thin',
  flashSize: 3,
})

// `pi_particle_03_beam`'s.
const BOLT = beamArchetype({
  kind: 'bolt',
  tipLength: 5,
  coreLength: 55,
  tailLength: 10,
  headWidth: 3,
  coreWidth: 2,
  secCoreWidth: 1,
  tipColor: { x: 223, y: 32, z: 32 },
  coreColor: { x: 245, y: 45, z: 45 },
  outerColor: { x: 223, y: 32, z: 32 },
  secCoreColor: { x: 200, y: 175, z: 175 },
  secOuterColor: { x: 175, y: 175, z: 175 },
  tailColor: { x: 128, y: 128, z: 128 },
  headBrightness: 1,
  trailBrightness: 1,
  headTexture: 'ball',
  trailTexture: 'wide',
  flashSize: 3,
})

const always: BeamSeen = () => 'draw'
const start = { orientation: Matrix3.identity, position: { x: 0, y: 0, z: 0 } }

const built = (beam: BeamEffect, step: number, batch = beamBatch(), seen = always): BeamBatch => {
  beam.walk(step, seen, batch)
  return batch
}

const place = ({ vertices }: BeamBatch, at: number): Vector3 => ({
  x: vertices[at * 5]!,
  y: vertices[at * 5 + 1]!,
  z: vertices[at * 5 + 2]!,
})
const uv = ({ vertices }: BeamBatch, at: number): [number, number] => [
  vertices[at * 5 + 3]!,
  vertices[at * 5 + 4]!,
]
const rgb = ({ colors }: BeamBatch, at: number): number[] => [
  colors[at * 4 + 2]!,
  colors[at * 4 + 1]!,
  colors[at * 4]!,
]

test('a section defaults each key to 1, then holds lengths to widths and brightness to 0.01..1', () => {
  const bare = beamArchetype({ kind: 'spear' })

  assert.equal(bare.tipLength, 1)
  assert.equal(bare.coreLength, 1)
  assert.deepEqual(bare.tipColor, { x: 1, y: 1, z: 1 })

  const held = beamArchetype({
    kind: 'spear',
    coreWidth: 4,
    tipLength: 2,
    tailLength: 3,
    headWidth: 1,
    headBrightness: 0,
    trailBrightness: 9,
  })

  assert.equal(held.tipLength, 4)
  assert.equal(held.tailLength, 4)
  assert.equal(held.headWidth, 4)
  assert.equal(held.headBrightness, f(0.01))
  assert.equal(held.trailBrightness, 1)

  const bolt = beamArchetype({ kind: 'bolt', coreWidth: 4, secCoreWidth: 2, tailLength: 1 })

  assert.equal(bolt.tailLength, 2, "a bolt's tail is held to sec_core_width")
})

test('a colour is scaled by 1/255 as a float, so a byte comes back as ftol truncates it', () => {
  const white = beamArchetype({
    kind: 'spear',
    coreColor: { x: 255, y: 128, z: 1 },
    headBrightness: 1,
  })

  assert.equal(white.coreColor.x, f(255 * f(0.003921569)))

  const batch = built(new BeamEffect(white, { ...start, speed: 600 }), 0)
  const expected = [255, 128, 1].map((value) => Math.trunc(f(value * f(0.003921569)) * 255))

  assert.deepEqual(rgb(batch, 0), expected)
})

test('a shot grows from its first frame over (core + tail + 7.5) / speed', () => {
  const beam = new BeamEffect(SPEAR, { ...start, speed: 100 })
  // (1 + 75 + 7.5) / 100.
  const growth = 0.835
  const first = built(beam, 0.1)

  assert.equal(place(first, 6).z, f(-1.5), 'at T 0, the tip is the width ahead')
  assert.equal(place(first, 7).z, 1.5)

  const half = built(beam, f(growth / 2))
  const t = f(f(growth / 2) / f(83.5 / 100))

  assert.equal(place(half, 6).z, f(-(f(5 - 1.5) * t + 1.5)))
  assert.equal(place(half, 7).z, f(f(75 - 1.5) * t + 1.5))

  const done = built(beam, 1)

  assert.equal(place(done, 6).z, -5)
  assert.equal(place(done, 7).z, 75)
})

test('only the player’s spear flashes, on its first frame, and never from the cockpit', () => {
  const widthOf = (look: boolean, firstPerson: boolean, kind = SPEAR) =>
    place(built(new BeamEffect(kind, { ...start, speed: 600, look }), 0, beamBatch(firstPerson)), 8)
      .x

  assert.equal(widthOf(true, false), 3)
  assert.equal(widthOf(false, false), 1.5)
  assert.equal(widthOf(true, true), 1.5)
  // A bolt's first frame builds as a spear: `LAB_004fa0a0`, 0x4fa22a.
  assert.equal(widthOf(true, false, BOLT), 3)

  const beam = new BeamEffect(SPEAR, { ...start, speed: 600, look: true })

  built(beam, 0)
  assert.equal(place(built(beam, 0.01), 8).x, 1.5, 'gone by the next')
})

test('a spear has 12 vertices and 12 triangles, a grown bolt 17 and 20', () => {
  const spear = built(new BeamEffect(SPEAR, { ...start, speed: 600 }), 0)

  assert.equal(spear.count, 12)
  assert.equal(spear.indices.length, 12 * 3)

  const beam = new BeamEffect(BOLT, { ...start, speed: 600 })

  built(beam, 0)

  const bolt = built(beam, 1)

  assert.equal(bolt.count, 17)
  assert.equal(bolt.indices.length, (4 + 4 + 8 + 4) * 3)
})

test('head and trail textures pick their half and their side, each kind as it was listed', () => {
  const spear = built(new BeamEffect(SPEAR, { ...start, speed: 600 }), 0)

  // `star` is the bottom half of V, `thin` the left of U. These are U, V as the batch writes them.
  assert.deepEqual(uv(spear, 0), [0.75, 0.75])
  assert.deepEqual(uv(spear, 1), [0.5, 0.5])
  assert.deepEqual(uv(spear, 2), [0.5, 1])
  assert.deepEqual(uv(spear, 3), [1, 1])
  assert.deepEqual(uv(spear, 4), [1, 0.5])
  assert.deepEqual(uv(spear, 5), [0, 0])
  assert.deepEqual(uv(spear, 6), [0.25, f(0.45)])
  assert.deepEqual(uv(spear, 8), [0.25, 0])

  const beam = new BeamEffect(BOLT, { ...start, speed: 600 })

  built(beam, 0)

  const bolt = built(beam, 1)

  // `ball` is the top half, and `wide` the right. A bolt's head turns the other way, its fan's V swapped.
  assert.deepEqual(uv(bolt, 1), [0.5, 0])
  assert.deepEqual(uv(bolt, 2), [1, 0])
  assert.deepEqual(uv(bolt, 3), [1, 0.5])
  assert.deepEqual(uv(bolt, 4), [0.5, 0.5])
  assert.deepEqual(uv(bolt, 5), [0, 1])
  assert.deepEqual(uv(bolt, 6), [0.25, f(0.55)])
  assert.deepEqual(uv(bolt, 11), [0, f(0.55)])
  assert.deepEqual(uv(bolt, 12), [0.25, 1])
})

test("a bolt's core runs back from the head by core_length, its tail past that", () => {
  const beam = new BeamEffect(BOLT, { ...start, speed: 600 })

  built(beam, 0)

  const bolt = built(beam, 1)

  assert.equal(place(bolt, 6).z, -5, 'the tip, its length with the width back on')
  assert.equal(place(bolt, 7).x, 2, 'the ring about the origin')
  assert.equal(place(bolt, 11).z, 55, 'the core')
  assert.equal(place(bolt, 12).z, 65, 'the tail')
  assert.equal(place(bolt, 13).z, 55)
  assert.equal(place(bolt, 13).x, 2)
})

test('each shot is placed by the host, turned by its frame', () => {
  const beam = new BeamEffect(SPEAR, { ...start, speed: 600 })
  // -Z along +X: the shot's tip goes +X.
  const orientation = lookMatrix({ x: 1, y: 0, z: 0 })
  const position = { x: 10, y: 20, z: 30 }

  beam.place(orientation, position)
  built(beam, 0)

  const grown = built(beam, 1)

  assert.deepEqual(place(grown, 0), position)

  const tip = place(grown, 6)

  assert.ok(Math.abs(tip.x - 15) < 1e-4, `${tip.x}`)
  assert.ok(Math.abs(tip.y - 20) < 1e-4)
  assert.ok(Math.abs(tip.z - 30) < 1e-4)
})

test('a killed shot coasts at its velocity, fades over 0.3 s and dies, whatever is placed', () => {
  const beam = new BeamEffect(SPEAR, { ...start, speed: 600 })

  built(beam, 1)
  beam.kill({ x: 0, y: 0, z: -100 })

  const moving = built(beam, 0.1)

  beam.place(Matrix3.identity, { x: 99, y: 99, z: 99 })
  assert.ok(Math.abs(place(moving, 0).z + 10) < 1e-4, 'its first step coasts')

  const third = f(f(f(0.3) - 0.1) / f(0.3))

  assert.deepEqual(
    rgb(moving, 0),
    [250, 200, 100].map((byte) => Math.trunc(third * f(byte * f(0.003921569)) * 255)),
    'the head fades by what is left over the whole',
  )
  built(beam, 0.1)
  assert.equal(beam.dead, false)

  const empty = built(beam, 0.11)

  assert.equal(beam.dead, true, 'its fade ran out')
  assert.equal(empty.count, 0, 'and it draws nothing that frame')
  assert.equal(built(beam, 0.1).count, 0)
})

test('killed twice, a shot keeps what it had left, and its coast', () => {
  const beam = new BeamEffect(SPEAR, { ...start, speed: 600 })

  built(beam, 1)
  beam.kill({ x: 1, y: 0, z: 0 })
  built(beam, 0.1)
  beam.kill({ x: 0, y: 5, z: 0 })

  const after = built(beam, 0.1)

  assert.equal(place(after, 0).y, 0, 'the first velocity stands')
  assert.equal(beam.dead, false)
  built(beam, 0.11)
  assert.equal(beam.dead, true, 'the fade was not restarted')
})

test('a shot unseen ages without building', () => {
  const beam = new BeamEffect(SPEAR, { ...start, speed: 100 })
  const hidden: BeamSeen = () => 'run'

  assert.equal(built(beam, 0.5, beamBatch(), hidden).count, 0)
  built(beam, 0.5, beamBatch(), hidden)

  const shown = built(beam, 0.001)

  assert.ok(place(shown, 6).z < -2, 'it grew while hidden')
})

const camera = {
  position: { x: 0, y: 0, z: 0 },
  orientation: Matrix3.identity,
  fovh: 35,
  near: 1,
  far: 1000,
} as unknown as Camera

const view = Matrix4.identity

test('the view test takes its radius of 50 and its type’s pbubble, at retail’s defaults', () => {
  const seen = beamView(camera, 4 / 3, view)

  assert.equal(seen({ x: 0, y: 0, z: -100 }, 50), 'draw')
  assert.equal(seen({ x: 0, y: 0, z: 48.5 }, 50), 'draw', 'its far edge just past the near plane')
  assert.equal(seen({ x: 0, y: 0, z: 49.5 }, 50), 'run', 'behind it')
  assert.equal(seen({ x: 0, y: 0, z: -549 }, 50), 'draw', '`.data`’s pbubble to 500')
  assert.equal(seen({ x: 0, y: 0, z: -551 }, 50), 'run')
  assert.equal(seen({ x: 500, y: 0, z: -100 }, 50), 'run', 'beside the view')
})

test('`[EffectType]` and `generic_effect_perf` move that, and its priority can end a shot', () => {
  const near = 1250
  const far = 2000
  const types = { effectTypes: { 0x2c: { pbubble: { near, far } } } as never }

  assert.equal(beamView(camera, 4 / 3, view, types)({ x: 0, y: 0, z: -2049 }, 50), 'draw')

  const half = { ...types, effectDetail: 0.5 }
  const middle = beamView(camera, 4 / 3, view, half)

  assert.equal(middle({ x: 0, y: 0, z: -1674 }, 50), 'draw')
  assert.equal(middle({ x: 0, y: 0, z: -1676 }, 50), 'run')

  const low = { effectDetail: 0, effectTypes: { 0x2c: { priority: 0.5 } } as never }

  assert.equal(beamView(camera, 4 / 3, view, low)({ x: 0, y: 0, z: -100 }, 50), 'die')
})

test('not EXIST_OFFSCREEN, an unseen shot dies', () => {
  const types = { effectTypes: { 0x2c: { existOffscreen: false } } as never }
  const seen = beamView(camera, 4 / 3, view, types)

  assert.equal(seen({ x: 0, y: 0, z: 100 }, 50), 'die')

  const beam = new BeamEffect(SPEAR, { ...start, position: { x: 0, y: 0, z: 100 }, speed: 600 })

  built(beam, 0.1, beamBatch(), seen)
  assert.equal(beam.dead, true)
})

test('lookMatrix runs -Z along the direction, and its frame is right-handed', () => {
  for (const direction of [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 0, z: -1 },
    { x: 0, y: 0, z: 1 },
    { x: 3, y: -4, z: 12 },
  ]) {
    const { x, y, z } = lookMatrix(direction)
    const length = Math.hypot(direction.x, direction.y, direction.z)

    assert.ok(Math.abs(z.x + direction.x / length) < 1e-6)
    assert.ok(Math.abs(z.y + direction.y / length) < 1e-6)
    assert.ok(Math.abs(z.z + direction.z / length) < 1e-6)
    assert.ok(Math.abs(Matrix3.determinant({ x, y, z }) - 1) < 1e-5, 'a rotation')
  }

  assert.equal(lookMatrix({ x: 0, y: 0, z: -1 }).y.y, 1, '+Y straight ahead')
})

test("the frame's one draw: added, unculled, LEQUAL, no depth writes, in the world, freed after", () => {
  const batch = built(new BeamEffect(SPEAR, { ...start, speed: 600 }), 0)
  const draw = beamDraw(batch, texture)!

  assert.equal(draw.count, 36)
  assert.equal(draw.blendMode, 'add')
  assert.equal(draw.blend, true)
  assert.equal(draw.cull, 'none')
  assert.equal(draw.depthFunc, 'lequal')
  assert.equal(draw.depthWrite, false)
  assert.equal(draw.unlit, true)
  assert.equal(draw.transient, true)
  assert.deepEqual(draw.world, Matrix4.identity)
  assert.equal(draw.texture?.entry, texture)
  assert.equal(beamDraw(beamBatch(), texture), undefined, 'nothing built, nothing drawn')
})

test('every shot of the frame shares the batch, its indices past the last', () => {
  const batch = beamBatch()

  built(new BeamEffect(SPEAR, { ...start, speed: 600 }), 0, batch)
  built(new BeamEffect(SPEAR, { ...start, speed: 600 }), 0, batch)
  assert.equal(batch.count, 24)
  assert.equal(batch.indices[36], 12)
  assert.equal(beamDraw(batch, texture)!.mesh.vertices.length, 24 * 24)
})
