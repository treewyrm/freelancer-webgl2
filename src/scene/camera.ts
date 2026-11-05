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

/**
 * `ClassifySphere` (`FSpaceCamera`, `0x40ffe0`) for a sphere in view space: 1 is outside, 3 crosses a
 * plane, 4 is wholly inside. A room's also drops what covers under a pixel (rank 2), which isn't
 * built: M8's.
 */
export const classifySphere = (
  { x, y, z }: Vector3,
  radius: number,
  { fovh, near, far }: Camera,
  aspect: number,
): 1 | 3 | 4 => {
  const nearEdge = -z - radius
  const farEdge = radius - z
  if (farEdge < near || nearEdge > far) return 1
  const tanX = Math.tan((fovh * Math.PI) / 180)
  const tanY = tanX / aspect
  const distanceX = (Math.abs(x) + tanX * z) / Math.hypot(1, tanX)
  const distanceY = (Math.abs(y) + tanY * z) / Math.hypot(1, tanY)
  if (distanceX > radius || distanceY > radius) return 1
  return nearEdge < near || farEdge > far || distanceX > -radius || distanceY > -radius ? 3 : 4
}

/** Whether a sphere in view space can reach the frustum. */
export const sphereInFrustum = (
  center: Vector3,
  radius: number,
  camera: Camera,
  aspect: number,
): boolean => classifySphere(center, radius, camera, aspect) >= 3

/**
 * RP8 flips view Z and applies a left-handed D3D projection (`FDirectX8::SetPerspective`). For a GL
 * clip space that comes to this plain right-handed perspective: no axis is negated, and z / w maps
 * onto the same window depth as D3D's. `hvaspect` never reaches the screen, so aspect is the viewport's.
 */
export const projectionMatrix = ({ fovh, near, far }: Camera, aspect: number): Matrix4 => {
  const scaleY = aspect / Math.tan((fovh * Math.PI) / 180)
  const depth = far - near
  return {
    x: { x: scaleY / aspect, y: 0, z: 0, w: 0 },
    y: { x: 0, y: scaleY, z: 0, w: 0 },
    z: { x: 0, y: 0, z: -(far + near) / depth, w: -1 },
    w: { x: 0, y: 0, z: (-2 * far * near) / depth, w: 0 },
  }
}
