import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix4 } from '@treewyrm/freelancer/math'
import type { NebulaState, SpaceNebula } from './nebula.js'
import { fogOverlayDraw } from './overlay.js'
import { zoneOf } from './nebula.js'

const nebulaOf = (): SpaceNebula => ({
  zone: zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: 1000 }),
  fog: { color: { x: 10 / 255, y: 7 / 255, z: 30 / 255 } },
  exclusions: [],
})
const stateOf = (nebula: SpaceNebula, depth: number): NebulaState => ({
  nebula,
  fogDistance: 1500,
  depth,
  start: 0,
  end: 1500,
  surface: -depth * 1500,
})
const viewport = { width: 1024, height: 768 }

test("the overlay is the fog's colour, as opaque as the camera is deep", () => {
  const draw = fogOverlayDraw(stateOf(nebulaOf(), 0.5), Matrix4.identity, viewport)!
  assert.deepEqual([...draw.mesh.vertices.slice(12, 16)], [30, 7, 10, 127])
  assert.deepEqual(
    [draw.depthFunc, draw.depthWrite, draw.blend, draw.cull],
    ['always', false, true, 'none'],
  )
  assert.equal(draw.texture, undefined)
})

test('it stops a pixel short of the right and bottom edges, as retail does', () => {
  const draw = fogOverlayDraw(stateOf(nebulaOf(), 0.5), Matrix4.identity, viewport)!
  const floats = new Float32Array(draw.mesh.vertices.buffer)
  assert.ok(Math.abs(floats[6]! - (1023 * (2 / 1024) - 1)) < 1e-6)
  assert.ok(Math.abs(floats[13]! - (1 - 767 * (2 / 768))) < 1e-6)
  // With no viewport, the whole view.
  const whole = fogOverlayDraw(stateOf(nebulaOf(), 0.5), Matrix4.identity)!
  assert.deepEqual([...new Float32Array(whole.mesh.vertices.buffer).slice(6, 8)], [1, 1])
})

test('none at no depth; at full depth one frame, then none until it falls under 1', () => {
  const nebula = nebulaOf()
  const at = (depth: number) =>
    fogOverlayDraw(stateOf(nebula, depth), Matrix4.identity) !== undefined
  assert.equal(at(0), false)
  assert.deepEqual(
    [at(0.9), at(1), at(1), at(1), at(0.99), at(1)],
    [true, true, false, false, true, true],
  )
})
