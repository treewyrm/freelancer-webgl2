import type { Material } from '@treewyrm/freelancer/material'
import type { Texture } from '@treewyrm/freelancer/texture'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import {
  Primitive,
  type VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import type { Fixture } from '#/harness.js'
import { RETAIL_FLARE_LIGHT } from './flare.js'
import { FlashLight } from './flashlight.js'
import type { Fog } from './nebula.js'
import { createRenderer } from './render.js'
import { collectRoomFrame, type RoomObject } from './room.js'

export interface RoomReport {
  error: number
  /** The middle: a white square 50 away under no fog, then black exp and exp2 fog of 0.01 density. */
  fogged: { none: number[]; exp: number[]; exp2: number[] }
  /** Looking down on a white floor: bare, then under a black fading shadow at its foot. */
  shadow: { bare: number[]; shadowed: number[] }
  /** The middle, over black: a quarter-red flashlight 10 ahead, its glow and bulb added. */
  flashlight: number[]
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

const WHITE: Material = { name: 'flat', type: 'DcDt', diffuse: { x: 1, y: 1, z: 1 } }

// Unlit under the room's white ambient, so it's white before the fog.
const square = (distance: number): RoomObject => ({
  position: { x: 0, y: 0, z: -distance },
  lit: false,
  model: {
    parts: [
      {
        reference,
        world: Matrix4.multiply(
          Matrix4.translation({ x: 0, y: 0, z: -distance }),
          Matrix4.scaling(distance),
        ),
      },
    ],
    mesh: () => mesh,
    material: () => WHITE,
    texture: () => undefined,
  },
})

// A white floor of 40 across, its face up, at the origin.
const floor: RoomObject = {
  position: { x: 0, y: 0, z: 0 },
  lit: false,
  model: {
    parts: [
      {
        reference,
        world: Matrix4.multiply(
          Matrix4.fromRotationTranslation(Matrix3.axisAngle({ x: 1, y: 0, z: 0 }, -Math.PI / 2)),
          Matrix4.scaling(20),
        ),
      },
    ],
    mesh: () => mesh,
    material: () => WHITE,
    texture: () => undefined,
  },
}

// Nothing to draw but its shadow, standing on the floor.
const caster: RoomObject = {
  position: { x: 0, y: 0, z: 0 },
  model: { parts: [], mesh: () => mesh, material: () => WHITE, texture: () => undefined },
  shadow: {
    fading: true,
    floor: 0,
    world: Matrix4.identity,
    bounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 1, z: 1 } },
  },
}

const efxshadow: Texture = {
  type: 'image',
  name: 'efxshadow',
  format: 'rgba32_8888',
  storage: 'targa',
  flip: false,
  width: 1,
  height: 1,
  levels: [new Uint8Array([0, 0, 0, 255])],
}

const white: Texture = {
  ...efxshadow,
  name: 'white',
  levels: [new Uint8Array([255, 255, 255, 255])],
}

export default (async (gl) => {
  const renderer = createRenderer(gl)
  const { width, height } = gl.canvas

  const shot = (fog?: Fog): number[] => {
    renderer.render(
      collectRoomFrame({
        camera: {
          position: { x: 0, y: 0, z: 0 },
          orientation: Matrix3.identity,
          fovh: 45,
          near: 1,
          far: 1000,
        },
        aspect: width / height,
        lights: [],
        objects: [square(50)],
        ...(fog && { fog }),
      }),
    )

    const pixel = new Uint8Array(4)

    gl.readPixels(width >> 1, height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    return [...pixel.subarray(0, 3)]
  }

  const black = { x: 0, y: 0, z: 0 }
  const fogged = {
    none: shot(),
    exp: shot({ color: black, start: 0, end: 0, mode: 'exp', density: 0.01 }),
    exp2: shot({ color: black, start: 0, end: 0, mode: 'exp2', density: 0.01 }),
  }

  const down = (objects: RoomObject[]): number[] => {
    renderer.render(
      collectRoomFrame({
        camera: {
          position: { x: 0, y: 10, z: 0 },
          orientation: Matrix3.axisAngle({ x: 1, y: 0, z: 0 }, -Math.PI / 2),
          fovh: 45,
          near: 1,
          far: 1000,
        },
        aspect: width / height,
        lights: [],
        objects,
        shadows: { texture: efxshadow },
      }),
    )

    const pixel = new Uint8Array(4)

    gl.readPixels(width >> 1, height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    return [...pixel.subarray(0, 3)]
  }

  const shadow = { bare: down([floor]), shadowed: down([floor, caster]) }
  const light = FlashLight.fromLight({ ...RETAIL_FLARE_LIGHT, color: { x: 0.25, y: 0, z: 0 } })

  light.world = Matrix4.translation({ x: 0, y: 0, z: -10 })
  light.update(0)
  renderer.render(
    collectRoomFrame({
      camera: {
        position: { x: 0, y: 0, z: 0 },
        orientation: Matrix3.identity,
        fovh: 45,
        near: 1,
        far: 100,
      },
      aspect: width / height,
      lights: [],
      objects: [],
      flashlights: [light],
      flashlightTextures: { shine: white, bulb: white },
    }),
  )

  const pixel = new Uint8Array(4)

  gl.readPixels(width >> 1, height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)

  const flashlight = [...pixel.subarray(0, 3)]

  return { error: gl.getError(), fogged, shadow, flashlight }
}) satisfies Fixture<RoomReport>
