/**
 * An asteroid field's cubes: one mesh of its `[Cube]` asteroids, drawn at every cube of a grid near
 * the camera that the zone holds, no exclusion zone takes, and its id doesn't leave empty, each
 * turned by its id. `CliAsteroidDrawNearField` (`FUN_00522a60`) and `CliAsteroidMergeCubeMesh` in
 * `src/freelancer/Client/cli_asteroid.cpp`; the grid, ids and rotations are Common's
 * (`common_casteroid.cpp`, `common_casteroidfield.cpp`). Deterministic. Pure, no GL.
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import {
  getMeshDraw,
  Primitive,
  setMapCount,
  vertexByteLength,
  VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import { vertexLayout } from '#/mesh/plan.js'
import type { AsteroidBand } from './band.js'
import type { AsteroidBillboards } from './billboards.js'
import type { Camera } from './camera.js'
import type { DynamicAsteroids } from './dynamic.js'
import type { SceneModel } from './frame.js'
import { immersion, type Zone } from './nebula.js'

const f = Math.fround

/** Each axis's four angles in radians, `[Cube]`'s `xaxis_rotation` and the rest. */
export type CubeRotations = readonly [readonly number[], readonly number[], readonly number[]]

/** `CAsteroidField`'s constructor: quarter turns about each axis. */
export const RETAIL_CUBE_ROTATIONS: CubeRotations = [0, 1, 2].map(() => [
  0,
  f(1.5707963),
  f(3.14159265),
  f(4.71238898),
]) as unknown as CubeRotations

// `DAT_0639d210`, the degrees-to-radians every angle here is read with.
const DEGREES = f(0.017453292)

/** `xaxis_rotation` and its kin as written, in degrees, to `CubeRotations`. */
export const cubeRotations = (degrees: readonly (readonly number[])[]): CubeRotations =>
  degrees.map((axis) => axis.map((value) => f(value * DEGREES))) as unknown as CubeRotations

/** The nudge and `ftol` Common snaps each coordinate with: 0.1 away from zero, then truncated. */
const nudge = (value: number): number => Math.trunc(value > 0 ? value + f(0.1) : value - f(0.1))

/** `closest_cube_coord` (`0x42ff0`): a cube's centre on one axis. */
const cubeCoord = (coord: number, size: number): number => {
  const half = Math.trunc((size + 1) * 0.5)
  const step = Math.trunc(coord / size) * size
  return coord > 0 ? step + half : step - half
}

/** `CAsteroidField::closest_cube_pos` (`0x45ee0`). */
export const closestCubePosition = ({ x, y, z }: Vector3, size: number): Vector3 => ({
  x: cubeCoord(nudge(x), size),
  y: cubeCoord(nudge(y), size),
  z: cubeCoord(nudge(z), size),
})

/** `compute_cube_id` (`0x62a6010`): 0 for a position past the grid. */
export const cubeId = ({ x, y, z }: Vector3): number => {
  const [nx, ny, nz] = [nudge(x), nudge(y), nudge(z)]
  let gx = Math.abs(nx) >>> 7
  let gy = Math.abs(ny) >>> 7
  let gz = Math.abs(nz) >>> 7
  if (gx >= 0x400 || gy >= 0x200 || gz >= 0x400) return 0
  if (nx < 0) gx |= 0x400
  if (nz < 0) gz |= 0x400
  if (ny < 0) gy |= 0x200
  return ((gz << 10) | gy | (gx << 21)) >>> 0
}

/** Rotations about X, then Y, then Z: `Rz · Ry · Rx`, as Common composes them row by row. */
const rotationOf = (ax: number, ay: number, az: number): Matrix4 => {
  const c = (angle: number) => f(Math.cos(angle))
  const s = Math.sin
  // Rows of `R`, applied as `R · v`.
  let rows = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  const turn = (i: number, j: number, angle: number, sign: 1 | -1) => {
    const [ci, si] = [c(angle), s(angle)]
    rows = rows.map((row) => [...row])
    for (let col = 0; col < 3; col++) {
      const a = rows[i]![col]!
      const b = rows[j]![col]!
      rows[i]![col] = f(a * ci - sign * b * si)
      rows[j]![col] = f(b * ci + sign * a * si)
    }
  }
  turn(1, 2, ax, 1)
  turn(0, 2, ay, -1)
  turn(0, 1, az, 1)
  const [r0, r1, r2] = rows as [number[], number[], number[]]
  return {
    x: { x: r0[0]!, y: r1[0]!, z: r2[0]!, w: 0 },
    y: { x: r0[1]!, y: r1[1]!, z: r2[1]!, w: 0 },
    z: { x: r0[2]!, y: r1[2]!, z: r2[2]!, w: 0 },
    w: { x: 0, y: 0, z: 0, w: 1 },
  }
}

/** An `asteroid =` line's turn, its three angles in degrees as written. */
export const entryOrientation = (x: number, y: number, z: number): Matrix4 =>
  rotationOf(x * DEGREES, y * DEGREES, z * DEGREES)

/**
 * `compute_cube_orientation` (`0x62a4010`): an LCG seeded with the cube's id says whether it's
 * empty, at `frequency`, and which of each axis's four angles turns it.
 */
export const cubeOrientation = (
  id: number,
  rotations: CubeRotations,
  frequency: number,
): Matrix4 | undefined => {
  let state = id >>> 0
  const next = () => {
    state = (Math.imul(state, 214013) + 2531011) >>> 0
    return (state >>> 16) & 0x7fff
  }
  for (let warm = (next() >> 13) & 3; warm > 0; warm--)
    state = (Math.imul(state, 214013) + 2531011) >>> 0
  if (frequency >= 0 && next() * f(1 / 32768) < frequency) return undefined
  const pick = () => Math.min(Math.max(Math.trunc(next() * f(4 / 32768)), 0), 3)
  const [i, j, k] = [pick(), pick(), pick()]
  return rotationOf(rotations[0][i]!, rotations[1][j]!, rotations[2][k]!)
}

/** One `asteroid =` of a `[Cube]`: the level it draws, and where in the cube. */
export interface CubeAsteroid {
  mesh: VMeshData
  reference: VMeshRef
  /** Its offset in the cube: the line's three, each held to [-1, 1], times half a cube. */
  offset: Vector3
  orientation: Matrix4
}

/**
 * The layout a cube's mesh takes: retail copies every asteroid as FVF `0x252` (`CopyVertexData`), so
 * position, normal and the first UV set, whatever else a source holds. Its diffuse is never read with
 * lighting on, and what `CopyVertexData` writes for a source without one is unread here, so it's kept
 * only when every source has one.
 */
const cubeFormat = (asteroids: readonly CubeAsteroid[]): VertexFormat => {
  for (const { mesh } of asteroids)
    if (
      !(mesh.format & VertexFormat.Normal) ||
      !vertexLayout(mesh.format).attributes.some(({ name }) => name === 'uv0')
    )
      throw new Error(
        `An asteroid's FVF 0x${mesh.format.toString(16)} lacks a normal or UV, unread`,
      )
  const diffuse = asteroids.every(({ mesh }) => mesh.format & VertexFormat.Diffuse)
  return setMapCount(
    VertexFormat.Position | VertexFormat.Normal | (diffuse ? VertexFormat.Diffuse : 0),
    1,
  )
}

/**
 * `CliAsteroidMergeCubeMesh`: every asteroid's vertices turned and moved into the cube, one mesh in
 * list order, drawn whole with the first's material, each copied into `cubeFormat`'s layout.
 */
export const mergeCube = (
  asteroids: readonly CubeAsteroid[],
): { mesh: VMeshData; reference: VMeshRef } | undefined => {
  const first = asteroids[0]
  if (!first) return undefined
  const format = cubeFormat(asteroids)
  const stride = vertexByteLength(format)
  const layout = vertexLayout(format)
  const normal = layout.attributes.find(({ name }) => name === 'normal')
  let vertexCount = 0
  for (const { reference } of asteroids) vertexCount += reference.vertexCount
  const vertices = new Uint8Array(vertexCount * stride)
  const indices: number[] = []
  let base = 0
  for (const { mesh, reference, offset, orientation } of asteroids) {
    const source = vertexLayout(mesh.format)
    const copies = layout.attributes.map((to) => {
      const from = source.attributes.find(({ name }) => name === to.name)!
      return { from: from.offset, to: to.offset, bytes: to.normalizedBytes ? to.size : to.size * 4 }
    })
    for (let at = 0; at < reference.vertexCount; at++) {
      const read = (reference.vertexStart + at) * source.stride
      const write = (base + at) * stride
      for (const { from, to, bytes } of copies)
        vertices.set(mesh.vertices.subarray(read + from, read + from + bytes), write + to)
    }
    const view = new DataView(vertices.buffer, base * stride, reference.vertexCount * stride)
    for (let at = 0; at < reference.vertexCount; at++) {
      const read = (offsetBytes: number) =>
        [0, 4, 8].map((k) => view.getFloat32(at * stride + offsetBytes + k, true))
      const write = (offsetBytes: number, { x, y, z }: Vector3) =>
        [x, y, z].forEach((value, k) =>
          view.setFloat32(at * stride + offsetBytes + k * 4, value, true),
        )
      const [px, py, pz] = read(0) as [number, number, number]
      const p = Matrix4.transformDirection({ x: px, y: py, z: pz }, orientation)
      write(0, { x: f(offset.x + f(p.x)), y: f(f(p.y) + offset.y), z: f(f(p.z) + offset.z) })
      if (normal) {
        const [nx, ny, nz] = read(normal.offset) as [number, number, number]
        const n = Matrix4.transformDirection({ x: nx, y: ny, z: nz }, orientation)
        write(normal.offset, { x: f(n.x), y: f(n.y), z: f(n.z) })
      }
    }
    for (const { startIndex, elementCount, baseVertex } of getMeshDraw(mesh, reference))
      for (let at = 0; at < elementCount; at++)
        indices.push(mesh.indices[startIndex + at]! + baseVertex - reference.vertexStart + base)
    base += reference.vertexCount
  }
  const materialId = first.mesh.groups[first.reference.groupStart]?.materialId ?? 0
  const mesh: VMeshData = {
    name: 'asteroid cube',
    version: 1,
    primitive: Primitive.TriangleList,
    format,
    groups: [
      {
        materialId,
        vertexStart: 0,
        vertexEnd: vertexCount - 1,
        elementCount: indices.length,
        padding: 0,
      },
    ],
    indices: Uint16Array.from(indices),
    vertices,
  }
  const reference: VMeshRef = {
    meshId: 0,
    vertexStart: 0,
    vertexCount,
    indexStart: 0,
    indexCount: indices.length,
    groupStart: 0,
    groupCount: 1,
    boundingBox: first.reference.boundingBox,
    boundingSphere: first.reference.boundingSphere,
  }
  return { mesh, reference }
}

/** A zone that takes cubes, as `[Exclusion Zones]` names it. */
export interface CubeExclusion {
  zone: Zone
  /** Its zone's `edge_fraction`. 0 when absent. */
  edgeFraction?: number
  /** `empty_cube_frequency` of its own: then it thins the cubes rather than taking them. */
  emptyFrequency?: number
  /** `exclude_billboards` above 0: no billboard stands in it. */
  excludeBillboards?: boolean
  /** `billboard_count`, truncated, when above 0: how many billboards stand in it. */
  billboardCount?: number
  /**
   * `exclude_dynamic_asteroids` above 0, on a sphere or an ellipsoid (`062a4f81`): no dynamic
   * asteroid is placed about a point in it.
   */
  excludeDynamicAsteroids?: boolean
}

/** What the cube walk needs of a field, as its file and zone give it. The host reads them. */
export interface CubeField {
  zone: Zone
  /** Its zone's `edge_fraction`. 0 when absent. */
  edgeFraction?: number
  /** `cube_size`, 400 when absent. */
  cubeSize: number
  /** `fill_dist`, 1200 when absent. */
  fillDistance: number
  /** `empty_cube_frequency`, 0 when absent. */
  emptyFrequency?: number
  /** `max_alpha`, 1 when absent. */
  maxAlpha?: number
  rotations?: CubeRotations
  exclusions?: readonly CubeExclusion[]
  /**
   * `+0x230`: how far the walk reaches, from the `Asteroids` option as last applied, `(1 - d) ·
   * 0.65 + d`. 1 when absent, as at 1 and at load.
   */
  detailScale?: number
}

/** A cube to draw: where, turned how, and how faded. */
export interface CubeDraw {
  position: Vector3
  orientation: Matrix4
  /** `max_alpha`, less over the last half cube before the walk's reach. */
  alpha: number
}

/** `CAsteroidField::near_field` (`0x62a53c0`): within the zone, or near enough its surface. */
export const nearField = (field: CubeField, eye: Vector3): boolean => {
  const fill = Math.trunc(field.fillDistance * (field.detailScale ?? 1))
  const margin = f((field.cubeSize + fill) * f(1.74))
  const { zone } = field
  const d = {
    x: f(eye.x - zone.position.x),
    y: f(eye.y - zone.position.y),
    z: f(eye.z - zone.position.z),
  }
  const reach = zone.radius + margin
  const squared = d.x * d.x + d.z * d.z + d.y * d.y
  if (squared > reach * reach) return false
  const distance = Math.sqrt(f(squared))
  let excess = 0
  if (distance > f(0.0001)) {
    const length = f(distance)
    const inverse = 1 / length
    excess =
      length - zone.radiusAlong({ x: f(d.x * inverse), y: f(d.y * inverse), z: f(d.z * inverse) })
  }
  return excess <= margin
}

/**
 * `CAsteroidField::near_field_fraction` (`0x62a54e0`): 1 at the zone's surface, falling to 0 `distance`
 * past it, and unclamped within, so over 1. A distance of 0 or less is `(fill_dist + cube_size) · 1.2`; the client passes 1000.
 */
export const nearFieldFraction = (
  field: Pick<CubeField, 'zone' | 'fillDistance' | 'cubeSize'>,
  eye: Vector3,
  distance: number,
): number => {
  const reachBy = distance > 0 ? distance : f((field.fillDistance + field.cubeSize) * f(1.2))
  const { zone } = field
  const d = {
    x: f(eye.x - zone.position.x),
    y: f(eye.y - zone.position.y),
    z: f(eye.z - zone.position.z),
  }
  const reach = zone.radius + reachBy
  const squared = d.x * d.x + d.z * d.z + d.y * d.y
  if (squared > reach * reach) return 0
  const root = Math.sqrt(f(squared))
  const inverse = 1 / root
  const excess =
    f(root) - zone.radiusAlong({ x: f(d.x * inverse), y: f(d.y * inverse), z: f(d.z * inverse) })
  if (!(excess <= reachBy)) return 0
  return f(1 - excess / reachBy)
}

/** `AsteroidExclusionZone::update_dist`: how far outside a zone the camera is, squared. */
export const outsideSquared = ({ zone }: CubeExclusion, eye: Vector3): number => {
  const d = {
    x: f(eye.x - zone.position.x),
    y: f(eye.y - zone.position.y),
    z: f(eye.z - zone.position.z),
  }
  const length = f(Math.sqrt(d.z * d.z + d.y * d.y + d.x * d.x))
  const inverse = 1 / length
  const radius = zone.radiusAlong({ x: f(d.x * inverse), y: f(d.y * inverse), z: f(d.z * inverse) })
  const distance = length - radius
  return distance < 0 ? 0 : f(distance * distance)
}

/**
 * `is_cliasteroid_excluded` (`0x62bc200`) over the zones nearest first: a zone holding the cube takes
 * it, or thins it to its own frequency; past `reach`, squared, the scan stops.
 */
const excluded = (
  zones: readonly { exclusion: CubeExclusion; key: number }[],
  reach: number,
  point: Vector3,
): { taken: boolean; frequency?: number } => {
  let frequency: number | undefined
  for (const { exclusion, key } of zones) {
    if (key > reach) break
    if (immersion(exclusion.zone, exclusion.edgeFraction ?? 0, point) !== 0) {
      if (!((exclusion.emptyFrequency ?? -1) >= 0)) return { taken: true }
      frequency = exclusion.emptyFrequency
    }
  }
  return frequency === undefined ? { taken: false } : { taken: false, frequency }
}

/**
 * `CliAsteroidDrawNearField`: the cubes to draw, in the walk's order. A box of cubes spans the view
 * out to `fill_dist`; each is kept if it's within the side planes and the reach, the zone holds it
 * past 0.001, no exclusion takes it, and its id doesn't leave it empty. The camera's own cube is
 * drawn last if the walk missed it. Nothing past `nearField`.
 */
export const fieldCubes = (field: CubeField, camera: Camera, aspect: number): CubeDraw[] => {
  const eye = camera.position
  if (!nearField(field, eye)) return []
  const size = field.cubeSize
  const rotations = field.rotations ?? RETAIL_CUBE_ROTATIONS
  const maxAlpha = f(field.maxAlpha ?? 1)
  const frame = Matrix4.fromRotationTranslation(camera.orientation, { x: 0, y: 0, z: 0 })
  const col0 = { x: frame.x.x, y: frame.x.y, z: frame.x.z }
  const col1 = { x: frame.y.x, y: frame.y.y, z: frame.y.z }
  const col2 = { x: frame.z.x, y: frame.z.y, z: frame.z.z }
  const add = (a: Vector3, b: Vector3) => ({ x: f(a.x + b.x), y: f(a.y + b.y), z: f(a.z + b.z) })
  const sub = (a: Vector3, b: Vector3) => ({ x: f(a.x - b.x), y: f(a.y - b.y), z: f(a.z - b.z) })
  const scale = (a: Vector3, s: number) => ({ x: f(a.x * s), y: f(a.y * s), z: f(a.z * s) })
  const dot = (a: Vector3, b: Vector3) => a.x * b.x + a.z * b.z + a.y * b.y

  const halfX = f((camera.fovh * Math.PI) / 180)
  const fovY = f(Math.atan(Math.tan(halfX) / aspect))
  const angleX = f(Math.PI / 2) - halfX
  const angleY = f(Math.PI / 2) - fovY
  const [sinX, cosX, sinY, cosY] = [
    Math.sin(angleX),
    Math.cos(angleX),
    Math.sin(angleY),
    Math.cos(angleY),
  ].map(f) as [number, number, number, number]
  const backX = scale(col2, cosX)
  const d0 = sub(scale(col0, -sinX), backX)
  const d1 = sub(scale(col0, sinX), backX)
  const backY = scale(col2, cosY)
  const d2 = sub(scale(col1, -sinY), backY)
  const d3 = sub(scale(col1, sinY), backY)

  const margin = f(size * f(1.25))
  const nearPoint = add(eye, scale(col2, margin))
  const tanX = f(Math.tan(halfX))
  const tanY = f(Math.tan(fovY))
  const fill = Math.trunc(field.fillDistance) * f(field.detailScale ?? 1)
  const extX = Math.trunc(tanX * fill)
  const extY = Math.trunc(tanY * fill)

  const seed = closestCubePosition(add(scale(col2, size), eye), size)
  let [minX, maxX, minY, maxY, minZ, maxZ] = [seed.x, seed.x, seed.y, seed.y, seed.z, seed.z]
  const negZ = { x: -col2.x, y: -col2.y, z: -col2.z }
  const farCentre = add(scale(negZ, fill), eye)
  const latX = scale(col0, extX)
  const latY = scale(col1, extY)
  const farXp = add(farCentre, latX)
  const farXm = sub(farCentre, latX)
  for (const corner of [add(farXp, latY), sub(farXp, latY), sub(farXm, latY), add(farXm, latY)]) {
    const snapped = closestCubePosition(corner, size)
    ;[minX, maxX] = [Math.min(minX, snapped.x), Math.max(maxX, snapped.x)]
    ;[minY, maxY] = [Math.min(minY, snapped.y), Math.max(maxY, snapped.y)]
    ;[minZ, maxZ] = [Math.min(minZ, snapped.z), Math.max(maxZ, snapped.z)]
  }

  const halfCube = f(size * 0.5)
  const reachWide = fill + margin
  const reach = f(reachWide)
  const fadeStart = f(reachWide - halfCube)
  const exclusionReach = f(
    Math.pow(Math.trunc(field.fillDistance) * (field.detailScale ?? 1) * 1.25, 2),
  )
  const zones = (field.exclusions ?? [])
    .map((exclusion) => ({ exclusion, key: outsideSquared(exclusion, eye) }))
    .sort((a, b) => a.key - b.key)
  const playerId = cubeId(closestCubePosition(eye, size))
  let playerSeen = false

  /** The tests every cube passes, the walk's and the camera's own: its turn, or none. */
  const keep = (position: Vector3, id: number): Matrix4 | undefined => {
    if (!(immersion(field.zone, field.edgeFraction ?? 0, position) > f(0.001))) return undefined
    const { taken, frequency } = excluded(zones, exclusionReach, position)
    if (id === 0 || taken) return undefined
    return cubeOrientation(id, rotations, frequency ?? field.emptyFrequency ?? 0)
  }

  const cubes: CubeDraw[] = []
  for (let x = minX; x <= maxX; x += size)
    for (let y = minY; y <= maxY; y += size)
      for (let z = minZ; z <= maxZ; z += size) {
        const position = closestCubePosition({ x, y, z }, size)
        const delta = sub(position, nearPoint)
        const depth = Math.abs(dot(negZ, delta))
        if (depth > reach) continue
        const inverse = 1 / depth
        const slopeX = dot(delta, col0) * inverse
        if (!(tanX >= Math.abs(slopeX)) && dot(slopeX > 0 ? d0 : d1, delta) < 0) continue
        const slopeY = dot(delta, col1) * inverse
        if (!(tanY >= Math.abs(slopeY)) && dot(slopeY > 0 ? d2 : d3, delta) < 0) continue
        if (!(immersion(field.zone, field.edgeFraction ?? 0, position) > f(0.001))) continue
        const id = cubeId(position)
        const { taken, frequency } = excluded(zones, exclusionReach, position)
        if (id === 0 || taken) continue
        if (id === playerId) playerSeen = true
        const orientation = cubeOrientation(id, rotations, frequency ?? field.emptyFrequency ?? 0)
        if (!orientation) continue
        let alpha = maxAlpha
        if (fadeStart < depth) {
          const ramp = ((reach - depth) / halfCube) * maxAlpha
          alpha = ramp > maxAlpha ? maxAlpha : ramp < 0 ? 0 : f(ramp)
          if (alpha <= f(0.001)) continue
        }
        cubes.push({ position, orientation, alpha })
      }

  if (!playerSeen && playerId !== 0) {
    const position = closestCubePosition(eye, size)
    const orientation = keep(position, playerId)
    if (orientation) cubes.push({ position, orientation, alpha: maxAlpha })
  }
  return cubes
}

/** A field as the frame draws it: its cube walk, its merged mesh's lookups, and its colours. */
export interface SpaceAsteroidField extends CubeField {
  /** `mergeCube`'s mesh, with the lookups its material and textures resolve through. */
  cube: Pick<SceneModel, 'material' | 'texture' | 'materialMap'> & {
    mesh: VMeshData
    reference: VMeshRef
  }
  /** `diffuse_color` over 255, or `tint_field`'s. */
  diffuse: Vector3
  /** `ambient_color` over 255, or `tint_field`'s. */
  ambient: Vector3
  /** `ambient_increase`, 0 to 255 a channel, added to the ambient the field is lit by. */
  ambientIncrease?: Vector3
  /** `contains_fog_zone`: lit and fogged by the nebula the camera is in. */
  containsFogZone?: boolean
  /** Its `[Band]`, built from its zone and colours. */
  band?: AsteroidBand
  /** Its `[ExclusionBand]`s, in file order, each about its own `zone`. */
  exclusionBands?: readonly AsteroidBand[]
  /** Its `[AsteroidBillboards]`, when the `Asteroids` option is above 1 and effects are on. */
  billboards?: AsteroidBillboards
  /**
   * Its `[DynamicAsteroids]`, in file order, each with its archetype's top level as `mergeCube`
   * gives it alone: the whole mesh drawn with its first group's material.
   */
  dynamic?: readonly { rocks: DynamicAsteroids; model: SpaceAsteroidField['cube'] }[]
}
