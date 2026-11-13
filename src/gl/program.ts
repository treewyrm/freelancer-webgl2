/** A linked program and its uniform locations. `null` is GL's own: optimized out by the driver. */
export interface Program<U extends string = string> {
  handle: WebGLProgram
  uniforms: Record<U, WebGLUniformLocation | null>
}

const compile = (gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader => {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Cannot create shader')

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)

    gl.deleteShader(shader)
    throw new Error(`Shader compilation failed: ${log}`)
  }

  return shader
}

/** Compiles and links GLSL ES 3.00 sources, looking up the named uniforms once. */
export const createProgram = <U extends string = never>(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  uniforms: readonly U[] = [],
): Program<U> => {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource)
  let fragment: WebGLShader

  try {
    fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  } catch (error) {
    gl.deleteShader(vertex)
    throw error
  }

  const handle = gl.createProgram()

  gl.attachShader(handle, vertex)
  gl.attachShader(handle, fragment)
  gl.linkProgram(handle)

  // Flagged for deletion only: GL keeps them until the program is gone.
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)

  if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(handle)

    gl.deleteProgram(handle)
    throw new Error(`Program link failed: ${log}`)
  }

  const locations = {} as Record<U, WebGLUniformLocation | null>
  for (const name of uniforms) locations[name] = gl.getUniformLocation(handle, name)

  return { handle, uniforms: locations }
}
