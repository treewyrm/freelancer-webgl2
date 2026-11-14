/** A camera's turn from where it stands and what it looks at. */
import { Matrix3 } from '@treewyrm/freelancer/math'

export type Triple = readonly [number, number, number]

/** The turn whose -Z runs from `eye` to `target`, +Y kept up, as rows: `Matrix3` holds a file's. */
export const lookAt = (eye: Triple, target: Triple): Matrix3 => {
  const forward = target.map((value, axis) => value - eye[axis]!)
  const length = Math.hypot(...forward)
  const [fx, fy, fz] = forward.map((value) => value / length) as [number, number, number]
  // Right is forward × up, up is right × forward.
  const side = Math.hypot(fz, fx)
  const right = { x: -fz / side, y: 0, z: fx / side }
  const up = {
    x: right.y * fz - right.z * fy,
    y: right.z * fx - right.x * fz,
    z: right.x * fy - right.y * fx,
  }

  return Matrix3.transpose({ x: right, y: up, z: { x: -fx, y: -fy, z: -fz } })
}
