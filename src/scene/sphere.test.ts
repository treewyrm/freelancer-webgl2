import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getResourceId } from '@treewyrm/freelancer'
import type { Material } from '@treewyrm/freelancer/material'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import type { Sphere } from '@treewyrm/freelancer/rigid'
import { spherePatch } from '#/mesh/sphere.js'
import type { Camera } from './camera.js'
import { collectFrame, type SceneModel } from './frame.js'
import { placeSphere, sphereLevel } from './sphere.js'

const SIDES = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']
const sphere = (sides = SIDES, radius = 100): Sphere => ({
  type: 'sphere',
  hardpoints: [],
  sides,
  radius,
})

const camera = (x: number, y: number, z: number): Camera => ({
  position: { x, y, z },
  orientation: Matrix3.identity,
  fovh: 20,
  near: 1,
  far: 100000,
})

const facesOf = (parts: { materialId?: number }[], sides = SIDES) =>
  parts.map(({ materialId }) => sides.findIndex((side) => getResourceId(side) === materialId))

test('the level follows the pixel size against the radius, as the menu planets', () => {
  // `run1-stock-menu`: 1.5 × distance × tan 20° / 512 of a planet, and the triangles retail drew.
  assert.equal(sphereLevel(200, (1.5 * 5760 * Math.tan((20 * Math.PI) / 180)) / 512), 5)
  assert.equal(sphereLevel(1000, (1.5 * 4207 * Math.tan((20 * Math.PI) / 180)) / 512), 8)
})

test('the level clamps, and what acos cannot take is the lowest', () => {
  assert.equal(sphereLevel(1000, 1e-6), 9)
  assert.equal(sphereLevel(1000, 1500), 3)
  // Past twice the radius, and at no distance at all, retail's `ftol` gives `INT_MIN`.
  assert.equal(sphereLevel(1000, 2500), 3)
  assert.equal(sphereLevel(1000, 0), 3)
})

test('straight on, only that face draws, and each side has its own axis', () => {
  const near = 110
  const cases: [number, [number, number, number]][] = [
    [0, [0, 0, near]],
    [1, [near, 0, 0]],
    [2, [0, 0, -near]],
    [3, [-near, 0, 0]],
    [4, [0, near, 0]],
    [5, [0, -near, 0]],
  ]
  for (const [face, position] of cases) {
    const parts = placeSphere(sphere(), Matrix4.identity, {
      camera: camera(...position),
      width: 1024,
    })
    assert.deepEqual(facesOf(parts), [face])
    const { z: normal } = parts[0]!.world
    assert.deepEqual(
      [normal.x, normal.y, normal.z],
      position.map((axis) => axis / near),
    )
  }
})

test('far away the corners of the nearest face show its neighbours, never its opposite', () => {
  const parts = placeSphere(sphere(), Matrix4.identity, {
    camera: camera(0, 0, 100000),
    width: 1024,
  })
  assert.deepEqual(facesOf(parts), [0, 1, 3, 4, 5])
})

test('a turned sphere culls by its own axes', () => {
  // Turned so its +X face looks along world +Z.
  const world: Matrix4 = {
    x: { x: 0, y: 0, z: 1, w: 0 },
    y: { x: 0, y: 1, z: 0, w: 0 },
    z: { x: -1, y: 0, z: 0, w: 0 },
    w: { x: 0, y: 0, z: 0, w: 1 },
  }
  const parts = placeSphere(sphere(), world, { camera: camera(0, 0, 110), width: 1024 })
  assert.deepEqual(facesOf(parts), [1])
  const { z: normal } = parts[0]!.world
  assert.deepEqual([normal.x, normal.y, normal.z], [0, 0, 1])
})

test('sides repeat, and a seventh is not a face', () => {
  const one = ['only']
  const parts = placeSphere(sphere(one), Matrix4.identity, {
    camera: camera(0, 0, 100000),
    width: 1024,
  })
  assert.deepEqual(facesOf(parts, one), [0, 0, 0, 0, 0])

  const seven = [...SIDES, 'shell']
  const withShell = placeSphere(sphere(seven), Matrix4.identity, {
    camera: camera(0, 0, 100000),
    width: 1024,
  })
  assert.deepEqual(facesOf(withShell, seven), [0, 1, 3, 4, 5])
})

test('a pinned level overrides the choice, and spheres alike share a patch', () => {
  const [part] = placeSphere(sphere(), Matrix4.identity, {
    camera: camera(0, 0, 110),
    width: 1024,
    level: 6,
  })
  assert.equal(part!.mesh, spherePatch(100, 6).mesh)
  assert.equal(part!.reference, spherePatch(100, 6).reference)
})

test('the camera on the centre draws a face, rather than none or a NaN', () => {
  const parts = placeSphere(sphere(), Matrix4.identity, { camera: camera(0, 0, 0), width: 1024 })
  assert.deepEqual(facesOf(parts), [0])
  assert.equal(parts[0]!.mesh, spherePatch(100, 3).mesh)
})

test('faces become draws, by their own materials, with no mesh library', () => {
  const materials = new Map<number, Material>(
    SIDES.map((name) => [
      getResourceId(name),
      { name, type: 'DcDt', diffuse: { x: 1, y: 1, z: 1 } } as unknown as Material,
    ]),
  )
  const model: SceneModel = {
    parts: placeSphere(sphere(), Matrix4.identity, { camera: camera(0, 0, 100000), width: 1024 }),
    mesh: () => assert.fail('a patch is not in any library'),
    material: (id) => materials.get(id),
    texture: () => undefined,
  }
  const frame = collectFrame({
    camera: camera(0, 0, 100000),
    aspect: 4 / 3,
    ambient: { x: 1, y: 1, z: 1 },
    lights: [],
    models: [model],
  })
  assert.deepEqual(frame.unsupported, [])
  assert.deepEqual(
    frame.draws.map(({ materialName }) => materialName),
    ['m0', 'm1', 'm3', 'm4', 'm5'],
  )
  for (const draw of frame.draws) {
    assert.equal(draw.cull, 'back')
    assert.equal(draw.count, spherePatch(100, 3).mesh.indices.length)
    assert.equal(draw.byteOffset, 0)
  }
})

test('a face whose material the host lacks is reported, by id', () => {
  const frame = collectFrame({
    camera: camera(0, 0, 110),
    aspect: 4 / 3,
    ambient: { x: 1, y: 1, z: 1 },
    lights: [],
    models: [
      {
        parts: placeSphere(sphere(), Matrix4.identity, { camera: camera(0, 0, 110), width: 1024 }),
        mesh: () => undefined,
        material: () => undefined,
        texture: () => undefined,
      },
    ],
  })
  assert.deepEqual(frame.draws, [])
  assert.deepEqual(frame.unsupported, [`material ${getResourceId('m0')}`])
})
