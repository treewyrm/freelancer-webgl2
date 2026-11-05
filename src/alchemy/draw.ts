/** An effect's appearances as draws, in the game's order (`0x6201910`). Pure, no GL. */
import {
  curveAt,
  floatAt,
  colorAt,
  type AnimatedColor,
  type AnimatedFloat,
  type Blending,
} from '@treewyrm/freelancer/alchemy'
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { Texture, TextureEntry } from '@treewyrm/freelancer/texture'
import type { AppearanceNode, EffectInstance, FieldNode, Lane, RunNode } from './effect.js'
import { AGE, BORN, LIFE, POSITION, RECORD } from './effect.js'
import type { UVRect } from './curves.js'
import type { Appearance, BeamAppearance, Sprite } from './nodes.js'
import { frameInverse } from './transform.js'

export const FACING_CAMERA = 0
export const FACING_TRAVEL = 1
export const FACING_PERPENDICULAR = 2
export const FACING_NODE = 3
export const FACING_DUST = 4

export const SHAPE_QUAD = 0
export const SHAPE_TRIANGLE = 1
export const SHAPE_TRI_TEXTURE = 2

export const KIND_BASIC = 0
export const KIND_PERP = 1
export const KIND_RECT = 2
export const KIND_DUST = 3
export const KIND_ORIENTED = 4

export interface EffectDrawCommon {
  /** The appearance's world, as last composed: the game draws with it unadvanced. */
  world: Matrix4
  texture?: { name: string; entry: Texture }
  blend?: Blending
}

/** The lists a sprite reads, keyed in the vertex stage by each particle's age. */
export interface SpriteLists {
  kind: number
  color?: AnimatedColor
  alpha?: AnimatedFloat
  a?: AnimatedFloat
  b?: AnimatedFloat
  c?: AnimatedFloat
  roll?: AnimatedFloat
  frame?: AnimatedFloat
}

export interface SpriteDraw extends EffectDrawCommon {
  type: 'sprite'
  lane: Lane
  /** Its clock now: what `BORN` is read against. */
  time: number
  sparam: number
  /** `Appearance_LODCurve` at the host's key, on every extent but the dust's. */
  extent: number
  facing: number
  shape: number
  blur: boolean
  centered: boolean
  fade: boolean
  lists: SpriteLists
  /** The atlas frames a particle's own clock picks among. */
  frames: readonly UVRect[]
  /** The camera, in the appearance's frame. */
  eye: Vector3
  dust?: { previous: Matrix4; step: number; fade: number }
}

/** Interleaved `position, colour, uv` triangles, already in the appearance's frame. */
export interface BeamDraw extends EffectDrawCommon {
  type: 'beam'
  vertices: Float32Array
  count: number
}

export type EffectDraw = SpriteDraw | BeamDraw

const GREY: Vector3 = { x: 0.8, y: 0.8, z: 0.8 }

const FULL: UVRect = { u1: 0, v1: 0, u2: 1, v2: 1 }

const rectOf = (rect: UVRect, { flipU, flipV }: Sprite): UVRect => ({
  u1: flipU ? rect.u2 : rect.u1,
  u2: flipU ? rect.u1 : rect.u2,
  v1: flipV ? rect.v2 : rect.v1,
  v2: flipV ? rect.v1 : rect.v2,
})

/**
 * A sprite's texture and frames. `UseCommonTexFrame` is the instance's clock, and its frame names the
 * atlas. Otherwise it's each particle's clock over one atlas. **Not built:** that case also advances the
 * texture's own playback, which picks the atlas bound (`0x6244ef0`): M8's `TickAllPlayback`.
 */
const spriteTexture = (
  descriptor: Sprite,
  node: RunNode,
  sparam: number,
  texture: (name: string) => TextureEntry | undefined,
  unsupported: Set<string>,
): { texture?: { name: string; entry: Texture }; frames: readonly UVRect[] } => {
  const name = descriptor.texture
  const plain = { frames: [rectOf(FULL, descriptor)] }
  if (!name) return plain
  const entry = texture(name)
  if (!entry) {
    unsupported.add(`texture ${name}`)
    return plain
  }
  if (entry.type === 'cube') return plain
  if (entry.type !== 'animated') return { ...plain, texture: { name, entry } }
  if (!entry.frames.length) return plain
  const bound = (atlas: number) => {
    const found = texture(`${entry.name}_${atlas}`)
    return found && found.type !== 'cube' && found.type !== 'animated'
      ? { name: `${entry.name}_${atlas}`, entry: found }
      : undefined
  }
  if (descriptor.useCommonTexFrame) {
    const position = descriptor.commonTexFrame
      ? curveAt(descriptor.commonTexFrame, sparam, node.age)
      : 0
    const count = entry.frames.length
    const frame =
      entry.frames[Math.max(0, Math.min(count - 1, Math.trunc(position * (count - 1))))]!
    return { texture: bound(frame.index), frames: [rectOf(frame, descriptor)] }
  }
  return { texture: bound(0), frames: entry.frames.map((frame) => rectOf(frame, descriptor)) }
}

const listsOf = (descriptor: Appearance): SpriteLists | undefined => {
  switch (descriptor.kind) {
    case 'basic-appearance':
      return {
        kind: KIND_BASIC,
        color: descriptor.color,
        alpha: descriptor.alpha,
        a: descriptor.size,
        b: descriptor.aspect,
        roll: descriptor.rotate,
        frame: descriptor.texFrame,
      }
    case 'perp-appearance':
      return {
        kind: KIND_PERP,
        color: descriptor.color,
        alpha: descriptor.alpha,
        a: descriptor.size,
        frame: descriptor.texFrame,
      }
    case 'rect-appearance':
      return {
        kind: KIND_RECT,
        color: descriptor.color,
        alpha: descriptor.alpha,
        a: descriptor.width,
        b: descriptor.length,
        c: descriptor.scale,
        frame: descriptor.texFrame,
      }
    case 'dust-appearance':
      return {
        kind: KIND_DUST,
        color: descriptor.color,
        alpha: descriptor.alpha,
        a: descriptor.size,
      }
    case 'oriented-appearance':
      return {
        kind: KIND_ORIENTED,
        color: descriptor.color,
        alpha: descriptor.alpha,
        a: descriptor.width,
        b: descriptor.height,
        c: descriptor.scale,
        frame: descriptor.texFrame,
      }
    default:
      return undefined
  }
}

/** The camera's speed fades all of the dust: none at rest, full at 100, none at 1,200 (`0x620fcb0`). */
export const dustFade = (travel: number, previous: number, step: number): number => {
  const speed = travel / step
  let fade =
    speed < 100 ? 1 - (1 - speed / 100) ** 2 : speed < 1200 ? 1 - ((speed - 100) / 1100) ** 2 : 0
  // Kept when the previous travel is unknown, as the routine's compare falls through on a NaN.
  const jerk = Math.abs(previous - travel)
  if (jerk > 20) fade = jerk < 35 ? fade * (1 - (jerk - 20) / 15) : 0
  return fade
}

const FLOATS = 9

/** `_ftol(c × 255)`, keeping the low byte, as the vertex colour packs it (`0x620610d`). */
const packed = (c: number) => (Math.trunc(c * 255) & 0xff) / 255

interface BeamPoint {
  x: number
  y: number
  z: number
  half: number
  r: number
  g: number
  b: number
  a: number
  mirrored: boolean
}

/**
 * A beam's chain, newest first, opened on each point into a cross along the camera's axes. Built here,
 * as the game does, since every point is read and most are skipped or shifted (`0x6205720`).
 */
const beamVertices = (
  node: AppearanceNode,
  descriptor: BeamAppearance,
  instance: EffectInstance,
  rect: UVRect,
  axes: readonly [Vector3, Vector3],
): { vertices: Float32Array; count: number } | undefined => {
  const lane = node.lane!
  const { sparam, lod } = instance.context
  const extent = descriptor.lodCurve ? floatAt(descriptor.lodCurve, sparam, lod) : 1
  const live: number[] = []
  for (let i = lane.head - 1; i >= lane.tail; i--) {
    const o = i * RECORD
    const age = lane.records[o + AGE]! + (lane.clock - lane.records[o + BORN]!)
    if (age <= lane.records[o + LIFE]!) live.push(i)
  }
  if (!live.length) return undefined

  const position = (i: number): Vector3 => {
    const o = live[i]! * RECORD
    const elapsed = lane.clock - lane.records[o + BORN]!
    return {
      x: lane.records[o + POSITION]! + lane.records[o + 3]! * elapsed,
      y: lane.records[o + POSITION + 1]! + lane.records[o + 4]! * elapsed,
      z: lane.records[o + POSITION + 2]! + lane.records[o + 5]! * elapsed,
    }
  }
  const ageOf = (i: number) => {
    const o = live[i]! * RECORD
    return lane.records[o + AGE]! + (lane.clock - lane.records[o + BORN]!)
  }
  const keyOf = (i: number) => {
    const life = lane.records[live[i]! * RECORD + LIFE]!
    return life > 0 ? Math.min(1, Math.max(0, ageOf(i) / life)) : 0
  }

  const points: BeamPoint[] = []
  const toggle = lane.births % 2
  const emit = (i: number, { x, y, z }: Vector3) => {
    const key = keyOf(i)
    const width =
      (descriptor.width ? floatAt(descriptor.width, sparam, key) : 1) *
      (descriptor.scale ? floatAt(descriptor.scale, sparam, key) : 1) *
      extent
    const { x: r, y: g, z: b } = descriptor.color ? colorAt(descriptor.color, sparam, key) : GREY
    const a = descriptor.alpha ? floatAt(descriptor.alpha, sparam, key) : 1
    points.push({
      x,
      y,
      z,
      half: width / 2,
      r,
      g,
      b,
      a: packed(a),
      mirrored: (points.length & 1) === toggle,
    })
  }

  const near = (a: Vector3, b: Vector3) =>
    (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 <= 0.01

  // An `FLBeamField` it links is the head, wherever it stands.
  let anchor: Vector3 | undefined
  const inverse = frameInverse(node.world)
  for (const field of node.fields as FieldNode[])
    if (!field.dead && field.descriptor?.kind === 'beam-field') {
      anchor = Matrix4.transformPoint(field.world.w, inverse)
      break
    }

  let head: Vector3 | undefined
  if (anchor && !near(anchor, position(0))) head = anchor
  else if (live.length < 2) return undefined
  else if (!descriptor.disablePlaceHolder) {
    // Where a particle of age zero would be, from the two newest. Bunched, or a burst's two of one age, none.
    const p0 = position(0)
    const p1 = position(1)
    const r = ageOf(0) / (ageOf(1) - ageOf(0))
    if (!near(p0, p1) && Number.isFinite(r))
      head = {
        x: p0.x - (p1.x - p0.x) * r,
        y: p0.y - (p1.y - p0.y) * r,
        z: p0.z - (p1.z - p0.z) * r,
      }
  }

  // Without `DupeFirstParticle`, positions lag one point behind properties, and the oldest's is dropped.
  const shifted = head !== undefined && !descriptor.dupeFirstParticle
  if (head) emit(0, head)
  let last = head
  if (!shifted) {
    last = position(0)
    emit(0, last)
  }
  for (let i = 1; i < live.length; i++) {
    const at = position(shifted ? i - 1 : i)
    if (last && near(at, last)) continue
    emit(i, at)
    last = at
  }
  if (points.length < 2) return undefined

  const fan = descriptor.quadTexture
  const perSegment = (fan ? 12 : 6) * 2
  const vertices = new Float32Array((points.length - 1) * perSegment * FLOATS)
  let v = 0
  const write = (point: BeamPoint, axis: Vector3, side: number) => {
    vertices.set(
      [
        point.x + axis.x * point.half * side,
        point.y + axis.y * point.half * side,
        point.z + axis.z * point.half * side,
        point.r,
        point.g,
        point.b,
        point.a,
        side < 0 ? rect.u1 : rect.u2,
        point.mirrored ? rect.v1 : rect.v2,
      ],
      v,
    )
    v += FLOATS
  }
  // The centre takes UV (0.5, 0.5) literally, whatever the frame, and the far end's colour.
  const centre = (a: BeamPoint, b: BeamPoint) => {
    vertices.set(
      [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, b.r, b.g, b.b, b.a, 0.5, 0.5],
      v,
    )
    v += FLOATS
  }
  for (const axis of axes)
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!
      const b = points[i + 1]!
      if (fan) {
        write(a, axis, -1)
        write(a, axis, 1)
        centre(a, b)
        write(a, axis, 1)
        write(b, axis, 1)
        centre(a, b)
        write(b, axis, 1)
        write(b, axis, -1)
        centre(a, b)
        write(b, axis, -1)
        write(a, axis, -1)
        centre(a, b)
      } else {
        write(a, axis, -1)
        write(a, axis, 1)
        write(b, axis, -1)
        write(a, axis, 1)
        write(b, axis, 1)
        write(b, axis, -1)
      }
    }
  return { vertices, count: v / FLOATS }
}

export const collectEffect = (
  instance: EffectInstance,
  view: Matrix4,
  texture: (name: string) => TextureEntry | undefined,
  draws: EffectDraw[],
  unsupported: Set<string>,
): void => {
  const { sparam, lod } = instance.context
  const camera = frameInverse(view)

  const visit = (node: RunNode) => {
    if (node.dead) return
    if (node.descriptor?.category === 'appearance') appear(node as AppearanceNode)
    for (const child of node.children) visit(child)
  }

  const appear = (node: AppearanceNode) => {
    const { descriptor } = node
    if (descriptor.kind === 'particle-appearance') return
    if (descriptor.kind === 'mesh-appearance') {
      // The game's factory fails on every one of these and crashes on spawn (`0x6224ed9`).
      unsupported.add(`FxMeshAppearance ${descriptor.name}`)
      return
    }
    const lane = node.lane!
    if (!lane.count) return
    const { texture: bound, frames } = spriteTexture(descriptor, node, sparam, texture, unsupported)
    const common = { world: node.world, texture: bound, blend: descriptor.blend }

    if (descriptor.kind === 'beam-appearance') {
      // `S · W`'s first two columns, added in the frame, so `W` reaches them twice (`0x620592d`).
      const axes = Matrix4.multiply(camera, node.world)
      const beam = beamVertices(node, descriptor, instance, frames[0] ?? FULL, [axes.x, axes.y])
      if (beam) draws.push({ ...common, type: 'beam', ...beam })
      return
    }

    const lists = listsOf(descriptor)
    if (!lists) return
    const extent =
      descriptor.kind === 'dust-appearance' || !descriptor.lodCurve
        ? 1
        : floatAt(descriptor.lodCurve, sparam, lod)
    // The basic routine's one test on it, before any particle (`0x62165ca`).
    if (descriptor.kind === 'basic-appearance' && extent === 0) return

    const previous = instance.previousView
    const dust =
      descriptor.kind === 'dust-appearance'
        ? previous && instance.lastStep > 0
          ? {
              previous: Matrix4.multiply(previous, node.world),
              step: instance.lastStep,
              fade: dustFade(instance.cameraTravel, instance.previousTravel, instance.lastStep),
            }
          : undefined
        : undefined
    if (descriptor.kind === 'dust-appearance' && !dust) return

    const eye = Matrix4.transformPoint(camera.w, frameInverse(node.world))
    const basic = descriptor.kind === 'basic-appearance'
    draws.push({
      ...common,
      type: 'sprite',
      lane,
      time: lane.clock,
      sparam,
      extent,
      facing: basic
        ? FACING_CAMERA
        : descriptor.kind === 'rect-appearance'
          ? FACING_TRAVEL
          : descriptor.kind === 'perp-appearance'
            ? FACING_PERPENDICULAR
            : descriptor.kind === 'dust-appearance'
              ? FACING_DUST
              : FACING_NODE,
      // `QuadTexture` alone picks the routine (`0x6217720`).
      shape:
        !basic || descriptor.quadTexture
          ? SHAPE_QUAD
          : descriptor.triTexture
            ? SHAPE_TRI_TEXTURE
            : SHAPE_TRIANGLE,
      blur:
        (basic && descriptor.quadTexture && descriptor.motionBlur) ||
        (descriptor.kind === 'rect-appearance' && descriptor.motionBlur),
      centered: descriptor.kind === 'rect-appearance' && descriptor.centerOnPos,
      fade: 'viewingAngleFade' in descriptor && descriptor.viewingAngleFade,
      lists,
      frames,
      eye,
      dust,
    })
  }

  for (const node of instance.top) visit(node)
}
