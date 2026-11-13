/** From a captured texture's content hash back to the library entries that hold those pixels. */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { crc32 } from 'node:zlib'
import { readTextureLibrary, type TextureEntry } from '@treewyrm/freelancer/texture'
import { Directory, isUTF } from '@treewyrm/freelancer/utf'
import { planUpload, type TextureUpload } from '#/texture/upload.js'
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

/** Retail's memory order: D3D's A8R8G8B8 and A1R5G5B5 are not GL's. */
const asDevice = ({ layout }: TextureUpload, pixels: Uint8Array | Uint16Array): Uint8Array => {
  if (layout === 'rgb5a1') {
    const output = (pixels as Uint16Array).map((pixel) => (pixel >> 1) | ((pixel & 1) << 15))

    return new Uint8Array(output.buffer)
  }

  if (layout === 'rgba8') {
    const output = (pixels as Uint8Array).slice()

    for (let at = 0; at < output.length; at += 4) {
      output[at] = pixels[at + 2]!
      output[at + 2] = pixels[at]!
    }

    return output
  }

  return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)
}

/** The proxy hashes a cube's level as its six faces in a row, +X first. */
const inARow = (levels: Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(levels.reduce((total, level) => total + level.length, 0))
  let offset = 0

  for (const level of levels) {
    output.set(level, offset)
    offset += level.length
  }

  return output
}

/** Adds every usable level of a library to the index, as retail's device holds it. */
export const addLibrary = (
  index: TextureIndex,
  source: string,
  library: Iterable<TextureEntry>,
): void => {
  for (const entry of library) {
    if (entry.type === 'animated') continue

    const upload = planUpload(entry)

    upload.faces[0]!.forEach((_, at) => {
      const width = Math.max(1, upload.width >> at)
      const height = Math.max(1, upload.height >> at)
      if (width < SMALLEST_LEVEL || height < SMALLEST_LEVEL) return

      const hash = contentHash(inARow(upload.faces.map((face) => asDevice(upload, face[at]!))))
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

/** Calls back with every texture library under a `DATA` directory. */
export const forEachLibrary = (
  root: string,
  visit: (source: string, library: Iterable<TextureEntry>) => void,
): void => {
  for (const path of filesUnder(root)) {
    const file = readFileSync(path)
    const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
    if (bytes.byteLength < 4 || !isUTF(bytes)) continue
    visit(relative(root, path), readTextureLibrary(Directory.read(bytes)))
  }
}

/** Indexes every texture library under a `DATA` directory. */
export const indexTextures = (root: string): TextureIndex => {
  const index: TextureIndex = new Map()

  forEachLibrary(root, (source, library) => addLibrary(index, source, library))
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
