/**
 * A `MOTION_PATH`'s spline: `CV_CROrientationSplinePath` and `CV_CRSplinePath` in
 * `src/Thorn/SplinePath.cpp`. Uniform Catmull-Rom between keys, sampled 16 times a segment, and
 * travelled at constant speed along those chords: the parameter is normalised chord length.
 */
import { Quat, Vector3, Vector4 } from '@treewyrm/freelancer/math'
import type { PathProps } from '@treewyrm/freelancer/thn/scene'
import { columnsOf, nlerp, quaternionOf, type Quaternion } from './frame.js'

const f = Math.fround
const SAMPLES = 16
const IDENTITY: Quaternion = { x: 0, y: 0, z: 0, w: 1 }

export interface Path {
  /** In the path's own axes. Held at the first and last key outside `(0, 1)`. */
  position(u: number): Vector3 | undefined
  /** The unit Catmull-Rom tangent toward increasing `u`, lerped between samples; not held at the ends. */
  tangent(u: number): Vector3 | undefined
  /** Squad between keys' orientations; a position-only path has none. */
  orientation(u: number): Quaternion | undefined
}

/** `CatmullRomTangent3D` (`FUN_06f213d0`): the derivative over its length, a zero one dividing by 0. */
const crTangent = (p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, s: number): Vector3 => {
  const d = Vector3.catmullRomTangent(p0, p1, p2, p3, s)

  return Vector3.multiplyScalar(d, 1 / Math.sqrt(Vector3.dot(d, d)))
}

const scale = Vector4.multiplyScalar

/** `QuatLogRetail`: `(0, v·θ/sin θ)`, or `(0, v)` at `|w| ≥ 1` or a sine under 0.001. No hemisphere fold. */
const log = (q: Quaternion): Quaternion => {
  if (!(Math.abs(q.w) < 1)) return { ...q, w: 0 }

  const angle = Math.acos(q.w)
  const sin = Math.sin(angle)
  if (sin < f(0.001)) return { ...q, w: 0 }
  return { ...scale(q, angle / sin), w: 0 }
}

/** `QuatExpRetail`: `(cos |v|, v·sin |v|/|v|)`, `v` kept under a sine of 0.001. */
const exp = (q: Quaternion): Quaternion => {
  const n = Math.hypot(q.x, q.y, q.z)
  const sin = Math.sin(n)
  const v = sin < f(0.001) ? q : scale(q, sin / n)

  return { x: v.x, y: v.y, z: v.z, w: Math.cos(n) }
}

/** `QuatSquadControl`, `Quat.squadControl` with retail's log and exp: `q · exp(−¼(log(q⁻¹·prev) + log(q⁻¹·next)))`. */
const control = (prev: Quaternion, q: Quaternion, next: Quaternion): Quaternion => {
  const inverse = Quat.invert(q)
  const a = log(Quat.multiply(inverse, prev))
  const b = log(Quat.multiply(inverse, next))

  return Quat.multiply(q, exp(scale(Vector4.add(a, b), -0.25)))
}

/** `EvalCrOrientation` (`FUN_06f21770`) and `QuatSquad` (`FUN_06f248c0`): `Quat.squad`, every blend an nlerp. */
const squad = (q0: Quaternion, q1: Quaternion, q2: Quaternion, q3: Quaternion, s: number) =>
  nlerp(nlerp(q1, q2, s), nlerp(control(q0, q1, q2), control(q1, q2, q3), s), f((1 - s) * s * 2))

/**
 * A path from its `pathprops`, or nothing where thorn's load fails: a `NULL` path, or fewer than two
 * keys (`0x6f358fb`), and every animation on it does nothing.
 */
export const createPath = (props: PathProps | undefined): Path | undefined => {
  if (!props || props.path_type === 'NULL') return undefined

  const keys: { position: Vector3; orientation?: Quaternion }[] =
    props.path_type === 'CV_CROrientationSplinePath'
      ? props.points.map(({ position, orientation }) => ({ position, orientation }))
      : props.points.map((position) => ({ position }))
  const n = keys.length
  if (n < 2) return undefined

  const closed = props.flag === 'CLOSED'
  // The ends (`ApplyPersistGhosts`): open, the end keys doubled; closed, wrapped round.
  const points = [
    closed ? keys[n - 1]!.position : keys[0]!.position,
    ...keys.map((key) => key.position),
    closed ? keys[0]!.position : keys[n - 1]!.position,
    ...(closed ? [keys[1]!.position] : []),
  ]
  // Quaternions are wrapped by neither; a closed path's last ghost is never written in retail.
  const quats = [
    keys[0]!.orientation ?? IDENTITY,
    ...keys.map((key) => key.orientation ?? IDENTITY),
    keys[n - 1]!.orientation ?? IDENTITY,
    IDENTITY,
  ]
  const last = closed ? n + 1 : n
  const neighbours = <T>(list: readonly T[], k: number) =>
    [list[k - 1]!, list[k]!, list[k + 1]!, list[k + 2]!] as const

  // `RebuildSampleTables`: per segment, the running chord length at 17 samples; then all over the total.
  const tables: number[][] = []
  // `times[k]` is the normalised length where segment `k` starts (`times[last]` is 1);
  // slots 0 and `last + 1` stay 0.
  const times: number[] = [0, 0]
  let total = 0

  for (let k = 1; k < last; k++) {
    const [p0, p1, p2, p3] = neighbours(points, k)
    const table = [total]
    // `FUN_06f21000`.
    let previous = Vector3.catmullRom(p0, p1, p2, p3, 0)
    let length = 0

    for (let j = 1; j <= SAMPLES; j++) {
      const current = Vector3.catmullRom(p0, p1, p2, p3, f(j * 0.0625))

      length = f(length + Vector3.distance(previous, current))
      table.push(f(total + length))
      previous = current
    }

    tables[k] = table
    total = f(total + length)
    times[k + 1] = total
  }

  for (const table of tables) if (table) table.forEach((value, j) => (table[j] = f(value / total)))
  times[1] = 0
  times[last + 1] = 0
  for (let k = 0; k < times.length; k++) times[k] = f(times[k]! / total)

  /** `FindPathSegment`: past every key time at or before `u`, from the first live one. */
  const segmentOf = (u: number): number | undefined => {
    let k = 1

    while (k < last && !(times[k]! > u)) k++

    const segment = k - 1

    return segment >= 1 && segment < last ? segment : undefined
  }

  /** `FindSample`: the sample interval holding `u`, an exact hit the one before, and the fraction. */
  const sampleOf = (k: number, u: number): [number, number] => {
    const table = tables[k]!
    let at = 8

    // Binary search of the 17-entry table from its middle, stepping 4, 2, 1.
    for (let step = 8; step > 1;) {
      step = Math.trunc(step / 2)
      at += u < table[at]! ? -step : step
    }

    if (!(u > table[at]!)) at--
    return [at, f((u - table[at]!) / (table[at + 1]! - table[at]!))]
  }

  const along = (
    u: number,
    curve: (p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, s: number) => Vector3,
  ): Vector3 | undefined => {
    const k = segmentOf(u)
    if (k === undefined) return undefined

    const [j, fraction] = sampleOf(k, u)
    const [p0, p1, p2, p3] = neighbours(points, k)
    const a = curve(p0, p1, p2, p3, f(j * 0.0625))
    const b = curve(p0, p1, p2, p3, f((j + 1) * 0.0625))

    return Vector3.lerp(a, b, fraction)
  }

  const oriented = props.path_type === 'CV_CROrientationSplinePath'

  return {
    position: (u) => (u <= 0 ? points[1] : u >= 1 ? points[last] : along(u, Vector3.catmullRom)),
    tangent: (u) => along(u, crTangent),
    orientation: (u) => {
      if (!oriented) {
        // `BuildSlot5MatrixRetail` (`LAB_06f34420`): `Z = −t`, `X = Ŷ × Z`, `Y = Z × X`. Its asm isn't
        // decoded in the decomp; this is the extension's emulated reading. No retail path uses it.
        const t = along(u, crTangent)
        if (!t) return undefined

        const z = Vector3.multiplyScalar(Vector3.normalize(t), -1)
        const x = Vector3.normalize(Vector3.cross({ x: 0, y: 1, z: 0 }, z))

        return quaternionOf(columnsOf(x, Vector3.cross(z, x), z))
      }

      if (u <= 0) return quats[1]
      if (u >= 1) return quats[last]

      const k = segmentOf(u)
      if (k === undefined) return undefined

      const [j, fraction] = sampleOf(k, u)
      const [q0, q1, q2, q3] = neighbours(quats, k)
      const a = squad(q0, q1, q2, q3, f(j * 0.0625))
      const b = squad(q0, q1, q2, q3, f((j + 1) * 0.0625))

      return nlerp(a, b, fraction)
    },
  }
}
