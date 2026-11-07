/**
 * `ZONE::Intersect` (`LAB_0633aa40`, `src/Common/common_zone.cpp`): whether a segment meets a zone,
 * by the clip of its shape. Only whether it does is kept; where is never read by what calls it here.
 * Pure.
 */
import type { Vector3 } from '@treewyrm/freelancer/math'

const f = Math.fround

export type ZoneShapeType = 'sphere' | 'ellipsoid' | 'box' | 'cylinder' | 'ring'

interface Frame {
  position: Vector3
  /** `GetOrientation`'s columns. */
  axes: readonly [Vector3, Vector3, Vector3]
}

const sub = (a: Vector3, b: Vector3): Vector3 => ({
  x: f(a.x - b.x),
  y: f(a.y - b.y),
  z: f(a.z - b.z),
})

// `EngineTransposeTransform`: into the zone's own frame.
const toLocal = ({ axes }: Frame, d: Vector3): Vector3 => ({
  x: f(axes[0].x * d.x + axes[0].y * d.y + axes[0].z * d.z),
  y: f(axes[1].x * d.x + axes[1].y * d.y + axes[1].z * d.z),
  z: f(axes[2].x * d.x + axes[2].y * d.y + axes[2].z * d.z),
})

/** `FUN_06334ac0`: the segment enters the sphere, or starts in it. */
const clipSphere = (start: Vector3, end: Vector3, center: Vector3, radius: number): boolean => {
  const d = sub(end, start)
  const s = sub(start, center)
  const a = f(d.z * d.z + d.y * d.y + d.x * d.x)
  const b = d.z * s.z + d.y * s.y + s.x * d.x
  const c = s.z * s.z + s.y * s.y + s.x * s.x
  const disc = f(b * b - (c - radius * radius) * a)
  if (!(disc >= 0)) return false
  if (!(disc > 0)) {
    const t = -(b / a)
    return t >= 0 && f(t) <= 1
  }
  const root = Math.sqrt(disc)
  const t1 = f((-b - root) * (1 / a))
  const t2 = f((root - b) * (1 / a))
  // A start inside takes the exit, which isn't held to the segment.
  return !(t1 > 1) && !(t2 < 0)
}

/** `ClipSideWall`: the nearer root on the wall of `radius`, within its height. */
const sideWall = (
  a: number,
  b: number,
  disc: number,
  ls: Vector3,
  le: Vector3,
  half: number,
  best: number,
): number => {
  const height = (t: number) => half >= Math.abs((le.y - ls.y) * t + ls.y)
  if (disc > 0) {
    const root = Math.sqrt(disc)
    const twoA = a + a
    const t1 = f((-b - root) / twoA)
    const t2 = f((root - b) / twoA)
    if (t1 >= 0 && t1 <= best && height(t1)) {
      if (t2 >= 0 && t2 <= t1 && half >= Math.abs(f(le.y - ls.y) * t2 + ls.y)) return t2
      return t1
    }
    if (t2 >= 0 && t2 <= best && height(t2)) return t2
    return best
  }
  if (disc === 0) {
    const t = -b / (a + a)
    if (t >= 0 && f(t) <= best && height(f(t))) return f(t)
  }
  return best
}

/** The cylinder's and ring's walls and caps (`FUN_06334f30`, `FUN_06335440`). */
const clipTube = (
  frame: Frame,
  start: Vector3,
  end: Vector3,
  outer: number,
  inner: number | undefined,
  height: number,
): boolean => {
  const ls = toLocal(frame, sub(start, frame.position))
  const le = toLocal(frame, sub(end, frame.position))
  const half = f(height * 0.5)
  const dx = le.x - ls.x
  const dz = le.z - ls.z
  const a = f(dz * dz + dx * dx)
  const b = 2 * (ls.z * dz + ls.x * dx)
  const c = ls.z * ls.z + ls.x * ls.x
  let best = sideWall(a, b, b * b - (c - outer * outer) * a * 4, ls, le, half, 2)
  if (inner !== undefined)
    best = sideWall(a, b, b * b - (c - inner * inner) * a * 4, ls, le, half, best)
  const ld = toLocal(frame, sub(end, start))
  for (const num of [f(-half - ls.y), f(half - ls.y)]) {
    if (!((ld.y > 0 && num > 0) || (ld.y < 0 && num < 0))) continue
    const t = num / ld.y
    if (!(t > 0) || !(f(t) < best)) continue
    const x = ls.x + f(f(dx) * f(t))
    const z = ls.z + f(dz) * f(t)
    const radial = z * z + x * x
    if (radial < outer * outer && (inner === undefined || radial > inner * inner)) best = f(t)
  }
  return best >= 0 && best <= 1
}

/** `FUN_06335b10`: a start inside hits; otherwise the nearest face crossed, held only below 1. */
const clipBox = (frame: Frame, start: Vector3, end: Vector3, size: Vector3): boolean => {
  const ls = toLocal(frame, sub(start, frame.position))
  const le = toLocal(frame, sub(end, frame.position))
  const half = [f(size.x * 0.5), f(size.y * 0.5), f(size.z * 0.5)] as const
  if (size.x * 0.5 > Math.abs(ls.x) && half[1] > Math.abs(ls.y) && half[2] > Math.abs(ls.z))
    return true
  const ld = toLocal(frame, sub(end, start))
  const l = [ls.x, ls.y, ls.z]
  const e = [le.x, le.y, le.z]
  const dir = [ld.x, ld.y, ld.z]
  let best = 2
  for (let axis = 0; axis < 3; axis++) {
    const along = dir[axis]!
    const num = along > 0 ? -half[axis]! - l[axis]! : along < 0 ? half[axis]! - l[axis]! : 0
    if (!(along > 0 ? num > 0 : along < 0 ? num < 0 : false)) continue
    const t = num / along
    // The x faces aren't compared with the best so far.
    if (axis > 0 && !(t < best)) continue
    const point = l.map((value, at) => value + (e[at]! - value) * f(t))
    if ([0, 1, 2].every((other) => other === axis || half[other]! > Math.abs(point[other]!)))
      best = f(t)
  }
  return best <= 1
}

/** Whether the segment from `start` to `end` meets the zone (`ZONE::Intersect`). */
export const segmentMeetsZone = (
  type: ZoneShapeType,
  frame: Frame & { radius: number; size: Vector3 },
  start: Vector3,
  end: Vector3,
): boolean => {
  const { size } = frame
  switch (type) {
    case 'ellipsoid': {
      // Scaled by its written size into a unit sphere (`FUN_06334d10`).
      const unit = (point: Vector3) => {
        const local = toLocal(frame, sub(point, frame.position))
        return { x: f(local.x / size.x), y: f(local.y / size.y), z: f(local.z / size.z) }
      }
      return clipSphere(unit(start), unit(end), { x: 0, y: 0, z: 0 }, 1)
    }
    case 'box':
      return clipBox(frame, start, end, size)
    case 'cylinder':
      return clipTube(frame, start, end, size.x, undefined, size.y)
    case 'ring':
      return clipTube(frame, start, end, size.x, size.y, size.z)
    case 'sphere':
      return clipSphere(start, end, frame.position, frame.radius)
  }
}
