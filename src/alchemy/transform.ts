/** A node's matrices, as `alchemy.dll` builds them. */
import { transformAt, transformMatrix, type AnimatedTransform } from '@treewyrm/freelancer/alchemy'
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'

/** The local matrix at a moment, or `undefined` for the common header with no curves. */
export const localMatrix = (
  transform: AnimatedTransform | undefined,
  sparam: number,
  time: number,
): Matrix4 | undefined => {
  if (!transform?.curves) return undefined
  return transformMatrix(transformAt(transform, sparam, time))
}

/** `x86math.dll` `0x6f71380`: never fails. At `|det| ≤ 1e-8` the adjugate goes unscaled, so a zero scale still runs. */
export const frameInverse = (world: Matrix4): Matrix4 => {
  const { x: a, y: b, z: c, w: t } = world
  const r0 = { x: b.y * c.z - b.z * c.y, y: b.z * c.x - b.x * c.z, z: b.x * c.y - b.y * c.x }
  const r1 = { x: c.y * a.z - c.z * a.y, y: c.z * a.x - c.x * a.z, z: c.x * a.y - c.y * a.x }
  const r2 = { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
  const det = a.x * r0.x + a.y * r0.y + a.z * r0.z
  const k = Math.abs(det) > 1e-8 ? 1 / det : 1

  return {
    x: { x: r0.x * k, y: r1.x * k, z: r2.x * k, w: 0 },
    y: { x: r0.y * k, y: r1.y * k, z: r2.y * k, w: 0 },
    z: { x: r0.z * k, y: r1.z * k, z: r2.z * k, w: 0 },
    w: {
      x: -(r0.x * t.x + r0.y * t.y + r0.z * t.z) * k,
      y: -(r1.x * t.x + r1.y * t.y + r1.z * t.z) * k,
      z: -(r2.x * t.x + r2.y * t.y + r2.z * t.z) * k,
      w: 1,
    },
  }
}

/** `Mᵀ · (p − t)`, 3DMathEngine `+0x3c`: the transpose, so a scaled frame's result stays scaled. */
export const transposeInto = (matrix: Matrix4, point: Vector3): Vector3 => {
  const dx = point.x - matrix.w.x
  const dy = point.y - matrix.w.y
  const dz = point.z - matrix.w.z

  return {
    x: matrix.x.x * dx + matrix.x.y * dy + matrix.x.z * dz,
    y: matrix.y.x * dx + matrix.y.y * dy + matrix.y.z * dz,
    z: matrix.z.x * dx + matrix.z.y * dy + matrix.z.z * dz,
  }
}
