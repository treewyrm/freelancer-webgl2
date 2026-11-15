import type { CompoundNode } from '@treewyrm/freelancer/compound'
import type { Material } from '@treewyrm/freelancer/material'
import { Matrix4 } from '@treewyrm/freelancer/math'
import type { RigidPart } from '@treewyrm/freelancer/rigid'
import { Primitive, type VertexFormat, type VMeshData } from '@treewyrm/freelancer/vmesh'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { placeParts, type SceneModel } from './frame.js'
import {
  collectInterfaceFrame,
  INTERFACE_AMBER,
  INTERFACE_CAMERA,
  INTERFACE_CYAN,
  INTERFACE_GREY,
  InterfacePulse,
  interfaceWorld,
  spinAngle,
  tintOf,
} from './interface.js'

const f = Math.fround

// FVF 0x102, XYZ and one UV set, as `interface.generic.vms` holds every interface mesh.
const mesh: VMeshData = {
  name: 'square',
  version: 1,
  primitive: Primitive.TriangleList,
  format: 0x102 as VertexFormat,
  groups: [{ materialId: 1, vertexStart: 0, vertexEnd: 3, elementCount: 6, padding: 0 }],
  indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  vertices: new Uint8Array(
    new Float32Array([-1, -1, 0, 0, 0, 1, -1, 0, 1, 0, 1, 1, 0, 1, 1, -1, 1, 0, 0, 1]).buffer,
  ),
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

const modelOf = (material: Material, z: number, tint = INTERFACE_CYAN): SceneModel => ({
  parts: placeParts(part, interfaceWorld({ x: 0, y: 0, z })),
  mesh: () => mesh,
  material: () => material,
  texture: () => undefined,
  instance: tintOf(tint),
})

describe('the interface', () => {
  test("sees through Win3D's camera: x = tan 27.216° at z = -1 is the screen's right edge", () => {
    const frame = collectInterfaceFrame({ aspect: 4 / 3, models: [] })
    const edge = Matrix4.transformPoint({ x: 0, y: 0, z: -1 }, frame.view)
    const { x: sx, w: sw } = frame.projection.x
    const tan = Math.tan((INTERFACE_CAMERA.fovh * Math.PI) / 180)

    assert.equal(INTERFACE_CAMERA.fovh, f(27.216))
    assert.deepEqual(edge, { x: 0, y: 0, z: -1 })
    // x_ndc = sx · x / -z: a point at x = tan, z = -1 lands on 1.
    assert.ok(Math.abs(sx * tan - 1) < 1e-6 && sw === 0)
  })

  test('draws every model in order, unculled, depth neither tested nor written', () => {
    const frame = collectInterfaceFrame({
      aspect: 4 / 3,
      models: [
        modelOf({ name: 'ui_city_bar', type: 'DcDt' }, -1),
        modelOf({ name: 'HUD_frame', type: 'DcDt', diffuse: { x: 0.5, y: 0.5, z: 0.5 } }, -2),
      ],
    })

    assert.deepEqual(
      frame.draws.map(({ materialName, cull, depthFunc, depthWrite }) => [
        materialName,
        cull,
        depthFunc,
        depthWrite,
      ]),
      [
        ['ui_city_bar', 'none', 'always', false],
        ['HUD_frame', 'none', 'always', false],
      ],
    )
    assert.deepEqual(frame.ambient, { x: 1, y: 1, z: 1 })
    assert.deepEqual(frame.lights, [])
  })

  test("tints a ui_ material through HUDIconMaterial, and leaves any other material's own colour", () => {
    const [icon, frameDraw] = collectInterfaceFrame({
      aspect: 4 / 3,
      models: [
        modelOf({ name: 'UI_CITY_bar', type: 'DcDt' }, -1),
        modelOf({ name: 'HUD_frame', type: 'DcDt', diffuse: { x: 0.5, y: 0.5, z: 0.5 } }, -1),
      ],
    }).draws

    assert.deepEqual(icon!.ambient, tintOf(INTERFACE_CYAN).ambient)
    assert.deepEqual(frameDraw!.ambient, { x: 0.5, y: 0.5, z: 0.5 })
  })

  test('pulses from grey to amber after a reset, then back through grey to cyan', () => {
    const pulse = new InterfacePulse()

    pulse.reset()
    assert.deepEqual(pulse.colour, INTERFACE_GREY)

    pulse.advance(0.15)
    assert.deepEqual(pulse.colour, INTERFACE_AMBER)

    // Past the half cycle the direction flips: amber, then grey, then cyan at its end.
    pulse.advance(0.001)
    assert.equal(pulse.direction, 1)
    pulse.advance(0.149)
    assert.deepEqual(pulse.colour.slice(0, 3), INTERFACE_GREY.slice(0, 3))
    pulse.advance(0.15)
    assert.deepEqual(pulse.colour, INTERFACE_CYAN)
  })

  test('spins forward while hovered, and homes the short way at twice the speed', () => {
    assert.equal(spinAngle(0, true, 0.5), 90)
    assert.equal(spinAngle(90, false, 0.1), f(54))
    assert.equal(spinAngle(200, false, 0.1), f(236))
    assert.equal(spinAngle(350, false, 0.1), 0)
    assert.equal(spinAngle(10, false, 0.1), 0)
  })
})
