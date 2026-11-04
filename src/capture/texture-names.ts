/** From a captured texture's content hash back to the library entries that hold those pixels. */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { crc32 } from 'node:zlib'
import {
  readTextureLibrary,
  type CubeFaces,
  type Texture,
  type TextureEntry,
} from '@treewyrm/freelancer/texture'
import { Directory, isUTF } from '@treewyrm/freelancer/utf'
import type { CaptureTexture } from './capture.js'

export interface TextureName {
  /** Path of the file holding the library, relative to `DATA`. */
  source: string
  name: string
}

/** Content hash to the textures whose level has that content, at that width. */
export type TextureIndex = Map<string, (TextureName & { width: number })[]>

// Small levels are too often a flat colour to identify anything.
const SMALLEST_LEVEL = 16

const hex = (value: number): string => value.toString(16).padStart(8, '0')

const fnv1a = (bytes: Uint8Array): number => {
  let hash = 0x811c9dc5
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193)
  return hash >>> 0
}

/** The proxy's texture hash: CRC-32 then FNV-1a. See `tools/d3d8log/src/capture.cpp`. */
export const contentHash = (bytes: Uint8Array): string => hex(crc32(bytes)) + hex(fnv1a(bytes))

/** Blue, green, red bytes to `D3DFMT_R5G6B5`. */
const toR5G6B5 = (level: Uint8Array): Uint8Array => {
  const output = new Uint8Array((level.length / 3) * 2)
  for (let from = 0, to = 0; from < level.length; from += 3, to += 2) {
    const pixel =
      ((level[from + 2]! >> 3) << 11) | ((level[from + 1]! >> 2) << 5) | (level[from]! >> 3)
    output[to] = pixel & 0xff
    output[to + 1] = pixel >> 8
  }
  return output
}

/**
 * A level as RP8 uploads it. Measured against the stock menu capture: Targa rows arrive exactly as
 * stored, unflipped whatever the file's origin says, and 24-bit becomes R5G6B5 by truncation.
 */
const uploaded = (entry: Texture, level: Uint8Array): Uint8Array =>
  entry.storage === 'targa' && entry.format === 'rgb24_888' ? toR5G6B5(level) : level

/** The proxy hashes a cube's level as its six faces in a row, +X first. */
const cubeLevels = (faces: CubeFaces): Uint8Array[] =>
  faces[0].map((_, at) => {
    const levels = faces.map((face) => face[at] ?? new Uint8Array())
    const output = new Uint8Array(levels.reduce((total, level) => total + level.length, 0))
    let offset = 0
    for (const level of levels) {
      output.set(level, offset)
      offset += level.length
    }
    return output
  })

const addEntry = (
  index: TextureIndex,
  source: string,
  name: string,
  width: number,
  levels: Uint8Array[],
): void =>
  levels.forEach((level, at) => {
    const hash = contentHash(level)
    index.set(hash, [...(index.get(hash) ?? []), { source, name, width: Math.max(1, width >> at) }])
  })

/** Adds every usable level of a library to the index. */
export const addLibrary = (
  index: TextureIndex,
  source: string,
  library: Iterable<TextureEntry>,
): void => {
  for (const entry of library) {
    if (entry.type === 'cube') {
      addEntry(index, source, entry.name, entry.width, cubeLevels(entry.faces))
      continue
    }
    if (entry.type !== 'image') continue
    entry.levels.forEach((level, at) => {
      const width = Math.max(1, entry.width >> at)
      const height = Math.max(1, entry.height >> at)
      if (width < SMALLEST_LEVEL || height < SMALLEST_LEVEL) return

      const hash = contentHash(uploaded(entry, level))
      const names = index.get(hash) ?? []
      names.push({ source, name: entry.name, width })
      index.set(hash, names)
    })
  }
}

const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })

/** Indexes every texture library under a `DATA` directory. */
export const indexTextures = (root: string): TextureIndex => {
  const index: TextureIndex = new Map()
  for (const path of filesUnder(root)) {
    const file = readFileSync(path)
    const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
    if (bytes.byteLength < 4 || !isUTF(bytes)) continue
    addLibrary(index, relative(root, path), readTextureLibrary(Directory.read(bytes)))
  }
  return index
}

/** The entries holding a captured texture, by its largest level that is found at the same width. */
export const namesOf = (index: TextureIndex, texture: CaptureTexture): TextureName[] => {
  if (texture.width === undefined) return []
  for (const [at, hash] of texture.hash.entries()) {
    const width = Math.max(1, texture.width >> at)
    const names = hash === undefined ? [] : (index.get(hash) ?? [])
    const matching = names.filter((name) => name.width === width)
    if (matching.length) return matching.map(({ source, name }) => ({ source, name }))
  }
  return []
}
