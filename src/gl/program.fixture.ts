import { Matrix4 } from '@treewyrm/freelancer/math'
import type { Fixture } from '#/harness.js'
import { createProgram } from './program.js'

export interface ProgramReport {
  center: number[]
  translated: number[]
  compileError?: string
}

const VERTEX = `#version 300 es
uniform mat4 transform;
in vec2 position;
void main() { gl_Position = transform * vec4(position, 0.0, 1.0); }
`

const FRAGMENT = `#version 300 es
precision highp float;
out vec4 color;
void main() { color = vec4(0.0, 1.0, 0.0, 1.0); }
`

const readPixel = (gl: WebGL2RenderingContext, x: number, y: number): number[] => {
  const pixel = new Uint8Array(4)
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
  return [...pixel]
}

const getCompileError = (gl: WebGL2RenderingContext): string | undefined => {
  try {
    createProgram(gl, VERTEX, '#version 300 es\nnot glsl')
  } catch (error) {
    return (error as Error).message
  }
}

export default ((gl) => {
  const { handle, uniforms } = createProgram(gl, VERTEX, FRAGMENT, ['transform'])
  const vertices = new Float32Array([-0.5, -0.5, 0.5, -0.5, 0, 0.5])

  gl.bindVertexArray(gl.createVertexArray())
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
  gl.enableVertexAttribArray(gl.getAttribLocation(handle, 'position'))
  gl.vertexAttribPointer(gl.getAttribLocation(handle, 'position'), 2, gl.FLOAT, false, 0, 0)

  gl.useProgram(handle)
  gl.uniformMatrix4fv(
    uniforms.transform,
    false,
    Matrix4.toArray(Matrix4.translation({ x: 0.5, y: 0, z: 0 })),
  )

  gl.clearColor(0, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.drawArrays(gl.TRIANGLES, 0, 3)

  // The triangle's own center, then where the translation should have moved it.
  const center = readPixel(gl, 32, 26)
  const translated = readPixel(gl, 48, 26)
  const compileError = getCompileError(gl)

  return { center, translated, ...(compileError ? { compileError } : {}) }
}) satisfies Fixture<ProgramReport>
