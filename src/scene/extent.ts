/**
 * An engine instance's extent: `EngineComputeInstanceExtent` (`0x661ed90`) in
 * `src/EngBase/EngBase.cpp`. A space sky stands at its centre (`StarSphereLoadLayer`), and a solar
 * without a body is tested against it (`CObject::get_physical_radius_r`). Pure, no GL.
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { CompoundNode } from '@treewyrm/freelancer/compound'
import type { RigidModel, RigidPart } from '@treewyrm/freelancer/rigid'

export interface Extent {
  /** In the model's own space. */
  center: Vector3
  radius: number
}

const ORIGIN: Vector3 = { x: 0, y: 0, z: 0 }

/**
 * A part's own sphere: its mesh reference's (`CreateMeshInstance`, `Extra2C` and `Extra38`), the
 * first level's for a multilevel part, and a `.sph`'s radius. A part with no mesh is a point at its
 * origin, which is an inference: its `GetExtra` isn't traced.
 */
const ownSphere = (part: RigidPart): Extent => {
  if (part.type === 'sphere') return { center: ORIGIN, radius: part.radius }
  if (part.type !== 'rigid' || !part.part) return { center: ORIGIN, radius: 0 }

  const source = part.part
  const reference = source.type === 'multilevel' ? source.levels[0]?.reference : source.reference

  return reference
    ? { center: reference.boundingSphere.center, radius: reference.boundingSphere.radius }
    : { center: ORIGIN, radius: 0 }
}

const distance = (a: Vector3, b: Vector3): number =>
  Math.sqrt((a.z - b.z) ** 2 + (a.y - b.y) ** 2 + (a.x - b.x) ** 2)

/** The box around a part's sphere and each child's extent, and a radius holding all of them. */
const extentOf = (own: Extent, world: Matrix4, children: Extent[]): Extent => {
  const center = Matrix4.transformPoint(own.center, world)
  const axes = ['x', 'y', 'z'] as const
  const least = { x: center.x - own.radius, y: center.y - own.radius, z: center.z - own.radius }
  const most = { x: center.x + own.radius, y: center.y + own.radius, z: center.z + own.radius }

  for (const child of children)
    for (const axis of axes) {
      least[axis] = Math.min(least[axis], child.center[axis] - child.radius)
      most[axis] = Math.max(most[axis], child.center[axis] + child.radius)
    }

  const middle = {
    x: Math.fround((most.x + least.x) * 0.5),
    y: Math.fround((most.y + least.y) * 0.5),
    z: Math.fround((most.z + least.z) * 0.5),
  }
  let radius = Math.max(...axes.map((axis) => most[axis] - least[axis])) * 0.5

  radius = Math.max(radius, distance(middle, center) + own.radius)

  for (const child of children)
    radius = Math.max(radius, distance(child.center, middle) + child.radius)

  return { center: middle, radius: Math.fround(radius) }
}

/**
 * Every part's extent first, then its parent's around them. The engine caches the first answer
 * (`Instance->Extent`), and finds it as the model loads, with every part still at the root: what
 * `starsphere_li01` and its stars measure in `space_order`, where posed parts miss by up to 15.
 */
const compoundExtent = (node: CompoundNode<RigidPart>): Extent =>
  extentOf(ownSphere(node.part), Matrix4.identity, node.children.map(compoundExtent))

/** The extent of a model as it loads, with its root at the origin. */
export const instanceExtent = (model: RigidModel): Extent =>
  model.type === 'compound'
    ? compoundExtent(model)
    : extentOf(ownSphere(model), Matrix4.identity, [])
