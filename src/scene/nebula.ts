/**
 * A system's nebulae as the frame sees them: which one the camera answers to, and the fog and ambient
 * each gives what it holds. `FNebulaEffect` in `src/freelancer/Client/cli_nebula.cpp`, `ZONE` in
 * `src/Common/common_zone.cpp`. Pure, no GL.
 */
import { Quat, type Shape, type Vector3 } from '@treewyrm/freelancer/math'

/** What a nebula asks of its zone: `IZone`'s position, `GetRadius` and `GetRadiusAlong`. */
export interface Zone {
  position: Vector3
  /** The sphere around it. */
  radius: number
  /** From its centre to its surface along a unit direction in world space. */
  radiusAlong: (direction: Vector3) => number
}

/** A system's `[Nebula]`: its zone, and what its file's `[Fog]` and `[NebulaLight]` say. */
export interface SpaceNebula {
  zone: Zone
  fog: {
    /** `near`, 0 when absent. */
    near?: number
    /** `distance`, `limits.nebulaFogDistance` when absent. */
    distance?: number
    /** `color` over 255, each kept below 1 (`ParseFogSection`). */
    color: Vector3
  }
  /** `[NebulaLight] ambient`, as written, 0 to 255. */
  ambient?: Vector3
}

/** What retail hardcodes about nebulae, and a mod can patch. */
export interface NebulaLimits {
  /** A `[Fog]` with no `distance` (`FNebulaEffect::Load`). */
  nebulaFogDistance: number
  /** Past the fog's end, the far plane in a core (`FogFarClamp`, `0x5d9668`). */
  nebulaFarMargin: number
  /** The least far plane in a core (`+0x2bc`, set by `FNebulaEffect`'s constructor). */
  nebulaLeastFar: number
}

export const RETAIL_NEBULA_LIMITS: Readonly<NebulaLimits> = {
  nebulaFogDistance: 10000,
  nebulaFarMargin: 500,
  nebulaLeastFar: 5000,
}

/** D3D's linear fog: none nearer than `start`, all of `color` from `end`. */
export interface Fog {
  /** 0 to 1, whole bytes. */
  color: Vector3
  start: number
  end: number
}

const f = Math.fround

const sub = (a: Vector3, b: Vector3): Vector3 => ({
  x: f(a.x - b.x),
  y: f(a.y - b.y),
  z: f(a.z - b.z),
})

const scaled = ({ x, y, z }: Vector3, by: number): Vector3 => ({
  x: f(x * by),
  y: f(y * by),
  z: f(z * by),
})

/** `ZONE::GetRadius` and `GetRadiusAlong` for each shape the game knows. */
export const zoneOf = (shape: Shape): Zone => {
  const position = shape.center
  if (shape.type === 'sphere') {
    const radius = f(shape.radius)
    return { position, radius, radiusAlong: () => radius }
  }
  // `EngineTransposeTransform`: the direction in the zone's own frame.
  const inverse = Quat.conjugate(shape.orientation)
  const local = (direction: Vector3) => Quat.transform(direction, inverse)

  if (shape.type === 'ellipsoid') {
    const { x, y, z } = shape.radii
    const a = x * x
    const b = y * y
    const c = z * z
    return {
      position,
      radius: f(Math.max(x, y, z)),
      // `EllipsoidRadiusAlong` (`0x633dc90`).
      radiusAlong: (direction) => {
        const d = local(direction)
        const sum = d.x * d.x * c * b + d.z * d.z * b * a + d.y * d.y * c * a
        const product = a * (c * b) * sum
        return product > 1e-4 ? Math.sqrt(product) / sum : 0
      },
    }
  }

  if (shape.type === 'box') {
    const { x, y, z } = shape.size
    const along = (size: number, component: number) => {
      const magnitude = Math.abs(component)
      return magnitude > f(1e-4) ? size / magnitude : f(1e10)
    }
    return {
      position,
      radius: f(Math.sqrt(x * x + y * y + z * z) * 0.5),
      radiusAlong: (direction) => {
        const d = local(direction)
        return Math.min(f(along(x, d.x)), along(y, d.y), f(along(z, d.z))) * 0.5
      },
    }
  }

  // A cylinder's height is its `size` y and a ring's its z, and only the outer radius counts.
  const { radius } = shape
  const half = shape.height * 0.5
  const cutoff = half / Math.sqrt(radius * radius + half * half)
  return {
    position,
    radius: f(Math.sqrt(radius * radius + half * half)),
    radiusAlong: (direction) => {
      const d = local(direction)
      const y = Math.abs(d.y)
      return y > cutoff ? half / y : radius / Math.sqrt(d.x * d.x + d.z * d.z)
    },
  }
}

/** `FNebulaEffect::ZoneExteriorFactor`: 0 outside, rising to 1 a fog distance in from its surface. */
export const exteriorFactor = (zone: Zone, distance: number, point: Vector3): number => {
  const offset = sub(point, zone.position)
  const squared = f(offset.x * offset.x + offset.z * offset.z + offset.y * offset.y)
  if (squared > zone.radius * zone.radius) return 0
  if (squared < 0.1) return 1
  const length = Math.sqrt(squared)
  const edge = zone.radiusAlong(scaled(offset, 1 / length)) - f(length)
  if (edge < 0) return 0
  if (f(edge) > distance) return 1
  return f(f(edge) / distance)
}

/** What `FNebulaEffect::Update` keeps from where the camera is, each frame. */
export interface NebulaState {
  nebula: SpaceNebula
  fogDistance: number
  /** `+0x294`: how deep the camera is, over the fog's whole span, up to 1. */
  depth: number
  /** `+0x2ac`, the fog's start. */
  start: number
  /** `+0x2b0`, the fog's end. */
  end: number
}

/** `FNebulaEffect::Update`'s depth and fog range, before an exclusion zone moves the end. */
export const nebulaState = (
  nebula: SpaceNebula,
  eye: Vector3,
  limits: NebulaLimits = RETAIL_NEBULA_LIMITS,
): NebulaState => {
  const { zone, fog } = nebula
  const near = f(fog.near ?? 0)
  const fogDistance = f(fog.distance ?? limits.nebulaFogDistance)
  const offset = sub(eye, zone.position)
  const length = f(Math.sqrt(offset.y * offset.y + offset.z * offset.z + offset.x * offset.x))
  const span = f(fogDistance + near)
  const surface = f(length - zone.radiusAlong(scaled(offset, 1 / length)))
  const depth = surface > 0 ? 0 : -surface > span ? 1 : f(-surface / span)
  if (depth > 0) return { nebula, fogDistance, depth, start: near, end: span }
  // Outside, the fog's range follows the camera's distance from the surface.
  const start = surface + near
  return { nebula, fogDistance, depth, start: f(start), end: f(start + fogDistance) }
}

/** `FNebulaEffect::FogFactor`: where the fog ends for what stands at `point`. */
export const fogEnd = (state: NebulaState, point: Vector3): number => {
  const factor = exteriorFactor(state.nebula.zone, state.fogDistance, point)
  if (!(factor < 1)) return state.end
  return f(state.end / Math.max(factor * factor, f(1e-4)))
}

/** `FNebulaEffect::FogFarClamp`: the pass's far plane in its core, before the system's cuts it. */
export const fogFar = (state: NebulaState, limits: NebulaLimits = RETAIL_NEBULA_LIMITS): number => {
  const sum = state.end + limits.nebulaFarMargin
  return sum < limits.nebulaLeastFar ? limits.nebulaLeastFar : f(sum)
}

// `FogApplyColorAndRange`: each channel to a byte, by truncation.
const byte = (value: number) => Math.min(Math.max(Math.trunc(value * 255), 0), 255) / 255

/** The fog `FogApplyColorAndRange` sets, in `colour` or the nebula's own. */
export const fogOf = (start: number, end: number, color: Vector3): Fog => ({
  color: { x: byte(color.x), y: byte(color.y), z: byte(color.z) },
  start,
  end,
})

/** The nebula a point is in, and how far, from 0 to 1: `Gameobj`'s `+0x38` and `+0x3c`. */
export interface Within {
  state: NebulaState
  factor: number
}

/** `StarSysFindNebula` (`0x5553b0`), without a hint: the first nebula that holds `point`. */
export const findNebula = (nebulae: readonly NebulaState[], point: Vector3): Within | undefined => {
  for (const state of nebulae) {
    const factor = exteriorFactor(state.nebula.zone, state.fogDistance, point)
    if (factor > 0) return { state, factor }
  }
  return undefined
}

/** The nebula the camera answers to (`DAT_00675244`), and how far it's in. */
export interface SpaceField {
  state: NebulaState
  /** `DAT_0067524c`: 0 outside it, 1 in its edge, 2 in its core. */
  enclosure: 0 | 1 | 2
}

const floats = new Float32Array(1)
const bits = new Int32Array(floats.buffer)

// The distance by one Newton step from `0x5f3759df`, as `SelectFieldControllers` has it.
const roughLength = (squared: number): number => {
  floats[0] = squared
  bits[0] = 0x5f3759df - (bits[0]! >> 1)
  const estimate = floats[0]!
  return f((1.5 - estimate * estimate * squared * 0.5) * estimate * squared)
}

/**
 * `SelectFieldControllers` (`0x51b730`): the first nebula the camera is in, taking a core over an
 * edge, or else the one whose surface is nearest within `range`.
 */
export const pickField = (
  nebulae: readonly NebulaState[],
  eye: Vector3,
  range: number,
): SpaceField | undefined => {
  let best = f(range * range)
  let field: SpaceField | undefined
  for (const state of nebulae) {
    if (field && field.enclosure !== 0) continue
    const { zone } = state.nebula
    const dx = zone.position.x - eye.x
    const dy = zone.position.y - eye.y
    const dz = zone.position.z - eye.z
    const squared = dx * dx + dy * dy + dz * dz
    const distance = roughLength(squared)
    const inverse = f(1 / distance)
    const hit = f(zone.radiusAlong({ x: f(inverse * dx), y: f(inverse * dy), z: f(inverse * dz) }))
    const score = distance <= hit ? 0 : f((distance - hit) * (distance - hit))

    const enclosed = exteriorFactor(zone, state.fogDistance, eye)
    if (enclosed >= 1) return { state, enclosure: 2 }
    if (enclosed > 0) field = { state, enclosure: 1 }
    else if (score < best) {
      best = score
      field = { state, enclosure: 0 }
    }
  }
  return field
}
