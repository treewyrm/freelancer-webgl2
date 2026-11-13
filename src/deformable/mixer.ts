/**
 * A character's motion mixer: the per-joint blend stacks `engbase.dll` keeps (`EngBaseMixer.cpp`),
 * with the scripts, root placement and aims `deformable2.dll` drives them by. Pure, no GL.
 *
 * Each animated target, a joint or the root, has a stack of leaves (a playing channel), overlays (a
 * snapshot of the target) and blends (a fade from what is beneath to the leaf above). Starting with
 * a transition fades in over what is there; a transition of 0 replaces it. What it writes is a
 * joint's state as `@treewyrm/freelancer/compound` reads it, so `placeCostume`'s `jointState` takes
 * it as is, and the root's placement in the character's frame, for the host to set its root by.
 *
 * Not here: the pose curve a blend runs on a root started with event flags `0x38`
 * (`FMixerBlend::Evaluate` `0661d227`, `MixerBlendAttach` `06616319`), which no retail THN is known
 * to use; aims over more than one joint (the damped least-squares solve, `FUN_065fc000`); aims
 * without `point_at`; compounds' motion, which has no root block or heading.
 */
import type { AnimationScript } from '@treewyrm/freelancer/animation'
import { getJointMatrix, type Joint, type JointState } from '@treewyrm/freelancer/compound'
import { Matrix3, Matrix4, Quat, Vector3 } from '@treewyrm/freelancer/math'
import {
  bind,
  blendOverlays,
  channelShape,
  createPlayer,
  hold,
  mapped,
  mix,
  placeAt,
  playable,
  rest,
  shift,
  tick,
  turnTo,
  turnY,
  yaw,
  type Header,
  type Placement,
  type Player,
  type PlayerContext,
  type Shape,
} from './player.js'

/** Event flags a motion reads. */
export const MotionFlag = {
  Backwards: 0x1,
  Loop: 0x2,
  Bounce: 0x4,
  /** Keep what is beneath once the fade in completes, rather than stopping it. */
  KeepBeneath: 0x80,
} as const

// `G_MixerEaseStep` (`DAT_06629508`): the double 0x3F893B352540C735, which is 3.14159 / 255,
// not π / 255.
const EASE_STEP = 3.14159 / 255

/** `MixerEase` (`FUN_0661d050`): a fade's weight at step `i` of 255, `½(1 − cos(i · step))`. */
export const EASE: Float32Array = Float32Array.from({ length: 0x100 }, (_, step) =>
  Math.fround((1 - Math.cos(step * EASE_STEP)) * 0.5),
)

/**
 * A fade's weight `time` seconds into `duration`: its step is floored, and a zero-length fade is
 * whole.
 */
export const fadeWeight = (time: number, duration: number): number => {
  if (!(duration > 0)) return EASE[0xff]!

  const step = Math.floor(Math.fround(1 / duration) * time * 255)

  return EASE[step] ?? EASE[0xff]!
}

type Node = Leaf | Blend | Overlay

interface Leaf {
  type: 'leaf'
  player: Player
  /** `bRemove`: dropped once this walk's value is written. */
  remove?: boolean
}

interface Blend {
  type: 'blend'
  time: number
  duration: number
  /** `Flags` bit 0: once done, stop what it faded from. Off with {@link MotionFlag.KeepBeneath}. */
  dropBeneath: boolean
}

interface Overlay {
  type: 'overlay'
  value: JointState
}

interface Target {
  /** Absent for the root. */
  name?: string
  shape: Shape
  revolute: boolean
  /** The target's parameters as last written: `GetJointParams`, or the root's placement. */
  value: JointState
  /** `FMixerList`. Absent once empty, as the engine erases it. */
  track?: { nodes: Node[]; fade: number }
}

interface Motion {
  type: 'motion'
  handle: number
  /** In the script's map order, which `TypedSampleXformType6` picks the first of. */
  players: { player: Player; target: Target }[]
  height?: number
}

interface Aim {
  type: 'aim'
  handle: number
  player: Player
  target: Target
  joint: string
  goal: Quat
  stopped: boolean
}

/** One animatable joint: its name, its parent's, and the joint its constraint makes. */
export interface MixerJoint {
  name: string
  parent: string
  joint: Joint
}

export interface MixerOptions {
  /** The root bone's name, which object maps drive. */
  root: string
  /** Every joint, a parent before its children. */
  joints: readonly MixerJoint[]
  /** The root's placement in the character's frame. */
  position?: Vector3
  orientation?: Quat
}

/** A motion's record, as `START_MOTION` hands it to `IDeformable +0x1c`. */
export interface MotionOptions {
  /** Seconds into each channel; past any channel's end the motion does not start. */
  startTime?: number
  /** The players' speed, its sign ignored. */
  timeScale?: number
  /** An amplitude on every channel, not a mix weight. */
  weight?: number
  /** The fade in, per target. 0 stops whatever was on each target. */
  transTime?: number
  eventFlags?: number
  /** Radians about Y the root faces; negative keeps its current yaw. */
  heading?: number
}

export interface AimOptions {
  /** The joint's world rotation, in the space the root is placed in: the root's own turn included. */
  target: Quat
  transitionDuration?: number
  eventFlags?: number
}

const SHAPES: Partial<Record<Joint['type'], Shape>> = {
  revolute: 'value',
  prismatic: 'value',
  translational: 'position',
  sphere: 'orientation',
  loose: 'pose',
}

// `SetHeight` (`0x65f50b0`) leaves the root be when the shift is within a float's epsilon.
const FLOAT_EPSILON = 1.1920928955078125e-7

const placementOf = ({ position, orientation }: JointState): Placement => ({
  position: position ?? Vector3.zero,
  rotation: orientation ?? Quat.identity,
})

const isLeafOf = (node: Node, player: Player): boolean =>
  node.type === 'leaf' && node.player === player

const remove = (nodes: Node[], node: Node): void => {
  const at = nodes.indexOf(node)
  if (at >= 0) nodes.splice(at, 1)
}

/** `MixerMarkDropped`: a dropped leaf's player counts as ended. */
const drop = (nodes: Node[], node: Node): void => {
  if (node.type === 'leaf') node.player.ended = true
  remove(nodes, node)
}

/**
 * `MixerUnlinkParentBlend` (`FUN_066156f0`): a blend, what it faded from (recursively when that is
 * a blend too) and, with `inner`, what it faded to.
 */
const unwind = (nodes: Node[], blend: Node, inner: boolean): void => {
  const at = nodes.indexOf(blend)
  const to = nodes[at - 1]
  const from = nodes[at - 2]

  if (from?.type === 'blend') unwind(nodes, from, true)
  else if (from) drop(nodes, from)

  if (inner && to) drop(nodes, to)
  remove(nodes, blend)
}

/** What was faded from, a blend with all beneath it or a single node. */
const dropBeneath = (nodes: Node[], node: Node | undefined): void => {
  if (node?.type === 'blend') unwind(nodes, node, true)
  else if (node) drop(nodes, node)
}

export class Mixer {
  readonly #rootName: string
  readonly #root: Target
  readonly #joints = new Map<string, { parent: string; joint: Joint; target?: Target }>()
  readonly #locks = new Set<string>()
  /** `FDeformInstance`'s list: motions and aims in the order they started. */
  #records: (Motion | Aim)[] = []
  #next = 1
  /** `Offset20`, the floor. */
  #floor = 0
  /**
   * `Offset24`: the root's height over the floor when nothing plays, for a script with no `Root
   * height`.
   */
  #base = 0

  constructor({
    root,
    joints,
    position = Vector3.zero,
    orientation = Quat.identity,
  }: MixerOptions) {
    this.#rootName = root
    this.#root = { shape: 'pose', revolute: false, value: { position, orientation } }

    for (const { name, parent, joint } of joints) {
      // A fixed or cylinder joint takes no channel (`TypedBindMap`); it is still a parent.
      const shape = SHAPES[joint.type]
      const target: Target | undefined = shape && {
        name,
        shape,
        revolute: joint.type === 'revolute',
        value: rest(shape),
      }

      this.#joints.set(name, { parent, joint, ...(target ? { target } : {}) })
    }
  }

  /** The root's placement in the character's frame, as the mixer last wrote it. */
  get root(): { position: Vector3; orientation: Quat } {
    const { position, rotation } = placementOf(this.#root.value)

    return { position, orientation: rotation }
  }

  /** `Offset20`. */
  get floor(): number {
    return this.#floor
  }

  /** A joint's state as last written, its rest before anything has. */
  jointState(name: string): JointState | undefined {
    return this.#joints.get(name)?.target?.value
  }

  /**
   * `RegisterAnimHandle`: scripts started later leave the joint be, and an aim through it fails.
   */
  lock(name: string): void {
    this.#locks.add(name)
  }

  /** `UnregisterAnimHandle`, as THN's Finish of a motion with a `locked_bone` does. */
  unlock(name: string): void {
    this.#locks.delete(name)
  }

  /**
   * `PlayInstanceAnim` (`FUN_065f41d0`): bind the script's maps, stand the root upright at its
   * `Root height` over the floor facing `heading`, and fade each target in. `undefined` when the
   * start time is past a channel's end (`TypedTimePlayable`), which retail destroys the script for.
   */
  start(script: AnimationScript, options: MotionOptions = {}): number | undefined {
    const {
      startTime = 0,
      timeScale = 1,
      weight = 1,
      transTime = 0,
      eventFlags = 0,
      heading = -1,
    } = options

    this.#sweep()

    const players = this.#bindMaps(script)
    const at = Math.fround(startTime)
    const header: Header = {
      start: at,
      flags: eventFlags & 0xfe,
      rate: Math.abs(Math.fround(timeScale)) * (eventFlags & MotionFlag.Backwards ? -1 : 1),
      scale: weight,
      transScale: 1,
    }

    if (!players.every(({ player }) => playable(player, at))) return undefined

    const root = placementOf(this.#root.value)
    // `RootDataEval`: a start part way in lifts the root by the stored height there, so it does not
    // drop.
    let lift = 0

    if (at > 0) {
      for (const { player } of players) bind(player, header, root)

      const first = players.find(
        ({ player }) => player.shape === 'position' || player.shape === 'pose',
      )
      if (first) lift = mapped(first.player).stored.y
    }

    const height = (script.height ?? this.#base) + this.#floor
    const block: Placement = {
      rotation: heading < 0 ? yaw(root.rotation) : turnY(heading),
      position: { x: root.position.x, y: lift + height, z: root.position.z },
    }
    for (const { player } of players) bind(player, { ...header, block }, root)
    for (const { player, target } of players) this.#attach(target, player, transTime, eventFlags)

    const handle = this.#next++

    this.#records.push({
      type: 'motion',
      handle,
      players,
      ...(script.height === undefined ? {} : { height: script.height }),
    })
    return handle
  }

  /**
   * `DestroyHandle`: THN's Finish. Every target lets go at once, with no fade out
   * (`MixerUnbindTyped`).
   */
  stop(handle: number): void {
    const record = this.#records.find((record) => record.handle === handle)
    if (record?.type !== 'motion') return
    for (const { player, target } of record.players) this.#unbind(target, player)
    this.#records = this.#records.filter((other) => other !== record)
  }

  /** Whether any of a motion's channels is still on a target. */
  playing(handle: number): boolean {
    const record = this.#records.find((record) => record.handle === handle)
    if (!record) return false
    return record.type === 'motion'
      ? record.players.some(({ player, target }) => this.#onTrack(target, player))
      : this.#onTrack(record.target, record.player)
  }

  /**
   * `FUN_065f5400` for one joint with `point_at`: the joint's world rotation goes to `target`,
   * entering its stack as a motion would, with the transition as its fade. The joint locks;
   * `undefined` when it already was, or is not a sphere joint (on a loose one retail would write a
   * rotation over its position, which is not reproduced).
   */
  aim(
    joint: string,
    { target, transitionDuration = 0, eventFlags = 0 }: AimOptions,
  ): number | undefined {
    const entry = this.#joints.get(joint)?.target
    if (entry?.shape !== 'orientation') return undefined
    if (this.#locks.has(joint)) return undefined
    this.#locks.add(joint)

    // `StartIk` (`0x452460`) adds 0x40 for point_at, 0x80 for one joint and 0x100 for the flags'
    // top
    // bit; the play header keeps bit 8 as bit 7 (`(Flags >> 1) & 0x80`).
    const flags = eventFlags | 0x40 | 0x80 | (eventFlags & 0x80 ? 0x100 : 0)
    const keep = (flags >> 1) & MotionFlag.KeepBeneath
    const player = createPlayer('orientation', {})

    bind(
      player,
      { start: 0, flags: keep, rate: 1, scale: 1, transScale: 1 },
      placementOf(this.#root.value),
    )
    this.#attach(entry, player, Math.fround(transitionDuration), keep)

    const handle = this.#next++

    this.#records.push({
      type: 'aim',
      handle,
      player,
      target: entry,
      joint,
      goal: target,
      stopped: false,
    })
    return handle
  }

  /** THN re-sends an aim's target at every update. */
  setAimTarget(handle: number, target: Quat): void {
    const record = this.#records.find((record) => record.handle === handle)
    if (record?.type === 'aim') record.goal = target
  }

  /**
   * `StopAimNode`: the joint unlocks, and the aim ends as a channel running out does. With
   * {@link MotionFlag.KeepBeneath} it fades back to what is beneath; without, its pose holds.
   */
  stopAim(handle: number): void {
    const record = this.#records.find((record) => record.handle === handle)
    if (record?.type !== 'aim' || record.stopped) return
    record.stopped = true
    this.#locks.delete(record.joint)
  }

  /**
   * `MixerWalkAll` (`LAB_066157f0`): every stack ticks, then writes its target. Joints first, then
   * the root.
   */
  advance(dt: number): void {
    const step = Math.fround(dt)

    const context: PlayerContext = {
      root: placementOf(this.#root.value),
      loopHeight: (player) => {
        const motion = this.#records.find(
          (record): record is Motion =>
            record.type === 'motion' && record.players.some((bound) => bound.player === player),
        )

        return (motion?.height ?? this.#base) + this.#floor
      },
      aim: (player) => {
        const record = this.#records.find(
          (record): record is Aim => record.type === 'aim' && record.player === player,
        )

        if (!record || record.stopped)
          return { value: record?.target.value ?? player.sampled, stopped: true }

        return { value: { orientation: this.#aimRotation(record) }, stopped: false }
      },
    }

    for (const { target } of this.#joints.values()) {
      if (!target) continue
      context.root = placementOf(this.#root.value)
      this.#walk(target, step, context)
    }

    context.root = placementOf(this.#root.value)
    this.#walk(this.#root, step, context)
  }

  /**
   * `SetPosePos`: the root goes to `position`'s x and z. Its height is each motion's own: `Root
   * height` plus its stored height now plus the floor, or the resting height without one;
   * `position.y` is not read.
   */
  setRootPosition(position: Vector3): void {
    this.#sweep()

    let y: number | undefined

    for (const record of this.#records) {
      if (record.type !== 'motion') continue

      const height =
        record.height === undefined
          ? this.#base
          : record.height + (this.#firstMapped(record)?.stored.y ?? 0)

      y = height + this.#floor

      const target = { x: position.x, y, z: position.z }

      if (!this.#anyTrack()) continue
      // `PlaybackWriteOverlayPos` (`FUN_06612a70`).
      for (const { player } of record.players) placeAt(player, target)

      if (record.players.some(({ player }) => player.root))
        this.#overlays(this.#root, (value) => ({ ...value, position: target }))
    }

    this.#root.value = {
      ...this.#root.value,
      position: { x: position.x, y: y ?? this.#base + this.#floor, z: position.z },
    }
  }

  /**
   * `SetPoseOri`: the root turns to `orientation`, every motion's root turning with it about where
   * it stands.
   */
  setRootOrientation(orientation: Quat): void {
    const current = placementOf(this.#root.value).rotation

    if (this.#anyTrack())
      for (const record of this.#records) {
        if (record.type !== 'motion') continue
        // `PlaybackWriteOverlayOrient` (`FUN_06612b80`).
        for (const { player } of record.players) turnTo(player, orientation, current)

        if (record.players.some(({ player }) => player.root))
          this.#overlays(this.#root, (value) => ({ ...value, orientation }))
      }

    this.#root.value = { ...this.#root.value, orientation }
  }

  /**
   * `SetHeight` (`0x65f50b0`): the floor, under every motion's root from the next advance. A
   * motion's root moves by what puts it at its height over the new floor.
   */
  setFloor(height: number): void {
    this.#floor = Math.fround(height)
    this.#sweep()

    for (const record of this.#records) {
      if (record.type !== 'motion') continue

      let delta: number

      if (record.height === undefined) {
        delta = this.#base + this.#floor - placementOf(this.#root.value).position.y
      } else {
        const { stored, placed } = this.#firstMapped(record) ?? {
          stored: Vector3.zero,
          placed: Vector3.zero,
        }

        delta = record.height + stored.y + this.#floor - placed.y
      }

      if (!(Math.abs(delta) > FLOAT_EPSILON) || !this.#anyTrack()) continue

      // `PlaybackAddOverlayPos` (`FUN_06612c60`).
      const step = { x: 0, y: delta, z: 0 }
      for (const { player } of record.players) shift(player, step)

      if (record.players.some(({ player }) => player.root))
        this.#overlays(this.#root, (value) => ({
          ...value,
          position: Vector3.add(value.position ?? Vector3.zero, step),
        }))
    }
  }

  /**
   * `BindTrackTarget` and `TypedBindMap`: a map binds by name, parent and shape, and not to a
   * locked target.
   */
  #bindMaps({ maps }: AnimationScript): Motion['players'] {
    const players: Motion['players'] = []

    for (const map of maps) {
      const shape = channelShape(map.channel)

      if (map.type === 'joint') {
        const entry = this.#joints.get(map.child)
        const target = entry?.target
        if (!target || this.#locks.has(map.child)) continue
        if (entry.parent !== map.parent || shape !== target.shape) continue

        const { channel } = map

        players.push({
          player: createPlayer(shape, { channel, revolute: target.revolute }),
          target,
        })
      } else {
        // An object map names the root, or nothing the character has and so the root
        // (`BindTrackTarget`, `FUN_06612320`).
        // Retail's 1,008 all name `Root`; one naming another joint would drive it as a root, not
        // here.
        if (this.#joints.has(map.object) || this.#locks.has(this.#rootName)) continue
        if (shape !== 'pose') continue
        players.push({
          player: createPlayer('pose', { channel: map.channel, root: true }),
          target: this.#root,
        })
      }
    }

    return players
  }

  /** `MixerBlendAttach` (`FUN_06616090`). */
  #attach(target: Target, player: Player, duration: number, flags: number): void {
    target.track ??= { nodes: [], fade: 0 }

    const track = target.track
    const { nodes } = track
    if (nodes.some((node) => isLeafOf(node, player))) return

    const fades = duration > 0

    if (fades) {
      // Over nothing, the snapshot always goes once the fade completes.
      if (!nodes.length) {
        flags &= ~MotionFlag.KeepBeneath
        nodes.push({ type: 'overlay', value: target.value })
      }
    } else {
      for (const node of nodes) if (node.type === 'leaf') node.player.ended = true
      nodes.length = 0
    }

    // Stack order `[…old, leaf, blend]`: a blend pops what it fades to (the leaf), then what it fades from.
    nodes.push({ type: 'leaf', player })
    if (!fades) return
    nodes.push({
      type: 'blend',
      time: 0,
      duration,
      dropBeneath: !(flags & MotionFlag.KeepBeneath),
    })
    track.fade = duration
  }

  /**
   * `MixerUnbindTyped` (`FUN_06615ec0`): a leaf another fade still reads from is swapped for a
   * snapshot of the target; a leaf being faded to takes what it faded from with it.
   */
  #unbind(target: Target, player: Player): void {
    const nodes = target.track?.nodes
    if (!nodes) return

    const leaf = nodes.find((node) => isLeafOf(node, player))

    if (leaf) {
      const at = nodes.indexOf(leaf)
      const after = nodes[at + 1]

      if (after && nodes[at + 2]?.type === 'blend') {
        nodes.splice(at + 1, 0, { type: 'overlay', value: target.value })

        const blend = nodes[at + 3]
        if (blend?.type === 'blend') blend.dropBeneath = true
      } else if (after?.type === 'blend') {
        const next = nodes[at + 2]

        if (next && nodes[at + 3]?.type === 'blend')
          nodes.splice(at + 2, 0, { type: 'overlay', value: target.value })

        dropBeneath(nodes, nodes[at - 1])
        remove(nodes, after)
      }

      remove(nodes, leaf)
    }

    if (!nodes.length) delete target.track
  }

  /**
   * `MixerWalkPlayback` (`EngBaseMixer.cpp`): tick each node, settle what finished, write the
   * stack's value.
   */
  #walk(target: Target, dt: number, context: PlayerContext): void {
    const track = target.track
    if (!track) return

    const { nodes } = track

    for (const node of [...nodes]) {
      const at = nodes.indexOf(node)
      if (at < 0) continue

      if (node.type === 'blend') {
        // `FMixerBlend::Tick`: done at or past its length, the sum compared before it is stored.
        const sum = dt + node.time

        node.time = Math.fround(sum)
        if (!(sum >= node.duration)) continue
        if (node.dropBeneath) dropBeneath(nodes, nodes[at - 2])
        remove(nodes, node)
      } else if (node.type === 'leaf') {
        if (!tick(node.player, dt, context)) continue

        const next = nodes[at + 1]
        const before = nodes[at - 1]

        if (next) {
          // Under a fade it holds its last value; beneath a finished one it goes.
          if (next.type === 'blend' || nodes[at + 2]?.type === 'blend') hold(node.player)
          else remove(nodes, node)
        } else if (!before) {
          hold(node.player)
          node.remove = true
        } else {
          // On top of something: fade back to it over the target's last transition.
          // `[…, before, leaf]` becomes `[…, leaf, before, blend]`: the held leaf fades to what was beneath.
          hold(node.player)
          remove(nodes, node)
          nodes.splice(nodes.indexOf(before), 0, node)
          nodes.push({ type: 'blend', time: 0, duration: track.fade, dropBeneath: true })
        }
      }
    }

    const stack = [...nodes]
    const top = stack.pop()
    const value = top && this.#evaluate(top, stack, target)
    if (value) target.value = value

    track.nodes = nodes.filter((node) => !(node.type === 'leaf' && node.remove))
    if (!track.nodes.length) delete target.track
  }

  /** `MixerStackEvaluate`: a node's value, a blend popping what it fades to and from beneath it. */
  #evaluate(node: Node, stack: Node[], target: Target): JointState | undefined {
    if (node.type === 'leaf') return node.player.sampled
    if (node.type === 'overlay') return node.value

    const to = stack.pop()
    const from = stack.pop()
    // Retail would read through a null here; nothing it builds gets there.
    if (!to || !from) return undefined

    const a = this.#evaluate(from, stack, target) ?? target.value
    const b = this.#evaluate(to, stack, target) ?? target.value
    const w = fadeWeight(node.time, node.duration)
    // The leaf faded to, or else the one faded from, decides how (`0661d1d7`).
    const leaf = to.type === 'leaf' ? to : from.type === 'leaf' ? from : undefined
    if (leaf) return mix(leaf.player, a, b, w)

    if (to.type === 'overlay' && from.type === 'overlay')
      return blendOverlays(target.shape, a, b, w)

    // Retail writes a stale value here; nothing it builds gets there either.
    return undefined
  }

  /**
   * `IkSolveSingleJoint` with `point_at`: the parent's world rotation undone from the target.
   * Retail reads the parent's world part way through the walk, in the engine's order; here joints
   * walk parents first and the root last, so the parent is this tick's and the root the last one's.
   * Uncertain.
   */
  #aimRotation({ joint, goal }: Aim): Quat {
    const parent = this.#joints.get(joint)?.parent
    const world = parent === undefined ? Matrix4.identity : this.#world(parent)

    return Quat.multiply(Quat.conjugate(Matrix4.decompose(world).orientation), goal)
  }

  /**
   * A joint's world, from the values as they stand: through its parents to the root's placement. An
   * unknown name is the identity.
   */
  #world(name: string): Matrix4 {
    if (name === this.#rootName) {
      const { position, rotation } = placementOf(this.#root.value)

      return Matrix4.fromRotationTranslation(Matrix3.fromQuaternion(rotation), position)
    }

    const entry = this.#joints.get(name)
    if (!entry) return Matrix4.identity
    return Matrix4.multiply(
      this.#world(entry.parent),
      getJointMatrix(entry.joint, entry.target?.value),
    )
  }

  /**
   * `SweepExpiredList` (`FUN_065f4de0`): forget what no stack holds; with nothing left, note the
   * root's height.
   */
  #sweep(): void {
    this.#records = this.#records.filter((record) =>
      record.type === 'aim'
        ? !record.stopped || this.#onTrack(record.target, record.player)
        : record.players.some(({ player, target }) => this.#onTrack(target, player)),
    )

    if (!this.#records.length)
      this.#base = Math.fround(placementOf(this.#root.value).position.y - this.#floor)
  }

  #onTrack(target: Target, player: Player): boolean {
    return !!target.track?.nodes.some((node) => isLeafOf(node, player))
  }

  /**
   * Whether the character has any stack: `MixerFindKey` on its root, which the overlay writers
   * need.
   */
  #anyTrack(): boolean {
    if (this.#root.track) return true
    for (const { target } of this.#joints.values()) if (target?.track) return true
    return false
  }

  /**
   * `PlaybackTouchMappedTyped` (`FUN_066122d0`): the first channel carrying a position, as `mapped`
   * reads it.
   */
  #firstMapped(record: Motion): ReturnType<typeof mapped> | undefined {
    const first = record.players.find(
      ({ player }) => player.shape === 'position' || player.shape === 'pose',
    )

    return first && mapped(first.player)
  }

  #overlays(target: Target, change: (value: JointState) => JointState): void {
    for (const node of target.track?.nodes ?? [])
      if (node.type === 'overlay') node.value = change(node.value)
  }
}
