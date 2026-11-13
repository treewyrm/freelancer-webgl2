import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getJointMatrix,
  type CompoundNode,
  type Hardpoint,
  type Joint,
} from '@treewyrm/freelancer/compound'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import { attachJoint, partTransforms } from './hierarchy.js'

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

const revolutePoint = (min: number, max: number, x = 0): Hardpoint => ({
  type: 'revolute',
  name: 'Hp',
  position: { x, y: 0, z: 0 },
  orientation: Matrix3.identity,
  axis: { x: 0, y: 1, z: 0 },
  min,
  max,
})

test('two revolute hardpoints join by the narrower range, a full turn or more opened to ±π', () => {
  const limits = (parent: Hardpoint, child: Hardpoint) => {
    const joint = attachJoint(parent, child)

    assert.equal(joint.type, 'revolute')
    return joint.type === 'revolute' ? [joint.min, joint.max] : []
  }

  const pi = Math.fround(Math.PI)

  // `space_order`'s turrets: `HpConnect` spans ±2π, so a platform's quarter turn wins.
  assert.deepEqual(
    limits(revolutePoint(-1.5708, 1.5708), revolutePoint(-2 * pi, 2 * pi)),
    [-1.5708, 1.5708],
  )
  // Both full: the range compared is still the written one, so a tie goes to the child, opened.
  assert.deepEqual(limits(revolutePoint(-2 * pi, 2 * pi), revolutePoint(-2 * pi, 2 * pi)), [
    -pi,
    pi,
  ])
  assert.deepEqual(limits(revolutePoint(-1, 1), revolutePoint(-0.5, 0.5)), [-0.5, 0.5])

  // A fixed parent keeps the child's limits as written.
  const fixedParent: Hardpoint = { type: 'fixed', name: 'Hp', orientation: Matrix3.identity }

  assert.deepEqual(limits(fixedParent, revolutePoint(-2 * pi, 2 * pi)), [-2 * pi, 2 * pi])
})

/** A hardpoint's frame in its part, read the way `Matrix4` reads a `Matrix3`. */
const frameOf = ({ orientation, position }: Hardpoint): Matrix4 =>
  Matrix4.fromRotationTranslation(orientation, position ?? zero)

const near = (a: Matrix4, b: Matrix4) => {
  for (const axis of ['x', 'y', 'z', 'w'] as const)
    for (const cell of ['x', 'y', 'z', 'w'] as const)
      assert.ok(Math.abs(a[axis][cell] - b[axis][cell]) < 1e-9, `${axis}.${cell}`)
}

// A quarter turn about +X, as a `Matrix3`'s rows.
const ABOUT_X: Matrix3 = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 0, z: -1 },
  z: { x: 0, y: 1, z: 0 },
}

test("a fixed child lands its hardpoint's frame on the parent's: HpA · HpB⁻¹", () => {
  const parent: Hardpoint = {
    type: 'fixed',
    name: 'HpMount',
    position: { x: 5, y: 1, z: 0 },
    orientation: QUARTER,
  }
  const child: Hardpoint = {
    type: 'fixed',
    name: 'HpConnect',
    position: { x: 0, y: 2, z: 3 },
    orientation: ABOUT_X,
  }

  near(
    getJointMatrix(attachJoint(parent, child)),
    Matrix4.multiply(frameOf(parent), Matrix4.invert(frameOf(child))),
  )
})

test("a revolute child turns about its own axis, carried by the parent's frame", () => {
  const parent = { ...revolutePoint(-1, 1, 3), orientation: ABOUT_X }
  const child: Hardpoint = { ...revolutePoint(-1, 1), position: { x: 0, y: -2, z: 0 } }
  const joint = attachJoint(parent, child)
  // The child's frame is the identity, so retail's untransposed product is HpA · R(axis) · HpB⁻¹.
  const expected = (angle: number) =>
    Matrix4.multiply(
      frameOf(parent),
      Matrix4.multiply(
        Matrix4.fromRotationTranslation(Matrix3.axisAngle({ x: 0, y: 1, z: 0 }, angle)),
        Matrix4.invert(frameOf(child)),
      ),
    )

  near(getJointMatrix(joint), expected(0))
  near(getJointMatrix(joint, { value: 0.5 }), expected(0.5))
  // Asked for more than its limit of 1, it holds there.
  near(getJointMatrix(joint, { value: Math.PI / 2 }), expected(1))
})
