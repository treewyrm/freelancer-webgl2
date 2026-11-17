import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import type { MeshSource } from '@treewyrm/freelancer/rigid'
import type { VMeshPart, VMeshRef } from '@treewyrm/freelancer/vmesh'
import type { Camera } from './camera.js'
import { levelAt, levelEnds, levelMetric, lodRange, lodScale } from './level.js'

const part = (meshId: number, center = { x: 0, y: 0, z: 0 }): VMeshPart =>
  ({
    type: 'vmeshpart',
    reference: { meshId, boundingSphere: { center, radius: 1 } } as VMeshRef,
  }) as VMeshPart

const source = (ranges?: number[]): MeshSource =>
  ({
    type: 'multilevel',
    levels: [part(1), part(2), part(3)],
    ...(ranges ? { ranges } : {}),
  }) as MeshSource

// `0x5c7410`, about tan 35°, each end stored as a float.
const scaled = (range: number) => Math.fround(0.700208 * range)

test('with no list, the ends are the model`s own', () => {
  assert.deepEqual(levelEnds(source([0, 100, 1000, 10000]), 'Root'), [100, 1000, 10000])
})

test('a list overwrites as far as it reaches, scaled by about tan 35', () => {
  const ends = levelEnds(source([0, 100, 1000, 10000]), 'Root', [{ ranges: [0, 40] }])

  assert.equal(ends[0], scaled(40))
  assert.deepEqual(ends.slice(1), [1000, 10000])
})

test('a list longer than the part stops at its levels, and a negative value ends it', () => {
  assert.equal(levelEnds(source([0, 100, 200]), 'Root', [{ ranges: [0, 1, 2, 3, 4] }]).length, 2)

  const ends = levelEnds(source([0, 100, 1000]), 'Root', [{ ranges: [0, 40, -1, 80] }])

  assert.equal(ends[1], 1000)
})

test('the first list for the part wins, by name in any case, or one with no obj', () => {
  const lists = [{ obj: 'Wing', ranges: [0, 10] }, { ranges: [0, 20] }]

  assert.equal(levelEnds(source([0, 100]), 'WING', lists)[0], scaled(10))
  assert.equal(levelEnds(source([0, 100]), 'Tail', lists)[0], scaled(20))
})

test('a bare part is one level to a million, and no Switch2 is reached by nothing', () => {
  assert.deepEqual(levelEnds(part(1), 'Root'), [1e6])
  assert.ok(Number.isNaN(levelEnds(source(), 'Root')[0]))
  assert.equal(levelAt(source(), 0, levelEnds(source(), 'Root')), undefined)
})

test('the first end reaching the metric chooses, inclusively, and past the last is nothing', () => {
  const multi = source([0, 100, 200, 300])
  const ends = [100, 200, 300]
  const idAt = (metric: number) => levelAt(multi, metric, ends)?.reference.meshId

  assert.deepEqual(
    [idAt(0), idAt(100), idAt(100.5), idAt(300), idAt(300.5)],
    [1, 1, 2, 3, undefined],
  )
})

test('a level ending under the one before it is never chosen', () => {
  const multi = source([0, 200, 100, 300])
  const idAt = (metric: number) => levelAt(multi, metric, [200, 100, 300])?.reference.meshId

  assert.deepEqual([idAt(150), idAt(250)], [1, 3])
})

const camera: Camera = {
  position: { x: 0, y: 0, z: 0 },
  orientation: Matrix3.identity,
  fovh: 45,
  near: 1,
  far: 1000,
}

test('the metric is view depth, not distance, of the centre, widened by the view', () => {
  const at = (x: number, z: number) => Matrix4.translation({ x, y: 0, z })
  const near = levelMetric(part(1), at(0, -100), at(0, 0), camera)

  assert.ok(Math.abs(near - 100) < 1e-9, `${near}`)
  // Far off to the side at the same depth, and behind, which takes the absolute depth.
  assert.ok(Math.abs(levelMetric(part(1), at(500, -100), at(0, 0), camera) - 100) < 1e-9)
  assert.ok(Math.abs(levelMetric(part(1), at(0, 100), at(0, 0), camera) - 100) < 1e-9)

  // The centre of the top level counts, in the part's space.
  const centred = part(1, { x: 0, y: 0, z: 10 })

  assert.ok(Math.abs(levelMetric(centred, at(0, -100), at(0, 0), camera) - 90) < 1e-9)
})

test('the metric is over the largest axis of the transform given to the draw', () => {
  const scaled: Matrix4 = {
    x: { x: 2, y: 0, z: 0, w: 0 },
    y: { x: 0, y: 4, z: 0, w: 0 },
    z: { x: 0, y: 0, z: 1, w: 0 },
    w: { x: 0, y: 0, z: 0, w: 1 },
  }
  const metric = levelMetric(part(1), Matrix4.translation({ x: 0, y: 0, z: -100 }), scaled, camera)

  assert.ok(Math.abs(metric - 25) < 1e-9, `${metric}`)
})

test('the option maps to low detail below 0.75, and a scale from 0.5 to 2', () => {
  assert.deepEqual(lodScale(0), { low: true, scale: 0.5 })
  assert.deepEqual(lodScale(0.75), { low: false, scale: 1 })
  assert.deepEqual(lodScale(1), { low: false, scale: 2 })
})

test("an archetype's lod range is the largest any part walked, or -1", () => {
  const parts = [
    { source: source([0, 100, 1000, 10000]), name: 'Root' },
    { source: source([0, 100]), name: 'Wing' },
  ]
  // Each list, as far as its part has levels and its ranges stay positive.
  const lists = [{ obj: 'Wing', ranges: [0, 5000, 9000] }, { ranges: [0, 40, 400, -1, 9999] }]

  assert.equal(lodRange(parts, lists), 5000)
  assert.equal(lodRange(parts, [{ obj: 'Tail', ranges: [0, 1] }]), -1)
  assert.equal(lodRange(parts, []), -1)
})

test("low detail skips the first list's MinSpecLOD levels, which end at 0", () => {
  const four = source([0, 100, 1000, 10000])
  const lists = [{ ranges: [0, 40, 400, 4000], minSpecLod: 2 }]

  assert.deepEqual(levelEnds(four, 'Root', lists, { detail: 0.5 }), [0, 0, scaled(4000)])
  assert.equal(lodRange([{ source: four, name: 'Root' }], lists, { detail: 0.5 }), 4000)
  // 1 when absent, but 0 under three ranges.
  assert.deepEqual(levelEnds(four, 'Root', [{ ranges: [0, 40, 400] }], { detail: 0.5 }), [
    0,
    scaled(400),
    10000,
  ])
  assert.deepEqual(levelEnds(four, 'Root', [{ ranges: [0, 40] }], { detail: 0.5 }), [
    scaled(40),
    1000,
    10000,
  ])
})

test('at high detail a list ending short of 15000 is held there where its scale passes it', () => {
  const three = source([0, 100, 1000, 10000])
  const lists = [{ ranges: [0, 100, 5000, 9000] }]

  // At a scale of 2 only 9000 passes 15000, and is held at 15000 and its level.
  assert.deepEqual(levelEnds(three, 'Root', lists, { detail: 1 }), [
    scaled(100),
    scaled(5000),
    scaled(15002),
  ])
  assert.equal(lodRange([{ source: three, name: 'Root' }], lists, { detail: 1 }), 15002)
  // At a scale of 1 nothing is held.
  assert.equal(lodRange([{ source: three, name: 'Root' }], lists), 9000)
})

test("ortho: the metric is the view's own half-width over the axis, at any depth", () => {
  const at = (x: number, z: number) => Matrix4.translation({ x, y: 0, z })
  const plan: Camera = { ...camera, ortho: { halfWidth: 300 } }

  for (const z of [-1, -100, -900])
    assert.ok(Math.abs(levelMetric(part(1), at(50, z), at(0, 0), plan) - 300) < 1e-9)
})
