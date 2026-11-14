/**
 * What a ray hits among objects' collision shapes: `PhysicalSystem::FindRayCollisions`
 * (`FUN_0628d1a0`, `src/Common/common_physicalsystem.cpp`), which asks IVP's ray solver of every
 * object in the system and takes its hits nearest first. Each convex hull the ray enters is a hit of
 * its own, so one object can give several. Pure.
 */
import { Matrix4, Ray, Vector3 } from '@treewyrm/freelancer/math'
import { HullType, type Hull, type Node, type Surface } from '@treewyrm/freelancer/surface'
import type { RayHit } from './corona.js'

/** One of an object's physics shapes, in the frame its points are in. */
export interface HitboxSurface {
  surface: Surface
  /** Its frame in the world: the object's for the root part's, its own part's for a `!fxd` one. */
  world: Matrix4
}

/**
 * An object's collision shapes as `BuildIVP_Real` (`0x6288970`) makes them: its `.sur`'s root part,
 * which holds every fixed child's hulls too, and each `!fxd` part's own. A `.sph` solar's is a ball
 * of its `solar_radius` instead (`BuildIVP_Sphere`, from `CSolar`'s `0x62b74d5`).
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

/** Whether a segment, `length` along a unit ray, comes within a node's sphere. */
const reaches = (node: Node, ray: Ray, length: number): boolean => {
  const span = Ray.sphere(ray, node)

  return span !== undefined && span.min <= length && span.max >= 0
}

/**
 * How far along a unit ray it enters a convex hull, its faces wound counter-clockwise from outside,
 * within `length`, or nothing. A ray starting inside one is taken as not hitting it: what IVP's
 * solver does there isn't read, and only a camera inside a hitbox would show it.
 */
const enters = (
  hull: Hull,
  points: readonly Vector3[],
  ray: Ray,
  length: number,
): number | undefined => {
  const span = Ray.hull(ray, points, faces(hull))

  return span && span.min >= 0 && span.min <= length ? span.min : undefined
}

function* faces({ faces }: Hull): Generator<readonly [number, number, number]> {
  for (const { points } of faces) yield points
}

/** How far along a unit ray it enters a ball from outside, within `length`, or nothing. */
const entersBall = (center: Vector3, radius: number, ray: Ray, length: number) => {
  const span = Ray.sphere(ray, { center, radius })

  return span && span.min > 0 && span.min <= length ? span.min : undefined
}

/** The unit ray from `from` toward `to`, and how far `to` is along it; none where they meet. */
const rayBetween = (from: Vector3, to: Vector3): { ray: Ray; length: number } | undefined => {
  const delta = Vector3.subtract(to, from)
  const length = Vector3.magnitude(delta)
  if (!(length > 0)) return undefined
  return { ray: { origin: from, direction: Vector3.divideScalar(delta, length) }, length }
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
  const cast = rayBetween(from, to)

  for (const { object, position, radius, hitbox } of objects) {
    const hit: RayHit = { position, radius, ...(object !== undefined && { object }) }

    if (hitbox.ball !== undefined && cast) {
      const distance = entersBall(position, hitbox.ball, cast.ray, cast.length)
      if (distance !== undefined) found.push({ distance, hit })
    }

    for (const { surface, world } of hitbox.surfaces ?? []) {
      const inverse = Matrix4.invert(world)
      const local = rayBetween(
        Matrix4.transformPoint(from, inverse),
        Matrix4.transformPoint(to, inverse),
      )
      if (!local) continue

      const { ray, length } = local

      const visit = (node: Node) => {
        if (!reaches(node, ray, length)) return

        const { hull } = node

        if (hull && hull.type === HullType.Enabled) {
          const distance = enters(hull, surface.points, ray, length)

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
