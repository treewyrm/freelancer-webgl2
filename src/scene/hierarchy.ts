/** A compound model's parts in the scene. */
import { getJointMatrix, type CompoundNode, type JointState } from '@treewyrm/freelancer/compound'
import { Matrix4 } from '@treewyrm/freelancer/math'

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
