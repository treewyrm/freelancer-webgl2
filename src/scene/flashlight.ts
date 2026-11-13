/**
 * A base room's flashlights: `FFlashLight` in `src/freelancer/Client/flash_light.cpp`, the blinking
 * lights a prop's or ship's `[Light]` equipment carries and a room's `[FlashlightSet]` lines up, and
 * `DrawFlashlightFlares` (`FUN_00558000`), which draws each as two camera-facing quads. Pure, no GL.
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import { Primitive, setMapCount, VertexFormat, type VMeshData } from '@treewyrm/freelancer/vmesh'
import { DEFAULT_SAMPLER } from '#/texture/texture.js'
import type { Camera } from './camera.js'
import { LightBlink, type FlareLight } from './flare.js'
import type { Draw } from './frame.js'
import type { Random } from './lightning.js'
import { inverseRoot, unitByte } from './retail.js'

const f = Math.fround
const BLACK: Vector3 = { x: 0, y: 0, z: 0 }
const DEGREES = f(0.017453292)

/** A `[FlashlightSet]` or `[FlashlightLine]` from a room's INI. The host reads it. */
export interface FlashlightSet {
  /** `color`, or `icolor` over 255. */
  color: Vector3
  /** The glow's half-size; the bulb's is a quarter of it. */
  scale: number
  /** Seconds between one light's blink and the next's. */
  gap: number
  /** How long each blink lasts. */
  blink: number
  /** The pause after the last light's, before the first's again. */
  endpause: number
}

/** One light: its colours, sizes and cone, its blink, and where the host has put it. */
export class FlashLight {
  readonly color: Vector3
  readonly minColor: Vector3
  readonly bulbSize: number
  readonly glowSize: number
  /** `flare_cone`'s cosines: the glow's gone below `inner`, and whole from `outer`. */
  readonly cone: { inner: number; outer: number }
  readonly blink: LightBlink
  /** Its hardpoint's frame in the world, which the host keeps up to date (`FUN_00558470`). */
  world: Matrix4 = Matrix4.identity
  /** The bulb's colour, `min_color` to `color` with the blink, and the glow's, black to `color`. */
  bulbColor: Vector3
  glowColor: Vector3

  constructor(
    color: Vector3,
    minColor: Vector3,
    bulbSize: number,
    glowSize: number,
    cone: { inner: number; outer: number },
    blink: LightBlink,
  ) {
    this.color = color
    this.minColor = minColor
    this.bulbSize = bulbSize
    this.glowSize = glowSize
    this.cone = cone
    this.blink = blink
    this.bulbColor = color
    this.glowColor = color
  }

  /**
   * A `[Light]` on a prop or ship (`FUN_00557700`), `always_on` and with a hardpoint. Its glow is
   * `color`'s, not `glow_color`'s, and its period and phase are drawn from `rand()`.
   */
  static fromLight(light: FlareLight, random?: Random): FlashLight {
    const [first, second] = light.flareCone ?? []
    // `0x40adea`: each by `DAT_005c77f4`, the second's cosine first. -1 each when absent.
    const cos = (degrees: number | undefined) =>
      degrees === undefined ? -1 : f(Math.cos(f(degrees) * DEGREES))

    return new FlashLight(
      light.color,
      light.minColor,
      f(light.bulbSize),
      f(light.glowSize),
      { inner: cos(first), outer: cos(second) },
      new LightBlink(light, random),
    )
  }

  /** `RoomControlLoadFlashlights` (`FUN_0044a3a0`): one light per frame, staggered by `gap`. */
  static ofSet({ color, scale, gap, blink, endpause }: FlashlightSet, frames: readonly Matrix4[]) {
    const count = frames.length
    const period = f((count - 1) * f(gap) + f(endpause))
    const step = period > 0 ? f(f(gap) / period) : 0

    return frames.map((world, index) => {
      const light = new FlashLight(
        color,
        BLACK,
        f(f(scale) * 0.25),
        f(scale),
        { inner: 0, outer: 0 },
        LightBlink.timed(period, -(index * step), blink),
      )

      light.world = world
      return light
    })
  }

  /** `FUN_00557860`: the blink advanced by `step` seconds, and both colours made from it. */
  update(step: number): void {
    this.blink.tick(step)

    const level = this.blink.brightness
    const { color, minColor } = this

    this.glowColor = { x: f(level * color.x), y: f(level * color.y), z: f(level * color.z) }
    this.bulbColor = {
      x: f(f(color.x - minColor.x) * level + minColor.x),
      y: f(f(color.y - minColor.y) * level + minColor.y),
      z: f(f(color.z - minColor.z) * level + minColor.z),
    }
  }
}

// `FUN_00557d00`: the fast inverse square root and one Newton step.
const normalizeFast = ({ x, y, z }: Vector3): Vector3 => {
  const scale = inverseRoot(f(x * x + y * y + z * z))

  return { x: f(scale * x), y: f(scale * y), z: f(scale * z) }
}

/** `FUN_005579b0`'s cone term: 1 inside `outer`, 0 past `inner`, a ramp between. */
export const coneLevel = (light: FlashLight, eye: Vector3): number => {
  const { inner, outer } = light.cone
  if (!(outer > inner)) return 1

  const { z: axis, w: position } = light.world
  const dir = normalizeFast({
    x: f(position.x - eye.x),
    y: f(position.y - eye.y),
    z: f(position.z - eye.z),
  })
  const wide = dir.z * axis.z + dir.y * axis.y + dir.x * axis.x
  if (wide < inner) return 0

  const dot = f(wide)

  return dot < outer ? (dot - inner) / (outer - inner) : 1
}

// `FUN_00421ad0`: times 255, truncated, clamped. Alpha is 255.
const colourBytes = ({ x, y, z }: Vector3): number[] => {
  const byte = unitByte

  return [byte(z), byte(y), byte(x), 255]
}

// XYZ, D3DCOLOR and one UV set: FVF 0x142, 24 bytes, as Win3D's immediate mode draws.
const FORMAT = setMapCount(VertexFormat.Position | VertexFormat.Diffuse, 1)
const STRIDE = 24
// Win3D's quads, triangulated `(0, 1, 2)` and `(0, 2, 3)`.
const ORDER = [0, 1, 2, 0, 2, 3]
const UVS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]

interface Flare {
  center: Vector3
  size: number
  color: Vector3
}

const isBlack = ({ x, y, z }: Vector3) => x === 0 && y === 0 && z === 0

// One pass of `DrawFlashlightFlares`: a quad per light, `Center ∓ R ± U` as `EmitFlareQuad` rounds them.
const passDraw = (name: string, flares: Flare[], right: Vector3, up: Vector3, texture: Texture) => {
  const count = flares.length * ORDER.length
  const vertices = new Uint8Array(count * STRIDE)
  const floats = new Float32Array(vertices.buffer)

  flares.forEach(({ center: c, size, color }, index) => {
    const r = { x: f(right.x * size), y: f(right.y * size), z: f(right.z * size) }
    const u = { x: f(up.x * size), y: f(up.y * size), z: f(up.z * size) }
    const left = { x: f(c.x - r.x), y: f(c.y - r.y), z: f(c.z - r.z) }
    const edge = { x: f(c.x + r.x), y: f(c.y + r.y), z: f(c.z + r.z) }
    const corners = [
      [f(left.x + u.x), f(left.y + u.y), f(left.z + u.z)],
      [f(u.x + edge.x), f(u.y + edge.y), f(u.z + edge.z)],
      [f(edge.x - u.x), f(edge.y - u.y), f(edge.z - u.z)],
      [f(c.x - r.x - u.x), f(c.y - r.y - u.y), f(left.z - u.z)],
    ]
    const bytes = colourBytes(color)

    ORDER.forEach((corner, at) => {
      const offset = (index * ORDER.length + at) * STRIDE

      floats.set(corners[corner]!, offset / 4)
      vertices.set(bytes, offset + 12)
      floats.set(UVS[corner]!, (offset + 16) / 4)
    })
  })

  const mesh: VMeshData = {
    name,
    version: 1,
    primitive: Primitive.TriangleList,
    format: FORMAT,
    groups: [
      { materialId: 0, vertexStart: 0, vertexEnd: count - 1, elementCount: count, padding: 0 },
    ],
    indices: Uint16Array.from({ length: count }, (_, at) => at),
    vertices,
  }
  const draw: Draw = {
    mesh,
    reference: {
      meshId: 0,
      vertexStart: 0,
      vertexCount: count,
      indexStart: 0,
      indexCount: count,
      groupStart: 0,
      groupCount: 1,
      boundingBox: { min: BLACK, max: BLACK },
      boundingSphere: { center: BLACK, radius: 0 },
    },
    transient: true,
    byteOffset: 0,
    count,
    world: Matrix4.identity,
    materialName: name,
    diffuse: [1, 1, 1, 1],
    ambient: BLACK,
    emissive: BLACK,
    colorVertex: true,
    nomad: false,
    texture: { name, entry: texture, sampler: DEFAULT_SAMPLER, uvSet: 0 },
    cull: 'none',
    depthWrite: false,
    depthFunc: 'lequal',
    lightless: true,
    negateNormals: false,
    normalizeNormals: false,
    blend: true,
    blendMode: 'add',
    unlit: true,
    // The alpha test is the device's as the last draw left it, taken as off: uncaptured.
    alphaReference: 0,
    alphaFunction: 'always',
  }

  return draw
}

/** `fx/efx.txm`'s `shine` and `bulb`. */
export interface FlashlightTextures {
  shine: Texture
  bulb: Texture
}

/** At most this many of a prop's or ship's lights draw (`FUN_00558580`); a room's own aren't held to it. */
export const FLASHLIGHTS_PER_SET = 0x20

/**
 * `DrawFlashlightFlares`: every glow, then every bulb, each a quad facing the camera, added, `LEQUAL`
 * without writing depth, no culling and no fog. A black one is left out.
 */
export const flashlightDraws = (
  lights: readonly FlashLight[],
  camera: Camera,
  { shine, bulb }: FlashlightTextures,
): Draw[] => {
  if (lights.length === 0) return []

  const { x: right, y: up } = Matrix4.fromRotationTranslation(camera.orientation)
  const centre = (light: FlashLight) => light.world.w
  const glows: Flare[] = []
  const bulbs: Flare[] = []

  for (const light of lights) {
    if (!isBlack(light.glowColor)) {
      const level = f(coneLevel(light, camera.position))
      const { x, y, z } = light.glowColor

      glows.push({
        center: centre(light),
        size: light.glowSize,
        color: { x: f(x * level), y: f(y * level), z: f(z * level) },
      })
    }

    if (!isBlack(light.bulbColor))
      bulbs.push({ center: centre(light), size: light.bulbSize, color: light.bulbColor })
  }

  return [
    ...(glows.length ? [passDraw('shine', glows, right, up, shine)] : []),
    ...(bulbs.length ? [passDraw('bulb', bulbs, right, up, bulb)] : []),
  ]
}
