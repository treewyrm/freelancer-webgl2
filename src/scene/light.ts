/**
 * A system's lights as the game gives them to one object: `StarSysApplyObjectLighting` (`0x5554d0`) in
 * `src/freelancer/Client/space_scene_obj_draw.cpp`, and `engine_light.cpp`. Pure, no GL.
 */
import type { Vector3 } from '@treewyrm/freelancer/math'
import type { SceneLight } from './frame.js'

/** An `[IGraph]`'s `point = x, value` keys, in file order. A colour graph's values are `0xAARRGGBB`. */
export interface Graph {
  points: readonly (readonly [x: number, value: number])[]
}

/** A `[LightSource]`, in the order the system file lists them, which is the game's (`GameLightEnable`). */
export interface SpaceLight {
  type: 'ambient' | 'point' | 'cone' | 'directional'
  position: Vector3
  /** Made unit, as `direction` is read. Down -Z when absent. */
  direction?: Vector3
  /** As written, 0 to 255. */
  color: Vector3
  range: number
  /** Constant, linear and quadratic. `(0, 1, 0)` when absent (`FEngineLight`'s constructor). */
  attenuation?: Vector3
  /** `atten_curve`, but an ambient light's is its `ambientCurve`: the colour over `[0, range]`. */
  attenuationCurve?: Graph
  /** `ambient_curve`: what an ambient light adds, over `[0, range]`. */
  ambientCurve?: Graph
  /** `color_curve`: a tint over the host's clock, repeating every `period` seconds. */
  colorCurve?: { graph: Graph; period: number }
}

/** What one object is lit by: at most four lights, and the ambient, 0 to 1. */
export interface ObjectLighting {
  lights: SceneLight[]
  ambient: Vector3
}

// `FindBracketingKeys`, interpolating, as `G_bGraphInterpolate` is 1.
const interpolate = (points: Graph['points'], x: number): [number, number, number] => {
  let lo = 0
  let hi = points.length - 1
  if (x <= points[0]![0]) hi = 0
  else if (x >= points[hi]![0]) lo = hi
  else
    while (hi - lo > 1) {
      const mid = Math.trunc((hi + lo) / 2)
      if (!(x < points[mid]![0])) lo = mid
      else hi = mid
    }
  const span = points[hi]![0] - points[lo]![0]
  return [lo, hi, span]
}

// `FGraphData::Evaluate` and `EvaluateColor` map the caller's range onto the keys' own extent.
const graphX = ({ points }: Graph, t: number, max: number, clamp: boolean): number => {
  let at: number
  if (clamp) {
    // `GraphRangeWrap`, clamping into `[0, max - 0.001]`.
    const least = 0 < t ? t : 0
    at = Math.fround(least < max - 0.001 ? least : max - 0.001)
  } else {
    const fraction = t / Math.fround(max)
    at = Math.fround(Math.abs(fraction - Math.floor(fraction)) * Math.fround(max))
  }
  let least = points[0]![0]
  let most = least
  for (const [x] of points) {
    least = Math.min(least, x)
    most = Math.max(most, x)
  }
  return (at / max) * (most - least) + least
}

/** `FGraphData::Evaluate` over `[0, max]`, clamped. */
export const evaluateGraph = (graph: Graph, t: number, max: number): number => {
  const x = graphX(graph, t, max, true)
  const [lo, hi, span] = interpolate(graph.points, x)
  const weight = span > 0 ? (graph.points[hi]![0] - x) / span : 1
  return (1 - weight) * graph.points[hi]![1] + graph.points[lo]![1] * weight
}

/**
 * `FGraphData::EvaluateColor` over `[0, period]`, repeating: its bytes. Its weight runs from the low
 * key while the blend still gives the rest to the high one, so retail's colour curves run backwards
 * between keys (`0x41963c`).
 */
export const evaluateColorGraph = (graph: Graph, t: number, period: number): Vector3 => {
  const x = graphX(graph, t, period, false)
  const [lo, hi, span] = interpolate(graph.points, x)
  const weight = span > 0 ? (x - graph.points[lo]![0]) / span : 1
  const high = graph.points[hi]![1] >>> 0
  const low = graph.points[lo]![1] >>> 0
  const channel = (shift: number) =>
    Math.trunc(((high >>> shift) & 0xff) * (1 - weight) + ((low >>> shift) & 0xff) * weight) & 0xff
  return { x: channel(16), y: channel(8), z: channel(0) }
}

interface Entry {
  light: number
  x: number
  z: number
  range: number
}

interface Cell {
  x: number
  z: number
  half: number
  children: (Cell | undefined)[]
  /** Newest first, as each payload is pushed on the front. */
  entries: Entry[]
}

// `LightGridRebuildImpl`: the root's half size, and its two pools.
const ROOT_HALF = 100000
const POOL = 256

/**
 * The XZ quadtree `LightGridRebuildImpl` builds once per system. Its cells only narrow the search, but
 * the order it hands lights back in decides which of equal range win the last of the four places.
 */
class LightGrid {
  readonly root: Cell = this.cell(0, 0, ROOT_HALF)
  private cells = 0
  private entries = 0

  constructor(lights: readonly SpaceLight[]) {
    lights.forEach((light, index) =>
      this.insert(this.root, {
        light: index,
        x: Math.trunc(light.position.x),
        z: Math.trunc(light.position.z),
        range: Math.trunc(light.range),
      }),
    )
  }

  private cell(x: number, z: number, half: number): Cell {
    return { x, z, half, children: [undefined, undefined, undefined, undefined], entries: [] }
  }

  // `LightGridAllocTreeNode`: the pool runs out at 256, and what needed a cell then is dropped.
  private child(parent: Cell, slot: number, dx: number, dz: number): Cell | undefined {
    const existing = parent.children[slot]
    if (existing) return existing
    if (this.cells >= POOL) return undefined
    this.cells++
    const half = Math.trunc(parent.half / 2)
    const made = this.cell(parent.x + dx * half, parent.z + dz * half, half)
    parent.children[slot] = made
    return made
  }

  /** `LightGridInsert` (`0x537d20`): into every quadrant its square reaches, while it fits one. */
  private insert(start: Cell, entry: Entry): void {
    const { range } = entry
    let cell: Cell | undefined = start
    while (range <= cell.half) {
      const x = entry.x - cell.x
      const z = entry.z - cell.z
      if (x < range) {
        if (z < range) this.descend(cell, 1, -1, -1, entry)
        if (-z < range) this.descend(cell, 3, -1, 1, entry)
      }
      if (range <= -x) return
      if (z < range) this.descend(cell, 0, 1, -1, entry)
      if (range <= -z) return
      cell = this.child(cell, 2, 1, 1)
      if (!cell) return
    }
    if (this.entries >= POOL) return
    this.entries++
    cell.entries.unshift(entry)
  }

  private descend(cell: Cell, slot: number, dx: number, dz: number, entry: Entry): void {
    const child = this.child(cell, slot, dx, dz)
    if (child) this.insert(child, entry)
  }

  /** `LightTreeCollect`: each cell the query's square reaches, itself before its children. */
  collect(cell: Cell | undefined, x: number, z: number, radius: number, into: Cell[]): void {
    if (!cell) return
    if (cell.entries.length) into.push(cell)
    const dx = x - cell.x
    const dz = z - cell.z
    if (dx < radius) {
      if (dz < radius) this.collect(cell.children[1], x, z, radius, into)
      if (-dz < radius) this.collect(cell.children[3], x, z, radius, into)
    }
    if (-dx < radius) {
      if (dz < radius) this.collect(cell.children[0], x, z, radius, into)
      if (-dz < radius) this.collect(cell.children[2], x, z, radius, into)
    }
  }
}

// `CollectNearbyLights`' second argument at every caller.
const MOST_LIGHTS = 4
const SORTED_LIMIT = 0x100

// With a curve a directional or cone light turns to face each object, and its last reach test is 3D.
const turns = (light: SpaceLight): boolean =>
  light.attenuationCurve !== undefined ||
  light.ambientCurve !== undefined ||
  light.colorCurve !== undefined

/** `EngineLightAffectsPoint` (`0x410a40`). */
const reaches = (light: SpaceLight, point: Vector3, radius: number): boolean => {
  if (light.type === 'directional' && !turns(light)) return true
  const dx = point.x - light.position.x
  const dy = point.y - light.position.y
  const dz = point.z - light.position.z
  const reach = light.range + radius
  return reach * reach > dx * dx + dz * dz + dy * dy
}

/** `CollectNearbyLights` (`0x537f40`): the widest-reaching lights first, four at most. */
const nearbyLights = (
  grid: LightGrid,
  lights: readonly SpaceLight[],
  position: Vector3,
  radius: number,
): number[] => {
  const cells: Cell[] = []
  grid.collect(grid.root, Math.trunc(position.x), Math.trunc(position.z), Math.trunc(radius), cells)

  // Insertion by range, descending, where an equal range goes in front of those already there.
  const sorted: Entry[] = []
  for (const cell of cells)
    for (const entry of cell.entries) {
      if (sorted.some(({ light }) => light === entry.light)) continue
      let lo = 0
      let hi = sorted.length
      while (lo < hi) {
        const mid = Math.trunc((lo + hi) / 2)
        if (entry.range < sorted[mid]!.range) lo = mid + 1
        else hi = mid
      }
      if (hi >= SORTED_LIMIT) continue
      sorted.splice(hi, 0, entry)
      sorted.length = Math.min(sorted.length, SORTED_LIMIT)
    }

  const kept: number[] = []
  for (const { light, x, z, range } of sorted) {
    if (kept.length >= MOST_LIGHTS) break
    const dx = position.x - x
    const dz = position.z - z
    const reach = range + radius
    if (reach * reach > dz * dz + dx * dx) kept.push(light)
  }
  return kept.filter((index) => reaches(lights[index]!, position, radius))
}

// `-Orient`'s third column, from an identity: a light with no `direction` shines down -Z.
const FORWARD: Vector3 = { x: 0, y: 0, z: -1 }

// `EngineLightPackColorBytes` then back: the colour is whole 1/255 steps.
const quantize = (value: number): number => Math.min(Math.max(Math.trunc(value), 0), 255) / 255

const unit = ({ x, y, z }: Vector3): Vector3 => {
  const length = Math.hypot(x, y, z)
  return { x: x / length, y: y / length, z: z / length }
}

const scale = ({ x, y, z }: Vector3, by: number): Vector3 => ({ x: x * by, y: y * by, z: z * by })

/** `[Ambient] color` as the device takes it: whole bytes, 0 to 1. */
export const systemAmbient = ({ x, y, z }: Vector3): Vector3 => ({
  x: quantize(x),
  y: quantize(y),
  z: quantize(z),
})

/** What `SpaceObject`'s lighting reads, built once a frame from a system's lights. */
export interface LightSet {
  lights: readonly SpaceLight[]
  grid: LightGrid
}

export const lightSet = (lights: readonly SpaceLight[]): LightSet => ({
  lights,
  grid: new LightGrid(lights),
})

/** The `[NebulaLight] ambient` an object is in, as written, and how far in, from 0 to 1. */
export interface NebulaAmbient {
  ambient: Vector3
  factor: number
}

// `0x555595`: towards the nebula's, rounded, and with no clamp, so only the low byte is kept.
const towards = (from: number, to: number, by: number): number =>
  (Math.trunc((to - from) * by + from + 0.5) & 0xff) / 255

/**
 * `StarSysApplyObjectLighting` with every option on, from where the object stands and its sphere's
 * radius. `ambient` is the system's `[Ambient]`, as written. Its fog is `collectSpaceFrame`'s.
 */
export const lightObject = (
  { lights, grid }: LightSet,
  position: Vector3,
  radius: number,
  ambient: Vector3,
  time: number,
  nebula?: NebulaAmbient,
): ObjectLighting => {
  // `EngineLightApplyList` reads the bytes it was given back as floats, and adds ambient lights to them.
  const sum = systemAmbient(ambient)
  if (nebula) {
    const { ambient: to, factor } = nebula
    const byte = (value: number) => Math.trunc(value) & 0xff
    sum.x = towards(Math.round(sum.x * 255), byte(to.x), factor)
    sum.y = towards(Math.round(sum.y * 255), byte(to.y), factor)
    sum.z = towards(Math.round(sum.z * 255), byte(to.z), factor)
  }
  const lit: SceneLight[] = []
  for (const index of nearbyLights(grid, lights, position, radius)) {
    const light = lights[index]!
    // `EngineLightApplyNearby` (`0x4104e0`).
    const dx = position.x - light.position.x
    const dy = position.y - light.position.y
    const dz = position.z - light.position.z
    const distance = Math.fround(Math.hypot(dx, dy, dz))
    let color = {
      x: quantize(light.color.x),
      y: quantize(light.color.y),
      z: quantize(light.color.z),
    }
    if (light.colorCurve) {
      const { graph, period } = light.colorCurve
      const tint = evaluateColorGraph(graph, Math.fround(time), period)
      color = {
        x: (tint.x / 255) * color.x,
        y: (tint.y / 255) * color.y,
        z: (tint.z / 255) * color.z,
      }
    }
    if (light.attenuationCurve && light.type !== 'ambient')
      color = scale(color, evaluateGraph(light.attenuationCurve, distance, light.range))

    if (light.type === 'ambient') {
      const curve = light.ambientCurve ?? light.attenuationCurve
      const by = curve ? Math.fround(evaluateGraph(curve, distance, light.range)) : 1
      sum.x += color.x * by
      sum.y += color.y * by
      sum.z += color.z * by
      // It has no D3D type to draw as, so adds only to the ambient.
      continue
    }
    // Under a byte's worth, it's left off.
    if (color.z + color.y + color.x < 1 / 255) continue
    // A cone from `[LightSource]` has no angles, and D3D's spot falloff gives nothing outside 0°.
    if (light.type === 'cone') continue

    if (light.type === 'point')
      lit.push({
        color,
        direction: FORWARD,
        position: light.position,
        range: light.range,
        attenuation: light.attenuation ?? { x: 0, y: 1, z: 0 },
      })
    else
      lit.push({
        color,
        // A curve turns it to shine from its position at the object.
        direction: turns(light) ? unit({ x: dx, y: dy, z: dz }) : unit(light.direction ?? FORWARD),
      })
  }
  const byte = (value: number) => Math.min(Math.max(Math.trunc(value * 255), 0), 255) / 255
  return { lights: lit, ambient: { x: byte(sum.x), y: byte(sum.y), z: byte(sum.z) } }
}
