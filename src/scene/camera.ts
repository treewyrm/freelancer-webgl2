/** A camera as the game holds one, to GL matrices. */
import { Matrix3, Matrix4, Vector3 } from '@treewyrm/freelancer/math'

export interface Camera {
  position: Vector3
  /** Rows, as `./thn/scene` reads a THN `orient`. Looks down local -Z, with +Y up (`0x5568b0`). */
  orientation: Matrix3
  /** Half the horizontal field of view, in degrees (`RoomCameraSetHalfFovX`). */
  fovh: number
  near: number
  far: number
}

/** `Mᵀ(p - position)`, the game's own right-handed view space (`0x40ff50`). */
export const viewMatrix = ({ position, orientation }: Camera): Matrix4 =>
  Matrix4.invert(Matrix4.fromRotationTranslation(orientation, position))

/** A viewport's size in pixels. */
export interface Viewport {
  width: number
  height: number
}

const f = Math.fround

/**
 * `FRoomCamera::ClassifySphere`'s rank 2 (`0x55687a`): `π (R / z)²` times its pixel scales, under one
 * pixel. `HalfWidth` is `(width - 1) / 2`, as `Rect_to_ViewRect`'s edges are inclusive, and its Y
 * tangent is X's over `width / height` (`RoomCameraConstruct`, `FUN_00556280`).
 */
export const underPixel = (
  z: number,
  radius: number,
  fovh: number,
  { width, height }: Viewport,
): boolean => {
  // `0x556868`: a centre on the eye's plane isn't sized.
  if (!(Math.abs(z) >= 0.0001)) return false

  const tanX = f(Math.tan((fovh + fovh) * (Math.PI / 360)))
  const tanY = f(tanX / (width / height))
  const xScale = f(f((width - 1) * 0.5) / tanX)
  const yScale = f(-(f((height - 1) * 0.5) / tanY))
  const q = -(radius / z)

  return yScale * xScale * q * q * f(-Math.PI) < 1
}

/**
 * `ClassifySphere` (`FSpaceCamera`, `0x40ffe0`) for a sphere in view space: 1 is outside, 3 crosses a
 * plane, 4 is wholly inside. With a viewport, a room camera's (`FRoomCamera`, `0x556780`), whose
 * rank 2 is a sphere in view that covers under a pixel; no caller draws it.
 */
export function classifySphere(
  center: Vector3,
  radius: number,
  camera: Camera,
  aspect: number,
): 1 | 3 | 4

export function classifySphere(
  center: Vector3,
  radius: number,
  camera: Camera,
  aspect: number,
  viewport?: Viewport,
): 1 | 2 | 3 | 4

export function classifySphere(
  { x, y, z }: Vector3,
  radius: number,
  { fovh, near, far }: Camera,
  aspect: number,
  viewport?: Viewport,
): 1 | 2 | 3 | 4 {
  const nearEdge = -z - radius
  const farEdge = radius - z
  if (farEdge < near || nearEdge > far) return 1

  // Signed distance to the side plane nearest the centre, positive outside (-Z is ahead, so z < 0
  // in view): past `radius` is outside, past -`radius` is wholly inside.
  const tanX = Math.tan((fovh * Math.PI) / 180)
  const tanY = tanX / aspect
  const distanceX = (Math.abs(x) + tanX * z) / Math.hypot(1, tanX)
  const distanceY = (Math.abs(y) + tanY * z) / Math.hypot(1, tanY)
  if (distanceX > radius || distanceY > radius) return 1
  if (viewport && underPixel(z, radius, fovh, viewport)) return 2
  return nearEdge < near || farEdge > far || distanceX > -radius || distanceY > -radius ? 3 : 4
}

/** Whether a sphere in view space can reach the frustum. */
export const sphereInFrustum = (
  center: Vector3,
  radius: number,
  camera: Camera,
  aspect: number,
  viewport?: Viewport,
): boolean => classifySphere(center, radius, camera, aspect, viewport) >= 3

/**
 * RP8 flips view Z and applies a left-handed D3D projection (`FDirectX8::SetPerspective`). For a GL
 * clip space that comes to this plain right-handed perspective: no axis is negated, and z / w maps
 * onto the same window depth as D3D's. `hvaspect` never reaches the screen, so aspect is the viewport's.
 */
export const projectionMatrix = ({ fovh, near, far }: Camera, aspect: number): Matrix4 =>
  // `fovh` is half the horizontal angle, in degrees.
  Matrix4.perspectiveRH(2 * Math.atan(Math.tan((fovh * Math.PI) / 180) / aspect), aspect, near, far)
