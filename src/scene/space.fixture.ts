import type { Material } from '@treewyrm/freelancer/material'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import {
  Primitive,
  type VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import type { Fixture } from '#/harness.js'
import { createRenderer } from './render.js'
import { collectSpaceFrame, type SpaceObject } from './space.js'

export interface SpaceReport {
  error: number
  /** The middle of the view, then near a corner, in each scene. */
  beyondFar: number[][]
  noDepth: number[][]
  withDepth: number[][]
}

// A square of half-size 1 facing +Z: FVF 0x112.
const vertices = new Float32Array(
  [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].flatMap(([x, y]) => [x!, y!, 0, 0, 0, 1, 0, 0]),
)
const mesh: VMeshData = {
  name: 'square',
  version: 1,
  primitive: Primitive.TriangleList,
  format: 0x112 as VertexFormat,
  groups: [{ materialId: 1, vertexStart: 0, vertexEnd: 3, elementCount: 6, padding: 0 }],
  indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  vertices: new Uint8Array(vertices.buffer),
}
const reference: VMeshRef = {
  meshId: 1,
  vertexStart: 0,
  vertexCount: 4,
  indexStart: 0,
  indexCount: 6,
  groupStart: 0,
  groupCount: 1,
  boundingBox: { min: { x: -1, y: -1, z: 0 }, max: { x: 1, y: 1, z: 0 } },
  boundingSphere: { center: { x: 0, y: 0, z: 0 }, radius: 1.5 },
}

const MATERIAL = { name: 'flat', type: 'DcDt' }

/** `distance` is where it sorts, and `drawnAt` where its square stands, as wide as `scale`. */
const square = (
  color: [number, number, number],
  distance: number,
  drawnAt: number,
  scale: number,
  fields: Partial<SpaceObject> = {},
): SpaceObject => {
  const material: Material = { ...MATERIAL, diffuse: { x: color[0], y: color[1], z: color[2] } }
  const position = { x: 0, y: 0, z: -distance }
  return {
    position,
    sphere: { center: position, radius: 1.5 * scale },
    model: {
      parts: [
        {
          reference,
          world: Matrix4.multiply(
            Matrix4.translation({ x: 0, y: 0, z: -drawnAt }),
            Matrix4.scaling(scale),
          ),
        },
      ],
      mesh: () => mesh,
      material: () => material,
      texture: () => undefined,
    },
    ...fields,
  }
}

const SOLAR = { solar: { large: true } }
const RED: [number, number, number] = [1, 0, 0]
const GREEN: [number, number, number] = [0, 1, 0]

export default (async (gl) => {
  const renderer = createRenderer(gl)
  const { width, height } = gl.canvas
  const read = (x: number, y: number): number[] => {
    const pixel = new Uint8Array(4)
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    return [...pixel.subarray(0, 3)]
  }
  const shot = (objects: SpaceObject[]): number[][] => {
    renderer.render(
      collectSpaceFrame({
        camera: {
          position: { x: 0, y: 0, z: 0 },
          orientation: Matrix3.identity,
          fovh: 45,
          near: 1,
          far: 1,
        },
        aspect: width / height,
        // Ambient alone, so a square reads as its `Dc`.
        ambient: { x: 1, y: 1, z: 1 },
        lights: [],
        objects,
      }),
    )
    return [read(width >> 1, height >> 1), read(4, 4)]
  }

  const beyondFar = shot([
    // Far past the pass's plane of 21000, filling the view.
    square(RED, 100000, 100000, 200000, SOLAR),
    square(GREEN, 500, 500, 100),
  ])
  // The solar's square stands in front of the ship, and neither stops it nor leaves it depth to lose to.
  const noDepth = shot([square(RED, 30000, 50, 1000, SOLAR), square(GREEN, 500, 500, 100)])
  // The same two squares on the main list: now depth decides.
  const withDepth = shot([square(RED, 600, 50, 1000), square(GREEN, 500, 500, 100)])

  renderer.dispose()
  return { error: gl.getError(), beyondFar, noDepth, withDepth }
}) satisfies Fixture<SpaceReport>
