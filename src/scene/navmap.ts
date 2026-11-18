/**
 * The navmap's own layer (`NeuroNetNavMap`, draw `0x4926d0`), laid on the system's plane for a plan
 * frame to draw under and over its models: the grid quad, the terrain, nebula and exclusion fills,
 * the trade lanes and the object icons. See the extension's docs/system/NAVMAP.md.
 *
 * **In world units, on the plane y = 0.** The game projects every nav position `(x·s, z·s)` onto a
 * square of 0.468 plane units for `±E`, `E = 112 000`; seen through a parallel camera straight down,
 * that is the world itself, +X right and −Z up. So a plane unit at zoom 1 is `E / (0.234·s)` metres
 * ({@link navmapUnit}), and the game's screen-sized quantities come out as world sizes here: an icon
 * is `60 × solar_radius` across at any zoom, a lane narrows as the map zooms in.
 *
 * **No depth, painter's order**, as the game draws it (`glDisable(GL_DEPTH_TEST)`): every draw tests
 * and writes nothing, blends `SRC_ALPHA, INV_SRC_ALPHA`, and lies where the list puts it. Pure, no GL.
 */
import { Matrix4, Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import type { Camera } from './camera.js'
import { viewMatrix } from './camera.js'
import {
  collectModel,
  RETAIL_FRAME_LIMITS,
  type Draw,
  type Frame,
  type FrameLimits,
  type SceneModel,
} from './frame.js'
import { immediateDraw, type ImmediateBatch } from './immediate.js'
import type { Zone } from './nebula.js'
import { DEFAULT_SAMPLER, type SamplerState } from '#/texture/texture.js'

/** `E`, the map's half-extent in nav units (`nav+0x4a8`, `0x48e2fe`). Icons are clamped to it. */
export const NAVMAP_HALF_EXTENT = 112_000

/**
 * What the navmap's viewport shows, in nav units either side: `±0.55·tan 27.216°` plane units against
 * the `±0.234` that `E` projects to.
 */
export const NAVMAP_VISIBLE = 135_384

/** The zoom-in's half-extent over `E` (`0x49f1a0`): a zoom of 8.6. */
export const NAVMAP_ZOOM_IN = 0.116279

const WHITE: Vector3 = { x: 1, y: 1, z: 1 }

/** The map square's half-side in plane units (`nav+0x418`). */
const HALF_SQUARE = 0.234

/** World metres per plane unit at zoom 1, in a system of `NavMapScale` `scale`. */
export const navmapUnit = (scale: number): number => NAVMAP_HALF_EXTENT / (HALF_SQUARE * scale)

/**
 * The game's zoom for a view that shows `half` metres either side across its shorter side: 1 where
 * that is the navmap's own map, 8.6 at its zoom-in.
 */
export const navmapZoom = (half: number, scale: number): number =>
  NAVMAP_VISIBLE / (scale * Math.max(1e-9, half))

/** Lays a model on the plane: its +X along world +X, its +Y along world −Z, its +Z up. */
const onPlane = (scale: number, angle = 0, position: Vector3 = Vector3.zero): Matrix4 => {
  const cos = Math.cos(angle) * scale
  const sin = Math.sin(angle) * scale

  return {
    x: { x: cos, y: 0, z: -sin, w: 0 },
    y: { x: -sin, y: 0, z: -cos, w: 0 },
    z: { x: 0, y: scale, z: 0, w: 0 },
    w: { x: position.x, y: position.y, z: position.z, w: 1 },
  }
}

/** The two copies of `zoomedmap_liberty.3db` (`0x490cd0`): the system view's, and the zoom-in's. */
export type NavmapGrid = 'system' | 'zoomed'

/**
 * Plane units per model unit (`0x4963d0`). The system copy stands behind the map plane, at −0.71 for
 * −0.55, scaled 1.5: so its texture's 8 cells fill the visible map. The zoomed copy lies on the plane
 * at 0.116279, its cells a tenth of those.
 */
const GRID_SCALE: Readonly<Record<NavmapGrid, number>> = {
  system: (1.5 * 0.55) / 0.71,
  zoomed: NAVMAP_ZOOM_IN,
}

/** Where a grid copy lies: centred on the system's origin, its quad facing up. */
export const navmapGridWorld = (grid: NavmapGrid, scale: number): Matrix4 =>
  onPlane(GRID_SCALE[grid] * navmapUnit(scale))

/** An object the navmap draws an icon for. */
export interface NavmapIcon {
  /** Where the object is. Its Y is dropped. */
  position: Vector3
  /** Its archetype's `solar_radius`, 500 where none is written. */
  radius: number
  /** A sun's icon is 1.2 times larger. */
  sun?: boolean
  /** A planet's or a moon's icon is turned so its +X points at the system's origin (`0x4919e9`). */
  turned?: boolean
}

/** Icons whose `solar_radius × s` is under this are skipped in the system view (`0x492c4b`). */
const SMALL_ICON = 550

/** Whether an icon is drawn: in the system view, not one too small to read; zoomed in, every one. */
export const navmapIconShown = ({ radius }: NavmapIcon, scale: number, zoomedIn: boolean) =>
  zoomedIn || radius * scale >= SMALL_ICON

/**
 * Where an icon's model stands (`0x496600`): at its object, pinned to the `±E/s` square, scaled
 * `b/2E · 0.468 · zoom · 60` plane units — `60 × solar_radius` metres, whatever the zoom — and a
 * sun's 1.2 times that. A planet or moon is turned by `acos(−x/r)`, mirrored past `−z/r > 0`.
 */
export const navmapIconWorld = (
  { position, radius, sun = false, turned = false }: NavmapIcon,
  scale: number,
): Matrix4 => {
  const edge = NAVMAP_HALF_EXTENT / scale
  const x = Math.min(edge, Math.max(-edge, position.x))
  const z = Math.min(edge, Math.max(-edge, position.z))
  const r = Math.hypot(position.x, position.z)
  let angle = 0

  if (turned && r > 0) {
    angle = Math.acos(Math.min(1, Math.max(-1, -position.x / r)))
    if (-position.z / r > 0) angle = 2 * Math.PI - angle
  }

  return onPlane(radius * 60 * (sun ? 1.2 : 1), angle, { x, y: 0, z })
}

/** Zone `property_flags` the navmap fills (`0x3ffc0`): terrain, nebula and exclusion. */
const FILLED = 0x3ffc0
const NEBULA = 0x8000
const EXCLUSION = 0x30000
const TERRAIN = 0x7fc0

/** The first matching bit's shape, from `0x40` up (`0x611c60`); `0x4000` matches and names none. */
const FILL_TEXTURES: readonly (readonly [number, string | undefined])[] = [
  [0x40, 'asteroidtest'],
  [0x80, 'nav_terrain_debris'],
  [0x100, 'nav_terrain_ice'],
  [0x200, 'nav_terrain_lava'],
  [0x400, 'nav_terrain_nomadast'],
  [0x800, 'nav_terrain_ice'],
  [0x1000, 'nav_terrain_mines'],
  [0x2000, 'nav_terrain_badlands'],
  [0x4000, undefined],
  [0x8000, 'dustcloud'],
]

/**
 * The shape a zone is filled with, from `navmaptextures.ini`: an exclusion's `dustcloud` over
 * everything, else the first matching bit's. Nothing for a zone the navmap does not fill.
 */
export const navmapFillTexture = (flags: number): string | undefined => {
  if (!(flags & FILLED)) return undefined
  if (flags & EXCLUSION) return 'dustcloud'

  return FILL_TEXTURES.find(([bit]) => flags & bit)?.[1]
}

/**
 * The fills' draw order (`0x4a0670`): nebulae that are not exclusions, in file order; then terrain,
 * ascending by flag value, so rock < debris < ice < lava < nomad < crystal < mines < badlands; then
 * exclusions, in file order. `sort` has no say. A zone in none of the three is left out.
 */
export const navmapFillOrder = <T extends { readonly flags: number }>(zones: readonly T[]): T[] => {
  const nebulae = zones.filter(({ flags }) => flags & NEBULA && !(flags & EXCLUSION))
  const terrain = zones
    .filter(({ flags }) => flags & TERRAIN && !(flags & (NEBULA | EXCLUSION)))
    .map((zone, at) => ({ zone, at }))
    .sort((a, b) => (a.zone.flags & TERRAIN) - (b.zone.flags & TERRAIN) || a.at - b.at)
    .map(({ zone }) => zone)
  const exclusions = zones.filter(({ flags }) => flags & EXCLUSION)

  return [...nebulae, ...terrain, ...exclusions]
}

/** A fill's alpha byte: 255 in the system view, 86 zoomed in, `191/zoom + 64` between (`0x49c260`). */
export const navmapFillAlpha = (zoom: number): number => Math.min(255, 191 / Math.max(1, zoom) + 64)

/** A zone to fill: its shape, its `property_flags`, and a nebula's `property_fog_color`, 0 to 1. */
export interface NavmapZone {
  zone: Zone
  flags: number
  fogColor?: Vector3
}

/** The outline's points (`0x5d3f04`): a step of 2π/32. */
const RIM = 32

/** One texture repeat across 0.09 plane units of the unzoomed map. */
const REPEAT = 0.09

/**
 * A zone's fill (`0x49b600`): a fan of 32 rim points and the centre, on the plane. A sphere is the
 * circle of `size.x` in its own X/Z, turned; an ellipsoid its horizontal section through the centre.
 * Nothing for any other shape, or a zone the navmap does not fill.
 *
 * Every point but an exclusion's is jittered along X by `((i & 0xff) − 128)·32` nav units, `i` its
 * nav X truncated (`0x49bd82`), so the edge is ragged and holds still. The UVs repeat every
 * {@link REPEAT} plane units from the centre, which takes (0.5, 0.5); `alpha` is the byte to draw at.
 */
export const navmapFill = (
  { zone, flags, fogColor }: NavmapZone,
  scale: number,
  alpha: number,
): { texture: string; batch: ImmediateBatch } | undefined => {
  const texture = navmapFillTexture(flags)
  if (!texture || (zone.type !== 'sphere' && zone.type !== 'ellipsoid')) return undefined

  const exclusion = (flags & EXCLUSION) !== 0
  const { position: centre, axes, size } = zone
  const rim: Vector3[] = []

  for (let at = 0; at < RIM; at++) {
    const t = (at * 2 * Math.PI) / RIM
    const direction = { x: Math.sin(t), y: 0, z: Math.cos(t) }

    rim.push(
      zone.type === 'sphere'
        ? Vector3.add(
            centre,
            Vector3.add(
              Vector3.multiplyScalar(axes[0], size.x * direction.x),
              Vector3.multiplyScalar(axes[2], size.x * direction.z),
            ),
          )
        : Vector3.add(centre, Vector3.multiplyScalar(direction, zone.radiusAlong(direction))),
    )
  }

  const jitter = ({ x, z }: Vector3): Vector3 => {
    if (exclusion) return { x, y: 0, z }

    const nav = x * scale
    // A C `(int)`: toward zero; then its low byte, as two's complement keeps it.
    const i = Math.trunc(nav) | 0

    return { x: (nav + ((i & 0xff) - 128) * 32) / scale, y: 0, z }
  }

  const points = [jitter(centre), ...rim.map(jitter)]
  const [middle] = points
  const repeat = REPEAT * navmapUnit(scale)
  const tint = exclusion
    ? Vector3.zero
    : flags & NEBULA
      ? {
          x: Math.min(1, (fogColor?.x ?? 1) * 1.5),
          y: Math.min(1, (fogColor?.y ?? 1) * 1.5),
          z: Math.min(1, (fogColor?.z ?? 1) * 1.5),
        }
      : WHITE
  const byte = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255)
  const colour = [byte(tint.z), byte(tint.y), byte(tint.x), Math.round(alpha)]
  const vertices: number[] = []
  const colors: number[] = []
  const indices: number[] = []

  for (const point of points) {
    // Plane Y runs up the map, which is −Z.
    vertices.push(
      point.x,
      0,
      point.z,
      (point.x - middle!.x) / repeat + 0.5,
      -(point.z - middle!.z) / repeat + 0.5,
    )
    colors.push(...colour)
  }

  for (let at = 1; at <= RIM; at++) indices.push(0, at, (at % RIM) + 1)

  return { texture, batch: { vertices, colors, indices, count: points.length } }
}

/** `TLRanimated_01` … `_16`, one every 1/15 s (`0x5d3d30`). */
export const navmapLaneTexture = (time: number): string =>
  `TLRanimated_${String((Math.floor(time * 15) % 16) + 1).padStart(2, '0')}`

/**
 * A trade lane's strip from one ring to the next (`0x4992b0`): half-width `0.003 + 0.000263·(zoom − 1)`
 * plane units, in metres at that zoom; each side a quad from the centre line, white and opaque at
 * `u = 0.5`, to its edge, clear at `u = 1`. `v` runs 0 to 1 once along it. Ends are square.
 */
export const navmapLane = (
  from: Vector3,
  to: Vector3,
  scale: number,
  zoom: number,
  alpha = 1,
): ImmediateBatch => {
  const z = Math.max(1, zoom)
  const half = ((0.003 + 0.000263 * (z - 1)) * navmapUnit(scale)) / z
  const along = Math.hypot(to.x - from.x, to.z - from.z) || 1
  // Across the lane, on the plane.
  const side = { x: (-(to.z - from.z) / along) * half, y: 0, z: ((to.x - from.x) / along) * half }
  const centre = Math.round(255 * Math.min(1, Math.max(0, alpha)))
  const vertices: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const vertex = ({ x, z }: Vector3, u: number, v: number, a: number) => {
    vertices.push(x, 0, z, u, v)
    colors.push(255, 255, 255, a)
  }

  vertex(from, 0.5, 0, centre)
  vertex(to, 0.5, 1, centre)

  for (const sign of [1, -1]) {
    const base = vertices.length / 5

    vertex(Vector3.add(from, Vector3.multiplyScalar(side, sign)), 1, 0, 0)
    vertex(Vector3.add(to, Vector3.multiplyScalar(side, sign)), 1, 1, 0)
    indices.push(0, 1, base + 1, 0, base + 1, base)
  }

  return { vertices, colors, indices, count: vertices.length / 5 }
}

/** A model of the layer, drawn at `alpha`: a grid copy, or an icon. */
export interface NavmapModel {
  model: SceneModel
  alpha: number
}

/** A fill or a lane, built, and its texture. */
export interface NavmapStrip {
  batch: ImmediateBatch
  texture: Texture
}

export interface NavmapScene {
  /** The plan frame's camera. */
  camera: Camera
  aspect: number
  /** The grid's copies, under everything. */
  grids?: readonly NavmapModel[]
  /** The fills, in {@link navmapFillOrder}. */
  fills?: readonly NavmapStrip[]
  lanes?: readonly NavmapStrip[]
  /** The icons, in file order: a later one paints over an earlier. */
  icons?: readonly NavmapModel[]
  /** Seconds, for material UV animation. */
  time?: number
  limits?: Partial<FrameLimits>
}

/** The layer's draws: what lies under a plan frame's models, and what over them. */
export interface NavmapLayer {
  under: Draw[]
  over: Draw[]
  unsupported: string[]
}

/** How every draw of the layer stands: no depth, no culling, the interface's white light, blended. */
const flat = (draw: Draw, alpha = 1): Draw => {
  const faded = alpha < 1
  const { fog: _fog, ...rest } = draw

  return {
    ...rest,
    cull: 'none',
    depthFunc: 'always',
    depthWrite: false,
    lightless: true,
    sceneAmbient: WHITE,
    diffuse: [draw.diffuse[0], draw.diffuse[1], draw.diffuse[2], draw.diffuse[3] * alpha],
    blend: draw.blend || faded,
    blendMode: draw.blend ? draw.blendMode : 'alpha',
  }
}

/** A sampler that repeats, as a fill's UVs need: the pass never sets one (NAVMAP.md, open). */
const REPEATING: SamplerState = { ...DEFAULT_SAMPLER, wrapU: 'repeat', wrapV: 'repeat' }

/**
 * The navmap's draws (`0x4926d0`, passes 1, 4, 5 and 8) for a plan frame: the grid's copies, the
 * fills and the lanes under its models, the icons over them. Lay them on it with {@link withNavmap}.
 */
export const collectNavmapLayer = ({
  camera,
  aspect,
  grids = [],
  fills = [],
  lanes = [],
  icons = [],
  time = 0,
  limits,
}: NavmapScene): NavmapLayer => {
  const resolved = { ...RETAIL_FRAME_LIMITS, ...limits }
  const unsupported = new Set<string>()
  const unregistered = new Set<string>()
  const view = viewMatrix(camera)

  const models = (held: readonly NavmapModel[]): Draw[] =>
    held.flatMap(({ model, alpha }) => {
      if (!(alpha > 0)) return []

      const draws: Draw[] = []

      collectModel(
        model,
        camera,
        aspect,
        view,
        time,
        draws,
        undefined,
        unsupported,
        unregistered,
        resolved,
      )

      return draws.map((draw) => flat(draw, alpha))
    })

  const strips = (held: readonly NavmapStrip[], name: string, sampler?: SamplerState): Draw[] =>
    held.flatMap(({ batch, texture }) => {
      const draw = immediateDraw(name, batch, texture)
      if (!draw) return []

      const laid = flat(draw)

      return [
        {
          ...laid,
          blendMode: 'alpha',
          ...(sampler && laid.texture && { texture: { ...laid.texture, sampler } }),
        },
      ]
    })

  return {
    under: [
      ...models(grids),
      ...strips(fills, 'navmap_fill', REPEATING),
      ...strips(lanes, 'navmap_lane'),
    ],
    over: models(icons),
    unsupported: [...unsupported],
  }
}

/**
 * A plan frame with the navmap's layer on it: its `under` draws first, under every model, its `over`
 * draws last, over them. `begin` stays first and `end` last, after the icons, so what a host draws
 * there lies over the whole map; `opaque` keeps its place among the frame's own draws.
 */
export const withNavmap = <F extends Frame>(
  frame: F,
  { under, over, unsupported }: NavmapLayer,
): F => {
  const draws = [...under, ...frame.draws, ...over]

  return {
    ...frame,
    draws,
    hooks: frame.hooks.map((hook) =>
      hook.name === 'begin'
        ? { ...hook, before: 0 }
        : hook.name === 'end'
          ? { ...hook, before: draws.length }
          : { ...hook, before: hook.before + under.length },
    ),
    unsupported: [...new Set([...frame.unsupported, ...unsupported])],
  }
}
