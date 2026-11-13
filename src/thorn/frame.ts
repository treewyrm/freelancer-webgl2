/**
 * The frame arithmetic thorn does. A frame is `x86math.dll`'s `[R | t]`, applied as `R·v + t`, and
 * `A · B` applies `B` first: the library's `Matrix4` already, holding `R`'s columns.
 *
 * Thorn's quaternions are `{w, x, y, z}`; here they are the library's `{x, y, z, w}`.
 */
import { Matrix3, Matrix4, Vector3, type Vector4 } from '@treewyrm/freelancer/math'
import { data, type AxisName } from '@treewyrm/freelancer/thn/scene'

export type Frame = Matrix4
export type Quaternion = Vector4

const f = Math.fround

/** An entity's `spatialprops`: `orient`'s triples are `R`'s columns, which the reader has transposed. */
export const placement = (pos?: Vector3, orient?: Matrix3): Frame =>
  Matrix4.fromRotationTranslation(orient ?? Matrix3.identity, pos ?? Vector3.zero)

export const positionOf = ({ w }: Frame): Vector3 => ({ x: w.x, y: w.y, z: w.z })

export const withPosition = (frame: Frame, { x, y, z }: Vector3): Frame => ({
  ...frame,
  w: { x, y, z, w: 1 },
})

/** `[rotation.R | frame.t]`. */
export const withRotation = (frame: Frame, rotation: Frame): Frame => ({
  x: rotation.x,
  y: rotation.y,
  z: rotation.z,
  w: frame.w,
})

/** `R·v`. */
export const rotate = (frame: Frame, v: Vector3): Vector3 => Matrix4.transformDirection(v, frame)

/** `[Rᵀ | −Rᵀ·t]`, as thorn builds every inverse it takes. */
export const inverse = (frame: Frame): Frame => {
  const { x, y, z } = frame
  const rotation: Frame = {
    x: { x: x.x, y: y.x, z: z.x, w: 0 },
    y: { x: x.y, y: y.y, z: z.y, w: 0 },
    z: { x: x.z, y: y.z, z: z.z, w: 0 },
    w: { x: 0, y: 0, z: 0, w: 1 },
  }

  return withPosition(rotation, Vector3.multiplyScalar(rotate(rotation, positionOf(frame)), -1))
}

/** The rotation whose columns are these. */
export const columnsOf = (a: Vector3, b: Vector3, c: Vector3): Frame => ({
  x: { ...a, w: 0 },
  y: { ...b, w: 0 },
  z: { ...c, w: 0 },
  w: { x: 0, y: 0, z: 0, w: 1 },
})

/** `R(q)` scaled by `2/|q|²`, so a non-unit `q` is tolerated: `x86math.dll` `0x6f723c0`. */
export const rotationOf = ({ x, y, z, w }: Quaternion): Frame => {
  const s = 2 / (w * w + x * x + y * y + z * z)

  return columnsOf(
    { x: 1 - s * (y * y + z * z), y: s * (x * y + w * z), z: s * (x * z - w * y) },
    { x: s * (x * y - w * z), y: 1 - s * (x * x + z * z), z: s * (y * z + w * x) },
    { x: s * (x * z + w * y), y: s * (y * z - w * x), z: 1 - s * (x * x + y * y) },
  )
}

/** `R`'s quaternion, by the trace or else its largest diagonal: `x86math.dll` `0x6f72290`. */
export const quaternionOf = (frame: Frame): Quaternion => {
  // m[row][column] of R; a Matrix4 holds columns.
  const m = [
    [frame.x.x, frame.y.x, frame.z.x],
    [frame.x.y, frame.y.y, frame.z.y],
    [frame.x.z, frame.y.z, frame.z.z],
  ] as const
  const trace = m[0][0] + m[1][1] + m[2][2]

  if (trace > 0) {
    const s = Math.sqrt(trace + 1)
    const r = 0.5 / s

    return {
      x: (m[2][1] - m[1][2]) * r,
      y: (m[0][2] - m[2][0]) * r,
      z: (m[1][0] - m[0][1]) * r,
      w: s * 0.5,
    }
  }

  // `i` is the largest diagonal entry, `j` and `k` the next two cyclically; `v` is (x, y, z).
  let i = 0
  if (m[1][1] > m[0][0]) i = 1
  if (m[2][2] > m[i]![i]!) i = 2

  const j = (i + 1) % 3
  const k = (j + 1) % 3
  const s = Math.sqrt(m[i]![i]! - m[j]![j]! - m[k]![k]! + 1)
  const r = 0.5 / s
  const v = [0, 0, 0]

  v[i] = s * 0.5
  v[j] = (m[j]![i]! + m[i]![j]!) * r
  v[k] = (m[k]![i]! + m[i]![k]!) * r
  return { x: v[0]!, y: v[1]!, z: v[2]!, w: (m[k]![j]! - m[j]![k]!) * r }
}

/**
 * `x86math.dll`'s `+0x58` (`0x6f724d0`), which every "slerp" in thorn is: a normalised lerp,
 * folded onto `a`'s hemisphere.
 */
export const nlerp = (a: Quaternion, b: Quaternion, t: number): Quaternion => {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
  const k = dot < 0 ? -1 : 1
  const q = {
    x: a.x + (k * b.x - a.x) * t,
    y: a.y + (k * b.y - a.y) * t,
    z: a.z + (k * b.z - a.z) * t,
    w: a.w + (k * b.w - a.w) * t,
  }
  const n = Math.hypot(q.x, q.y, q.z, q.w)

  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n }
}

/** Axis 0 to 5: X, Y, Z, −X, −Y, −Z. */
export const axisIndex = (name: AxisName | undefined, fallback: number): number =>
  name === undefined ? fallback : data.AXES[name]

const AXES: readonly Vector3[] = [
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: -1 },
]

const POLE = 0.99

/**
 * `BuildAxisFrame` (`FUN_06f2e440`): the rotation turning the local `front` axis onto `d`, its `up`
 * leaning toward the scene's up, or within the pole toward `up × front` of the scene. The two axes
 * are written as columns and the third is their cross product. Retail's scene axes are always Y and
 * Z; `6` means those. `d` must not be zero.
 */
export const lookAt = (
  d: Vector3,
  front: number,
  up: number,
  sceneUp = 6,
  sceneFront = 6,
): Frame => {
  // A shared up of 6 skips both shared axes.
  const U = AXES[sceneUp === 6 ? 1 : sceneUp] ?? AXES[1]!
  const F = AXES[sceneUp === 6 || sceneFront === 6 ? 2 : sceneFront] ?? AXES[2]!
  const side = Vector3.cross(U, F)
  let dir = Vector3.normalize(d)
  let lean = U

  if (front > 2) dir = Vector3.multiplyScalar(dir, -1)
  if (up > 2) lean = Vector3.multiplyScalar(lean, -1)

  const ortho =
    Math.abs(Vector3.dot(lean, dir)) > POLE
      ? Vector3.normalize(Vector3.cross(dir, side))
      : Vector3.normalize(Vector3.cross(dir, Vector3.normalize(Vector3.cross(lean, dir))))
  const out: (Vector3 | undefined)[] = [undefined, undefined, undefined]

  out[front % 3] = dir
  out[up % 3] = ortho

  // An unwritten column starts as the identity's; retail leaves the caller's buffer there.
  const [x, y, z] = out.map((each, index) => each ?? AXES[index]!) as [Vector3, Vector3, Vector3]
  if (out[0] === undefined) return columnsOf(Vector3.normalize(Vector3.cross(y, z)), y, z)

  if (out[1] !== undefined) {
    if (out[2] === undefined) return columnsOf(x, y, Vector3.normalize(Vector3.cross(x, y)))
    return columnsOf(x, y, z)
  }

  return columnsOf(x, Vector3.normalize(Vector3.cross(z, x)), z)
}

/**
 * `ApplyAxisRotFpu` (`0x6f46eef`): a turn of `degrees` about an axis, applied to `base` in scene axes
 * for X, Y and Z and in its own for the negative names, whose sign is **not** flipped.
 */
export const axisTurn = (base: Frame, axis: number, degrees: number): Frame => {
  if (axis < 0 || axis > 5) return base

  const radians = degrees * f(0.017453292)
  const c = f(Math.cos(radians))
  const s = Math.sin(radians)
  // Right-handed Rx, Ry or Rz, each written as its columns.
  const turn =
    axis % 3 === 0
      ? columnsOf({ x: 1, y: 0, z: 0 }, { x: 0, y: c, z: s }, { x: 0, y: -s, z: c })
      : axis % 3 === 1
        ? columnsOf({ x: c, y: 0, z: -s }, { x: 0, y: 1, z: 0 }, { x: s, y: 0, z: c })
        : columnsOf({ x: c, y: s, z: 0 }, { x: -s, y: c, z: 0 }, { x: 0, y: 0, z: 1 })

  return axis <= 2 ? Matrix4.multiply(turn, base) : Matrix4.multiply(base, turn)
}
