/**
 * One effect running, advanced by host-supplied time. Retail keeps its nodes in a tree and walks it each
 * frame (`0x6201810`): each node updates in turn, and one past its life dies with all that hangs from
 * it. The picture depends on that order, so this keeps the same tree: an appearance updates before the
 * sibling fields it reads, so it sees them a frame late, and a sub-effect's nodes hang off its spawner.
 */
import {
  curveAt,
  floatAt,
  type AnimatedCurve,
  type AnimatedFloat,
} from '@treewyrm/freelancer/alchemy'
import { Matrix3, Matrix4, Quat, type Vector3, type Vector4 } from '@treewyrm/freelancer/math'
import type { Appearance, Emitter, Field, NodeDescriptor, ParticleAppearance } from './nodes.js'
import { frameInverse, localMatrix, transposeInto } from './transform.js'
import type { EffectLookup, EffectScene } from './tree.js'

/** A lane's record, in floats. Position and velocity are in the appearance's frame, at `BORN`. */
export const RECORD = 16
export const POSITION = 0
export const VELOCITY = 3
/** The lane's clock, less its epoch, when the record was last written. */
export const BORN = 6
export const AGE = 7
export const LIFE = 8
/** A perp's roll reference (`0x6235db0`). */
export const AXIS = 9
export const SERIAL = 12

/** How many of a kind the game's pool holds, from `dacom.ini`. A full one evicts its oldest. */
export type PoolSizes = Readonly<Record<Appearance['kind'], number>>

export const RETAIL_POOLS: PoolSizes = {
  'basic-appearance': 1000,
  'rect-appearance': 400,
  'perp-appearance': 250,
  // Not retail's: its `0` crashes the game on the first spawn (`effect_oriented`). So a mod has set this.
  'oriented-appearance': 1000,
  'beam-appearance': 680,
  'dust-appearance': 250,
  'mesh-appearance': 500,
  'particle-appearance': 100,
}

/** Where evictions are counted, and the random stream. Effects sharing one compete as in the game. */
export interface EffectPools {
  sizes: PoolSizes
  held: Map<Appearance['kind'], Set<AppearanceNode>>
  serial: number
  rngState: number
  rngCount: number
}

export const createPools = (seed = 0, sizes: PoolSizes = RETAIL_POOLS): EffectPools => ({
  sizes,
  held: new Map(),
  serial: 0,
  rngState: seed | 0,
  rngCount: 0,
})

/** `0x623f1f0`: one of 256 values, 0 and 1 included. */
const random = (pools: EffectPools): number => {
  const state = pools.rngState
  const mixed = (((state & 0xff) << 8) ^ (state & 0xff00)) | ((pools.rngCount ^ state) & 0xff)
  const bit = ((state >>> 14) & 1) ^ (state & 1)
  pools.rngCount = (pools.rngCount + 1) | 0
  pools.rngState = (bit + mixed * 2) | 0
  const next = pools.rngState
  return Math.fround(((next & 0xff) ^ ((next >>> 8) & 0xff)) * Math.fround(1 / 255))
}

const FLOAT = new Float32Array(1)
const INT = new Int32Array(FLOAT.buffer)

/** The fast inverse square root with one Newton step, as the emitter and turbulence take it. */
const inverseLength = (squared: number): number => {
  FLOAT[0] = squared
  INT[0] = 0x5f3759df - (INT[0]! >> 1)
  const guess = FLOAT[0]!
  return (1.5 - 0.5 * squared * guess * guess) * guess
}

const curve = (c: AnimatedCurve | undefined, sparam: number, time: number, fallback: number) =>
  c ? curveAt(c, sparam, time) : fallback

const scaled = (m: Matrix4, { x, y, z }: Vector3): Vector3 => ({
  x: m.x.x * x + m.y.x * y + m.z.x * z,
  y: m.x.y * x + m.y.y * y + m.z.y * z,
  z: m.x.z * x + m.y.z * y + m.z.z * z,
})

interface RunContext {
  pools: EffectPools
  lookup?: EffectLookup
  sparam: number
  lod: number
}

interface EffectRun {
  context: RunContext
  scene: EffectScene
  nodes: RunNode[]
  top: RunNode[]
  root?: RunNode
}

export interface RunNode {
  run: EffectRun
  index: number
  key: number
  descriptor?: NodeDescriptor
  parent?: RunNode
  children: RunNode[]
  age: number
  lifeSpan: number
  /** Marked by `+0x5c`: it no longer updates or draws. */
  dead: boolean
  world: Matrix4
  /** `+0xc(1, M)`: `parent · override · local`, how a placement reaches its node. */
  override?: Matrix4
  update: (dt: number) => boolean
  died?: () => void
}

/** What a field holds between its update and an appearance reading it. */
type FieldState =
  | { kind: 'gravity-field'; change: number }
  | { kind: 'air-field'; magnitude: number; blend: number }
  | { kind: 'turbulence-field'; magnitude: number; blend: number }
  | {
      kind: 'radial-field'
      magnitude: number
      inverseRadius: number
      attenuation?: AnimatedFloat
      blend: number
    }
  | { kind: 'collide-field'; reflectivity: number; dt: number }
  | { kind: 'dust-field'; radius: number }
  | { kind: 'beam-field' }

export interface FieldNode extends RunNode {
  state: FieldState
}

/** A run of a lane's records, in emission order, with the holes a ballistic lane leaves. */
export interface Lane {
  records: Float32Array
  capacity: number
  /** Up to here is gone. */
  tail: number
  head: number
  count: number
  /** Pushed each step, so `born == clock` and the vertex stage reads records as they stand. */
  stepped: boolean
  /** Seconds since it last rebased, so a float stays exact. Only `clock - BORN` means anything. */
  clock: number
  /** Bumped when records already uploaded change. */
  version: number
  /** Births, whose parity is the beam's texture mirror. */
  births: number
}

const LANE_MIN = 16

const createLane = (stepped: boolean): Lane => ({
  records: new Float32Array(LANE_MIN * RECORD),
  capacity: LANE_MIN,
  tail: 0,
  head: 0,
  count: 0,
  stepped,
  clock: 0,
  version: 0,
  births: 0,
})

const aliveAt = (lane: Lane, o: number): boolean =>
  lane.records[o + AGE]! + (lane.clock - lane.records[o + BORN]!) <= lane.records[o + LIFE]!

/** A ballistic particle is its birth record, and floats keep its age exact for about this long. */
const REBASE = 16

const rebase = (lane: Lane) => {
  const { records, clock } = lane
  if (clock < REBASE) return
  for (let i = lane.tail; i < lane.head; i++) records[i * RECORD + BORN]! -= clock
  lane.clock = 0
  lane.version++
}

export interface ParticleRecord {
  state: Float32Array
  lifeRun: EffectRun
  deathRun?: EffectRun
  blend: Vector4
}

export interface AppearanceNode extends RunNode {
  descriptor: Appearance
  /** How many emitters feed it (`+0xb0`): none, and nothing held, and it's done. */
  refs: number
  fields: FieldNode[]
  lane?: Lane
  records?: ParticleRecord[]
}

const held = (node: AppearanceNode) => node.lane?.count ?? node.records?.length ?? 0

const QUARTER_Z = Quat.axisAngle({ axis: { x: 0, y: 0, z: 1 }, angle: -Math.PI / 2 })

/** `0x622ff00`: the turn taking +Y onto a velocity. */
const turnTo = (velocity: Vector3): Vector4 => {
  const length = Math.hypot(velocity.x, velocity.y, velocity.z)
  if (!(length > 0)) return Quat.identity
  const d = { x: velocity.x / length, y: velocity.y / length, z: velocity.z / length }
  if (Math.abs(d.y) < 0.99) {
    const s = Math.hypot(d.z, d.x)
    return Quat.axisAngle({ axis: { x: d.z / s, y: 0, z: -d.x / s }, angle: Math.acos(d.y) })
  }
  const s = Math.hypot(d.z, d.y)
  const first = Quat.axisAngle({
    axis: s > 0 ? { x: 0, y: -d.z / s, z: d.y / s } : { x: 0, y: 0, z: 1 },
    angle: Math.acos(Math.max(-1, Math.min(1, d.x))),
  })
  return Quat.multiply(first, QUARTER_Z)
}

const insertChild = (parent: RunNode | undefined, top: RunNode[], node: RunNode) => {
  const list = parent ? parent.children : top
  // After the last whose key isn't greater, so ties keep entry order (`0x6201e00`).
  let at = list.length
  while (at > 0 && list[at - 1]!.key > node.key) at--
  list.splice(at, 0, node)
}

/** Depth first: children before the node, each marked and its emitter's ref given back. */
const kill = (node: RunNode) => {
  if (node.dead) return
  for (const child of node.children) kill(child)
  node.children = []
  node.dead = true
  node.died?.()
}

const detach = (node: RunNode, top: RunNode[]) => {
  const list = node.parent ? node.parent.children : top
  const at = list.indexOf(node)
  if (at >= 0) list.splice(at, 1)
}

/** `Slot11(7)`: nothing lives in it but its control root. */
const runFinished = (run: EffectRun) => run.nodes.every((one) => one.dead || one === run.root)

/** `Slot13(1)`: its emitters go, and what they made lives out. */
const stopRun = (run: EffectRun, top: RunNode[]) => {
  for (const node of run.nodes) {
    if (node.descriptor?.category !== 'emitter' || node.dead) continue
    kill(node)
    detach(node, top)
  }
}

export interface AdvanceOptions {
  /** The outer key of every animated property. 0 when absent, as the game's engine-less effects. */
  sparam?: number
  /** `[EffectLOD]`'s key. 1 when absent, what the game shows close up. */
  lod?: number
  /** Where the host has the effect: reaches its control root, or else every top-level node. */
  placement?: Matrix4
  /** The camera's world to view, which the dust's streak and fade read. */
  view?: Matrix4
}

const applyField = (field: FieldNode, frame: Matrix4, world: Matrix4) => {
  const { state } = field
  switch (state.kind) {
    case 'gravity-field': {
      const change = scaled(frame, { x: 0, y: -state.change, z: 0 })
      return (s: Float32Array, o: number) => {
        s[o + VELOCITY]! += change.x
        s[o + VELOCITY + 1]! += change.y
        s[o + VELOCITY + 2]! += change.z
      }
    }
    case 'air-field': {
      const target = scaled(frame, { x: 0, y: state.magnitude, z: 0 })
      const { blend } = state
      return (s: Float32Array, o: number) => {
        s[o + VELOCITY] = s[o + VELOCITY]! + (target.x - s[o + VELOCITY]!) * blend
        s[o + VELOCITY + 1] = s[o + VELOCITY + 1]! + (target.y - s[o + VELOCITY + 1]!) * blend
        s[o + VELOCITY + 2] = s[o + VELOCITY + 2]! + (target.z - s[o + VELOCITY + 2]!) * blend
      }
    }
    case 'turbulence-field': {
      const pools = field.run.context.pools
      const { magnitude, blend } = state
      // `0x623e370`: three draws, y, x, z, and a fourth for strength. Not a noise field.
      return (s: Float32Array, o: number) => {
        const y = 2 * (random(pools) - 0.5)
        const x = 2 * (random(pools) - 0.5)
        const z = 2 * (random(pools) - 0.5)
        const n = inverseLength(Math.fround(x * x + y * y + z * z))
        const push = random(pools) * magnitude
        s[o + VELOCITY] = s[o + VELOCITY]! + (x * n * push - s[o + VELOCITY]!) * blend
        s[o + VELOCITY + 1] = s[o + VELOCITY + 1]! + (y * n * push - s[o + VELOCITY + 1]!) * blend
        s[o + VELOCITY + 2] = s[o + VELOCITY + 2]! + (z * n * push - s[o + VELOCITY + 2]!) * blend
      }
    }
    case 'radial-field': {
      const origin = frame.w
      const { magnitude, inverseRadius, attenuation, blend } = state
      const { sparam } = field.run.context
      // `0x6236610`: the displacement isn't normalized, and nothing is cut off at the radius.
      return (s: Float32Array, o: number) => {
        const dx = s[o]! - origin.x
        const dy = s[o + 1]! - origin.y
        const dz = s[o + 2]! - origin.z
        const x = Math.min(1, Math.hypot(dx, dy, dz) * inverseRadius)
        const k = magnitude * (attenuation ? floatAt(attenuation, sparam, x) : 1)
        s[o + VELOCITY] = s[o + VELOCITY]! + (dx * k - s[o + VELOCITY]!) * blend
        s[o + VELOCITY + 1] = s[o + VELOCITY + 1]! + (dy * k - s[o + VELOCITY + 1]!) * blend
        s[o + VELOCITY + 2] = s[o + VELOCITY + 2]! + (dz * k - s[o + VELOCITY + 2]!) * blend
      }
    }
    case 'collide-field': {
      const axis = scaled(frame, { x: 0, y: 1, z: 0 })
      const inverse = 1 / Math.hypot(axis.x, axis.y, axis.z)
      const n = { x: axis.x * inverse, y: axis.y * inverse, z: axis.z * inverse }
      const point = Matrix4.transformPoint({ x: 1, y: 0, z: 1 }, frame)
      const { reflectivity, dt } = state
      // `0x621a0e0`: unbounded, and it acts only on a five-unit skin behind the plane.
      return (s: Float32Array, o: number) => {
        const v = o + VELOCITY
        const start =
          (s[o]! + 5 * n.x - point.x) * n.x +
          (s[o + 1]! + 5 * n.y - point.y) * n.y +
          (s[o + 2]! + 5 * n.z - point.z) * n.z
        if (start < 0) return
        const sx = s[v]! * dt
        const sy = s[v + 1]! * dt
        const sz = s[v + 2]! * dt
        const along = sx * n.x + sy * n.y + sz * n.z
        if (along < 0) return
        const end =
          (s[o]! + sx - point.x) * n.x +
          (s[o + 1]! + sy - point.y) * n.y +
          (s[o + 2]! + sz - point.z) * n.z
        if (end > 0) return
        const t = start / (start - end)
        const fromX = s[o]! + 5 * n.x
        const fromY = s[o + 1]! + 5 * n.y
        const fromZ = s[o + 2]! + 5 * n.z
        s[o] = fromX + t * (s[o]! + sx - fromX)
        s[o + 1] = fromY + t * (s[o + 1]! + sy - fromY)
        s[o + 2] = fromZ + t * (s[o + 2]! + sz - fromZ)
        // The position stands even when the speed is too small to reflect (`0x621a32f`).
        const speed = Math.hypot(s[v]!, s[v + 1]!, s[v + 2]!)
        if (!(speed > 0.001)) return
        const dot = 2 * (s[v]! * n.x + s[v + 1]! * n.y + s[v + 2]! * n.z)
        const rx = reflectivity * (s[v]! - dot * n.x)
        const ry = reflectivity * (s[v + 1]! - dot * n.y)
        const rz = reflectivity * (s[v + 2]! - dot * n.z)
        const back = (1 - t) * dt
        s[v] = rx
        s[v + 1] = ry
        s[v + 2] = rz
        s[o]! -= back * rx
        s[o + 1]! -= back * ry
        s[o + 2]! -= back * rz
      }
    }
    case 'dust-field': {
      const { radius } = state
      const squared = Math.fround(radius * radius)
      // `0x6212c90`: the field's world, not `frame`, and it writes the age. A zero radius kills all.
      return (s: Float32Array, o: number) => {
        const q = transposeInto(world, { x: s[o]!, y: s[o + 1]!, z: s[o + 2]! })
        const d = q.x * q.x + q.y * q.y + q.z * q.z
        if (d > squared) {
          s[o + AGE] = 3.4028234663852886e38
          return
        }
        let fade = 1
        const band = squared * 0.8
        if (q.z < 0 && d > band) fade = 1 - (d - band) / (squared - band)
        s[o + AGE] = (1 - (radius - q.z) / (radius + radius)) * fade * 10
      }
    }
    case 'beam-field':
      return undefined
  }
}

/** Every live field acting on an appearance's records, in link order (`0x6218780`). */
const applyFields = (
  node: AppearanceNode,
  each: (apply: (s: Float32Array, o: number) => void) => void,
) => {
  node.fields = node.fields.filter((field) => !field.dead)
  if (!node.fields.length) return
  const inverse = frameInverse(node.world)
  for (const field of node.fields) {
    const apply = applyField(field, Matrix4.multiply(inverse, field.world), field.world)
    if (apply) each(apply)
  }
}

/** Takes a list appearance's record for this birth, evicting the pool's oldest when it's full. */
const claim = ({ pools }: RunContext, node: AppearanceNode) => {
  const { kind } = node.descriptor
  let set = pools.held.get(kind)
  if (!set) {
    set = new Set()
    pools.held.set(kind, set)
  }
  set.add(node)
  let total = 0
  for (const one of set) total += held(one)
  if (total < pools.sizes[kind]) return
  let oldest: AppearanceNode | undefined
  let serial = Infinity
  for (const one of set) {
    const first = oldestSerial(one)
    if (first < serial) {
      serial = first
      oldest = one
    }
  }
  if (oldest) evict(oldest)
}

const oldestSerial = ({ lane, records }: AppearanceNode): number => {
  if (records) return records[0]?.state[SERIAL] ?? Infinity
  if (!lane) return Infinity
  for (let i = lane.tail; i < lane.head; i++) {
    const o = i * RECORD
    if (aliveAt(lane, o)) return lane.records[o + SERIAL]!
  }
  return Infinity
}

const evict = (node: AppearanceNode) => {
  const { lane, records } = node
  if (records) {
    const record = records.shift()
    if (record) {
      killRun(record.lifeRun, node)
      if (record.deathRun) killRun(record.deathRun, node)
    }
    return
  }
  if (!lane) return
  for (let i = lane.tail; i < lane.head; i++) {
    const o = i * RECORD
    if (!aliveAt(lane, o)) continue
    lane.records[o + LIFE] = -1
    lane.count--
    lane.version++
    return
  }
}

const killRun = (run: EffectRun, parent: AppearanceNode) => {
  for (const node of run.top) {
    kill(node)
    const at = parent.children.indexOf(node)
    if (at >= 0) parent.children.splice(at, 1)
  }
}

const appendRecord = (
  lane: Lane,
  six: Vector3[],
  age: number,
  life: number,
  axis: Vector3,
  serial: number,
) => {
  if (lane.head >= lane.capacity) repack(lane)
  const o = lane.head++ * RECORD
  const r = lane.records
  r[o] = six[0]!.x
  r[o + 1] = six[0]!.y
  r[o + 2] = six[0]!.z
  r[o + VELOCITY] = six[1]!.x
  r[o + VELOCITY + 1] = six[1]!.y
  r[o + VELOCITY + 2] = six[1]!.z
  r[o + BORN] = lane.clock
  r[o + AGE] = age
  r[o + LIFE] = life
  r[o + AXIS] = axis.x
  r[o + AXIS + 1] = axis.y
  r[o + AXIS + 2] = axis.z
  r[o + SERIAL] = serial
  lane.count++
  lane.births++
}

/** Drops the holes, never reordering, and grows if it's still more than half full. */
const repack = (lane: Lane) => {
  const { records } = lane
  const room = Math.max(LANE_MIN, lane.count * 2)
  const into = room === lane.capacity ? records : new Float32Array(room * RECORD)
  let write = 0
  for (let read = lane.tail; read < lane.head; read++) {
    const o = read * RECORD
    if (!aliveAt(lane, o)) continue
    if (into !== records || write !== read)
      into.set(records.subarray(o, o + RECORD), write * RECORD)
    write++
  }
  lane.records = into
  lane.capacity = room
  lane.tail = 0
  lane.head = write
  lane.version++
}

/** A perp's roll starts at +X, or +Z when it leaves along +X (`0x6235e15`). */
const perpSeed = ({ x, y, z }: Vector3): Vector3 =>
  (x - 1) ** 2 <= 1e-6 && y * y <= 1e-6 && z * z <= 1e-6
    ? { x: 0, y: 0, z: 1 }
    : { x: 1, y: 0, z: 0 }

const NO_AXIS: Vector3 = { x: 1, y: 0, z: 0 }

/** A perp lane's roll, re-derived from the last: the axis across the velocity (`0x6233330`). */
const carryAxis = (s: Float32Array, o: number) => {
  let vx = s[o + VELOCITY]!
  let vy = s[o + VELOCITY + 1]!
  let vz = s[o + VELOCITY + 2]!
  const ax = s[o + AXIS]!
  const ay = s[o + AXIS + 1]!
  const az = s[o + AXIS + 2]!
  const squared = Math.fround(vx * vx + vy * vy + vz * vz)
  const length = squared * inverseLength(squared)
  if (length > 1e-6) {
    vx /= length
    vy /= length
    vz /= length
  } else if (ax * ax <= 1e-8 && (1 - ay) * (1 - ay) <= 1e-8 && az * az <= 1e-8) {
    vx = 1
    vy = vz = 0
  } else {
    vx = vz = 0
    vy = 1
  }
  const nx = vz * ay - vy * az
  const ny = az * vx - vz * ax
  const nz = vy * ax - ay * vx
  const i = inverseLength(Math.fround(nx * nx + ny * ny + nz * nz))
  s[o + AXIS] = vy * nz * i - vz * ny * i
  s[o + AXIS + 1] = vz * nx * i - vx * nz * i
  s[o + AXIS + 2] = vx * ny * i - vy * nx * i
}

export class EffectInstance {
  readonly top: RunNode[] = []
  readonly context: RunContext
  /** Seconds, the effect's clock, which is also its top nodes' age. */
  time = 0
  /** `view` as given to the last advance, and the one before, for the dust. */
  view?: Matrix4
  previousView?: Matrix4
  lastStep = 0
  cameraTravel = 0
  previousTravel = Number.NaN
  readonly #run: EffectRun

  constructor(
    scene: EffectScene,
    { lookup, pools }: { lookup?: EffectLookup; pools?: EffectPools } = {},
  ) {
    this.context = { pools: pools ?? createPools(), lookup, sparam: 0, lod: 1 }
    this.#run = this.#start(scene, undefined)
  }

  /** Nothing left to show or make: what the game asks before dropping an effect (`+0x2c(7)`). */
  get finished(): boolean {
    return runFinished(this.#run)
  }

  /** Its emitters stop, and what they made lives out (`+0x34(1)`, `0x4f84d0`). */
  stop(): void {
    stopRun(this.#run, this.top)
  }

  /** One of the game's frames, at the step the host chooses (`0x4f8a20`). */
  advance(dt: number, { sparam, lod, placement, view }: AdvanceOptions = {}): void {
    const { context, top } = this
    if (sparam !== undefined) context.sparam = sparam
    if (lod !== undefined) context.lod = lod
    this.time += dt
    this.previousView = this.view
    this.view = view
    this.lastStep = dt
    if (view && this.previousView) {
      // The camera's travel in the world: the view's translation back through its rotation.
      const here = frameInverse(view).w
      const last = frameInverse(this.previousView).w
      this.previousTravel = this.cameraTravel
      this.cameraTravel = Math.hypot(here.x - last.x, here.y - last.y, here.z - last.z)
    }
    if (placement) {
      const { root } = this.#run
      if (root) root.override = placement
      else for (const node of this.#run.top) node.override = placement
    }
    for (const node of top.slice()) this.#compose(node, Matrix4.identity)
    for (const node of top.slice()) this.#walk(node, dt, top)
  }

  #compose(node: RunNode, parent: Matrix4): void {
    if (node.dead) return
    const { sparam } = this.context
    const { descriptor } = node
    if (descriptor?.kind === 'particle-appearance') this.#startDeaths(node as AppearanceNode)
    const local = localMatrix(descriptor?.transform, sparam, node.age)
    const placed = node.override ? Matrix4.multiply(parent, node.override) : parent
    node.world = local ? Matrix4.multiply(placed, local) : placed
    for (const child of node.children.slice()) this.#compose(child, node.world)
  }

  /** `0x6201810`. A node that says it's done dies here, with all that hangs from it. */
  #walk(node: RunNode, dt: number, top: RunNode[]): void {
    if (node.dead) return
    if (node.update(dt)) {
      kill(node)
      detach(node, top)
      return
    }
    for (const child of node.children.slice()) this.#walk(child, dt, top)
  }

  /** Builds a run's nodes, links them in entry order, then applies its `Pair` records in order. */
  #start(scene: EffectScene, parent: AppearanceNode | undefined): EffectRun {
    const run: EffectRun = { context: this.context, scene, nodes: [], top: [] }
    scene.nodes.forEach((entry, index) => {
      const node: RunNode = {
        run,
        index,
        key: entry.key,
        descriptor: entry.descriptor,
        parent: undefined,
        children: [],
        age: 0,
        // Reported, and inert rather than a clock that kills what hangs from it.
        lifeSpan: entry.descriptor?.lifeSpan ?? Infinity,
        dead: false,
        world: Matrix4.identity,
        update: () => false,
      }
      run.nodes.push(node)
    })
    // A flagged entry takes the longest lifespan below it, 0 with none (`0x621f526`). Top level first.
    const order = [...scene.top, ...scene.nodes.keys()].filter((v, i, a) => a.indexOf(v) === i)
    for (const index of order) {
      const entry = scene.nodes[index]!
      if (entry.descriptor?.category !== 'folder') continue
      const longest = (of: number): number =>
        scene.nodes[of]!.children.reduce(
          (most, child) => Math.max(most, run.nodes[child]!.lifeSpan, longest(child)),
          0,
        )
      run.nodes[index]!.lifeSpan = longest(index)
    }
    scene.nodes.forEach((entry, index) => {
      const node = run.nodes[index]!
      node.parent = entry.parent >= 0 ? run.nodes[entry.parent] : parent
      this.#behave(node)
    })
    for (const node of run.nodes) insertChild(node.parent, this.top, node)
    run.top = scene.top.map((index) => run.nodes[index]!)
    if (scene.root !== undefined) run.root = run.nodes[scene.root]
    scene.nodes.forEach((entry, index) => {
      const node = run.nodes[index]!
      for (const target of entry.targets) {
        const other = run.nodes[target]!
        if (node.descriptor?.category === 'emitter') this.#associate(node, other)
        else if (
          node.descriptor?.category === 'appearance' &&
          other.descriptor?.category === 'field'
        )
          (node as AppearanceNode).fields.push(other as FieldNode)
      }
    })
    return run
  }

  /** An emitter has one slot (`+0x98`), so a later link replaces it, and the old count stays. */
  #associate(node: RunNode, other: RunNode): void {
    const emitter = node as EmitterNode
    if (other.descriptor?.category !== 'appearance') {
      emitter.target = undefined
      return
    }
    emitter.target = other as AppearanceNode
    emitter.fresh = true
    emitter.target.refs++
  }

  #behave(node: RunNode): void {
    const { descriptor } = node
    switch (descriptor?.category) {
      case 'emitter':
        return this.#behaveEmitter(node as EmitterNode, descriptor)
      case 'appearance':
        return this.#behaveAppearance(node as AppearanceNode, descriptor)
      case 'field':
        return this.#behaveField(node as FieldNode, descriptor)
      default:
        node.update = (dt) => {
          node.age += dt
          return node.age > node.lifeSpan
        }
    }
  }

  #behaveField(node: FieldNode, descriptor: Field): void {
    node.state = { kind: 'beam-field' }
    const { context } = this
    const blendOf = (approach: number, dt: number) => Math.min(1, dt * approach * 4)
    node.update = (dt) => {
      node.age += dt
      const at = (c: AnimatedCurve | undefined, fallback: number) =>
        curve(c, context.sparam, node.age, fallback)
      switch (descriptor.kind) {
        case 'gravity-field':
          node.state = { kind: descriptor.kind, change: at(descriptor.gravity, 9.8) * dt }
          break
        case 'air-field':
          node.state = {
            kind: descriptor.kind,
            magnitude: at(descriptor.magnitude, 1),
            blend: blendOf(at(descriptor.approach, 1), dt),
          }
          break
        case 'turbulence-field':
          node.state = {
            kind: descriptor.kind,
            magnitude: at(descriptor.magnitude, 10),
            blend: blendOf(at(descriptor.approach, 1), dt),
          }
          break
        case 'radial-field':
          node.state = {
            kind: descriptor.kind,
            magnitude: at(descriptor.magnitude, 10),
            inverseRadius: 1 / Math.max(at(descriptor.radius, 50), 0.001),
            attenuation: descriptor.attenuation,
            blend: blendOf(at(descriptor.approach, 0.3), dt),
          }
          break
        case 'collide-field':
          node.state = {
            kind: descriptor.kind,
            reflectivity: at(descriptor.reflectivity, 0.7),
            dt,
          }
          break
        case 'dust-field':
          node.state = { kind: descriptor.kind, radius: at(descriptor.maxRadius, 60.1) }
          break
        case 'beam-field':
          break
      }
      return node.age > node.lifeSpan
    }
  }

  #behaveAppearance(node: AppearanceNode, descriptor: Appearance): void {
    node.refs = 0
    node.fields = []
    node.died = () => {
      this.context.pools.held.get(descriptor.kind)?.delete(node)
    }
    if (descriptor.kind === 'particle-appearance') {
      node.records = []
      node.update = (dt) => this.#updateSpawner(node, descriptor, dt)
      return
    }
    const entry = node.run.scene.nodes[node.index]!
    const stepped = entry.targets.some((target) => {
      const linked = node.run.scene.nodes[target]!.descriptor
      return linked?.category === 'field' && linked.kind !== 'beam-field'
    })
    const lane = createLane(stepped)
    node.lane = lane
    const perp = descriptor.kind === 'perp-appearance'
    node.update = (dt) => {
      node.age += dt
      const empty = node.refs === 0 && lane.count === 0
      if (lane.stepped) this.#stepLane(node, lane, dt, perp)
      else {
        lane.clock += dt
        rebase(lane)
        let count = 0
        const { head } = lane
        for (let i = lane.tail; i < head; i++) if (aliveAt(lane, i * RECORD)) count++
        lane.count = count
        while (lane.tail < head && !aliveAt(lane, lane.tail * RECORD)) lane.tail++
      }
      // It never checks its own clock: an appearance's `Node_LifeSpan` alone doesn't stop it (`0x6216441`).
      return empty
    }
  }

  /** The list appearance's update: fields over every record, then age and move (`0x62188c0`). */
  #stepLane(node: AppearanceNode, lane: Lane, dt: number, perp: boolean): void {
    const { records } = lane
    applyFields(node, (apply) => {
      for (let i = 0; i < lane.head; i++) apply(records, i * RECORD)
    })
    let write = 0
    for (let read = 0; read < lane.head; read++) {
      const o = read * RECORD
      const age = records[o + AGE]! + dt
      if (age > records[o + LIFE]!) continue
      const w = write * RECORD
      if (w !== o) records.copyWithin(w, o, o + RECORD)
      records[w + AGE] = age
      records[w] = records[w]! + records[w + VELOCITY]! * dt
      records[w + 1] = records[w + 1]! + records[w + VELOCITY + 1]! * dt
      records[w + 2] = records[w + 2]! + records[w + VELOCITY + 2]! * dt
      if (perp) carryAxis(records, w)
      write++
    }
    lane.head = write
    lane.count = write
    for (let i = 0; i < write; i++) records[i * RECORD + BORN] = lane.clock
    lane.version++
  }

  #updateSpawner(node: AppearanceNode, descriptor: ParticleAppearance, dt: number): boolean {
    node.age += dt
    const records = node.records!
    const empty = node.refs === 0 && records.length === 0
    applyFields(node, (apply) => {
      for (const { state } of records) if (state[AGE]! < state[LIFE]!) apply(state, 0)
    })
    let write = 0
    for (const record of records) {
      const { state } = record
      if (state[AGE]! <= state[LIFE]!) {
        state[AGE]! += dt
        if (!(state[AGE]! > state[LIFE]!)) this.#placeLife(descriptor, record, dt)
        else if (!runFinished(record.lifeRun)) stopRun(record.lifeRun, node.children)
        records[write++] = record
        continue
      }
      if (
        !runFinished(record.lifeRun) ||
        (record.deathRun !== undefined && !runFinished(record.deathRun))
      ) {
        records[write++] = record
        continue
      }
      killRun(record.lifeRun, node)
      if (record.deathRun) killRun(record.deathRun, node)
    }
    records.length = write
    return empty
  }

  /** `0x622ff00`: moves a particle, and hands its life effect `[R | p]`. */
  #placeLife(descriptor: ParticleAppearance, record: ParticleRecord, dt: number): void {
    const { state } = record
    state[0]! += state[VELOCITY]! * dt
    state[1]! += state[VELOCITY + 1]! * dt
    state[2]! += state[VELOCITY + 2]! * dt
    const position = { x: state[0]!, y: state[1]!, z: state[2]! }
    let placed = Matrix4.translation(position)
    if (descriptor.useDynamicRotation) {
      const velocity = { x: state[VELOCITY]!, y: state[VELOCITY + 1]!, z: state[VELOCITY + 2]! }
      let turn = turnTo(velocity)
      if (descriptor.smoothRotation) {
        const speed = Math.hypot(velocity.x, velocity.y, velocity.z)
        let blend = speed * dt
        if (!(speed >= 0.5)) {
          turn = Quat.identity
          blend = dt + 0.01
        }
        record.blend = Quat.slerp(record.blend, turn, Math.min(blend, 1))
        turn = record.blend
      }
      placed = Matrix4.fromRotationTranslation(Matrix3.fromQuaternion(turn), position)
    }
    this.#place(record.lifeRun, placed)
  }

  #place(run: EffectRun, placed: Matrix4): void {
    if (run.root) run.root.override = placed
    else for (const node of run.top) node.override = placed
  }

  /** `0x622fcf0`: a death effect starts where its particle stands, unturned, in the next compose. */
  #startDeaths(node: AppearanceNode): void {
    const descriptor = node.descriptor as ParticleAppearance
    if (!descriptor.deathName) return
    for (const record of node.records!) {
      const { state } = record
      if (record.deathRun || !(state[AGE]! > state[LIFE]!)) continue
      const scene = this.context.lookup?.(descriptor.deathName)
      if (!scene) continue
      record.deathRun = this.#start(scene, node)
      this.#place(
        record.deathRun,
        Matrix4.translation({ x: state[0]!, y: state[1]!, z: state[2]! }),
      )
    }
  }

  /** A birth handed over from an emitter (`+0xbc`), through the pool. */
  #spawn(
    node: AppearanceNode,
    position: Vector3,
    velocity: Vector3,
    age: number,
    life: number,
  ): void {
    const { descriptor } = node
    const { context } = this
    claim(context, node)
    const serial = context.pools.serial++
    if (descriptor.kind === 'particle-appearance') {
      // No name, or one no library defines, and no particle is born (`0x622f6fc`, `0x622f742`).
      const scene = descriptor.lifeName ? context.lookup?.(descriptor.lifeName) : undefined
      if (!scene) return
      const state = new Float32Array(RECORD)
      state.set([position.x, position.y, position.z, velocity.x, velocity.y, velocity.z])
      state[AGE] = age
      state[LIFE] = life
      state[SERIAL] = serial
      const lifeRun = this.#start(scene, node)
      const record: ParticleRecord = { state, lifeRun, blend: Quat.identity }
      node.records!.push(record)
      this.#placeLife(descriptor, record, 0)
      return
    }
    const axis = descriptor.kind === 'perp-appearance' ? perpSeed(velocity) : NO_AXIS
    appendRecord(node.lane!, [position, velocity], age, life, axis, serial)
  }

  #behaveEmitter(node: EmitterNode, descriptor: Emitter): void {
    node.fresh = true
    node.last = 0
    node.carry = 0
    node.previous = { x: 0, y: 0, z: 0 }
    node.died = () => {
      if (node.target) node.target.refs--
    }
    const { context } = this
    const emit = this.#emitter(node, descriptor)
    // `0x6245bf0`.
    node.update = (dt) => {
      node.age += dt
      const expired = node.age > node.lifeSpan
      const target = node.target
      if (!target) return expired
      if (target.dead) {
        node.target = undefined
        return expired
      }
      emit(target, context.sparam, node.age)
      return expired
    }
  }

  #emitter(node: EmitterNode, descriptor: Emitter) {
    const { context } = this
    return (target: AppearanceNode, sparam: number, t: number) => {
      const at = (c: AnimatedCurve | undefined, fallback: number) => curve(c, sparam, t, fallback)
      const pressure = at(descriptor.pressure, 10)
      const lifeSpan = at(descriptor.initLifeSpan, 2)
      const frequency = at(descriptor.frequency, 100)
      const elapsed = t - node.last
      let count = Math.trunc(elapsed * frequency)
      const here = node.world.w
      if (node.fresh) {
        node.fresh = false
        count += Math.trunc(descriptor.initialParticles)
        node.previous = { x: here.x, y: here.y, z: here.z }
      }
      for (const { key, value } of descriptor.emitCount?.keyframes[0]?.keyframes ?? []) {
        if (key < node.last) continue
        if (key > t) break
        count = Math.trunc(count + value.x)
      }
      const lod = descriptor.lodCurve ? floatAt(descriptor.lodCurve, sparam, context.lod) : 1
      const sum = lod * count + node.carry
      const total = Math.trunc(sum)
      node.carry = sum - total
      if (!total) {
        if (!frequency) node.last = t
        return
      }
      const path = transposeInto(node.world, node.previous)
      node.previous = { x: here.x, y: here.y, z: here.z }
      // The whole path lends the velocity; only its share per birth spaces them (`0x6245fa0`).
      const share = elapsed > 0 ? -at(descriptor.velocityApproach, 0) / elapsed : 0
      const bias = { x: path.x * share, y: path.y * share, z: path.z * share }
      if (target.parent === node.parent) path.x = path.y = path.z = 0
      const room = at(descriptor.maxParticles, 10000) - held(target)
      let births = room < total ? Math.trunc(room) : total
      // This library's rule, not read: a birth with no life would last until the next update at most.
      if (!(lifeSpan > 0)) births = 0
      const frame = Matrix4.multiply(frameInverse(target.world), node.world)
      for (let n = 1; n <= births; n++) {
        const back = 1 - n / total
        const age = elapsed * back
        const { point, direction } = this.#shape(descriptor, sparam, t)
        const vx = direction.x * pressure
        const vy = direction.y * pressure
        const vz = direction.z * pressure
        const position = Matrix4.transformPoint(
          {
            x: point.x + vx * age + path.x * back,
            y: point.y + vy * age + path.y * back,
            z: point.z + vz * age + path.z * back,
          },
          frame,
        )
        const velocity = scaled(frame, { x: vx + bias.x, y: vy + bias.y, z: vz + bias.z })
        this.#spawn(target, position, velocity, age, lifeSpan)
      }
      node.last = t
    }
  }

  #spread(min: number, max: number): Vector3 {
    const { pools } = this.context
    const phi = random(pools) * 2 * Math.PI
    const theta = (min + random(pools) * (max - min)) * (Math.PI / 180)
    const sin = Math.sin(theta)
    return { x: Math.cos(phi) * sin, y: Math.cos(theta), z: -Math.sin(phi) * sin }
  }

  /** Where a particle appears and which way it leaves, random draws in the DLL's order, about +Y. */
  #shape(descriptor: Emitter, sparam: number, t: number) {
    const { pools } = this.context
    const at = (c: AnimatedCurve | undefined, fallback: number) => curve(c, sparam, t, fallback)
    switch (descriptor.kind) {
      // `0x621d430`: half-extents, height drawn first, and a heading independent of the point.
      case 'cube-emitter': {
        const direction = this.#spread(at(descriptor.minSpread, 0), at(descriptor.maxSpread, 15))
        const y = 2 * (random(pools) - 0.5) * at(descriptor.height, 5)
        const x = 2 * (random(pools) - 0.5) * at(descriptor.width, 5)
        const z = 2 * (random(pools) - 0.5) * at(descriptor.depth, 5)
        return { point: { x, y, z }, direction }
      }
      // `0x623bd60`: a point of the cube normalized, so it leans towards the diagonals.
      case 'sphere-emitter': {
        const b = 2 * (random(pools) - 0.5)
        const a = 2 * (random(pools) - 0.5)
        const c = 2 * (random(pools) - 0.5)
        const i = inverseLength(Math.fround(a * a + b * b + c * c))
        const direction = { x: a * i, y: b * i, z: c * i }
        const min = at(descriptor.minRadius, 0)
        const radius = min + random(pools) * (at(descriptor.maxRadius, 1) - min)
        return {
          point: { x: direction.x * radius, y: direction.y * radius, z: direction.z * radius },
          direction,
        }
      }
      // `0x621ba90`.
      case 'cone-emitter': {
        const direction = this.#spread(at(descriptor.minSpread, 0), at(descriptor.maxSpread, 0))
        const min = at(descriptor.minRadius, 0)
        const radius = min + random(pools) * (at(descriptor.maxRadius, 1) - min)
        return {
          point: { x: direction.x * radius, y: direction.y * radius, z: direction.z * radius },
          direction,
        }
      }
    }
  }
}

interface EmitterNode extends RunNode {
  target?: AppearanceNode
  /** Adds `InitialParticles` once, and takes where it stands now (`0x6245cd9`). */
  fresh: boolean
  last: number
  carry: number
  previous: Vector3
}
