import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CompoundNode, Joint } from '@treewyrm/freelancer/compound'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import { partTransforms } from './hierarchy.js'

const part = (
  name: string,
  joint: Joint | undefined,
  children: CompoundNode<undefined>[] = [],
): CompoundNode<undefined> => ({
  type: 'compound',
  name,
  index: 0,
  filename: name,
  part: undefined,
  children,
  ...(joint ? { joint } : {}),
})

const zero = { x: 0, y: 0, z: 0 }

// Rows of a quarter turn about +Z: +X goes to +Y.
const QUARTER: Matrix3 = {
  x: { x: 0, y: -1, z: 0 },
  y: { x: 1, y: 0, z: 0 },
  z: { x: 0, y: 0, z: 1 },
}

const fixed = (x: number, orientation: Matrix3 = Matrix3.identity): Joint => ({
  type: 'fixed',
  position: { x, y: 0, z: 0 },
  orientation,
})

const origin = (matrix: Matrix4 | undefined) => Matrix4.transformPoint(zero, matrix!)

test('the root stands at the model, and parts compose parent first', () => {
  const leaf = part('leaf', fixed(1))
  const middle = part('middle', fixed(2, QUARTER), [leaf])
  const root = part('root', undefined, [middle])
  const transforms = partTransforms(root, Matrix4.translation({ x: 10, y: 0, z: 0 }))

  assert.deepEqual(origin(transforms.get(root)), { x: 10, y: 0, z: 0 })
  assert.deepEqual(origin(transforms.get(middle)), { x: 12, y: 0, z: 0 })
  // The leaf's own offset along X has turned with its parent, onto +Y.
  assert.deepEqual(origin(transforms.get(leaf)), { x: 12, y: 1, z: 0 })
})

test('a joint takes its state, and has none by default', () => {
  const revolute: Joint = {
    type: 'revolute',
    position: zero,
    offset: zero,
    orientation: Matrix3.identity,
    axis: { x: 0, y: 0, z: 1 },
    min: -Math.PI,
    max: Math.PI,
  }
  const arm = part('arm', revolute, [part('tip', fixed(1))])
  const root = part('root', undefined, [arm])
  const tip = arm.children[0]!

  const rest = origin(partTransforms(root, Matrix4.translation(zero)).get(tip))
  assert.ok(Math.abs(rest.x - 1) < 1e-9 && Math.abs(rest.y) < 1e-9)

  const turned = origin(
    partTransforms(root, Matrix4.translation(zero), (node) =>
      node === arm ? { value: Math.PI / 2 } : undefined,
    ).get(tip),
  )
  assert.ok(Math.abs(turned.x) < 1e-9 && Math.abs(turned.y - 1) < 1e-9)
})
