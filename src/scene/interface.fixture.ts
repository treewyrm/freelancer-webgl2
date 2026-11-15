import type { CompoundNode } from '@treewyrm/freelancer/compound'
import type { Material } from '@treewyrm/freelancer/material'
import { Matrix3 } from '@treewyrm/freelancer/math'
import type { RigidPart } from '@treewyrm/freelancer/rigid'
import { Primitive, type VertexFormat, type VMeshData } from '@treewyrm/freelancer/vmesh'
import type { Fixture } from '#/harness.js'
import { collectFrame, placeParts, type SceneModel } from './frame.js'
import {
  BUTTON_SELECTED,
  collectInterfaceFrame,
  INTERFACE_CYAN,
  interfaceWorld,
  tintOf,
  type InterfaceColour,
} from './interface.js'
import { createRenderer } from './render.js'

export interface InterfaceReport {
  error: number
  /** The corner's pixel: the frame beneath, kept. */
  corner: number[]
  /** The left square's: a `ui_` material in its tint. */
  tinted: number[]
  /** The middle, where a far square drawn second overlaps a near one drawn first. */
  overlap: number[]
  /** The right square's, wound to face away. */
  backFacing: number[]
}

// FVF 0x102: a square of half-size `size` at `x`, its corners counter-clockwise from +Z, or not.
const meshOf = (x: number, size: number, facing: boolean): VMeshData => {
  const corners = [
    [x - size, -size],
    [x + size, -size],
    [x + size, size],
    [x - size, size],
  ]

  return {
    name: `square${x}`,
    version: 1,
    primitive: Primitive.TriangleList,
    format: 0x102 as VertexFormat,
    groups: [{ materialId: 1, vertexStart: 0, vertexEnd: 3, elementCount: 6, padding: 0 }],
    indices: new Uint16Array(facing ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]),
    vertices: new Uint8Array(
      new Float32Array(corners.flatMap(([a, b]) => [a!, b!, 0, 0, 0])).buffer,
    ),
  }
}

const part: CompoundNode<RigidPart> = {
  type: 'compound',
  name: 'Root',
  index: 0,
  filename: 'root.3db',
  part: {
    type: 'rigid',
    hardpoints: [],
    part: {
      type: 'vmeshpart',
      reference: {
        meshId: 1,
        vertexStart: 0,
        vertexCount: 4,
        indexStart: 0,
        indexCount: 6,
        groupStart: 0,
        groupCount: 1,
        boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
        boundingSphere: { center: { x: 0, y: 0, z: 0 }, radius: 0 },
      },
    },
  },
  children: [],
}

const ICON: Material = { name: 'UI_test', type: 'DcDt' }

const modelOf = (mesh: VMeshData, z: number, tint: InterfaceColour): SceneModel => ({
  parts: placeParts(part, interfaceWorld({ x: 0, y: 0, z })),
  mesh: () => mesh,
  material: () => ICON,
  texture: () => undefined,
  instance: tintOf(tint),
})

export default ((gl) => {
  const renderer = createRenderer(gl)
  const { drawingBufferWidth: width, drawingBufferHeight: height } = gl
  const read = (x: number, y: number) => {
    const pixel = new Uint8Array(4)

    gl.readPixels(
      Math.round(x * width),
      Math.round(y * height),
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixel,
    )
    return [...pixel]
  }

  // The frame beneath: nothing but its blue background.
  renderer.render(
    collectFrame({
      camera: {
        position: { x: 0, y: 0, z: 0 },
        orientation: Matrix3.identity,
        fovh: 45,
        near: 1,
        far: 10,
      },
      aspect: width / height,
      ambient: { x: 1, y: 1, z: 1 },
      lights: [],
      models: [],
      background: { x: 0, y: 0, z: 1 },
    }),
  )

  // At z = -1 the screen spans x ±0.514. The left square in cyan; a near square in yellow, then a
  // far one twice as distant and twice as big, so the same size on screen, in cyan over it; and a
  // back-facing one on the right.
  renderer.render(
    collectInterfaceFrame({
      aspect: width / height,
      models: [
        modelOf(meshOf(-0.3, 0.08, true), -1, INTERFACE_CYAN),
        modelOf(meshOf(0, 0.08, true), -1, BUTTON_SELECTED),
        modelOf(meshOf(0, 0.16, true), -2, INTERFACE_CYAN),
        modelOf(meshOf(0.3, 0.08, false), -1, BUTTON_SELECTED),
      ],
    }),
    {},
    { over: true },
  )

  // Window coordinates run up from the bottom; every square sits on the middle row.
  return {
    error: gl.getError(),
    corner: read(0.02, 0.02),
    tinted: read((1 - 0.3 / 0.514283) / 2, 0.5),
    overlap: read(0.5, 0.5),
    backFacing: read((1 + 0.3 / 0.514283) / 2, 0.5),
  }
}) satisfies Fixture<InterfaceReport>
