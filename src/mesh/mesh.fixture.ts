import {
  Primitive,
  type VertexFormat,
  type VMeshData,
  type VMeshGroup,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import { createProgram } from '#/gl/program.js'
import type { Fixture } from '#/harness.js'
import { createReferenceArray, createVertexBuffer } from './mesh.js'
import { ATTRIBUTE_LOCATIONS, drawMode, planReference, type ReferencePlan } from './plan.js'

export type MeshReport = Record<string, number[]>

const VERTEX = `#version 300 es
layout(location = ${ATTRIBUTE_LOCATIONS.position}) in vec3 position;
layout(location = ${ATTRIBUTE_LOCATIONS.normal}) in vec3 normal;
layout(location = ${ATTRIBUTE_LOCATIONS.diffuse}) in vec4 diffuse;
layout(location = ${ATTRIBUTE_LOCATIONS.uv0}) in vec2 uv0;
layout(location = ${ATTRIBUTE_LOCATIONS.uv1}) in vec2 uv1;
uniform int show;
out vec4 shown;
void main() {
  gl_Position = vec4(position, 1.0);
  shown = show == 0 ? vec4(diffuse.bgr, 1.0)
    : show == 1 ? vec4(normal, 1.0)
    : show == 2 ? vec4(uv0, 0.0, 1.0)
    : vec4(uv1, 0.0, 1.0);
}`

const FRAGMENT = `#version 300 es
precision highp float;
in vec4 shown;
out vec4 color;
void main() { color = shown; }`

// FVF 0x252, the widest retail uses: position, normal, diffuse, two UV sets. 44 bytes.
const STRIDE = 44

/** Three vertices of one big triangle, in the same place whichever `bgra` it wears. */
const writeTriangle = (view: DataView, first: number, bgra: number[], tag: number) => {
  const corners = [
    [-1, -1],
    [3, -1],
    [-1, 3],
  ]
  corners.forEach(([x, y], at) => {
    const from = (first + at) * STRIDE
    const floats = (offset: number, values: number[]) =>
      values.forEach((value, n) => view.setFloat32(from + offset + n * 4, value, true))
    floats(0, [x!, y!, 0])
    floats(12, [tag, 0, 1])
    bgra.forEach((byte, n) => view.setUint8(from + 24 + n, byte))
    floats(28, [1, 0])
    floats(36, [0, 1])
  })
}

const group = (vertexStart: number): VMeshGroup => ({
  materialId: 0,
  vertexStart,
  vertexEnd: vertexStart + 2,
  elementCount: 3,
  padding: 0,
})

const reference = (fields: Partial<VMeshRef>): VMeshRef => ({
  meshId: 0,
  vertexStart: 0,
  vertexCount: 3,
  indexStart: 0,
  indexCount: 3,
  groupStart: 0,
  groupCount: 1,
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
  boundingSphere: { center: { x: 0, y: 0, z: 0 }, radius: 0 },
  ...fields,
})

export default ((gl) => {
  const bytes = new Uint8Array(STRIDE * 9)
  const view = new DataView(bytes.buffer)
  writeTriangle(view, 0, [0, 0, 255, 255], 0)
  writeTriangle(view, 3, [0, 255, 0, 255], 0.25)
  writeTriangle(view, 6, [255, 0, 0, 255], 0.5)

  const data: VMeshData = {
    name: 'test',
    version: 1,
    primitive: Primitive.TriangleList,
    format: 0x252 as VertexFormat,
    groups: [group(0), group(3), group(3)],
    indices: new Uint16Array([0, 1, 2, 0, 1, 2, 0, 1, 2]),
    vertices: bytes,
  }

  const { handle, uniforms } = createProgram(gl, VERTEX, FRAGMENT, ['show'])
  const vertices = createVertexBuffer(gl, data)
  gl.useProgram(handle)

  const draw = (plan: ReferencePlan, at: number, show = 0): number[] => {
    gl.bindVertexArray(createReferenceArray(gl, data, vertices, plan).array)
    gl.uniform1i(uniforms.show, show)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const { byteOffset, count } = plan.groups[at]!
    gl.drawElements(drawMode(data.primitive), count, gl.UNSIGNED_SHORT, byteOffset)
    const pixel = new Uint8Array(4)
    gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    return [...pixel]
  }

  const first = planReference(data, reference({ groupCount: 2, indexCount: 6 }))
  // The third group's base comes from `ref.vertexStart` and its own `vertexStart` together.
  const third = planReference(data, reference({ groupStart: 2, indexStart: 6, vertexStart: 3 }))

  const report: MeshReport = {
    firstGroup: draw(first, 0),
    secondGroup: draw(first, 1),
    summedBases: draw(third, 0),
    normal: draw(first, 1, 1),
    uv0: draw(first, 0, 2),
    uv1: draw(first, 0, 3),
    error: [gl.getError()],
  }
  return report
}) satisfies Fixture<MeshReport>
