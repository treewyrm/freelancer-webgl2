/**
 * A script's events as thorn's parser and factory make them (`0x6f25400`, `AddEventFromDesc`), and
 * what each action does when it starts and at every update (`FThornEvent::Start`, `StillRunning`).
 */
import { Matrix4, Vector3 } from '@treewyrm/freelancer/math'
import { data, type Event, type EventTypeName, type Script } from '@treewyrm/freelancer/thn/scene'
import type { Value } from '@treewyrm/freelancer/thn'
import { createCurve, progress, type Timing } from './curve.js'
import type { Path } from './path.js'
import { blendAudio, DEFAULT_AUDIO_TARGET, readAudio, type AudioState } from './sound.js'
import {
  blendFog,
  blendLight,
  readFog,
  readLightTarget,
  type FogState,
  type LightState,
} from './light.js'
import {
  axisIndex,
  axisTurn,
  inverse,
  lookAt,
  nlerp,
  placement,
  positionOf,
  quaternionOf,
  rotate,
  rotationOf,
  type Frame,
  type Quaternion,
} from './frame.js'

const f = Math.fround

/** The flag word's bits (`ThornScene.h`). Bit 16 is `q_orient`'s, read by nothing here. */
export const FLAGS = {
  USE_SCRIPT_DURATION: 1,
  PATH_POSITION: 2,
  ...data.ATTACH_FLAGS,
  ...data.SOUND_FLAGS,
} as const

/** What an event needs of the playback it runs in. */
export interface Stage {
  /** Thorn's frame for an entity: scene space, which the host keeps. */
  frame(entity: number): Frame
  setPosition(entity: number, position: Vector3): void
  setOrientation(entity: number, orientation: Frame): void
  /** Whether it has an `ICompoundControl`: a `COMPOUND` or `DEFORMABLE`. */
  compound(entity: number): boolean
  /** `ICompoundControl +0x24` for a `target_type` and `target_part`: nothing when it writes nothing. */
  part(entity: number, type: number, name: string): Frame | undefined
  path(entity: number): Path | undefined
  /** `ICompoundControl +0x1c`/`+0x20`, which the host makes a parent link of. */
  connect(event: ThornEvent): void
  disconnect(event: ThornEvent): void
  /** A camera's or monitor's `{fovh, near, far, aspect}`, as thorn caches them. */
  cameraProps(entity: number): CameraProps
  /** `ApplyCameraProps`: stored, and on from a camera to every monitor linked to it. */
  setCameraProps(entity: number, props: CameraProps): void
  /** `SET_CAMERA`'s link: the monitor follows the camera from now on. */
  cut(monitor: number, camera: number): void
  /** Whether the entity is a `CAMERA` (not a `MONITOR`). */
  camera(entity: number): boolean
  /** A `LIGHT`'s block as its host holds it, or nothing for another entity. */
  light(entity: number): LightState | undefined
  setLight(entity: number, light: LightState): void
  /** The host's one fog state, `on` as in effect (`0x454480`). */
  fog(): FogState
  /** `0x6f43140`: pushed by mask. */
  setFog(fog: FogState, mask: number): void
  /** The entity's type. */
  kind(entity: number): string | undefined
  /** `IPSysControl +0xc`: a new instance of its effect; false where the game made no host. */
  psysStart(entity: number): boolean
  /** `+0x10`: the effect killed outright. */
  psysStop(entity: number): void
  /** `+0x1c`: the host's cache of the last `sparam` set, 0 at first. */
  sparam(entity: number): number
  /** `+0x18`: cached, and handed to the effect only while one runs. */
  setSparam(entity: number, value: number): void
  /** The clock after the tick's step, which a starting event is handed (`ClockAfterDt_`). */
  readonly now: number
  /** `ISoundControl +0xc`: plays the entity's sound, cutting off what it was playing. */
  soundStart(entity: number, record: { offset: number; loop: boolean; spatial: boolean }): boolean
  /** `+0x10`: cut dead. */
  soundStop(entity: number): void
  /** `ICompoundControl +0xc`/`+0x10`: a script started on a compound or character, and stopped. */
  motionStart(entity: number, motion: MotionRecord): boolean
  motionStop(entity: number, motion: MotionRecord): void
  /** `IIKControl +0xc`/`+0x14`/`+0x10`: a character's aim, its target re-sent at every update. */
  aimStart(entity: number, aim: AimRecord): boolean
  aimUpdate(entity: number, aim: AimRecord): void
  aimStop(entity: number, aim: AimRecord): void
  /** `ICompoundControl +0x28`/`+0x14`: a character's floor height. */
  floor(entity: number): number | undefined
  setFloor(entity: number, height: number): void
  /** A `SOUND`'s `audioprops`, or nothing for another entity. */
  audio(entity: number): AudioState | undefined
  setAudio(entity: number, audio: AudioState): void
  readonly sceneUp: number
  readonly sceneFront: number
}

/** A `START_MOTION` as thorn hands it to the host (`ApplyMotionDesc`, parser `0x6f25a9d`). */
export interface MotionRecord {
  readonly event: Event
  animation: string
  /** Seconds into each channel. */
  startTime: number
  /** The blend-in, seconds; 0 replaces. */
  transTime: number
  timeScale: number
  /** An amplitude, not a mix weight. */
  weight: number
  /** Radians, or −1 for the character's own yaw. Only parsed off a `COMPOUND`. */
  heading: number
  /** Only parsed on a `COMPOUND`: its object map's translation scale. */
  transScale: number
  lockedBone: string | undefined
  /** 1 backwards, 2 loop, 4 bounce, 128 keep what is beneath once blended in. */
  eventFlags: number
}

/** A `START_IK` as thorn hands it on (`BuildIkPose`): the target and the look-at toward it, in scene space. */
export interface AimRecord {
  readonly event: Event
  endEffector: string
  countToRoot: number
  damping: number
  pointAt: boolean
  moveTo: boolean
  /** Seconds. */
  transitionDuration: number
  eventFlags: number
  target: Vector3
  /** Turns the joint's `front` onto the target, its `up` toward the scene's. */
  rotation: Frame
}

/** Thorn's four camera slots: `fovh` (half the horizontal angle, degrees), planes, and `hvaspect`. */
export type CameraProps = readonly [fovh: number, near: number, far: number, aspect: number]

/** One event, from load to finish. */
export interface ThornEvent {
  /** The action it runs as: a `START_PATH_ANIMATION` on an entity becomes an `ATTACH_ENTITY`. */
  readonly action: EventTypeName
  readonly type: number
  readonly source: Event
  /** Milliseconds. */
  readonly start: number
  readonly duration: number
  readonly flags: number
  readonly primary: number
  /** −1 for none. */
  readonly secondary: number
  /** Set at start: −1 never ends. */
  end: number
  /** True to join the active list. */
  begin(stage: Stage): boolean
  /** One update at `now`; the engine then asks whether it still runs. */
  update(stage: Stage, now: number): void
  /** Its end, or every running event's at a stop: `FThornEvent::Stop`. */
  finish?(stage: Stage): void
}

/**
 * Seconds to whole milliseconds: `time · 1000` rounded to the x87's 24-bit precision, which D3D8
 * leaves it at without `FPU_PRESERVE`, then chopped (`LuaMillisecondsToRetailInt`).
 */
export const milliseconds = (seconds: number): number => Math.trunc(f(seconds * 1000))

/** A flag set as the parser reads it, from the typed `flags` or one the typed layer left unknown. */
const flagNames = (event: Event): readonly string[] | number | undefined => {
  if ('flags' in event && event.flags) return event.flags

  const raw: Value | undefined = event.unknown?.['flags']
  if (raw?.type === 'identifier') return raw.names
  if (raw?.type === 'number') return Number(raw.literal)
  return undefined
}

/**
 * The flag word: bit 1 when `duration` is nil (`0x6f25760`), then a `flags` key replaces it whole
 * (`0x6f257c9`). `STREAM` and `FOG_PROPS_REMOVED` have no measured bit, so count for nothing.
 */
export const flagWord = (event: Event): number => {
  const names = flagNames(event)
  if (names === undefined) return event.duration === undefined ? FLAGS.USE_SCRIPT_DURATION : 0
  if (typeof names === 'number') return names

  let word = 0
  for (const name of names) word |= (FLAGS as Record<string, number>)[name] ?? 0
  return word
}

const unknownTarget = (event: Event) => {
  const type = event.unknown?.['target_type']
  const part = event.unknown?.['target_part']
  const types = data.TARGET_TYPES as Record<string, number>

  return {
    type:
      type?.type === 'identifier' && type.names.length === 1
        ? types[type.names[0]!]
        : type?.type === 'number'
          ? Number(type.literal)
          : undefined,
    part: part?.type === 'string' ? part.value : undefined,
  }
}

/** `target_type` and `target_part`, wherever the typed layer put them. */
const targetOf = (event: Event): { type: number; part: string | undefined } => {
  const raw = unknownTarget(event)
  const typed =
    'target_type' in event && event.target_type !== undefined
      ? data.TARGET_TYPES[event.target_type]
      : undefined
  const part = 'target_part' in event ? event.target_part : undefined

  return { type: typed ?? raw.type ?? 0, part: part ?? raw.part }
}

const timingOf = (event: Event, start: number, duration: number): Timing => ({
  start,
  duration,
  ...(event.param_curve && { curve: createCurve(event.param_curve) }),
  // `_ftol` of the value, milliseconds with no ×1000 (`0x6f25885`); −1 when absent.
  period: event.pcurve_period === undefined ? -1 : Math.trunc(event.pcurve_period),
})

/** `ApplyEndTime`: never with `USE_SCRIPT_DURATION`, else `start + duration`. */
const endOf = (flags: number, start: number, duration: number): number =>
  flags & FLAGS.USE_SCRIPT_DURATION ? -1 : (start + duration) | 0

/** Whether `+0x24` is asked: a `target_part`, a `target_type` other than `ROOT`, on a compound. */
const asksPart = (stage: Stage, parent: number, type: number, part: string | undefined) =>
  part !== undefined && type !== 0 && stage.compound(parent)

/** An attach's `P`: the frame `+0x24` writes over the parent's own, which a miss leaves. */
const parentFrame = (stage: Stage, parent: number, type: number, part: string | undefined) =>
  (asksPart(stage, parent, type, part) && stage.part(parent, type, part!)) || stage.frame(parent)

/** `ATTACH_ENTITY` (`StartAttachEntity`, `TickAttachEntity`). */
const attach = (base: Base, event: Event): ThornEvent => {
  const { type, part } = targetOf(event)
  const offset = ('offset' in event && event.offset) || Vector3.zero
  const front = axisIndex('front' in event ? event.front : undefined, 5)
  const up = axisIndex('up' in event ? event.up : undefined, 1)
  const has = (bit: number) => (base.flags & bit) !== 0
  let rel: Frame = Matrix4.identity

  return {
    ...base,
    action: 'ATTACH_ENTITY',
    type: data.EVENT_TYPES.ATTACH_ENTITY,
    begin(stage) {
      this.end = endOf(base.flags, base.start, base.duration)

      // Whatever the flags; only `PARENT_CHILD` and `ORIENTATION_RELATIVE` read it.
      const P = parentFrame(stage, base.secondary, type, part)

      // The child's frame in `P`'s space, so `P · rel` holds it where it was as `P` moves.
      rel = Matrix4.multiply(inverse(P), stage.frame(base.primary))
      return true
    },
    update(stage) {
      const P = parentFrame(stage, base.secondary, type, part)
      const child = base.primary

      if (has(FLAGS.PARENT_CHILD)) {
        const held = Matrix4.multiply(P, rel)
        if (has(FLAGS.POSITION)) stage.setPosition(child, positionOf(held))
        if (has(FLAGS.ORIENTATION)) stage.setOrientation(child, held)
        return
      }

      const o = has(FLAGS.ENTITY_RELATIVE) ? rotate(P, offset) : offset
      const target = Vector3.add(positionOf(P), o)
      if (has(FLAGS.POSITION)) stage.setPosition(child, target)

      if (has(FLAGS.ORIENTATION))
        stage.setOrientation(child, has(FLAGS.ORIENTATION_RELATIVE) ? Matrix4.multiply(P, rel) : P)
      else if (has(FLAGS.LOOK_AT)) {
        // From where the child is now, after any position written above.
        const d = Vector3.subtract(target, positionOf(stage.frame(child)))

        if (Vector3.dot(d, d) !== 0)
          stage.setOrientation(child, lookAt(d, front, up, stage.sceneUp, stage.sceneFront))
      }
    },
  }
}

/**
 * `START_PATH_ANIMATION` (`TickPathAnim`): the object along its path's frame as it is now, between
 * `start_percent` and `stop_percent`. Orientation, then position, every update.
 */
const pathAnimation = (
  base: Base,
  event: Event & { action: 'START_PATH_ANIMATION' },
): ThornEvent => {
  const from = event.start_percent ?? 0
  const scale = f((event.stop_percent ?? 1) - from)
  const offset = event.offset ?? Vector3.zero
  const front = axisIndex(event.front, 5)
  const up = axisIndex(event.up, 1)
  const has = (bit: number) => (base.flags & bit) !== 0

  /** `EvaluateControlBackedCurve`: 1 for a zero span, the start plus the span's share, unclamped. */
  const percent = (now: number): number => {
    if (scale === 0) return 1

    const { curve, period, start, duration } = base.timing
    const elapsed = now - start
    const share = curve
      ? curve.evaluate(period > 0 ? f((elapsed % period) / period) : f(elapsed / duration))
      : elapsed / duration

    return share * scale + from
  }

  return {
    ...base,
    begin() {
      this.end = endOf(base.flags, base.start, base.duration)
      return true
    },
    update(stage, now) {
      const path = stage.path(base.secondary)
      if (!path) return

      const u = percent(now)
      const object = stage.frame(base.primary)
      const R = stage.frame(base.secondary)
      let position = positionOf(object)
      let orientation: Frame = object
      const at = has(FLAGS.POSITION) ? path.position(u) : undefined
      if (at) position = Matrix4.transformPoint(Vector3.add(at, offset), R)

      if (has(FLAGS.ORIENTATION))
        if (has(FLAGS.LOOK_AT)) {
          const tangent = path.tangent(u)

          if (tangent)
            orientation = lookAt(rotate(R, tangent), front, up, stage.sceneUp, stage.sceneFront)
        } else {
          const q = path.orientation(u)
          if (q) orientation = Matrix4.multiply(R, rotationOf(q))
        }

      stage.setOrientation(base.primary, orientation)
      stage.setPosition(base.primary, position)
    },
  }
}

/**
 * `START_SPATIAL_PROP_ANIM` (`TickSpatialPropAnim`): each update moves the entity the share still
 * left of the way to an absolute target, or a second entity's live frame, then turns `axisrot`.
 */
const spatialAnimation = (
  base: Base,
  event: Event & { action: 'START_SPATIAL_PROP_ANIM' },
): ThornEvent => {
  const props = event.spatialprops ?? {}
  const mask =
    (props.pos ? 1 : 0) | (props.q_orient || props.orient ? 2 : 0) | (props.axisrot ? 4 : 0)
  const { type, part } = targetOf(event)
  const toPosition = props.pos ?? Vector3.zero
  const toQuaternion: Quaternion =
    props.q_orient ?? quaternionOf(placement(undefined, props.orient))
  const [angle = 0, axisName] = props.axisrot ?? []
  const axis = axisIndex(axisName, 1)
  let last = 0
  let applied = 0

  return {
    ...base,
    begin() {
      applied = 0
      last = 0
      this.end = endOf(base.flags, base.start, base.duration)
      return true
    },
    update(stage, now) {
      if (mask === 0) return

      const u = f(progress(base.timing, now))
      // `SpatialWrapScale`: the share of what's left, kept on the target once `u` reaches 1.
      const delta = f(u - last)
      let share: number

      if (delta === 0) share = 0
      else if (u >= 1) share = 1
      else if (f(1 - last) === 0) ((share = 1), (last = u))
      else ((share = f(delta / (1 - last))), (last = u))

      const current = stage.frame(base.primary)
      const from = positionOf(current)
      const fromQuaternion = quaternionOf(current)
      let target = { position: toPosition, quaternion: toQuaternion }

      if (base.secondary !== -1) {
        // `+0x24` writes over an identity at the origin here, so a miss is that (`0x6f46d23`).
        const other = asksPart(stage, base.secondary, type, part)
          ? (stage.part(base.secondary, type, part!) ?? Matrix4.identity)
          : stage.frame(base.secondary)

        target = { position: positionOf(other), quaternion: quaternionOf(other) }
      }

      if (mask & 1)
        stage.setPosition(
          base.primary,
          Vector3.add(from, Vector3.multiplyScalar(Vector3.subtract(target.position, from), share)),
        )

      if (mask & 2)
        stage.setOrientation(
          base.primary,
          rotationOf(nlerp(fromQuaternion, target.quaternion, share)),
        )

      if (mask & 4) {
        // Degrees still to turn: the total at `u` less what earlier updates already applied.
        const turn = f(u * angle - applied)

        applied = f(u * angle)
        // From the orientation read before this update's own write.
        stage.setOrientation(base.primary, axisTurn(rotationOf(fromQuaternion), axis, turn))
      }
    },
  }
}

/**
 * `CONNECT_HARDPOINTS`: thorn computes nothing, and hands the event to the first target's host at
 * its start and its end (`0x6f48320`, `0x6f483c0`). The game's failures log and still succeed.
 */
const connection = (base: Base): ThornEvent => ({
  ...base,
  begin(stage) {
    this.end = endOf(base.flags, base.start, base.duration)
    if (!stage.compound(base.primary)) return false
    stage.connect(this)
    return true
  },
  update() {},
  finish(stage) {
    stage.disconnect(this)
  },
})

/**
 * `SET_CAMERA` (`StartSetCamera`, `0x6f44ec0`): links monitor and camera, copies the camera's slots and
 * pose onto the monitor, and returns false, so it is never active and its duration means nothing.
 */
const setCamera = (base: Base): ThornEvent => ({
  ...base,
  begin(stage) {
    stage.cut(base.primary, base.secondary)
    return false
  },
  update() {},
})

/**
 * `START_CAMERA_PROP_ANIM` (`TickCameraPropAnim`). Its keys land **by position** (`0x6f5e148`):
 * `fovh` the fov, `aspect` the near plane, `near` the far plane, `far` the aspect. `from` is a
 * camera's slots at the start; `to` the event's, or a second camera's live ones.
 */
const cameraAnimation = (
  base: Base,
  event: Event & { action: 'START_CAMERA_PROP_ANIM' },
): ThornEvent => {
  const keys = event.cameraprops ?? {}
  const values = [keys.fovh, keys.aspect, keys.near, keys.far]
  const mask = values.reduce<number>(
    (bits, value, slot) => (value === undefined ? bits : bits | (1 << slot)),
    0,
  )
  const to = values.map((value) => f(value ?? 0))
  let from: readonly number[] = [0, 0, 0, 0]

  return {
    ...base,
    begin(stage) {
      if (stage.camera(base.primary)) from = stage.cameraProps(base.primary)
      this.end = endOf(base.flags, base.start, base.duration)
      return true
    },
    update(stage, now) {
      if (mask === 0) return

      const target =
        base.secondary !== -1 && stage.camera(base.secondary)
          ? stage.cameraProps(base.secondary)
          : to
      const u = progress(base.timing, now)
      const out = [...stage.cameraProps(base.primary)]

      for (let slot = 0; slot < 4; slot++)
        if (mask & (1 << slot)) out[slot] = f(from[slot]! + (target[slot]! - from[slot]!) * u)

      stage.setCameraProps(base.primary, out as unknown as CameraProps)
    },
  }
}

/**
 * `START_LIGHT_PROP_ANIM` (`StartLightPropAnim`, `TickLightPropAnim`): a light from its block as it
 * started toward the event's, or a second light's live one. On a `SCENE` it animates the ambient
 * through `ILightControl`, which the game doesn't implement: nothing.
 */
const lightAnimation = (
  base: Base,
  event: Event & { action: 'START_LIGHT_PROP_ANIM' },
): ThornEvent => {
  const { light: to, mask } = readLightTarget(event.lightprops ?? {})
  let from: LightState | undefined

  return {
    ...base,
    begin(stage) {
      from = stage.light(base.primary)
      this.end = endOf(base.flags, base.start, base.duration)
      return true
    },
    update(stage, now) {
      if (mask === 0) return

      const target = (base.secondary !== -1 && stage.light(base.secondary)) || to
      const current = stage.light(base.primary)
      if (!current || !from) return
      stage.setLight(
        base.primary,
        blendLight(current, from, target, mask, progress(base.timing, now)),
      )
    },
  }
}

/** `START_FOG_PROP_ANIM` (`StartFogPropAnim`, `TickFogPropAnim`), always on the `SCENE`. */
const fogAnimation = (base: Base, event: Event & { action: 'START_FOG_PROP_ANIM' }): ThornEvent => {
  const { fog: to, mask } = readFog(event.fogprops ?? {})
  let from: FogState | undefined

  return {
    ...base,
    begin(stage) {
      if (stage.kind(base.primary) === 'SCENE') from = stage.fog()
      this.end = endOf(base.flags, base.start, base.duration)
      return true
    },
    update(stage, now) {
      if (mask === 0 || !from || stage.kind(base.primary) !== 'SCENE') return

      const u = f(progress(base.timing, now))

      stage.setFog(blendFog(stage.fog(), from, to, mask, u), mask)
    },
  }
}

/**
 * `START_PSYS` (`0x6f48760`): the one Start with no end-time prologue, so its end is `start +
 * duration` whatever the flags, and its end kills the effect: the duration is its whole life.
 */
const startPsys = (base: Base): ThornEvent => ({
  ...base,
  begin(stage) {
    this.end = (base.start + base.duration) | 0
    return stage.kind(base.primary) === 'PSYS' && stage.psysStart(base.primary)
  },
  update() {},
  finish(stage) {
    stage.psysStop(base.primary)
  },
})

/**
 * `START_PSYS_PROP_ANIM` (`StartPsysPropAnim`, `TickPsysPropAnim`): `sparam` from the host's cache at
 * the start toward the event's, or a second effect's cached one, by the shared progress.
 */
const psysAnimation = (
  base: Base,
  event: Event & { action: 'START_PSYS_PROP_ANIM' },
): ThornEvent => {
  const to = event.psysprops?.sparam
  let from = 0

  return {
    ...base,
    begin(stage) {
      if (stage.kind(base.primary) === 'PSYS') from = stage.sparam(base.primary)
      this.end = endOf(base.flags, base.start, base.duration)
      return true
    },
    update(stage, now) {
      if (to === undefined || stage.kind(base.primary) !== 'PSYS') return

      const target =
        base.secondary !== -1 && stage.kind(base.secondary) === 'PSYS'
          ? stage.sparam(base.secondary)
          : f(to)
      const u = f(progress(base.timing, now))

      stage.setSparam(base.primary, f(from + (target - from) * u))
    },
  }
}

/**
 * `START_SOUND` (`0x6f44a20`, the host's `0x4574d0`): plays from `start_time`, integer milliseconds
 * with no ×1000, plus how far past its start the tick's clock is; `LOOP` loops it; its end cuts it.
 */
const startSound = (
  base: Base,
  event: Event & { action: 'START_SOUND' },
  /** Made `SPATIAL` by any `START_SOUND` of its own with flags bit 2, at parse (`0x6f258fd`). */
  spatial: boolean,
): ThornEvent => {
  const offset = Math.trunc(event.start_time ?? 0)

  return {
    ...base,
    begin(stage) {
      this.end = endOf(base.flags, base.start, base.duration)
      if (stage.kind(base.primary) !== 'SOUND') return false
      return stage.soundStart(base.primary, {
        offset: offset + (stage.now - base.start),
        loop: (base.flags & FLAGS.LOOP) !== 0,
        spatial,
      })
    },
    update() {},
    finish(stage) {
      stage.soundStop(base.primary)
    },
  }
}

/** `START_AUDIO_PROP_ANIM` (`StartAudioPropAnim`, `TickAudioPropAnim`): all eight sent every update. */
const audioAnimation = (
  base: Base,
  event: Event & { action: 'START_AUDIO_PROP_ANIM' },
): ThornEvent => {
  const { audio: to, mask } = readAudio(event.audioprops ?? {}, DEFAULT_AUDIO_TARGET)
  let from: AudioState | undefined

  return {
    ...base,
    begin(stage) {
      from = stage.audio(base.primary) ?? from
      this.end = endOf(base.flags, base.start, base.duration)
      return true
    },
    update(stage, now) {
      const current = stage.audio(base.primary)
      if (mask === 0 || !current || !from) return

      const target = (base.secondary !== -1 && stage.audio(base.secondary)) || to

      stage.setAudio(
        base.primary,
        blendAudio(current, from, target, mask, progress(base.timing, now)),
      )
    },
  }
}

/** `START_MOTION` (`0x6f43cd0`): the whole record to the host, kept on `S_OK`; Finish stops it at once. */
const startMotion = (
  base: Base,
  event: Event & { action: 'START_MOTION' },
  compound: boolean,
): ThornEvent => {
  const motion: MotionRecord = {
    event,
    animation: event.animation ?? '',
    startTime: f(event.start_time ?? 0),
    transTime: f(event.trans_time ?? 0),
    timeScale: f(event.time_scale ?? 1),
    weight: f(event.weight ?? 1),
    heading: compound ? -1 : f(event.heading ?? -1),
    transScale: compound ? f(event.trans_scale ?? 1) : 1,
    lockedBone: event.locked_bone,
    eventFlags: event.event_flags ?? 0,
  }

  return {
    ...base,
    begin(stage) {
      this.end = endOf(base.flags, base.start, base.duration)
      return stage.compound(base.primary) && stage.motionStart(base.primary, motion)
    },
    update() {},
    finish(stage) {
      stage.motionStop(base.primary, motion)
    },
  }
}

/**
 * `START_IK` (`0x6f44140`, `0x6f444f0`): the end effector's bone frame, the target's position or its
 * part's, and the look-at from one to the other, which the host's aim takes at start and every
 * update. Only a character has an `IIKControl`.
 */
const startIk = (base: Base, event: Event & { action: 'START_IK' }): ThornEvent => {
  const { type, part } = targetOf(event)
  const front = axisIndex(event.front, 5)
  const up = axisIndex(event.up, 1)

  const aim = (stage: Stage): AimRecord => {
    const effector =
      stage.part(base.primary, data.TARGET_TYPES.PART, event.end_effector ?? '') ?? Matrix4.identity
    let target = positionOf(stage.frame(base.secondary))

    if (part !== undefined && type !== 0 && stage.compound(base.secondary)) {
      const found = stage.part(base.secondary, type, part)
      // `+0x24` writes over the target's position and an identity, a miss leaving them.
      if (found) target = positionOf(found)
    }

    return {
      event,
      endEffector: event.end_effector ?? '',
      countToRoot: event.count_to_root ?? 0,
      damping: f(event.damping ?? 1),
      pointAt: (event.point_at ?? 0) !== 0,
      moveTo: (event.move_to ?? 0) !== 0,
      transitionDuration: f(event.transition_duration ?? 1),
      eventFlags: event.event_flags ?? 0,
      target,
      rotation: lookAt(
        Vector3.subtract(target, positionOf(effector)),
        front,
        up,
        stage.sceneUp,
        stage.sceneFront,
      ),
    }
  }

  let current: AimRecord | undefined

  return {
    ...base,
    begin(stage) {
      this.end = endOf(base.flags, base.start, base.duration)
      if (stage.kind(base.primary) !== 'DEFORMABLE') return false
      current = aim(stage)
      return stage.aimStart(base.primary, current)
    },
    update(stage) {
      if (stage.kind(base.primary) !== 'DEFORMABLE') return
      current = aim(stage)
      stage.aimUpdate(base.primary, current)
    },
    finish(stage) {
      if (current) stage.aimStop(base.primary, current)
    },
  }
}

/**
 * `START_FLR_HEIGHT_ANIM` (`StartFloorHeightAnim`, `TickFloorHeightAnim`): a character's floor chases
 * `floor_height`, or a second entity's `y`, or its part's, by the share still left, as a spatial
 * animation chases its target.
 */
const floorAnimation = (
  base: Base,
  event: Event & { action: 'START_FLR_HEIGHT_ANIM' },
): ThornEvent => {
  const { type, part } = targetOf(event)
  const height = f(event.floor_height ?? 0)
  let last = 0

  return {
    ...base,
    begin() {
      last = 0
      this.end = endOf(base.flags, base.start, base.duration)
      return true
    },
    update(stage, now) {
      const current = stage.floor(base.primary)
      if (current === undefined) return

      const u = f(progress(base.timing, now))
      const delta = f(u - last)
      let share: number

      if (delta === 0) share = 0
      else if (u >= 1) share = 1
      else if (f(1 - last) === 0) ((share = 1), (last = u))
      else ((share = f(delta / (1 - last))), (last = u))

      let target = height

      if (base.secondary !== -1) {
        target = positionOf(stage.frame(base.secondary)).y

        if (part !== undefined && type !== 0 && stage.compound(base.secondary)) {
          const found = stage.part(base.secondary, type, part)
          if (found) target = found.w.y
        }
      }

      stage.setFloor(base.primary, f(current + (target - current) * share))
    },
  }
}

/** An action run for its timing alone: what it does belongs to a later step. */
const inert = (base: Base): ThornEvent => ({
  ...base,
  begin() {
    switch (base.action) {
      default:
        // A motion, sound or IK joins only on its host's `S_OK`: taken as given until its step.
        this.end = endOf(base.flags, base.start, base.duration)
        return true
    }
  },
  update() {},
})

type Base = Omit<ThornEvent, 'begin' | 'update'> & { timing: Timing }

/** The actions this library runs. The rest are scheduled and timed, and do nothing yet. */
export const RUN: ReadonlySet<EventTypeName> = new Set([
  'ATTACH_ENTITY',
  'CONNECT_HARDPOINTS',
  'SET_CAMERA',
  'START_CAMERA_PROP_ANIM',
  'START_FOG_PROP_ANIM',
  'START_LIGHT_PROP_ANIM',
  'START_PSYS',
  'START_PSYS_PROP_ANIM',
  'START_SOUND',
  'START_AUDIO_PROP_ANIM',
  'START_MOTION',
  'START_IK',
  'START_FLR_HEIGHT_ANIM',
  'START_PATH_ANIMATION',
  'START_SPATIAL_PROP_ANIM',
])

/** Actions the factory refuses without a second target (`EventAllowsMissingSecondary`). */
const NEEDS_SECOND: ReadonlySet<EventTypeName> = new Set([
  'SET_CAMERA',
  'START_PATH_ANIMATION',
  'ATTACH_ENTITY',
  'CONNECT_HARDPOINTS',
  'START_IK',
])

/**
 * Every event the factory accepts, in script order: a first target that names an entity, and a
 * second that does when given or required. Entity ids are the script's order, first name winning.
 */
export const eventsOf = (script: Script): ThornEvent[] => {
  const ids = new Map<string, number>()

  script.entities.forEach((entity, index) => {
    if (!ids.has(entity.entity_name)) ids.set(entity.entity_name, index)
  })

  const out: ThornEvent[] = []
  // The parser ORs 2 into a sound entity's own flags for each of these, so every start hears it.
  const spatial = new Set(
    script.events.flatMap((source) =>
      source.action === 'START_SOUND' && flagWord(source) & 2
        ? [ids.get(source.targets[0] ?? '')]
        : [],
    ),
  )

  for (const source of script.events) {
    const [first, second] = source.targets
    const primary = first === undefined ? undefined : ids.get(first)
    const secondary = second === undefined ? -1 : (ids.get(second) ?? -2)
    if (primary === undefined || secondary === -2) continue

    let action: EventTypeName = source.action

    // A path animation onto an entity of type 1 to 8 is parsed as an attach (`0x6f258c0`).
    if (action === 'START_PATH_ANIMATION' && secondary >= 0) {
      const kind = data.ENTITY_TYPES[script.entities[secondary]!.type]
      if (kind >= 1 && kind <= 8) action = 'ATTACH_ENTITY'
    }

    if (secondary === -1 && NEEDS_SECOND.has(action)) continue

    let start = milliseconds(source.time)
    // START_IK at 0 starts at 1 ms, after the motions (`0x6f25962`).
    if (action === 'START_IK' && start === 0) start = 1

    const duration = source.duration === undefined ? 0 : milliseconds(source.duration)
    const base: Base = {
      action,
      type: data.EVENT_TYPES[action],
      source,
      start,
      duration,
      flags: flagWord(source),
      primary,
      secondary,
      end: -1,
      timing: timingOf(source, start, duration),
    }

    if (action === 'ATTACH_ENTITY') out.push(attach(base, source))
    else if (source.action === 'START_PATH_ANIMATION') out.push(pathAnimation(base, source))
    else if (source.action === 'START_SPATIAL_PROP_ANIM') out.push(spatialAnimation(base, source))
    else if (action === 'CONNECT_HARDPOINTS') out.push(connection(base))
    else if (action === 'SET_CAMERA') out.push(setCamera(base))
    else if (source.action === 'START_CAMERA_PROP_ANIM') out.push(cameraAnimation(base, source))
    else if (source.action === 'START_LIGHT_PROP_ANIM') out.push(lightAnimation(base, source))
    else if (source.action === 'START_FOG_PROP_ANIM') out.push(fogAnimation(base, source))
    else if (action === 'START_PSYS') out.push(startPsys(base))
    else if (source.action === 'START_PSYS_PROP_ANIM') out.push(psysAnimation(base, source))
    else if (source.action === 'START_SOUND')
      out.push(startSound(base, source, spatial.has(primary)))
    else if (source.action === 'START_AUDIO_PROP_ANIM') out.push(audioAnimation(base, source))
    else if (source.action === 'START_MOTION')
      out.push(startMotion(base, source, script.entities[primary]!.type === 'COMPOUND'))
    else if (source.action === 'START_IK') out.push(startIk(base, source))
    else if (source.action === 'START_FLR_HEIGHT_ANIM') out.push(floorAnimation(base, source))
    else out.push(inert(base))
  }

  return out
}
