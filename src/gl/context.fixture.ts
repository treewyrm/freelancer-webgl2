import type { Fixture } from '#/harness.js'

export interface ContextReport {
  version: string
  pixel: number[]
  s3tc: boolean
}

export default ((gl) => {
  gl.clearColor(1, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)

  const pixel = new Uint8Array(4)

  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)

  return {
    version: gl.getParameter(gl.VERSION) as string,
    pixel: [...pixel],
    s3tc: gl.getExtension('WEBGL_compressed_texture_s3tc') !== null,
  }
}) satisfies Fixture<ContextReport>
