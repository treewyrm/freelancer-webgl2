/**
 * Lights and fog as thorn holds them (`LoadLightProps`, `ApplyLightEventPost`, `EvalLightProps`,
 * `TickFogPropAnim` in `src/Thorn/`), and as the game's hosts hand them to the room
 * (`gf_thorn_light.cpp`, `GfFog*` in `gf_script.cpp`).
 */
import { Vector3 } from '@treewyrm/freelancer/math'
import { data, type FogProps, type LightProps } from '@treewyrm/freelancer/thn/scene'
import type { Fog } from '#/scene/nebula.js'
import type { RoomLight } from '#/scene/room.js'
import { rotate, type Frame } from './frame.js'

const f = Math.fround
const RADIANS = Math.PI / 180

/** `kThornLightBit*`: which of a block's keys were given. */
export const LIGHT_BITS = {
  color: 0x1,
  direction: 0x2,
  range: 0x4,
  cutoff: 0x8,
  on: 0x10,
  infinite: 0x20,
  atten: 0x40,
  theta: 0x80,
  type: 0x100,
  specular: 0x200,
  ambient: 0x400,
  diffuse: 0x800,
} as const

/** A light block: the legacy keys and the `D3DLIGHT8` beside them. Angles in radians. */
export interface LightState {
  on: boolean
  infinite: boolean
  /** Whole numbers, 0 to 255, which reach nothing once there is a `type`. */
  color: Vector3
  /** In the light's own axes. */
  direction: Vector3
  /** `D3DLIGHTTYPE`: 1 point, 2 spot, 3 directional. */
  type: number
  diffuse: Vector3
  specular: Vector3
  ambient: Vector3
  range: number
  atten: Vector3
  theta: number
  /** `cutoff`, as D3D's `Phi`. */
  phi: number
}

/** `FUN_06f41840`: a white spot, range 1000, theta 144°, phi 180°, `Att2` 100 over range². */
export const DEFAULT_LIGHT: LightState = {
  on: true,
  infinite: false,
  color: { x: 255, y: 255, z: 255 },
  direction: { x: 0, y: 0, z: 1 },
  type: 2,
  diffuse: { x: 1, y: 1, z: 1 },
  specular: Vector3.zero,
  ambient: Vector3.zero,
  range: 1000,
  atten: { x: 0, y: 0, z: f(0.0001) },
  theta: f(2.5132741),
  phi: f(Math.PI),
}

const truth = (name: string | undefined) => name === 'Y'

const ints = ({ x, y, z }: Vector3): Vector3 => ({
  x: Math.trunc(x),
  y: Math.trunc(y),
  z: Math.trunc(z),
})

/** `LoadLightProps` (`FUN_06f27fe0`): the keys a block gives, over `base`, and their mask. */
export const readLight = (
  props: LightProps,
  base: LightState,
): { light: LightState; mask: number } => {
  const light = { ...base }
  let mask = 0
  if (props.on !== undefined) ((light.on = truth(props.on)), (mask |= LIGHT_BITS.on))
  if (props.color) ((light.color = ints(props.color)), (mask |= LIGHT_BITS.color))
  if (props.diffuse) ((light.diffuse = props.diffuse), (mask |= LIGHT_BITS.diffuse))
  if (props.specular) ((light.specular = props.specular), (mask |= LIGHT_BITS.specular))
  if (props.ambient) ((light.ambient = props.ambient), (mask |= LIGHT_BITS.ambient))
  if (props.direction) ((light.direction = props.direction), (mask |= LIGHT_BITS.direction))
  if (props.atten) ((light.atten = props.atten), (mask |= LIGHT_BITS.atten))
  if (props.type) ((light.type = data.LIGHT_TYPES[props.type]), (mask |= LIGHT_BITS.type))
  if (props.range !== undefined) ((light.range = f(props.range)), (mask |= LIGHT_BITS.range))

  if (props.cutoff !== undefined)
    ((light.phi = f(props.cutoff * RADIANS)), (mask |= LIGHT_BITS.cutoff))

  if (props.theta !== undefined)
    ((light.theta = f(props.theta * RADIANS)), (mask |= LIGHT_BITS.theta))

  return { light, mask }
}

/**
 * An entity's light: the record over the defaults. Only with no `type` does thorn derive the
 * `D3DLIGHT8` from the legacy keys (`0x6f29492`, `0x6f2eb20`): infinite directional, a negative
 * cutoff a point, else a spot; diffuse the colour over 255, `Att (1, 0, 4/range²)`, twice the range.
 * Every retail light has a `type`. That rule is the extension's reading, not traced here.
 */
export const lightOf = (props: LightProps | undefined): LightState => {
  const { light, mask } = readLight(props ?? {}, DEFAULT_LIGHT)
  if (mask & LIGHT_BITS.type) return light

  const cutoff = light.phi / RADIANS
  const theta = Math.min(light.phi, Math.PI)

  return {
    ...light,
    type: light.infinite ? 3 : cutoff < 0 ? 1 : 2,
    diffuse: Vector3.multiplyScalar(light.color, 1 / 255),
    specular: Vector3.zero,
    ambient: Vector3.zero,
    atten: { x: 1, y: 0, z: 4 / (light.range * light.range) },
    range: 2 * light.range,
    theta,
    phi: Math.min(1.1 * theta, Math.PI),
  }
}

/**
 * A `START_LIGHT_PROP_ANIM`'s block (`ApplyLightEventPost`, `FUN_06f24b40`): `color` also sets the
 * diffuse at a 255th, `infinite` the type, and a negative cutoff makes a point light.
 */
export const readLightTarget = (props: LightProps): { light: LightState; mask: number } => {
  const { light, mask } = readLight(props, DEFAULT_LIGHT)
  let out = mask

  if (out & LIGHT_BITS.color) {
    light.diffuse = Vector3.multiplyScalar(light.color, f(1 / 255))
    out |= LIGHT_BITS.diffuse
  }

  if (out & LIGHT_BITS.cutoff && light.phi < 0) {
    light.type = 1
    light.phi = 0
    light.theta = 0
    out |= LIGHT_BITS.type
  }

  return { light, mask: out }
}

const lerp = (a: number, b: number, u: number) => f(a + (b - a) * u)
const lerp3 = (a: Vector3, b: Vector3, u: number): Vector3 => ({
  x: lerp(a.x, b.x, u),
  y: lerp(a.y, b.y, u),
  z: lerp(a.z, b.z, u),
})

/**
 * `EvalLightProps`: each masked field from `from` toward `to` by `u`, unclamped; the colour truncated
 * to whole numbers; `on`, `type` and `infinite` switch only once `u` reaches 1. The direction is
 * lerped and not renormalised.
 */
export const blendLight = (
  current: LightState,
  from: LightState,
  to: LightState,
  mask: number,
  u: number,
): LightState => {
  const out = { ...current }
  const done = u >= 1

  if (mask & LIGHT_BITS.range) out.range = lerp(from.range, to.range, u)
  if (mask & LIGHT_BITS.cutoff) out.phi = lerp(from.phi, to.phi, u)
  if (mask & LIGHT_BITS.type && done) out.type = to.type
  if (mask & LIGHT_BITS.theta) out.theta = lerp(from.theta, to.theta, u)
  if (mask & LIGHT_BITS.specular) out.specular = lerp3(from.specular, to.specular, u)
  if (mask & LIGHT_BITS.ambient) out.ambient = lerp3(from.ambient, to.ambient, u)
  if (mask & LIGHT_BITS.diffuse) out.diffuse = lerp3(from.diffuse, to.diffuse, u)
  if (mask & LIGHT_BITS.atten) out.atten = lerp3(from.atten, to.atten, u)
  if (mask & LIGHT_BITS.color) out.color = ints(lerp3(from.color, to.color, u))
  if (mask & LIGHT_BITS.infinite && done) out.infinite = to.infinite
  if (mask & LIGHT_BITS.direction) out.direction = lerp3(from.direction, to.direction, u)
  if (mask & LIGHT_BITS.on && done) out.on = to.on
  return out
}

/**
 * The room's light for a THN light (`Thorn_Light`, `0x452fa0`, and `GameLight::set_d3d`, `0x411120`):
 * at thorn's position, `C` not applied, shining along its frame's turn of `direction`. A point's
 * cone is a whole sphere; a phi past π is π; no attenuation at all is 0.1 constant. Its type is the
 * one it was made with: a later change is ignored. `lt_grp` picks what it lights.
 */
export const roomLightOf = (
  light: LightState,
  madeAs: number,
  frame: Frame,
  group: number,
): RoomLight => {
  const direction = Vector3.normalize(rotate(frame, light.direction))
  const zero = light.atten.x === 0 && light.atten.y === 0 && light.atten.z === 0
  const point = madeAs === 1

  return {
    group,
    color: light.diffuse,
    direction,
    ...(light.ambient.x || light.ambient.y || light.ambient.z ? { ambient: light.ambient } : {}),
    ...(madeAs !== 3 && {
      position: { x: frame.w.x, y: frame.w.y, z: frame.w.z },
      range: light.range,
      attenuation: zero ? { x: f(0.1), y: 0, z: 0 } : light.atten,
      ...(!point && {
        spot: { theta: light.theta, phi: Math.min(light.phi, f(Math.PI)), falloff: 1 },
      }),
    }),
  }
}

/** `GfFog`'s one global state, which every script's `SCENE` shares. Zeroed at room setup. */
export interface FogState {
  on: boolean
  /** `fogtable` as passed: true writes `FOGTABLEMODE`, so `Y` is table fog and `N` vertex fog. */
  table: boolean
  /** Whole numbers, 0 to 255. */
  color: Vector3
  /** `D3DFOGMODE`: 0 none, 1 exp, 2 exp2, 3 linear. */
  mode: number
  start: number
  end: number
  density: number
}

export const NO_FOG: FogState = {
  on: false,
  table: false,
  color: Vector3.zero,
  mode: 0,
  start: 0,
  end: 0,
  density: 0,
}

/** A `fogprops` block's values and mask (`0x6f27c50`): on 1, table 2, colour 4, mode 8, then 0x10–0x40. */
export const readFog = (props: FogProps): { fog: FogState; mask: number } => {
  const fog = { ...NO_FOG }
  let mask = 0
  if (props.fogon !== undefined) ((fog.on = truth(props.fogon)), (mask |= 1))
  if (props.fogtable !== undefined) ((fog.table = truth(props.fogtable)), (mask |= 2))
  if (props.fogcolor) ((fog.color = ints(props.fogcolor)), (mask |= 4))
  if (props.fogmode) ((fog.mode = data.FOG_MODES[props.fogmode]), (mask |= 8))
  if (props.fogstart !== undefined) ((fog.start = f(props.fogstart)), (mask |= 0x10))
  if (props.fogend !== undefined) ((fog.end = f(props.fogend)), (mask |= 0x20))
  if (props.fogdensity !== undefined) ((fog.density = f(props.fogdensity)), (mask |= 0x40))
  return { fog, mask }
}

/** `TickFogPropAnim`: on, table and mode switch at `u ≥ 1`; the rest lerp, the colour truncated. */
export const blendFog = (
  current: FogState,
  from: FogState,
  to: FogState,
  mask: number,
  u: number,
): FogState => {
  const out = { ...current }

  if (u >= 1) {
    if (mask & 1) out.on = to.on
    if (mask & 2) out.table = to.table
    if (mask & 8) out.mode = to.mode
  }

  if (mask & 0x10) out.start = lerp(from.start, to.start, u)
  if (mask & 0x20) out.end = lerp(from.end, to.end, u)
  if (mask & 0x40) out.density = lerp(from.density, to.density, u)
  if (mask & 4) out.color = ints(lerp3(from.color, to.color, u))
  return out
}

const MODES = { 1: 'exp', 2: 'exp2', 3: 'linear' } as const

/**
 * The room's fog (`GfFogApply`, `0x454250`): when on and the `fog` option is, in D3D's mode. Per pixel
 * here whichever of vertex and table fog the script asks for.
 */
export const roomFogOf = (fog: FogState, enabled = true): Fog | undefined => {
  const mode = MODES[fog.mode as 1 | 2 | 3]
  if (!fog.on || !enabled || !mode) return undefined
  return {
    color: Vector3.multiplyScalar(fog.color, 1 / 255),
    start: fog.start,
    end: fog.end,
    mode,
    density: fog.density,
  }
}
