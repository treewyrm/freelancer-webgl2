/** A compound model's parts in the scene, and what attaches to them. */
import {
  getJointMatrix,
  type CompoundNode,
  type Hardpoint,
  type Joint,
  type JointState,
} from '@treewyrm/freelancer/compound'
import { Matrix3, Matrix4, Vector3 } from '@treewyrm/freelancer/math'

/**
 * Every part's world transform: `W_child = W_parent · L_child`, the root at `model`. A joint with no
 * state stands at rest. Parts are keyed by identity.
 */
export const partTransforms = <T>(
  root: CompoundNode<T>,
  model: Matrix4,
  stateOf?: (part: CompoundNode<T>) => JointState | undefined,
): Map<CompoundNode<T>, Matrix4> => {
  const transforms = new Map<CompoundNode<T>, Matrix4>()

  const visit = (part: CompoundNode<T>, parent: Matrix4) => {
    const world = part.joint
      ? Matrix4.multiply(parent, getJointMatrix(part.joint, stateOf?.(part)))
      : parent

    transforms.set(part, world)
    for (const child of part.children) visit(child, world)
  }

  visit(root, model)
  return transforms
}

// `0x6293fb5`: a float 2π, which a range is compared against in double.
const FULL_TURN = Math.fround(2 * Math.PI)
const HALF_TURN = Math.fround(Math.PI)
// `DAT_0639c9e0`, the step `WrapLimitRange` takes. Its upper bound is 360, in degrees.
const WRAP_STEP = 6.2831854820251465

/** `WrapLimitRange`: a range under a full turn, wrapped into [0, 360) by steps of 2π. */
const wrapRange = (range: number): number => {
  while (range < 0) range += WRAP_STEP
  while (range >= 360) range -= WRAP_STEP
  return range
}

/** A revolute hardpoint's range, and its limits opened to ±π at a full turn or more. */
const limitsOf = ({ min, max }: { min: number; max: number }) => {
  const range = max - min

  return range >= FULL_TURN
    ? { range, min: -HALF_TURN, max: HALF_TURN }
    : { range: wrapRange(range), min, max }
}

/** Retail's `A · B`, row-major, for two `Matrix3`s whose triples are rows (RENDERER.md). */
const product = (a: Matrix3, b: Matrix3): Matrix3 => Matrix3.multiply(b, a)

/** Retail's `M · v`: `Matrix3.transform` applies the transpose. */
const rotate = (v: Vector3, m: Matrix3): Vector3 => Matrix3.transform(v, Matrix3.transpose(m))

/**
 * The joint that hangs `child`'s hardpoint on `parent`'s, as attached equipment is connected
 * (`ConnectAttachedHardpoints`, `0x6293e10`, then `HardpointConnect`, `EngBase` `IHardpoint` slot 6).
 * Two revolute hardpoints make a revolute joint limited by the narrower range. Otherwise the child's
 * type decides: a fixed one lands its point and frame on the parent's, a revolute one turns about its
 * own axis within its own limits. A revolute joint's orientation is the parent's times the child's,
 * untransposed as retail has it; no reference attaches a child whose frame isn't the identity.
 */
export const attachJoint = (parent: Hardpoint, child: Hardpoint): Joint => {
  const parentAt = parent.position ?? Vector3.zero
  const childAt = child.position ?? Vector3.zero

  if (child.type === 'fixed') {
    const orientation = product(parent.orientation, Matrix3.transpose(child.orientation))
    const position = Vector3.subtract(parentAt, rotate(childAt, orientation))

    return { type: 'fixed', position, orientation }
  }

  const orientation = product(parent.orientation, child.orientation)
  const axis = rotate(child.axis, orientation)
  const joint = {
    type: 'revolute',
    position: parentAt,
    offset: childAt,
    orientation,
    axis,
  } as const
  if (parent.type !== 'revolute') return { ...joint, min: child.min, max: child.max }

  const outer = limitsOf(parent)
  const inner = limitsOf(child)
  const { min, max } = outer.range < inner.range ? outer : inner

  return { ...joint, min, max }
}
