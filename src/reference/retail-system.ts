/** A retail system's INI as a `ReferenceSystem`, for the bench and `npm run view`. Test-only. */
import { Document, type Section } from '@treewyrm/freelancer/ini'
import type { ReferenceSystem } from './systems.js'

type ReadAsset = (path: string) => Promise<Uint8Array>
type Vector = readonly [number, number, number]

const numbers = (section: Section, key: string): number[] =>
  section.getValue(key) === undefined
    ? []
    : (section.properties
        .find(({ name }) => name.toLowerCase() === key)
        ?.values.map(({ value }) => Number(value)) ?? [])

const text = (section: Section, key: string): string | undefined => {
  const value = section.getValue(key)?.value

  return value === undefined ? undefined : String(value)
}

const triple = (section: Section, key: string, fallback: Vector = [0, 0, 0]): Vector => {
  const [x = fallback[0], y = fallback[1], z = fallback[2]] = numbers(section, key)

  return [x, y, z]
}

const ZONE_SHAPES = {
  SPHERE: 'SPHERE',
  ELLIPSOID: 'ELLIPSOID',
  RING: 'RING',
  BOX: 'BOX',
  CYLINDER: 'CYLINDER',
} as const

export interface RetailSystem {
  system: ReferenceSystem
  /** What was left out, and why. */
  skipped: string[]
}

/**
 * `path` under `DATA`, as `universe.ini` names it; `player` places the player's ship. `leaveOut`
 * names `[Asteroids]` and `[Nebula]` files this renderer can't load yet, by path, with the reason.
 */
export const readRetailSystem = async (
  read: ReadAsset,
  path: string,
  player: ReferenceSystem['player'],
  leaveOut: Record<string, string> = {},
): Promise<RetailSystem> => {
  const sections = [...Document.read(await read(path))]
  const of = (kind: string) => sections.filter(({ name }) => name.toLowerCase() === kind)
  const archetypes = new Set(
    [...Document.read(await read('SOLAR/solararch.ini'))].flatMap(
      (section) => section.getNickname()?.toLowerCase() ?? [],
    ),
  )
  const skipped: string[] = []

  const background = of('background')[0]
  const info = of('systeminfo')[0]

  const objects: ReferenceSystem['objects'] = of('object').flatMap((section) => {
    const nickname = section.getNickname() ?? '?'
    const archetype = text(section, 'archetype')

    if (!archetype || !archetypes.has(archetype.toLowerCase())) {
      skipped.push(`object ${nickname}: archetype ${archetype} not in solararch.ini`)
      return []
    }

    const star = text(section, 'star')
    const loadout = text(section, 'loadout')
    const nebulaeBefore = sections
      .slice(0, sections.indexOf(section))
      .filter(({ name }) => name.toLowerCase() === 'nebula').length
    const ring = section.properties.find(({ name }) => name.toLowerCase() === 'ring')

    return [
      {
        nickname,
        archetype,
        position: triple(section, 'pos'),
        ...(section.getValue('rotate') !== undefined && { rotate: triple(section, 'rotate') }),
        ...(star && { star }),
        ...(loadout && { loadout }),
        ...(nebulaeBefore && { nebulaeBefore }),
        ...(ring && {
          ring: { zone: String(ring.values[0]!.value), file: String(ring.values[1]!.value) },
        }),
      },
    ]
  })

  const zones: NonNullable<ReferenceSystem['zones']> = of('zone').map((section) => {
    const shape = (text(section, 'shape') ?? 'SPHERE').toUpperCase()
    const flags = numbers(section, 'property_flags')[0]
    const edgeFraction = numbers(section, 'edge_fraction')[0]
    const spacedust = text(section, 'spacedust')
    const maxParticles = numbers(section, 'spacedust_maxparticles')[0]

    return {
      nickname: section.getNickname() ?? '?',
      position: triple(section, 'pos'),
      pitch: numbers(section, 'rotate')[0] ?? 0,
      rotate: triple(section, 'rotate'),
      shape: ZONE_SHAPES[shape as keyof typeof ZONE_SHAPES] ?? 'SPHERE',
      size: numbers(section, 'size'),
      ...(flags !== undefined && { propertyFlags: flags }),
      ...(edgeFraction !== undefined && { edgeFraction }),
      ...(spacedust && {
        spacedust: { effect: spacedust, ...(maxParticles !== undefined && { maxParticles }) },
      }),
    }
  })

  const left = new Map(Object.entries(leaveOut).map(([file, why]) => [file.toLowerCase(), why]))

  const fileZones = (kind: string) =>
    of(kind).flatMap((section) => {
      const file = text(section, 'file')!
      const why = left.get(file.toLowerCase())
      if (why) skipped.push(`${kind} ${file}: ${why}`)
      return why ? [] : [{ file, zone: text(section, 'zone')! }]
    })

  const dust = of('dust')[0]
  const spacedust = dust && text(dust, 'spacedust')

  return {
    skipped,
    system: {
      name: path,
      ambient: triple(of('ambient')[0] ?? sections[0]!, 'color'),
      ...(info?.getValue('space_color') !== undefined && {
        spaceColor: triple(info, 'space_color'),
      }),
      background: {
        basic: (background && text(background, 'basic_stars')) ?? '',
        complex: (background && text(background, 'complex_stars')) ?? '',
        nebulae: (background && text(background, 'nebulae')) ?? '',
      },
      lights: of('lightsource').map((section) => {
        const attenuation = numbers(section, 'attenuation')
        const curve = text(section, 'atten_curve')

        return {
          nickname: section.getNickname() ?? '?',
          position: triple(section, 'pos'),
          color: triple(section, 'color'),
          range: numbers(section, 'range')[0] ?? 0,
          type: text(section, 'type')?.toUpperCase() === 'DIRECTIONAL' ? 'DIRECTIONAL' : 'POINT',
          ...(attenuation.length === 3 && { attenuation: attenuation as unknown as Vector }),
          ...(curve && { curve }),
        }
      }),
      objects,
      zones,
      asteroids: fileZones('asteroids'),
      nebulae: fileZones('nebula'),
      ...(spacedust && { dust: spacedust }),
      player,
    },
  }
}
