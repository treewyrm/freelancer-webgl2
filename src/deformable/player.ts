/**
 * One animation channel playing on one joint or a character's root: `FTypedChannel` in
 * `engbase.dll`, its clock (`TypedTick`, `FUN_0661b420`), bind (`TypedBind`, `TypedBindType6`) and
 * blends. Pure.
 *
 * Values are a joint's state as `@treewyrm/freelancer/compound` writes it, which `placeCostume`
 * reads. Times and the end test keep float precision, since they decide which frame a step lands
 * on; the values themselves are computed in double (retail rounds them to float as it stores).
 */
import { getChannelDuration, sampleChannel, type Channel } from '@treewyrm/freelancer/animation'
import type { JointState } from '@treewyrm/freelancer/compound'
import { Quat, Vector3, Vector4 } from '@treewyrm/freelancer/math'

/**
 * What a target's parameters hold, by `MixerJointValueCount` (`EngBaseMixer.cpp`): one float for a
 * revolute or prismatic joint, a position for a translational one, a rotation for a sphere, both
 * for a loose joint and for a root.
 */
export type Shape = 'value' | 'position' | 'orientation' | 'pose'

/** Where a root is: `Matrix` and `Delta` of a root player, which its samples are carried by. */
export interface Placement {
  rotation: Quat
  position: Vector3
}

/** The `PlayFlags` header a player is bound with: `PlaybackEvalTyped` (`FUN_066126e0`). */
export interface Header {
  /** Seconds in. `0` and `-1` (the end) and `-2` (where it stands) are the engine's own markers. */
  start: number
  /** `LoopFlags`: the event flags with bit 0 cleared. */
  flags: number
  /** `Weight`: the speed, negative backwards. */
  rate: number
  /** `Scale`: the motion's `weight`, an amplitude. */
  scale: number
  /** `Field_0x30`: scales a root's and a translational joint's travel. */
  transScale: number
  /** A root's placement at the start; absent, the root's own (`TypedBindType6`). */
  block?: Placement
}

export interface Player {
  /** Absent on an aim, whose value its owner solves each tick. */
  channel?: Channel
  shape: Shape
  /**
   * `JointType == 2`: a blend between two angles goes the short way round (`TypedWrapLerpType2`).
   */
  revolute: boolean
  /** An object map, `Kind == 1`: samples are carried by {@link Placement}. */
  root: boolean
  time: number
  rate: number
  flags: number
  scale: number
  transScale: number
  /** `PlayFlags` bit 0: posed and frozen, no tick moves it again (`FUN_0661b070`). */
  held: boolean
  /** `PlayFlags` bit 1: ran off its end or was dropped. */
  ended: boolean
  /** What `CopySampled` hands the mixer. */
  sampled: JointState
  placement: Placement
}

/** What a tick needs from the character around it. */
export interface PlayerContext {
  /** The root as it stands now, for a root player rebinding with no block. */
  root: Placement
  /** `FDeformInstance::OnLoop` (`LAB_065f52b0`): a looping root's height for its next cycle. */
  loopHeight(player: Player): number
  /**
   * An aim's value this tick: its owner's `Apply` (`IkApply`, `LAB_065fb540`). Once stopped, the
   * joint's own value and `stopped`, which ends the player as a channel running out does.
   */
  aim(player: Player): { value: JointState; stopped: boolean }
}

export const LOOP = 0x2
export const BOUNCE = 0x4
/** Bound at the block as given, whatever the start time (`TypedBindType6`). */
export const AT_BLOCK = 0x40

const ONE_BITS = 0x3f800000
const bits = new DataView(new ArrayBuffer(4))

const isOne = (value: number): boolean => {
  bits.setFloat32(0, value)
  return bits.getUint32(0) === ONE_BITS
}

const PI = Math.fround(Math.PI)
const TAU = Math.fround(Math.PI * 2)

/**
 * An amplitude on a rotation, `TypedSlerpType4`: from the identity, unless the scale is exactly 1.
 */
const amplified = (orientation: Quat, scale: number): Quat =>
  isOne(scale) ? orientation : Quat.nlerp(Quat.identity, orientation, scale)

export const duration = ({ channel }: Player): number =>
  channel ? Math.fround(getChannelDuration(channel)) : 0

export const createPlayer = (
  shape: Shape,
  {
    channel,
    revolute = false,
    root = false,
  }: { channel?: Channel; revolute?: boolean; root?: boolean },
): Player => ({
  ...(channel ? { channel } : {}),
  shape,
  revolute,
  root,
  time: 0,
  rate: 1,
  flags: 0,
  scale: 1,
  transScale: 1,
  held: false,
  ended: false,
  sampled: rest(shape),
  placement: { rotation: Quat.identity, position: Vector3.zero },
})

/** A target's parameters before anything writes them. */
export const rest = (shape: Shape): JointState => {
  switch (shape) {
    case 'value':
      return { value: 0 }
    case 'position':
      return { position: Vector3.zero }
    case 'orientation':
      return { orientation: Quat.identity }
    case 'pose':
      return { position: Vector3.zero, orientation: Quat.identity }
  }
}

/** The shape a channel's samples have, or none a target could take. */
export const channelShape = (channel: Channel): Shape | undefined => {
  if (channel.type === 'angle') return 'value'
  if (channel.position && channel.orientation) return 'pose'
  if (channel.position) return 'position'
  if (channel.orientation) return 'orientation'
  return undefined
}

/**
 * `Interpolate` at a time: a pose's position as stored and its rotation amplified
 * (`TypedLerpPosQuatScaled`); every other shape as `Apply` writes it.
 */
const interpolate = (player: Player, time: number): JointState => {
  const { channel, shape, scale, transScale } = player
  if (!channel) return player.sampled

  const sample = sampleChannel(channel, time, player.revolute)

  switch (shape) {
    case 'value':
      return { value: Math.fround(scale * Math.fround(sample.value ?? 0)) }
    case 'position':
      return {
        position: Vector3.multiplyScalar(sample.position ?? Vector3.zero, transScale * scale),
      }
    case 'orientation':
      return { orientation: amplified(sample.orientation ?? Quat.identity, scale) }
    case 'pose':
      return {
        position: sample.position ?? Vector3.zero,
        orientation: amplified(sample.orientation ?? Quat.identity, scale),
      }
  }
}

/** A root's travel at a time: the stored position times its weight and `trans_scale`. */
const travel = (player: Player, time: number): Vector3 =>
  Vector3.multiplyScalar(
    interpolate(player, time).position ?? Vector3.zero,
    player.transScale * player.scale,
  )

/**
 * `Apply` at a time into `sampled`. A root is carried by its placement
 * (`ApplyPositionQuaternionSample`).
 */
export const apply = (player: Player, time: number): void => {
  const sample = interpolate(player, time)

  if (!player.root) {
    player.sampled = sample
    return
  }

  const { rotation, position } = player.placement

  // `MulQuat(MatrixToQuat(Matrix), q)`: `x86math!0x6f72740` is the Hamilton `A ⊗ B`, base first.
  player.sampled = {
    position: Vector3.add(Quat.transform(travel(player, time), rotation), position),
    orientation: Quat.multiply(rotation, sample.orientation ?? Quat.identity),
  }
}

/** `TypedTimePlayable` (`FUN_0661af70`): the engine's markers, or a time within the channel. */
export const playable = (player: Player, start: number): boolean => {
  if (start === -1 || start === 0 || start === -2) return true
  return start <= duration(player) && start >= 0
}

/** `TypedSetTime`: `-1` the end, `-2` where it stands, another negative refused. */
const setTime = (player: Player, start: number): void => {
  if (start === -1) player.time = duration(player)
  else if (start === -2) return
  else if (start >= 0) player.time = Math.fround(start)
}

/**
 * `TypedBind` and, for a root, `TypedBindType6`: at a start of 0 (or with {@link AT_BLOCK}) the
 * root stands at the block; otherwise the block is solved so the root does not jump at the start's
 * sample. With no block the root's own placement stands in, its rotation less the sample's.
 */
export const bind = (player: Player, header: Header, root: Placement): void => {
  player.flags = header.flags
  player.rate = Math.fround(header.rate)
  player.scale = Math.fround(header.scale)
  player.transScale = Math.fround(header.transScale)
  setTime(player, header.start)
  player.held = false
  player.ended = false
  if (!player.root) return

  const { block } = header

  if (header.start === 0 || header.flags & AT_BLOCK) {
    player.placement = block ?? root
    return
  }

  // Solves a placement (R, P) with P = origin − R · stored, so the sample at `time` lands on `origin`.
  const position = travel(player, player.time)
  const rotation = block
    ? block.rotation
    : Quat.multiply(
        root.rotation,
        Quat.conjugate(interpolate(player, player.time).orientation ?? Quat.identity),
      )
  const origin = block ? block.position : root.position

  player.placement = {
    rotation,
    position: Vector3.subtract(origin, Quat.transform(position, rotation)),
  }
}

/**
 * `TypedApplyFromArchetype` (`FUN_0661b070`): posed where it stands, or at the end it ran into, and
 * frozen.
 */
export const hold = (player: Player): void => {
  player.held = true
  if (!player.channel) return

  const time = player.ended ? (player.rate < 0 ? 0 : duration(player)) : player.time

  apply(player, time)
}

/** The first or last keyframe's sample, as `GetFrame` hands it: the end a player runs towards. */
const endTime = (player: Player): number => (player.rate < 0 ? 0 : duration(player))

/** The yaw of a rotation's Z axis, as a turn about Y (`PlayInstanceAnim`, `OnLoop`). */
export const yaw = (orientation: Quat): Quat => {
  const front = Quat.transform(Vector3.z, orientation)

  return turnY(Math.atan2(front.x, front.z))
}

/** A turn of `angle` radians about Y. */
export const turnY = (angle: number): Quat => Quat.axisAngle({ axis: Vector3.y, angle })

/**
 * `TypedTick` (`FUN_0661b420`): advance by `dt · rate` and pose. True when a channel that does not
 * loop has run off its end this tick and nothing had posed it, or when an aim's owner has stopped.
 * A loop rebinds at the start with the overshoot carried, a root at its end placement, upright at
 * its next cycle's height (`OnLoop`); a bounce turns round.
 */
export const tick = (player: Player, dt: number, context: PlayerContext): boolean => {
  if (player.held || player.ended) return false
  player.time = Math.fround(dt * player.rate + player.time)

  if (!player.channel) {
    const { value, stopped } = context.aim(player)

    player.sampled = value
    return stopped
  }

  let ran = false
  const length = duration(player)
  const remaining = player.rate < 0 ? player.time : length - player.time

  // `remaining` is the time left towards the end it runs to; at or below 0, `wraps` whole lengths
  // were passed and `overshoot` is the part into the next cycle.
  if (remaining <= 0) {
    const wraps = length !== 0 ? Math.abs(Math.trunc(remaining / length)) : 0
    const overshoot = Math.fround(Math.abs(remaining) - wraps * length)
    const header = {
      flags: player.flags,
      rate: player.rate,
      scale: player.scale,
      transScale: player.transScale,
    }

    if (player.flags & LOOP) {
      let block: Placement | undefined

      if (player.root) {
        apply(player, endTime(player))

        const { position = Vector3.zero, orientation = Quat.identity } = player.sampled

        block = {
          rotation: yaw(orientation),
          position: { x: position.x, y: context.loopHeight(player), z: position.z },
        }
      }

      const start = player.rate < 0 ? length : 0

      bind(player, { ...header, start, ...(block ? { block } : {}) }, context.root)
      if (length !== 0) player.time = Math.fround(player.rate < 0 ? length - overshoot : overshoot)
    } else if (player.flags & BOUNCE) {
      // An even number of wraps turns round, an odd one carries on.
      const rate = wraps % 2 === 0 ? -player.rate : player.rate
      const start = rate < 0 ? Math.fround(length - overshoot) : overshoot

      bind(player, { ...header, start, rate }, context.root)
    } else {
      player.time = endTime(player)
      player.ended = true
      ran = !player.held
    }
  }

  apply(player, player.time)
  return ran
}

/**
 * `InterpolatePose` of the player a blend reads (`FMixerBlend::Evaluate`). The player's own
 * amplitude applies again over the blend: a weight under 1 dips further while it fades in, as
 * retail does.
 */
export const mix = (player: Player, a: JointState, b: JointState, w: number): JointState => {
  switch (player.shape) {
    case 'value': {
      const from = a.value ?? 0
      let to = b.value ?? 0

      if (player.revolute) {
        const d = to - from

        if (d < -PI) to += TAU
        else if (d > PI) to -= TAU
      }

      return { value: Math.fround(player.scale * Math.fround((to - from) * w + from)) }
    }
    case 'position':
      return {
        position: Vector3.multiplyScalar(
          Vector3.lerp(a.position ?? Vector3.zero, b.position ?? Vector3.zero, w),
          player.transScale * player.scale,
        ),
      }
    case 'orientation':
      return {
        orientation: amplified(
          Quat.nlerp(a.orientation ?? Quat.identity, b.orientation ?? Quat.identity, w),
          player.scale,
        ),
      }
    case 'pose':
      return blendPose(a, b, w)
  }
}

/**
 * A position's lerp and a rotation's nlerp, as two overlays or a pose blend (`MixerBlendPosQuat`).
 */
export const blendPose = (a: JointState, b: JointState, w: number): JointState => ({
  position: Vector3.lerp(a.position ?? Vector3.zero, b.position ?? Vector3.zero, w),
  orientation: Quat.nlerp(a.orientation ?? Quat.identity, b.orientation ?? Quat.identity, w),
})

/** Two overlays' blend by their count (`FMixerBlend::Evaluate`, `0661d349`), no amplitude. */
export const blendOverlays = (
  shape: Shape,
  a: JointState,
  b: JointState,
  w: number,
): JointState => {
  switch (shape) {
    case 'value': {
      const from = a.value ?? 0

      return { value: Math.fround(((b.value ?? 0) - from) * w + from) }
    }
    case 'position':
      return { position: Vector3.lerp(a.position ?? Vector3.zero, b.position ?? Vector3.zero, w) }
    case 'orientation':
      return {
        orientation: Quat.nlerp(a.orientation ?? Quat.identity, b.orientation ?? Quat.identity, w),
      }
    case 'pose':
      return blendPose(a, b, w)
  }
}

/** What `TypedSampleXformType6` hands back: the stored position, and where it stands placed. */
export const mapped = (player: Player): { stored: Vector3; placed: Vector3 } => {
  if (player.shape !== 'pose') return { stored: Vector3.zero, placed: Vector3.zero }

  const time = player.ended ? endTime(player) : player.time
  const stored = interpolate(player, time).position ?? Vector3.zero
  const { rotation, position } = player.placement

  return { stored, placed: Vector3.add(Quat.transform(stored, rotation), position) }
}

/**
 * `SetChannelOverlayPosition`: a root stands at `target` now and its motion carries on from there.
 */
export const placeAt = (player: Player, target: Vector3): void => {
  if (!player.root) return

  const { rotation } = player.placement

  player.placement = {
    rotation,
    position: Vector3.subtract(target, Quat.transform(travel(player, player.time), rotation)),
  }
  player.sampled = { ...player.sampled, position: target }
}

/**
 * `SetChannelOverlayOrientation`: a root turns to `orientation` about where it stands. The turn is
 * the root's from `current`; the position kept is the stored one placed, without its weight, as
 * retail has it.
 */
export const turnTo = (player: Player, orientation: Quat, current: Quat): void => {
  if (!player.root) return

  const sample = interpolate(player, player.time)
  const stored = sample.position ?? Vector3.zero
  const { rotation, position } = player.placement
  // Turns about the stored position's world point: `turned` is the delta `orientation · current⁻¹` applied
  // over `rotation`, and `offset` re-seats the placement so that point stays where it was. Retail
  // reads `current` back from the engine instance, a proper rotation (`SetChannelOverlayOrientation`);
  // here it is the composed root, so both are made unit, or a host turning the root each frame from
  // its own read-back squares the length's float noise away to nothing (s002xe's Lonnigan at 50 s).
  const unit = (q: Quat) => Vector4.normalize(q) as Quat
  const turned = unit(
    Quat.multiply(Quat.multiply(orientation, Quat.conjugate(unit(current))), rotation),
  )
  const world = Vector3.add(Quat.transform(stored, rotation), position)
  const offset = Vector3.subtract(world, Quat.transform(stored, turned))

  player.placement = { rotation: turned, position: offset }
  player.sampled = {
    position: world,
    orientation: Quat.multiply(turned, sample.orientation ?? Quat.identity),
  }
}

/** `TypedAddDelta`: a pose's placement moves by `delta`, a frozen one posed again. */
export const shift = (player: Player, delta: Vector3): void => {
  if (player.shape !== 'pose') return

  const { rotation, position } = player.placement

  player.placement = { rotation, position: Vector3.add(position, delta) }
  if (player.held) hold(player)
}
