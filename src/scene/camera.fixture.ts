import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import { createProgram } from '#/gl/program.js'
import type { Fixture } from '#/harness.js'
import { projectionMatrix, viewMatrix, type Camera } from './camera.js'

export interface CameraReport {
  right: number[]
  left: number[]
  culled: number[]
  nearerWins: number[]
  error: number
}

const VERTEX = `#version 300 es
uniform mat4 viewProjection;
in vec3 position;
void main() { gl_Position = viewProjection * vec4(position, 1.0); }`

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 tint;
out vec4 color;
void main() { color = vec4(tint, 1.0); }`

const camera: Camera = {
  position: { x: 0, y: 0, z: 10 },
  orientation: Matrix3.identity,
  fovh: 30,
  near: 1,
  far: 100,
}

// A triangle counter-clockwise when read from +Z, as retail's index order runs seen from outside.
const facing = (x: number, z: number) => [x - 1, -1, z, x + 1, -1, z, x, 1, z]
const backwards = (x: number, z: number) => [x - 1, -1, z, x, 1, z, x + 1, -1, z]

export default ((gl) => {
  const { handle, uniforms } = createProgram(gl, VERTEX, FRAGMENT, ['viewProjection', 'tint'])

  gl.useProgram(handle)

  const matrix = Matrix4.multiply(projectionMatrix(camera, 1), viewMatrix(camera))

  gl.uniformMatrix4fv(uniforms.viewProjection, false, Matrix4.toArray(matrix))

  gl.bindVertexArray(gl.createVertexArray())
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())

  const location = gl.getAttribLocation(handle, 'position')

  gl.enableVertexAttribArray(location)
  gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0)

  gl.enable(gl.CULL_FACE)
  gl.frontFace(gl.CCW)
  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.LEQUAL)

  const draw = (vertices: number[], tint: number[]) => {
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW)
    gl.uniform3f(uniforms.tint, tint[0]!, tint[1]!, tint[2]!)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  const clear = () => {
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  }

  const read = (x: number, y: number) => {
    const pixel = new Uint8Array(4)

    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    return [...pixel]
  }

  const { width, height } = gl.canvas
  const midY = height >> 1
  const atRight = Math.round(width * 0.75)
  const atLeft = Math.round(width * 0.25)

  // World +X lands on the right of the screen, facing front.
  clear()
  draw(facing(3, 0), [1, 0, 0])

  const right = read(atRight, midY)
  const left = read(atLeft, midY)

  clear()
  draw(backwards(3, 0), [1, 0, 0])

  const culled = read(atRight, midY)

  // Drawn far side last: depth keeps the nearer, which is at higher Z.
  clear()
  draw(facing(0, 1), [0, 1, 0])
  draw(facing(0, -1), [0, 0, 1])

  const nearerWins = read(width >> 1, midY)

  return { right, left, culled, nearerWins, error: gl.getError() }
}) satisfies Fixture<CameraReport>
