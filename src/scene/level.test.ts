import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import type { MeshSource } from '@treewyrm/freelancer/rigid'
import type { VMeshPart, VMeshRef } from '@treewyrm/freelancer/vmesh'
import type { Camera } from './camera.js'
import { levelAt, levelEnds, levelMetric } from './level.js'

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

const TAN_35 = Math.tan((35 * Math.PI) / 180)

test('with no list, the ends are the model`s own', () => {
  assert.deepEqual(levelEnds(source([0, 100, 1000, 10000]), 'Root'), [100, 1000, 10000])
})

test('a list overwrites as far as it reaches, scaled by tan 35', () => {
  const ends = levelEnds(source([0, 100, 1000, 10000]), 'Root', [{ ranges: [0, 40] }])
  assert.ok(Math.abs(ends[0]! - 40 * TAN_35) < 1e-9)
  assert.deepEqual(ends.slice(1), [1000, 10000])
})

test('a list longer than the part stops at its levels, and a negative value ends it', () => {
  assert.equal(levelEnds(source([0, 100, 200]), 'Root', [{ ranges: [0, 1, 2, 3, 4] }]).length, 2)
  const ends = levelEnds(source([0, 100, 1000]), 'Root', [{ ranges: [0, 40, -1, 80] }])
  assert.equal(ends[1], 1000)
})

test('the first list for the part wins, by name in any case, or one with no obj', () => {
  const lists = [{ obj: 'Wing', ranges: [0, 10] }, { ranges: [0, 20] }]
  assert.ok(Math.abs(levelEnds(source([0, 100]), 'WING', lists)[0]! - 10 * TAN_35) < 1e-9)
  assert.ok(Math.abs(levelEnds(source([0, 100]), 'Tail', lists)[0]! - 20 * TAN_35) < 1e-9)
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
