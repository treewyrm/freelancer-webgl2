import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CubeTexture, Texture } from '@treewyrm/freelancer/texture'
import { readCapture } from '#/capture/capture.js'
import { forEachLibrary, indexTextures } from '#/capture/texture-names.js'
import { planUpload } from './upload.js'

const flat = (fields: Partial<Texture>): Texture => ({
  name: 'test',
  type: 'image',
  storage: 'targa',
  format: 'rgba32_8888',
  width: 1,
  height: 1,
  flip: false,
  levels: [],
  ...fields,
})

const bytes = (...values: number[]) => new Uint8Array(values)

test('24-bit Targa becomes R5G6B5 by rounding, not truncation', () => {
  const upload = planUpload(
    flat({ format: 'rgb24_888', width: 3, levels: [bytes(255, 255, 255, 4, 2, 4, 5, 3, 5)] }),
  )
  assert.equal(upload.layout, 'rgb565')
  // 5 of 255 is 0.6 of a 5-bit step, 3 of 255 is 0.74 of a 6-bit step: both round up.
  assert.deepEqual([...upload.faces[0]![0]!], [0xffff, 0, (1 << 11) | (1 << 5) | 1])
})

test('16-bit Targa becomes R5G6B5 from its own 5 bits, green widened, the top bit ignored', () => {
  // X1R5G5B5 0x8200 is green 16 and the top bit; 0x7c1f is red and blue at 31.
  for (const format of ['rgb16_555', 'rgba16_5551'] as const) {
    const upload = planUpload(flat({ format, width: 2, levels: [bytes(0x00, 0x82, 0x1f, 0x7c)] }))
    assert.equal(upload.layout, 'rgb565', format)
    // GetTgaSourceFormat: 16 to 6 bits is 33, where through 8 bits it rounds to 32.
    assert.deepEqual([...upload.faces[0]![0]!], [33 << 5, 0xf81f], format)
  }
  // Rows reverse by the pixel, not the byte.
  const top = planUpload(
    flat({ format: 'rgb16_555', height: 2, flip: true, levels: [bytes(1, 0, 2, 0)] }),
  )
  assert.deepEqual([...top.faces[0]![0]!], [2, 1])
})

test('a top-left Targa has its rows reversed in every level, a surface never', () => {
  const rows = bytes(1, 1, 1, 1, 2, 2, 2, 2)
  const first = (fields: Partial<Texture>) => [...planUpload(flat(fields)).faces[0]![0]!]
  assert.deepEqual(first({ height: 2, levels: [rows] }), [...rows])
  assert.deepEqual(first({ height: 2, flip: true, levels: [rows] }), [2, 2, 2, 2, 1, 1, 1, 1])
  assert.deepEqual(
    first({ storage: 'dds', format: 'dxt1', height: 2, flip: true, levels: [rows] }),
    [...rows],
  )
})

test('a surface is little-endian and D3D ordered, and comes out in GL order', () => {
  const one = (format: Texture['format'], level: Uint8Array) =>
    planUpload(flat({ storage: 'dds', format, levels: [level] }))
  // A1R5G5B5 with alpha and all of red, as RGB5_A1.
  assert.deepEqual([...one('rgba16_5551', bytes(0x00, 0xfc)).faces[0]![0]!], [0xf801])
  assert.deepEqual([...one('rgb16_565', bytes(0x34, 0x12)).faces[0]![0]!], [0x1234])
  // X1R5G5B5, which no retail surface is, as RGB5_A1 and opaque.
  assert.deepEqual([...one('rgb16_555', bytes(0x00, 0x7c)).faces[0]![0]!], [0xf801])
  assert.deepEqual([...one('rgba32_8888', bytes(1, 2, 3, 4)).faces[0]![0]!], [3, 2, 1, 4])
})

test('a cube is swapped to RGBA and given a full chain by a rounded box', () => {
  const face = (value: number): Uint8Array[] => [
    bytes(value, 0, 0, 255, value + 1, 0, 0, 255, value + 2, 0, 0, 255, value + 3, 0, 0, 255),
  ]
  const cube: CubeTexture = {
    name: 'cube',
    type: 'cube',
    format: 'rgba32_8888',
    width: 2,
    height: 2,
    flip: true,
    faces: [face(10), face(20), face(30), face(40), face(50), face(60)],
  }
  const { faces, target } = planUpload(cube)
  assert.equal(target, 'cube')
  assert.equal(faces.length, 6)
  assert.equal(faces[0]!.length, 2)
  // 10 + 11 + 12 + 13 is 46: 11.5 rounds up to 12, and blue took the value.
  assert.deepEqual([...faces[0]![1]!], [0, 0, 12, 255])
})

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'

test(
  'every retail texture plans, at the size its layout needs',
  { skip: existsSync(data) ? false : 'no retail DATA' },
  () => {
    const texelBits = { dxt1: 4, dxt3: 8, dxt5: 8, rgb565: 16, rgb5a1: 16, rgba8: 32 }
    forEachLibrary(data, (_, library) => {
      for (const entry of library) {
        if (entry.type === 'animated') continue
        const { faces, layout, width, height } = planUpload(entry)
        for (const levels of faces)
          levels.forEach((level, at) => {
            const w = Math.max(1, width >> at)
            const h = Math.max(1, height >> at)
            const texels = layout.startsWith('dxt')
              ? Math.ceil(w / 4) * Math.ceil(h / 4) * 16
              : w * h
            const expected = (texels * texelBits[layout]) >> 3
            assert.equal(level.byteLength, expected, `${entry.name} level ${at}`)
          })
      }
    })
  },
)

const captured = ['run1-stock-menu', 'li_elite'].map((run) =>
  join(references, run, 'd3d8log.jsonl'),
)

test(
  'planned texels hash the same as retail, at every level of what retail loaded from a file',
  {
    skip: !existsSync(data)
      ? 'no retail DATA'
      : !captured.every((path) => existsSync(path))
        ? 'no captures in references'
        : false,
  },
  () => {
    const index = indexTextures(data)
    const textures = captured.flatMap((path) =>
      readCapture(readFileSync(path, 'utf8')).frames.flatMap(({ draws }) =>
        draws.flatMap(({ stages }) => stages.flatMap(({ texture }) => texture ?? [])),
      ),
    )
    // Left out, because no library holds them: the menu's text (format 25) and its 1024 logo.
    const fromFiles = [...new Set(textures)].filter(
      ({ format, width }) => format !== 25 && width !== 1024,
    )
    assert.ok(fromFiles.length > 25)
    for (const { hash, width, format } of fromFiles)
      hash.forEach((level: string | undefined, at: number) => {
        const size = Math.max(1, width! >> at)
        if (size < 16) return
        const found = index.get(level!)?.some((name) => name.width === size)
        assert.ok(found, `format ${format}, ${width} wide, level ${at} is not a planned level`)
      })
  },
)
