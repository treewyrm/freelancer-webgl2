/** Acquires a WebGL2 context, or throws: the renderer has no fallback for its absence. */
export const createContext = (
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options?: WebGLContextAttributes,
): WebGL2RenderingContext => {
  const gl = canvas.getContext('webgl2', options) as WebGL2RenderingContext | null
  if (!gl) throw new Error('WebGL2 is not available')
  return gl
}
