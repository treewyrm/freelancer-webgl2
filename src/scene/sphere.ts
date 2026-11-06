/** A `.sph` where a camera sees it: `FSphereAnim::Draw` and `UpdateLevel`, in `RendComp`. Pure, no GL. */
import { getResourceId } from '@treewyrm/freelancer'
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { Material } from '@treewyrm/freelancer/material'
import type { Sphere } from '@treewyrm/freelancer/rigid'
import { mapMaterialType, type MaterialMapRule } from '#/material/map.js'
import { spherePatch } from '#/mesh/sphere.js'
import type { Camera } from './camera.js'
import { DEFAULT_SHELL_SCALE, type PlacedPart } from './frame.js'
import { lodScale } from './level.js'

export interface SphereOptions {
  /** Decides the level and which faces draw. */
  camera: Camera
  /** Of the viewport, in pixels: the level bounds the sphere's error on screen. */
  width: number
  /** Pins a level, for a host choosing its own density. Faces still cull. */
  level?: number
  /** Finds the seventh side's `Scale`, which its shell culls by. 1 if absent. */
  material?: (id: number) => Material | undefined
  /** As on `SceneModel`, for that side's type. */
  materialMap?: readonly MaterialMapRule[]
  /** Over `RETAIL_SPHERE_LEVELS`, for a mod that patches them. */
  levels?: Partial<SphereLevels>
}

/** `FSphereAnim::Init`'s bounds on a sphere's level, and the bias on its pixel size. */
export interface SphereLevels {
  minimum: number
  maximum: number
  bias: number
}

// What a sphere starts with, and keeps unless `solarSphereLevels` reaches it.
export const RETAIL_SPHERE_LEVELS: Readonly<SphereLevels> = { minimum: 3, maximum: 9, bias: 1.5 }

/**
 * `SolarSpheresApplyDetail` (`0x5488a0`): the maximum, 7 to 10, and the bias, 3 to 1, the
 * `level_of_detail` option gives a solar's sphere. Retail applies it only as the option changes, to the
 * solars that exist then (`SetPerfOptionValue`): at startup none do, so a system's planets keep
 * `RETAIL_SPHERE_LEVELS` until the player moves the slider in it, and lose it when it reloads.
 */
export const solarSphereLevels = (detail: number): Pick<SphereLevels, 'maximum' | 'bias'> => {
  const { scale } = lodScale(detail)
  const t = Math.min(Math.max(scale + scale - 1, 0), 1)
  return { maximum: Math.trunc(3 * t + 7), bias: Math.trunc(3.5 - (t + t)) }
}

const K = Math.sqrt(1 / 3)

const axes = (x: Vector3, y: Vector3, z: Vector3): Matrix4 => ({
  x: { ...x, w: 0 },
  y: { ...y, w: 0 },
  z: { ...z, w: 0 },
  w: { x: 0, y: 0, z: 0, w: 1 },
})

const X = { x: 1, y: 0, z: 0 }
const Y = { x: 0, y: 1, z: 0 }
const Z = { x: 0, y: 0, z: 1 }
const NEGATIVE_X = { x: -1, y: 0, z: 0 }
const NEGATIVE_Y = { x: 0, y: -1, z: 0 }
const NEGATIVE_Z = { x: 0, y: 0, z: -1 }

// `SphereFaceRotation`, turning the `+Z` patch: `M0..M5` are +Z, +X, -Z, -X, +Y, -Y.
const FACES: readonly Matrix4[] = [
  axes(X, Y, Z),
  axes(NEGATIVE_Z, Y, X),
  axes(NEGATIVE_X, Y, NEGATIVE_Z),
  axes(Z, Y, NEGATIVE_X),
  axes(X, NEGATIVE_Z, Y),
  axes(X, Z, NEGATIVE_Y),
]

// Each face's cube corners, by `Draw`'s numbering. Only those of the face nearest the camera are
// tested, so a face draws by sharing a visible corner with it, and the one opposite never draws.
const FACE_CORNERS: readonly (readonly number[])[] = [
  [0, 3, 4, 7],
  [0, 1, 4, 5],
  [1, 2, 5, 6],
  [2, 3, 6, 7],
  [0, 1, 2, 3],
  [4, 5, 6, 7],
]
const CORNERS: readonly Vector3[] = [
  { x: K, y: K, z: K },
  { x: K, y: K, z: -K },
  { x: -K, y: K, z: -K },
  { x: -K, y: K, z: K },
  { x: K, y: -K, z: K },
  { x: K, y: -K, z: -K },
  { x: -K, y: -K, z: -K },
  { x: -K, y: -K, z: K },
]

const dot = (a: Vector3, b: Vector3): number => a.x * b.x + a.y * b.y + a.z * b.z

/**
 * `UpdateLevel` (`0x6c2c430`), from `metric`, the world size of a pixel at the sphere times the bias.
 * Out of `acos`'s range, or at no distance, x87's `ftol` gives `INT_MIN`, so the lowest level.
 */
export const sphereLevel = (
  radius: number,
  metric: number,
  { minimum, maximum }: Pick<SphereLevels, 'minimum' | 'maximum'> = RETAIL_SPHERE_LEVELS,
): number => {
  const ratio = Math.PI / 2 / Math.acos(1 - metric / radius)
  const level = Math.trunc(2 * Math.log2(ratio) + 0.5)
  if (!Number.isFinite(level)) return minimum
  return Math.min(maximum, Math.max(minimum, level))
}

/** Which faces draw, in order, at this radius. A world's rotation turns the cube; its scale isn't read. */
const visibleFaces = (radius: number, world: Matrix4, position: Vector3): number[] => {
  const turn = ({ x, y, z }: Vector3): Vector3 => ({
    x: world.x.x * x + world.y.x * y + world.z.x * z,
    y: world.x.y * x + world.y.y * y + world.z.y * z,
    z: world.x.z * x + world.y.z * y + world.z.z * z,
  })
  const away = { x: position.x - world.w.x, y: position.y - world.w.y, z: position.z - world.w.z }
  const distance = Math.hypot(away.x, away.y, away.z)
  const toCamera = { x: away.x / distance, y: away.y / distance, z: away.z / distance }

  let best = 0
  let most = -1
  FACES.forEach(({ z: normal }, face) => {
    const facing = dot(toCamera, turn(normal))
    if (facing > most) {
      most = facing
      best = face
    }
  })

  const threshold = Math.min(radius / distance, K)
  const visible = FACE_CORNERS[best]!.filter(
    (corner) => dot(toCamera, turn(CORNERS[corner]!)) > threshold,
  )
  return FACES.flatMap((_, face) =>
    face === best || FACE_CORNERS[face]!.some((corner) => visible.includes(corner)) ? [face] : [],
  )
}

/**
 * A sphere's visible faces, as parts, then its shell's, which is the same patch under the seventh
 * material and culls by its own larger radius. Materials repeat by `Sides`, a retail sun naming one.
 */
export const placeSphere = (
  { radius, sides }: Sphere,
  world: Matrix4,
  { camera, width, level, material, materialMap, levels }: SphereOptions,
): PlacedPart[] => {
  const { x, y, z } = camera.position
  const distance = Math.hypot(x - world.w.x, y - world.w.y, z - world.w.z)
  // `Draw` divides by `ZNear * GetXScaleOverNear()`, which is `HalfWidth / tan(fovx½)` (`space_camera.cpp`).
  const pixel = (Math.tan((camera.fovh * Math.PI) / 180) / (width / 2)) * distance
  const bounds = { ...RETAIL_SPHERE_LEVELS, ...levels }
  const { mesh, reference } = spherePatch(
    radius,
    level ?? sphereLevel(radius, pixel * bounds.bias, bounds),
  )
  const part = (face: number, name: string): PlacedPart => ({
    reference,
    mesh,
    world: Matrix4.multiply(world, FACES[face]!),
    materialId: getResourceId(name),
    materialName: name,
  })
  const parts = visibleFaces(radius, world, camera.position).map((face) =>
    part(face, sides[face % sides.length]!),
  )
  const shell = sides[FACES.length]
  if (shell === undefined) return parts

  // `FSphereHandle::Load` reads `Scale` only from a seventh side that's an `AtmosphereMaterial`.
  const found = material?.(getResourceId(shell))
  const scale =
    found && mapMaterialType(found, materialMap) === 'AtmosphereMaterial'
      ? (found.scale ?? DEFAULT_SHELL_SCALE)
      : 1
  const extent = radius * scale
  return [
    ...parts,
    ...visibleFaces(extent, world, camera.position).map((face) => ({
      ...part(face, shell),
      extent,
    })),
  ]
}
