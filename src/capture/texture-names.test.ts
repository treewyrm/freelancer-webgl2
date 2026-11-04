import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Texture, TextureEntry } from '@treewyrm/freelancer/texture'
import { readCapture, type CaptureTexture } from './capture.js'
import {
  addLibrary,
  contentHash,
  indexTextures,
  namesOf,
  type TextureIndex,
} from './texture-names.js'

const ascii = (text: string) => new TextEncoder().encode(text)

const image = (fields: Partial<Texture>): Texture => ({
  name: 'test',
  type: 'image',
  storage: 'dds',
  format: 'dxt1',
  width: 16,
  height: 16,
  flip: false,
  levels: [],
  ...fields,
})

const captured = (hash: (string | undefined)[], width = 16): CaptureTexture => ({
  pointer: 1,
  type: '2d',
  levels: hash.length,
  width,
  height: width,
  format: 21,
  pool: 1,
  hash,
})

test('contentHash is CRC-32 then FNV-1a, by their published check values', () => {
  assert.equal(contentHash(ascii('123456789')), 'cbf43926bb86b11c')
})

test('a surface is matched by its stored bytes, a dropped top level included', () => {
  const top = new Uint8Array(32 * 32).fill(1)
  const next = new Uint8Array(16 * 16).fill(2)
  const index: TextureIndex = new Map()
  addLibrary(index, 'a.txm', [image({ width: 32, height: 32, levels: [top, next] })])

  const expected = [{ source: 'a.txm', name: 'test' }]
  assert.deepEqual(namesOf(index, captured([contentHash(top)], 32)), expected)
  assert.deepEqual(namesOf(index, captured([contentHash(next)], 16)), expected)
  assert.deepEqual(namesOf(index, captured([undefined, contentHash(next)], 32)), expected)
})

test('the same bytes at a different width do not match', () => {
  const pixels = new Uint8Array(16 * 16).fill(1)
  const index: TextureIndex = new Map()
  addLibrary(index, 'a.txm', [image({ levels: [pixels] })])
  assert.deepEqual(namesOf(index, captured([contentHash(pixels)], 32)), [])
})

test('levels too small to identify anything are left out', () => {
  const index: TextureIndex = new Map()
  addLibrary(index, 'a.txm', [image({ width: 8, height: 8, levels: [new Uint8Array(32)] })])
  assert.equal(index.size, 0)
})

test('a 24-bit Targa is compared as uploaded: rows as stored, and as R5G6B5', () => {
  // Two rows of 16 BGR pixels, in file order: pure red, then white.
  const level = new Uint8Array(16 * 2 * 3)
  for (let at = 0; at < 48; at += 3) level[at + 2] = 0xff
  level.fill(0xff, 48)

  const index: TextureIndex = new Map()
  addLibrary(index, 'a.txm', [
    image({ storage: 'targa', format: 'rgb24_888', height: 16, levels: [level] }),
  ])

  const expected = new Uint8Array(16 * 2 * 2)
  for (let at = 0; at < 32; at += 2) expected[at + 1] = 0xf8
  expected.fill(0xff, 32)
  assert.deepEqual(namesOf(index, captured([contentHash(expected)])), [
    { source: 'a.txm', name: 'test' },
  ])
})

test('a 32-bit Targa is compared as stored', () => {
  const level = new Uint8Array(16 * 16 * 4).fill(7)
  const index: TextureIndex = new Map()
  addLibrary(index, 'a.txm', [image({ storage: 'targa', format: 'rgba32_8888', levels: [level] })])
  assert.equal(namesOf(index, captured([contentHash(level)])).length, 1)
})

test('a cube is matched by its six faces in a row', () => {
  const face = (value: number) => [new Uint8Array(16 * 16 * 4).fill(value)]
  const cube: TextureEntry = {
    name: 'envmap',
    type: 'cube',
    format: 'rgba32_8888',
    width: 16,
    height: 16,
    flip: true,
    faces: [face(1), face(2), face(3), face(4), face(5), face(6)],
  }
  const index: TextureIndex = new Map()
  addLibrary(index, 'a.txm', [cube])

  const row = new Uint8Array(6 * 16 * 16 * 4)
  cube.faces.forEach(([level], at) => row.set(level!, at * level!.length))
  assert.deepEqual(namesOf(index, { ...captured([contentHash(row)]), type: 'cube' }), [
    { source: 'a.txm', name: 'envmap' },
  ])
})

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const run = join(references, 'run1-stock-menu/d3d8log.jsonl')

test(
  'names the planet textures of a captured retail menu',
  {
    skip: !existsSync(data)
      ? 'no retail DATA'
      : !existsSync(run)
        ? 'no capture of the stock menu in references'
        : false,
  },
  () => {
    const index = indexTextures(data)
    const textures = readCapture(readFileSync(run, 'utf8'))
      .frames.flatMap(({ draws }) => draws)
      .flatMap(({ stages }) => stages.map(({ texture }) => texture))
      .filter((texture) => texture !== undefined)
    const names = new Set(textures.flatMap((texture) => namesOf(index, texture)).map((n) => n.name))
    for (const name of ['mercury01', 'atmosphere', 'detailmap_lava', 'smokecard'])
      assert.ok(names.has(name), `${name} not found`)
  },
)
