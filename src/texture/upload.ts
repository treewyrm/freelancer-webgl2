/** What a library texture becomes on the GPU: the same texels retail's device held. Pure, no GL. */
import type { CubeTexture, Texture } from '@treewyrm/freelancer/texture'

export type TextureLayout = 'dxt1' | 'dxt3' | 'dxt5' | 'rgb565' | 'rgb5a1' | 'rgba8'

export interface TextureUpload {
  target: '2d' | 'cube'
  layout: TextureLayout
  width: number
  height: number
  /** By face, then by level. A flat texture has one face. 16-bit layouts hold `Uint16Array`s. */
  faces: (Uint8Array | Uint16Array)[][]
}

const toLittleEndian16 = (bytes: Uint8Array): Uint16Array => {
  const output = new Uint16Array(bytes.length >> 1)
  for (let at = 0; at < output.length; at++) output[at] = bytes[at * 2]! | (bytes[at * 2 + 1]! << 8)
  return output
}

/** To `bits` by rounding, as D3DX loads a surface. Truncating fails retail's hashes on large levels. */
const narrow = (value: number, bits: number): number => {
  const top = (1 << bits) - 1
  return Math.floor((value * top) / 255 + 0.5)
}

/**
 * A Targa without alpha reaches retail's device as R5G6B5 (`DAOT`; captures, format 23). Hashes pin
 * this for colour-mapped and 24-bit chains. The library has expanded 16-bit Targas to 24-bit by here,
 * and through 8 bits green comes out one step dark from 16 up: retail rounds 5 bits to 6
 * (`code_beam` in `beam_shots`, `src/reference/beams.test.ts`). 102 retail chains are 16-bit.
 */
const rgbToRgb565 = (level: Uint8Array): Uint16Array => {
  const output = new Uint16Array(level.length / 3)
  for (let at = 0; at < output.length; at++)
    output[at] =
      (narrow(level[at * 3]!, 5) << 11) |
      (narrow(level[at * 3 + 1]!, 6) << 5) |
      narrow(level[at * 3 + 2]!, 5)
  return output
}

/** D3D's A1R5G5B5 has alpha on top, GL's RGB5_A1 at the bottom. */
const argb1555ToRgba5551 = (level: Uint8Array): Uint16Array =>
  toLittleEndian16(level).map((pixel) => ((pixel << 1) & 0xffff) | (pixel >> 15))

const swapRedBlue = (level: Uint8Array): Uint8Array => {
  const output = level.slice()
  for (let at = 0; at < level.length; at += 4) {
    output[at] = level[at + 2]!
    output[at + 2] = level[at]!
  }
  return output
}

const bgrToRgba = (level: Uint8Array): Uint8Array => {
  const output = new Uint8Array((level.length / 3) * 4)
  for (let at = 0; at < level.length / 3; at++) {
    output[at * 4] = level[at * 3 + 2]!
    output[at * 4 + 1] = level[at * 3 + 1]!
    output[at * 4 + 2] = level[at * 3]!
    output[at * 4 + 3] = 0xff
  }
  return output
}

/** Reverses rows: `shading.dll` does so for a top-left Targa (`DecodeTgaTexture`). No capture yet. */
const reverseRows = (level: Uint8Array, height: number): Uint8Array => {
  const row = level.length / height
  const output = new Uint8Array(level.length)
  for (let y = 0; y < height; y++)
    output.set(level.subarray(y * row, (y + 1) * row), (height - 1 - y) * row)
  return output
}

const flatLayout = ({ format, storage }: Texture): TextureLayout => {
  switch (format) {
    case 'dxt1':
    case 'dxt3':
    case 'dxt5':
      return format
    case 'rgb16_565':
      return 'rgb565'
    case 'rgba16_5551':
      return 'rgb5a1'
    case 'rgba32_8888':
      return 'rgba8'
    case 'rgb24_888':
      // Two DDS surfaces in `FX/rtc_scene02_e.txm`. Uncaptured, so their device format is a guess.
      return storage === 'targa' ? 'rgb565' : 'rgba8'
    default:
      throw new RangeError(`No retail texture uses ${format}`)
  }
}

const flatLevel = (texture: Texture, level: Uint8Array, at: number) => {
  const { format, storage, flip, height } = texture
  if (storage === 'targa') {
    // The library has already put a Targa in RGB order.
    const rows = flip ? reverseRows(level, Math.max(1, height >> at)) : level
    return format === 'rgb24_888' ? rgbToRgb565(rows) : rows
  }
  // A surface is as stored, whatever its header's origin says.
  switch (format) {
    case 'rgb16_565':
      return toLittleEndian16(level)
    case 'rgba16_5551':
      return argb1555ToRgba5551(level)
    case 'rgba32_8888':
      return swapRedBlue(level)
    case 'rgb24_888':
      return bgrToRgba(level)
    default:
      return level
  }
}

/** One level down by a 2x2 box, rounded: matches every generated level of retail's two cubes. */
const halve = (level: Uint8Array, size: number): Uint8Array => {
  const half = size >> 1
  const output = new Uint8Array(half * half * 4)
  for (let y = 0; y < half; y++)
    for (let x = 0; x < half; x++)
      for (let channel = 0; channel < 4; channel++) {
        const texel = (row: number, column: number) => level[(row * size + column) * 4 + channel]!
        const sum =
          texel(y * 2, x * 2) +
          texel(y * 2, x * 2 + 1) +
          texel(y * 2 + 1, x * 2) +
          texel(y * 2 + 1, x * 2 + 1)
        output[(y * half + x) * 4 + channel] = (sum + 2) >> 2
      }
  return output
}

/** The rest of a cube's chain: the file holds one level, and D3DX loads it with a full chain. */
const cubeChain = (levels: Uint8Array[], width: number): Uint8Array[] => {
  const chain = levels.map(swapRedBlue)
  for (let size = width >> (chain.length - 1); size > 1; size >>= 1)
    chain.push(halve(chain.at(-1)!, size))
  return chain
}

/** What to upload for a texture. Animated entries have no pixels of their own, so don't come here. */
export const planUpload = (texture: Texture | CubeTexture): TextureUpload => {
  const { width, height } = texture
  if (texture.type === 'cube') {
    if (texture.format !== 'rgba32_8888') throw new RangeError(`No cube uses ${texture.format}`)
    return {
      target: 'cube',
      layout: 'rgba8',
      width,
      height,
      faces: texture.faces.map((levels) => cubeChain(levels, width)),
    }
  }
  return {
    target: '2d',
    layout: flatLayout(texture),
    width,
    height,
    faces: [texture.levels.map((level, at) => flatLevel(texture, level, at))],
  }
}
