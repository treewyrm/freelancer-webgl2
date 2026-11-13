import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { test } from 'node:test'
import { readMaterialLibrary } from '@treewyrm/freelancer/material'
import { Directory } from '@treewyrm/freelancer/utf'
import { MATERIAL_MAP, mapMaterialType, REGISTERED_TYPES } from './map.js'

const DATA = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const EXE = join(DATA, '../EXE')
const absent = existsSync(DATA) ? false : `no retail data at ${DATA}`

const shadedAs = (name: string, type: string) => mapMaterialType({ name, type })

test('the last rule listed wins, so the specific one beats the general', () => {
  assert.equal(shadedAs('alpha_mask_wing', 'DcDtOcOt'), 'DcDt')
  assert.equal(shadedAs('alpha_mask_wing2side', 'DcDtOcOt'), 'DcDtTwo')
})

test('a name rule beats a type rule, being listed later', () => {
  assert.equal(shadedAs('detailmap_rock', 'DcDtEcEt'), 'BtDetailMapMaterial')
})

test('the name is lowercased and the type is not', () => {
  assert.equal(shadedAs('Nomad surface', 'DcDtBtOcOtTwo'), 'NomadMaterialNoBendy')
  assert.equal(shadedAs('L_GLASS', 'DcDtOcOt'), 'HighGlassMaterial')
  assert.equal(shadedAs('hull', 'dcdtecet'), 'dcdtecet')
})

test('a type rule searches, so its text matches anywhere in the type', () => {
  assert.equal(shadedAs('hull', 'DcDtEcEt'), 'DcDtEt')
  assert.equal(shadedAs('hull', 'DcDtBtDcDtEcEtTwo'), 'DcDtEt')
})

test('a name rule anchors only where its pattern says', () => {
  assert.equal(shadedAs('xl_glass', 'DcDtOcOt'), 'DcDtOcOt')
  assert.equal(shadedAs('alpha_mask_2side_more', 'DcDt'), 'DcDtTwo')
})

test('only the first 63 characters of a name are matched', () => {
  const beyond = `${'x'.repeat(63)}2side`

  assert.equal(shadedAs(`alpha_mask${beyond}`, 'DcDt'), 'DcDt')
})

test('the table is the section in the retail dacom.ini', { skip: absent }, () => {
  // As `FMaterialLibrary::ParseMaterialMap`: two `=` make a selector, and only `name` is a name rule.
  const text = readFileSync(join(EXE, 'dacom.ini'), 'latin1')
  const section = text.slice(text.indexOf('[MaterialMap]')).split(/\r?\n/).slice(1)
  const end = section.findIndex((line) => line.startsWith('['))

  const rules = section
    .slice(0, end)
    .map((line) => line.split(';')[0]!.trim())
    .filter((line) => line.includes('='))
    .map((line) => {
      const fields = line.split('=').map((field) => field.trim())

      return {
        on: fields.length === 3 && fields[0]!.toLowerCase() === 'name' ? 'name' : 'type',
        pattern: fields.at(-2),
        to: fields.at(-1),
      }
    })

  assert.deepEqual(
    MATERIAL_MAP.map(({ on, pattern, to }) => ({ on, pattern: pattern.source, to })),
    rules,
  )
})

test('every registered type is named in the retail DLLs', { skip: absent }, () => {
  const held = ['shading.dll', 'flmaterials.dll', 'deformable2.dll'].map((dll) =>
    readFileSync(join(EXE, dll), 'latin1'),
  )

  for (const name of REGISTERED_TYPES)
    assert.ok(
      held.some((dll) => dll.includes(`${name}\0`)),
      name,
    )
})

const retailMaterials = () => {
  const found: { name: string; type: string }[] = []

  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)

      if (entry.isDirectory()) walk(path)
      else if (
        ['.mat', '.cmp', '.3db', '.sph', '.dfm', '.utf'].includes(extname(path).toLowerCase())
      )
        found.push(...readMaterialLibrary(Directory.read(readFileSync(path))))
    }
  }

  walk(DATA)
  return found
}

test('over retail, the map rescues all but two unregistered materials', { skip: absent }, () => {
  const materials = retailMaterials()

  assert.equal(materials.length, 7525)

  const unregistered = (type: string) => !REGISTERED_TYPES.has(type)
  const before = materials
    .filter(({ type }) => !/^(EcEtOcOt|DcDtEcEt)$/.test(type))
    .filter(({ type }) => unregistered(type))

  assert.equal(before.length, 445)
  assert.equal(before.filter((material) => unregistered(mapMaterialType(material))).length, 2)
})

test('deformable2 maps what starts `ey` to the eye class, ahead of the file, and an `Et` goes with it', () => {
  for (const name of ['eyebrown_grey', 'EYE_white', 'ey'])
    assert.equal(mapMaterialType({ name, type: 'DcDtEt' }), 'EyeMaterial', name)

  assert.equal(mapMaterialType({ name: 'e', type: 'DcDtEt' }), 'DcDtEt')
  assert.equal(mapMaterialType({ name: 'my_eye', type: 'DcDtEt' }), 'DcDtEt')
})
