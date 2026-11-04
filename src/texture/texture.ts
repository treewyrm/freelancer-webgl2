/** GL textures and samplers. */
import type { TextureLayout, TextureUpload } from './upload.js'

interface Format {
  internal: GLenum
  format?: GLenum
  type?: GLenum
}

const FORMATS: Record<TextureLayout, Format> = {
  // Always the RGBA variants: DXT1 selects punch-through per block.
  dxt1: { internal: 0x83f1 },
  dxt3: { internal: 0x83f2 },
  dxt5: { internal: 0x83f3 },
  rgb565: { internal: 0x8d62, format: 0x1907, type: 0x8363 },
  rgb5a1: { internal: 0x8057, format: 0x1908, type: 0x8034 },
  rgba8: { internal: 0x8058, format: 0x1908, type: 0x1401 },
}

/** Creates a texture of exactly the planned levels, so a short chain is still complete. */
export const createTexture = (
  gl: WebGL2RenderingContext,
  { target, layout, width, height, faces }: TextureUpload,
): WebGLTexture => {
  const { internal, format, type } = FORMATS[layout]
  if (format === undefined && !gl.getExtension('WEBGL_compressed_texture_s3tc'))
    throw new Error('WEBGL_compressed_texture_s3tc is not available')

  const bind = target === 'cube' ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D
  const texture = gl.createTexture()
  gl.bindTexture(bind, texture)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texStorage2D(bind, faces[0]!.length, internal, width, height)

  faces.forEach((levels, face) => {
    const destination = target === 'cube' ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + face : gl.TEXTURE_2D
    levels.forEach((pixels, level) => {
      const w = Math.max(1, width >> level)
      const h = Math.max(1, height >> level)
      if (format === undefined)
        gl.compressedTexSubImage2D(destination, level, 0, 0, w, h, internal, pixels)
      else gl.texSubImage2D(destination, level, 0, 0, w, h, format, type!, pixels)
    })
  })

  gl.bindTexture(bind, null)
  return texture
}

export type TextureFilter = 'nearest' | 'linear'
export type TextureWrap = 'repeat' | 'mirror' | 'clamp'

export interface SamplerState {
  magnify: TextureFilter
  minify: TextureFilter
  /** Between mip levels. */
  mipmap: TextureFilter
  wrapU: TextureWrap
  wrapV: TextureWrap
}

/** Retail's on hull stages: bilinear within a level, none between (`li_elite`, and `G_RenderMipFilter`). */
export const DEFAULT_SAMPLER: SamplerState = {
  magnify: 'linear',
  minify: 'linear',
  mipmap: 'nearest',
  wrapU: 'repeat',
  wrapV: 'repeat',
}

const wrapOf = (gl: WebGL2RenderingContext, wrap: TextureWrap): GLenum =>
  wrap === 'repeat' ? gl.REPEAT : wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE

const minifyOf = (gl: WebGL2RenderingContext, { minify, mipmap }: SamplerState): GLenum => {
  if (minify === 'nearest')
    return mipmap === 'nearest' ? gl.NEAREST_MIPMAP_NEAREST : gl.NEAREST_MIPMAP_LINEAR
  return mipmap === 'nearest' ? gl.LINEAR_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_LINEAR
}

export const createSampler = (gl: WebGL2RenderingContext, state: SamplerState): WebGLSampler => {
  const sampler = gl.createSampler()
  gl.samplerParameteri(
    sampler,
    gl.TEXTURE_MAG_FILTER,
    state.magnify === 'linear' ? gl.LINEAR : gl.NEAREST,
  )
  gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, minifyOf(gl, state))
  gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, wrapOf(gl, state.wrapU))
  gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, wrapOf(gl, state.wrapV))
  return sampler
}
