/**
 * Retail's own arithmetic where several subsystems share it: the fast inverse square root, its
 * random points on and in a sphere, and colour channels truncated to a byte. Each copy in the
 * executable rounds as this does; the library's generic versions would change the picture.
 */
import type { Vector3 } from '@treewyrm/freelancer/math'
import type { Random } from './lightning.js'

const f = Math.fround

/** `rand()`'s 0 to 32767 onto [0, 1), as the executables scale it: 1 / 32768. */
export const RAND_UNIT = 3.0517578125e-5

/** 2π as a float. */
export const TWO_PI = 6.2831854820251465

const floats = new Float32Array(1)
const bits = new Int32Array(floats.buffer)

/** `1 / √squared` from the `0x5f3759df` estimate and one Newton step, left unrounded (`FUN_00507e70`). */
export const inverseRoot = (squared: number): number => {
  floats[0] = squared
  bits[0] = 0x5f3759df - (bits[0]! >> 1)

  const estimate = floats[0]!

  return (1.5 - estimate * estimate * squared * 0.5) * estimate
}

/** `random_inside_sphere` (`0x631dc50`): uniform direction (cos θ, φ uniform) at radius ∛u. */
export const insideSphere = (random: Random, radius: number): Vector3 => {
  const scaled = f(Math.pow(random() * RAND_UNIT, 1 / 3) * radius)
  const cos = random() * RAND_UNIT * 2 - 1
  const sin = f(Math.sin(Math.acos(cos)) * scaled)
  const phi = random() * RAND_UNIT * TWO_PI

  return { x: f(Math.sin(phi) * sin), y: f(f(cos) * scaled), z: f(Math.cos(phi) * sin) }
}

/** `random_on_unit_sphere` (`0x631db80`). */
export const onSphere = (random: Random): Vector3 => {
  const u1 = f(random() * RAND_UNIT)
  const u2 = f(random() * RAND_UNIT)
  const cos = Math.min(Math.max(f(u1 + u1 - 1), -1), 1)
  const theta = Math.acos(cos)
  const phi = u2 * TWO_PI
  const sin = Math.sin(theta)

  return { x: f(Math.sin(phi) * sin), y: f(Math.cos(theta)), z: f(Math.cos(phi) * sin) }
}

/** Truncated toward zero and held to a byte. */
export const clampByte = (value: number): number => Math.min(Math.max(Math.trunc(value), 0), 255)

/** A unit channel as a byte: times 255 on the FPU, truncated, held. */
export const unitByte = (value: number): number => clampByte(value * 255)

/** {@link unitByte} with the product rounded to a float first. */
export const unitByteRounded = (value: number): number => clampByte(f(value * 255))
