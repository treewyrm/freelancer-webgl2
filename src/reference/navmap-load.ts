/**
 * A retail system's navmap layer, read from the install: the grid quad, the fills, the lanes and
 * the icons, for `npm run view` with `VIEW_NAVMAP`. Test-only; the host's own reading is the
 * extension's. See the extension's docs/system/NAVMAP.md.
 */
import { Document, type Section } from '@treewyrm/freelancer/ini'
import { getMaterial, readMaterialLibrary } from '@treewyrm/freelancer/material'
import type { Vector3 } from '@treewyrm/freelancer/math'
import { readRigidModel } from '@treewyrm/freelancer/rigid'
import { readTextureLibrary, type Texture } from '@treewyrm/freelancer/texture'
import { Directory } from '@treewyrm/freelancer/utf'
import { getMesh, readVMeshLibrary } from '@treewyrm/freelancer/vmesh'
import type { Camera } from '#/scene/camera.js'
import { placeParts, type SceneModel } from '#/scene/frame.js'
import {
  collectNavmapLayer,
  navmapFill,
  navmapFillAlpha,
  navmapFillOrder,
  navmapGridWorld,
  navmapIconShown,
  navmapIconWorld,
  navmapLane,
  navmapLaneTexture,
  navmapZoom,
  type NavmapLayer,
  type NavmapStrip,
} from '#/scene/navmap.js'
import type { ReadAsset } from './load.js'
import { zoneFor } from './space-load.js'
import type { ReferenceSystem } from './systems.js'

const NAVMAP = 'INTERFACE/NEURONET/NAVMAP/NEWNAVMAP'

/** `0x2020bdff` (`nav+0x4b0`), as the `type` names it admits. A plain `ASTEROID` is left out. */
const ICON_TYPES = new Set([
  'MOON',
  'PLANET',
  'SUN',
  'BLACKHOLE',
  'SATELLITE',
  'DOCKING_RING',
  'JUMP_GATE',
  'TRADELANE_RING',
  'STATION',
  'AIRLOCK_GATE',
  'JUMP_HOLE',
  'WEAPONS_PLATFORM',
  'DESTROYABLE_DEPOT',
  'MISSION_SATELLITE',
  'CAPITAL',
])

const text = (section: Section, key: string): string | undefined => {
  const value = section.getValue(key)?.value

  return value === undefined ? undefined : String(value)
}

const numbers = (section: Section, key: string): number[] =>
  section.properties
    .find(({ name }) => name.toLowerCase() === key)
    ?.values.map(({ value }) => Number(value)) ?? []

/** A model read from its file, its meshes from `interface.generic.vms`, its materials its own or `also`'s. */
const modelOf = (
  bytes: Uint8Array,
  generic: ReturnType<typeof readVMeshLibrary>,
  also?: Directory,
) => {
  const root = Directory.read(bytes)
  const model = readRigidModel(root)
  const own = readVMeshLibrary(root)
  const materials = [...readMaterialLibrary(root), ...(also ? readMaterialLibrary(also) : [])]
  const textures = [...readTextureLibrary(root), ...(also ? readTextureLibrary(also) : [])]

  return (world: Parameters<typeof placeParts>[1]): SceneModel => ({
    parts: placeParts(model, world),
    mesh: (id) => getMesh(own, id) ?? getMesh(generic, id),
    material: (id) => getMaterial(materials, id),
    texture: (name) => textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase()),
  })
}

/**
 * The navmap's layer over a retail system, at the zoom a parallel `camera` shows it at (1 the system
 * view, 8.6 zoomed in): the grid copy of that mode, every fill and lane, and the icons.
 */
export const loadNavmap = async (
  read: ReadAsset,
  path: string,
  system: ReferenceSystem,
  { camera, aspect, time = 0 }: { camera: Camera; aspect: number; time?: number },
): Promise<{ layer: NavmapLayer; scale: number; zoom: number }> => {
  const universe = [...Document.read(await read('UNIVERSE/universe.ini'))]
  const entry = universe.find(
    (section) =>
      section.name.toLowerCase() === 'system' &&
      `UNIVERSE/${text(section, 'file') ?? ''}`.replace(/\\/g, '/').toLowerCase() ===
        path.replace(/\\/g, '/').toLowerCase(),
  )
  const scale = (entry && numbers(entry, 'navmapscale')[0]) || 1
  // Half the shorter side, as the navmap's square viewport holds its map.
  const half = (camera.ortho?.halfWidth ?? 0) / Math.max(1, aspect)
  const zoom = navmapZoom(half, scale)
  const zoomedIn = zoom > Math.sqrt(8.6)

  const solars = new Map<string, Section>()
  for (const section of Document.read(await read('SOLAR/solararch.ini')))
    if (section.name.toLowerCase() === 'solar')
      solars.set(section.getNickname()?.toLowerCase() ?? '', section)

  const sections = [...Document.read(await read(path))]
  const of = (kind: string) => sections.filter(({ name }) => name.toLowerCase() === kind)

  const generic = readVMeshLibrary(Directory.read(await read('INTERFACE/interface.generic.vms')))
  const mat = Directory.read(await read(`${NAVMAP}/SPACEOBJECTS/spaceobjects.mat`))
  const textures = [
    ...readTextureLibrary(Directory.read(await read(`${NAVMAP}/navmaptextures.txm`))),
  ]
  const texture = (name: string): Texture => {
    const found = textures.find((one) => one.name.toLowerCase() === name.toLowerCase())
    if (found?.type !== 'image') throw new Error(`navmaptextures.txm has no ${name}`)
    return found
  }

  const grid = modelOf(await read(`${NAVMAP}/zoomedmap_liberty.3db`), generic)

  // Fills: each zone the navmap fills, in its order, at the zoom's alpha.
  const fogOf = new Map(
    of('zone').map((section) => {
      const [r = 255, g = 255, b = 255] = numbers(section, 'property_fog_color')
      return [section.getNickname()?.toLowerCase() ?? '', { x: r / 255, y: g / 255, z: b / 255 }]
    }),
  )
  const fills = navmapFillOrder(
    (system.zones ?? []).map((zone) => ({ ...zone, flags: zone.propertyFlags ?? 0 })),
  ).flatMap((found): NavmapStrip[] => {
    const filled = navmapFill(
      {
        zone: zoneFor(system, found.nickname).zone,
        flags: found.flags,
        fogColor: fogOf.get(found.nickname.toLowerCase())!,
      },
      scale,
      navmapFillAlpha(zoom),
    )

    return filled ? [{ batch: filled.batch, texture: texture(filled.texture) }] : []
  })

  // Lanes: from each ring with no `prev_ring`, along `next_ring`.
  const objects = of('object')
  const byName = new Map(objects.map((section) => [section.getNickname()?.toLowerCase(), section]))
  const at = (section: Section): Vector3 => {
    const [x = 0, y = 0, z = 0] = numbers(section, 'pos')
    return { x, y, z }
  }
  const lane = texture(navmapLaneTexture(time))
  const lanes: NavmapStrip[] = []

  for (const start of objects) {
    if (text(start, 'prev_ring') || !text(start, 'next_ring')) continue

    let ring: Section | undefined = start
    const seen = new Set<Section>()

    while (ring && !seen.has(ring)) {
      seen.add(ring)
      const next = byName.get(text(ring, 'next_ring')?.toLowerCase())
      if (next) lanes.push({ batch: navmapLane(at(ring), at(next), scale, zoom), texture: lane })
      ring = next
    }
  }

  // Icons: the archetypes the mask admits whose `shape_name` has a model, middle lane rings left out.
  const loaded = new Map<string, ReturnType<typeof modelOf> | undefined>()
  const icons = []

  for (const section of objects) {
    const solar = solars.get(text(section, 'archetype')?.toLowerCase() ?? '')
    const type = (solar && text(solar, 'type'))?.toUpperCase() ?? ''
    const shape = solar && text(solar, 'shape_name')

    if (!solar || !shape || !ICON_TYPES.has(type)) continue
    if (text(section, 'prev_ring') && text(section, 'next_ring')) continue

    const key = shape.toLowerCase()

    if (!loaded.has(key))
      loaded.set(
        key,
        await read(`${NAVMAP}/SPACEOBJECTS/${key}.3db`).then(
          (bytes) => modelOf(bytes, generic, mat),
          () => undefined,
        ),
      )

    const model = loaded.get(key)
    const icon = {
      position: at(section),
      radius: numbers(solar, 'solar_radius')[0] ?? 500,
      sun: type === 'SUN',
      turned: type === 'PLANET' || type === 'MOON',
    }

    if (model && navmapIconShown(icon, scale, zoomedIn))
      icons.push({ model: model(navmapIconWorld(icon, scale)), alpha: 1 })
  }

  return {
    scale,
    zoom,
    layer: collectNavmapLayer({
      camera,
      aspect,
      grids: [{ model: grid(navmapGridWorld(zoomedIn ? 'zoomed' : 'system', scale)), alpha: 1 }],
      fills,
      lanes,
      icons,
      time,
    }),
  }
}
