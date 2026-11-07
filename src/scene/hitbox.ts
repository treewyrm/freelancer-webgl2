/**
 * What a ray hits among objects' collision shapes: `PhysicalSystem::FindRayCollisions`
 * (`FUN_0628d1a0`, `src/Common/common_physicalsystem.cpp`), which asks IVP's ray solver of every
 * object in the system and takes its hits nearest first. Each convex hull the ray enters is a hit of
 * its own, so one object can give several. Pure.
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import { HullType, type Hull, type Node, type Surface } from '@treewyrm/freelancer/surface'
import type { RayHit } from './corona.js'

/** One of an object's physics shapes, in the frame its points are in. */
export interface HitboxSurface {
  surface: Surface
  /** Its frame in the world: the object's for the root part's, its own part's for a `!fxd` one. */
  world: Matrix4
}

/**
 * An object's collision shapes as `BuildIVP_Real` (`0x6288dd0`) makes them: its `.sur`'s root part,
 * which holds every fixed child's hulls too, and each `!fxd` part's own. A `.sph` solar's is a ball
 * of its `solar_radius` instead (`BuildIVP_Sphere`, from `CSolar`'s `0x62b78c5`).
 */
export interface Hitbox {
  surfaces?: readonly HitboxSurface[]
  /** A ball about the object's position. Its hits have no hull, so part 0, never a shield. */
  ball?: number
  /** Whether a hull's id, a part's, is a shield's (`CObject::is_shield_part`). None when absent. */
  shield?: (id: number) => boolean
}

/** An object a ray can hit, and what the hit reports of it. */
export interface HitboxObject {
  /** Handed back as the hit's `object`. */
  object?: unknown
  /** `CObject::WorldPosition`. */
  position: Vector3
  /** `CObject::Radius`. */
  radius: number
  hitbox: Hitbox
}

const sub = (a: Vector3, b: Vector3): Vector3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a: Vector3, b: Vector3): number => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})

/** Whether the segment from `start`, along unit `dir` for `length`, comes within a node's sphere. */
const reaches = ({ center, radius }: Node, start: Vector3, dir: Vector3, length: number) => {
  const offset = sub(center, start)
  const along = Math.min(Math.max(dot(offset, dir), 0), length)
  const x = offset.x - dir.x * along
  const y = offset.y - dir.y * along
  const z = offset.z - dir.z * along
  return x * x + y * y + z * z <= radius * radius
}

/**
 * How far along the ray it enters a convex hull, its faces wound counter-clockwise from outside, or
 * nothing. A ray starting inside one is taken as not hitting it: what IVP's solver does there isn't
 * read, and only a camera inside a hitbox would show it.
 */
const enters = (
  hull: Hull,
  points: readonly Vector3[],
  start: Vector3,
  dir: Vector3,
  length: number,
): number | undefined => {
  let near = -Infinity
  let far = Infinity
  for (const {
    points: [ia, ib, ic],
  } of hull.faces) {
    const a = points[ia]!
    const normal = cross(sub(points[ib]!, a), sub(points[ic]!, a))
    const facing = dot(normal, dir)
    const height = dot(normal, sub(start, a))
    if (facing === 0) {
      if (height > 0) return undefined
      continue
    }
    const t = -height / facing
    if (facing < 0) near = Math.max(near, t)
    else far = Math.min(far, t)
    if (near > far) return undefined
  }
  return near >= 0 && near <= length ? near : undefined
}

/** How far along the segment it enters a ball, from outside, or nothing. */
const entersBall = (centre: Vector3, radius: number, from: Vector3, to: Vector3) => {
  const delta = sub(to, from)
  const length = Math.sqrt(dot(delta, delta))
  if (!(length > 0)) return undefined
  const dir = { x: delta.x / length, y: delta.y / length, z: delta.z / length }
  const offset = sub(from, centre)
  const b = dot(offset, dir)
  const c = dot(offset, offset) - radius * radius
  if (c <= 0) return undefined
  const disc = b * b - c
  if (disc < 0) return undefined
  const t = -b - Math.sqrt(disc)
  return t >= 0 && t <= length ? t : undefined
}

/**
 * `FindRayCollisions` from `from` to `to`: each hull entered, nearest first, at most `limit`. Inner
 * nodes' bounding hulls only cull, as IVP's ledge tree uses them.
 */
export const castRay = (
  objects: readonly HitboxObject[],
  from: Vector3,
  to: Vector3,
  limit: number,
): RayHit[] => {
  const found: { distance: number; hit: RayHit }[] = []
  for (const { object, position, radius, hitbox } of objects) {
    const hit: RayHit = { position, radius, ...(object !== undefined && { object }) }
    if (hitbox.ball !== undefined) {
      const distance = entersBall(position, hitbox.ball, from, to)
      if (distance !== undefined) found.push({ distance, hit })
    }
    for (const { surface, world } of hitbox.surfaces ?? []) {
      const inverse = Matrix4.invert(world)
      const start = Matrix4.transformPoint(from, inverse)
      const delta = sub(Matrix4.transformPoint(to, inverse), start)
      const length = Math.sqrt(dot(delta, delta))
      if (!(length > 0)) continue
      const dir = { x: delta.x / length, y: delta.y / length, z: delta.z / length }
      const visit = (node: Node) => {
        if (!reaches(node, start, dir, length)) return
        const { hull } = node
        if (hull && hull.type === HullType.Enabled) {
          const distance = enters(hull, surface.points, start, dir, length)
          if (distance !== undefined) {
            const shield = hitbox.shield?.(hull.id) ?? false
            found.push({ distance, hit: shield ? { ...hit, shield } : hit })
          }
        }
        if (node.left) visit(node.left)
        if (node.right) visit(node.right)
      }
      visit(surface.root)
    }
  }
  return found
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(({ hit }) => hit)
}
