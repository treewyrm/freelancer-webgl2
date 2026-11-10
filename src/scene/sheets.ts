/**
 * A nebula's fill sheets: `FNebulaEffect::DrawFogShell` (`LAB_00508cf0`) and the sheets it draws
 * (`NebulaUpdateBoltCamera`, `FUN_005074e0`, `cli_nebula.cpp`). Two quads through the zone's centre,
 * each turned about one of its axes to face the camera and faded as the camera comes round to look
 * along that axis, textured with `fill_shape` in the fog's colour. Pure, no GL.
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import {
  Primitive,
  setMapCount,
  VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import { DEFAULT_SAMPLER } from '#/texture/texture.js'
import type { Draw } from './frame.js'
import type { NebulaState, Zone } from './nebula.js'

const f = Math.fround

// XYZ, D3DCOLOR and one UV set: Win3D's FVF 0x142, 24 bytes.
const FORMAT = setMapCount(VertexFormat.Position | VertexFormat.Diffuse, 1)
const STRIDE = 24
const BLACK: Vector3 = { x: 0, y: 0, z: 0 }
const REACH = f(1.15)

const floats = new Float32Array(1)
const bits = new Int32Array(floats.buffer)

// `FUN_00507e70`: one Newton step from `0x5f3759df`, left unrounded.
const inverseRoot = (squared: number): number => {
  floats[0] = squared
  bits[0] = 0x5f3759df - (bits[0]! >> 1)
  const estimate = floats[0]!
  return (1.5 - estimate * estimate * squared * 0.5) * estimate
}

// `ScaleClampToByte`: times 255, truncated, held to a byte.
const byte = (value: number): number => Math.min(Math.max(Math.trunc(f(value * 255)), 0), 255)

const dot = (a: Vector3, b: Vector3): number => a.y * b.y + a.x * b.x + a.z * b.z

const cross = (a: Vector3, b: Vector3): Vector3 => ({
  x: f(b.z * a.y - a.z * b.y),
  y: f(a.z * b.x - b.z * a.x),
  z: f(b.y * a.x - a.y * b.x),
})

const scale = ({ x, y, z }: Vector3, by: number): Vector3 => ({
  x: f(x * by),
  y: f(y * by),
  z: f(z * by),
})

/** A sheet's edge: across the zone, out to its surface that way and 15% past (`0x50777c`). */
const edgeOf = (zone: Zone, edge: Vector3): Vector3 => {
  const unit = scale(edge, inverseRoot(f(edge.x * edge.x + edge.z * edge.z + edge.y * edge.y)))
  const reach = f(f(zone.radiusAlong(unit)) * REACH)
  return scale(unit, reach / Math.sqrt(unit.x * unit.x + unit.y * unit.y + unit.z * unit.z))
}

/** How much of a sheet shows, by how far the camera's look is off its axis: `(1 - |cos|) - by`. */
const facing = (axis: Vector3, look: Vector3, by: number, times: number): number => {
  const raw = (1 - Math.abs(dot(axis, look)) - f(by)) * f(times)
  if (raw > 1) return 1
  return f(raw) < 0 ? 0 : f(raw)
}

/**
 * The sheets for a nebula, or nothing: none once the camera's depth reaches 1, nor without a fill
 * shape, nor when both face the camera. Sheet A stands along the zone's longer of x and z, sheet B
 * along its y, each `size` × 1.15 from the centre, and across it to the zone's surface × 1.15.
 * A sphere written with one value has no y, so its sheet B has no height, and draws.
 *
 * Unlit, unculled, alpha-blended, with no depth test or writes (`DrawFogShell`), under the 250000 far
 * plane its callers set; `projection` is that. Fog and `ALPHAREF` are what the frame left: fog is off
 * wherever retail calls it, as the far list's nodes and `DrawBoltsPass` leave it, and the alpha test
 * is taken as `GREATER 0`. **Uncaptured.**
 */
export const fillSheetsDraw = (
  { nebula, depth }: NebulaState,
  eye: Vector3,
  projection: Matrix4,
): Draw | undefined => {
  const { fill, zone } = nebula
  if (!(depth < 1) || !fill) return undefined
  const { size, position: center } = zone
  const [x, y, z] = zone.axes
  const long = size.x > size.z
  let axisA = long ? x : z
  const axisB = long ? z : x

  // From the camera to the zone: `FUN_00423b60` takes the zone's position first (`0x507644`), where
  // the decomp has it the other way. Only the edges' sign shows it, which `nebula_sheets` captures.
  const offset = { x: f(center.x - eye.x), y: f(center.y - eye.y), z: f(center.z - eye.z) }
  const look = scale(
    offset,
    inverseRoot(f(offset.y * offset.y + offset.x * offset.x + offset.z * offset.z)),
  )

  const faceA = facing(axisA, look, 0.0001, 204.08163)
  const edgeA = edgeOf(zone, cross(look, axisA))
  axisA = scale(axisA, (long ? size.x : size.z) * REACH)

  let faceB = facing(y, look, 0.2, 5)
  // Only a sheet B that shows is refined by the other axis, and not held to 1 then.
  if (faceB > 0) {
    const refined = (1 - Math.abs(dot(axisB, look)) - f(0.2)) * faceB * 5
    faceB = refined < 0 ? 0 : f(refined)
  }
  const edgeB = edgeOf(zone, cross(look, y))
  const axisY = scale(y, f(size.y * REACH))

  const { color } = nebula.fog
  const { u0, v0, u1, v1 } = fill
  const corners: { at: [number, number, number]; uv: [number, number]; alpha: number }[] = []
  const sheet = (edge: Vector3, axis: Vector3, alpha: number, rounded: boolean) => {
    const near = { x: f(center.x + edge.x), y: f(center.y + edge.y), z: f(center.z + edge.z) }
    const far = { x: f(center.x - edge.x), y: f(center.y - edge.y), z: f(center.z - edge.z) }
    // Sheet B's last corner keeps x and y unrounded across both subtractions (`0x507dbf`).
    const lastX = rounded ? f(far.x - axis.x) : f(center.x - edge.x - axis.x)
    const lastY = rounded ? f(far.y - axis.y) : f(center.y - edge.y - axis.y)
    corners.push(
      { at: [f(near.x - axis.x), f(near.y - axis.y), f(near.z - axis.z)], uv: [u0, v0], alpha },
      { at: [f(near.x + axis.x), f(near.y + axis.y), f(near.z + axis.z)], uv: [u1, v0], alpha },
      { at: [f(far.x + axis.x), f(far.y + axis.y), f(far.z + axis.z)], uv: [u1, v1], alpha },
      { at: [lastX, lastY, f(far.z - axis.z)], uv: [u0, v1], alpha },
    )
  }
  if (faceA > 0) sheet(edgeA, axisA, faceA, true)
  if (faceB > 0) sheet(edgeB, axisY, faceB, false)
  if (!corners.length) return undefined

  const vertices = new Uint8Array(corners.length * STRIDE)
  const view = new Float32Array(vertices.buffer)
  corners.forEach(({ at, uv, alpha }, index) => {
    view.set(at, (index * STRIDE) / 4)
    vertices.set([byte(color.z), byte(color.y), byte(color.x), byte(alpha)], index * STRIDE + 12)
    view.set(uv, (index * STRIDE + 16) / 4)
  })
  // `Win3DEnd` makes each quad (0, 1, 2) and (0, 2, 3).
  const indices = new Uint16Array(
    Array.from({ length: corners.length / 4 }, (_, quad) =>
      [0, 1, 2, 0, 2, 3].map((corner) => quad * 4 + corner),
    ).flat(),
  )
  const mesh: VMeshData = {
    name: 'fill sheets',
    version: 1,
    primitive: Primitive.TriangleList,
    format: FORMAT,
    groups: [
      {
        materialId: 0,
        vertexStart: 0,
        vertexEnd: corners.length - 1,
        elementCount: indices.length,
        padding: 0,
      },
    ],
    indices,
    vertices,
  }
  const reference: VMeshRef = {
    meshId: 0,
    vertexStart: 0,
    vertexCount: corners.length,
    indexStart: 0,
    indexCount: indices.length,
    groupStart: 0,
    groupCount: 1,
    boundingBox: { min: BLACK, max: BLACK },
    boundingSphere: { center: BLACK, radius: 0 },
  }
  return {
    mesh,
    reference,
    transient: true,
    byteOffset: 0,
    count: indices.length,
    // In world space, under the camera's own view (`Win3DApplyCamera`).
    world: Matrix4.identity,
    projection,
    materialName: 'fill sheets',
    diffuse: [1, 1, 1, 1],
    ambient: BLACK,
    emissive: BLACK,
    colorVertex: true,
    nomad: false,
    // Frame 0 of the shape's texture (`TexShapeGetGpuHandle`).
    texture: { name: fill.texture.name, entry: fill.texture, sampler: DEFAULT_SAMPLER, uvSet: 0 },
    cull: 'none',
    depthWrite: false,
    depthFunc: 'always',
    lightless: true,
    negateNormals: false,
    normalizeNormals: false,
    blend: true,
    blendMode: 'alpha',
    unlit: true,
    alphaReference: 0,
    alphaFunction: 'greater',
  }
}
