/**
 * The retail install's answers to {@link createCast}: each `DEFORMABLE`'s `template_name` a
 * `costumes.ini` `[Costume]`, its parts from `bodyparts.ini`, and every `[Animations]` file in the
 * one global table. Test-only; the cast itself is `thorn`'s.
 *
 * Left out, each reported: accessories, and a `player` or role actor resolved to the room's own
 * character (here it is made from its costume like any other).
 */
import { readAnimationLibrary, type AnimationScript } from '@treewyrm/freelancer/animation'
import { readDeformableModel } from '@treewyrm/freelancer/deformable'
import { Document, type Section } from '@treewyrm/freelancer/ini'
import { readMaterialLibrary } from '@treewyrm/freelancer/material'
import { readTextureLibrary } from '@treewyrm/freelancer/texture'
import type * as thnScene from '@treewyrm/freelancer/thn/scene'
import { Directory } from '@treewyrm/freelancer/utf'
import type { SwitchTable } from '#/deformable/level.js'
import { castEntities, createCast, type Cast, type CostumePart } from '#/thorn/cast.js'

export type { Cast } from '#/thorn/cast.js'

type ReadAsset = (path: string) => Promise<Uint8Array>

const path = (value: string) => value.replaceAll('\\', '/')

const text = (section: Section, key: string) => {
  const value = section.getValue(key)?.value
  return value === undefined ? undefined : String(value)
}

/** `costumes.ini`'s four slots, in `common.dll`'s order (`0x63ecd68`): the body first. */
const SLOTS = ['body', 'head', 'lefthand', 'righthand'] as const

interface PartEntry {
  mesh: string
  table: SwitchTable | undefined
}

/**
 * `bodyparts.ini`: each part with the last `[DetailSwitchTable]` before it (`load_bodyparts`,
 * `0x6300570`, positional), and the `[Animations]` files.
 */
const readBodyparts = (bytes: Uint8Array) => {
  const parts = new Map<string, PartEntry>()
  const animations: string[] = []
  let table: SwitchTable | undefined

  for (const section of Document.read(bytes)) {
    const kind = section.name.toLowerCase()

    if (kind === 'animations')
      for (const { name, values } of section.properties)
        if (name.toLowerCase() === 'anim') animations.push(path(String(values[0]!.value)))

    if (kind === 'detailswitchtable') {
      const rows = section.properties
        .filter(({ name }) => name.toLowerCase() === 'switch')
        .map(({ values }) => [Number(values[0]!.value), Number(values[1]!.value)] as const)
      const fovx = section.getValue('fovx')?.value

      table = { rows, ...(fovx !== undefined && { fovx: Number(fovx) }) }
    }

    if ((SLOTS as readonly string[]).includes(kind)) {
      const nickname = section.getNickname()?.toLowerCase()
      const mesh = text(section, 'mesh')

      if (nickname && mesh) parts.set(`${kind}:${nickname}`, { mesh: path(mesh), table })
    }
  }

  return { parts, animations }
}

/** The cast of `scripts`, every costume read ahead from the install. */
export const loadCast = async (
  read: ReadAsset,
  scripts: readonly thnScene.Script[],
): Promise<Cast> => {
  const { parts, animations } = readBodyparts(await read('CHARACTERS/bodyparts.ini'))
  const costumes = new Map<string, Section>()
  const skipped: string[] = []

  for (const section of Document.read(await read('CHARACTERS/costumes.ini')))
    if (section.name.toLowerCase() === 'costume') {
      const nickname = section.getNickname()?.toLowerCase()
      if (nickname) costumes.set(nickname, section)
    }

  // One global table, found by name ignoring case (`0x435100`); the first file's script wins.
  const table = new Map<string, AnimationScript>()

  for (const file of animations)
    for (const script of readAnimationLibrary(Directory.read(await read(file)))) {
      const key = script.name.toLowerCase()
      if (!table.has(key)) table.set(key, script)
    }

  const worn = new Map<string, CostumePart[]>()

  for (const entity of castEntities(scripts)) {
    const costume = costumes.get((entity.template_name ?? '').toLowerCase())

    if (!costume) {
      skipped.push(`${entity.entity_name}: no costume ${entity.template_name}`)
      continue
    }

    const accessories = costume.properties.filter(({ name }) => name.toLowerCase() === 'accessory')
    if (accessories.length) skipped.push(`${entity.entity_name}: ${accessories.length} accessories`)

    const entries = SLOTS.flatMap((slot) => {
      const part = text(costume, slot)
      const entry = part && parts.get(`${slot}:${part.toLowerCase()}`)

      if (part && !entry) skipped.push(`${entity.entity_name}: no ${slot} ${part}`)
      return entry ? [entry] : []
    })

    worn.set(
      entity.entity_name,
      await Promise.all(
        entries.map(async ({ mesh, table }) => {
          const root = Directory.read(await read(mesh))

          return {
            model: readDeformableModel(root),
            materials: [...readMaterialLibrary(root)],
            textures: [...readTextureLibrary(root)],
            ...(table && { table }),
          }
        }),
      ),
    )
  }

  const cast = createCast(scripts, {
    costume: (entity) => worn.get(entity.entity_name),
    animation: (name) => table.get(name.toLowerCase()),
  })

  cast.skipped.unshift(...skipped)
  return cast
}
