/** GL buffers and vertex arrays for a VMesh. */
import type { VMeshData } from '@treewyrm/freelancer/vmesh'
import { ATTRIBUTE_LOCATIONS, vertexLayout, type ReferencePlan } from './plan.js'

export const createVertexBuffer = (gl: WebGL2RenderingContext, data: VMeshData): WebGLBuffer => {
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW)
  gl.bindBuffer(gl.ARRAY_BUFFER, null)
  return buffer
}

/** A vertex array over a mesh's shared vertices and one reference's own indices. */
export const createReferenceArray = (
  gl: WebGL2RenderingContext,
  data: VMeshData,
  vertices: WebGLBuffer,
  { indices }: ReferencePlan,
): WebGLVertexArrayObject => {
  const { stride, attributes } = vertexLayout(data.format)
  const array = gl.createVertexArray()

  gl.bindVertexArray(array)
  gl.bindBuffer(gl.ARRAY_BUFFER, vertices)
  for (const { name, size, normalizedBytes, offset } of attributes) {
    const location = ATTRIBUTE_LOCATIONS[name]
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(
      location,
      size,
      normalizedBytes ? gl.UNSIGNED_BYTE : gl.FLOAT,
      normalizedBytes,
      stride,
      offset,
    )
  }

  const elements = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elements)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)

  gl.bindVertexArray(null)
  gl.bindBuffer(gl.ARRAY_BUFFER, null)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)
  return array
}
