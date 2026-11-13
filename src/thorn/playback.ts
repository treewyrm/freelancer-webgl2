/**
 * One script's engine: `FThornScene` (`src/Thorn/ThornScene.cpp`). It keeps its own clock in whole
 * milliseconds and only moves forward by a delta (`Tick`, engine `+0x68`): every event start and end
 * inside a step is visited at its own instant, in order, so one jump equals any run of smaller ones.
 *
 * Thorn renders nothing. Each entity is a proxy for what the host owns, and here its frame in scene
 * space is plain data, which {@link Playback.world} places as the game's host classes do.
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import { data, type Entity, type EventTypeName, type Script } from '@treewyrm/freelancer/thn/scene'
import {
  eventsOf,
  milliseconds,
  RUN,
  type AimRecord,
  type CameraProps,
  type MotionRecord,
  type Stage,
  type ThornEvent,
} from './events.js'
import {
  axisIndex,
  inverse,
  placement,
  positionOf,
  withPosition,
  withRotation,
  type Frame,
} from './frame.js'
import { createPath, type Path } from './path.js'
import { lightOf, NO_FOG, roomFogOf, roomLightOf, type FogState, type LightState } from './light.js'
import type { Fog } from '#/scene/nebula.js'
import type { EffectInstance } from '#/alchemy/effect.js'
import { DEFAULT_AUDIO, readAudio, type AudioState, type SoundRecord } from './sound.js'
import type { RoomLight } from '#/scene/room.js'
import { spawns, type SpawnOptions } from './room.js'

/** What the host answers for its entities, by name. Every frame is in the entity's own space. */
export interface ThornHost {
  /**
   * A hardpoint's frame relative to the entity's root at its current pose, or nothing found. The game
   * matches names ignoring case, the last duplicate winning (`HardpointSummary::find_name`).
   */
  hardpoint?(entity: string, name: string): Frame | undefined
  /** A `DEFORMABLE`'s bone by name, ignoring case, relative to its root; nothing when missing. */
  bone?(entity: string, name: string): Frame | undefined
  /**
   * `ICompoundControl +0x18` and `IPSysControl +0x14`: a compound's, deformable's or effect's time
   * moves on, before the events at each update instant and once more by 0 at the end of a tick.
   */
  advance?(entity: string, milliseconds: number): void
}

export interface PlaybackOptions {
  loop?: boolean
  /**
   * The host's scene frame `C`: a room character's setpoint over its actor (`ThornScriptGetCsys`),
   * the identity everywhere else. Thorn's own scene frame is always the identity in the game.
   */
  frame?: Frame
  host?: ThornHost
  /** The room's fog, which every script shares: pass one holder to them all. A fresh room's when absent. */
  fog?: { state: FogState }
  /** The `fog` detail option, which `GfFogSetOn` ANDs into `on`. */
  fogEnabled?: boolean
  /**
   * A new instance of a `PSYS`'s `[VisEffect]`, named by its template ignoring case, or nothing
   * where there's none. `PlayerShipEngines` is the player ship's own engines: the host's.
   */
  createEffect?: (entity: string, template: string) => EffectInstance | undefined
  /** The detail gate, which decides which entities get a host at all. */
  spawn?: SpawnOptions
  /**
   * What runs a compound's or character's scripts and aims: false where the game's host answers
   * other than `S_OK`. The records are kept either way, and every start succeeds without one.
   */
  characters?: CharacterHost
  /**
   * What a `REFERENCE` binds to: a live entity of that type and name in another script, by name, or
   * where the room's set script puts it, in this script's space; nothing leaves it at its record.
   */
  resolve?: (
    type: Entity['type'],
    name: string,
  ) => { playback: Playback; name: string } | { frame: Frame } | undefined
}

/**
 * A `CONNECT_HARDPOINTS` while it runs. The game finds the part owning each hardpoint, names
 * ignoring case, and links the child's under the parent's so the two hardpoints meet:
 * `childPart = parentPart · H_parent · inverse(H_child)` ({@link connectedFrame}, `0x44fdd0`).
 */
export interface Connection {
  readonly event: ThornEvent
  readonly child: string
  readonly hardpoint: string
  readonly parent: string
  readonly parentHardpoint: string
}

/**
 * Where a connected child part goes (`engbase.dll` `0x6626690`): the parent part's world frame, its
 * hardpoint's frame on it, and the child's hardpoint on the child part. Fixed hardpoints only; a
 * revolute or prismatic child takes a branch not decoded.
 */
export const connectedFrame = (
  parentPart: Frame,
  parentHardpoint: Frame,
  childHardpoint: Frame,
): Frame => Matrix4.multiply(Matrix4.multiply(parentPart, parentHardpoint), inverse(childHardpoint))

/**
 * Thorn's first play from 0 to `milliseconds`, as the game starts a script: started, ticked by 0,
 * then one exact jump. A rewind isn't this: thorn's restores no transform.
 */
export const replay = (
  script: Script,
  milliseconds: number,
  options?: PlaybackOptions,
): Playback => {
  const playback = new Playback(script, options)

  playback.start(0)
  playback.tick(0)
  playback.tick(milliseconds)
  return playback
}

/** A camera or monitor in the world, as its host holds it. */
export interface CameraView {
  world: Frame
  /** Half the horizontal angle, degrees. */
  fovh: number
  near: number
  far: number
  /** `hvaspect`, which the game never reads: its aspect getter and setter are stubs (`0x454190`). */
  aspect: number
}

/** `cameraprops`' defaults (`0x6f29270`). */
const DEFAULT_CAMERA: CameraProps = [60, 0.1, 100000, 1.3333]

const cameraPropsOf = (entity: Entity): CameraProps => {
  if (entity.type !== 'CAMERA') return DEFAULT_CAMERA

  const { fovh, nearplane, farplane, hvaspect } = entity.cameraprops ?? {}
  const [a, b, c, d] = DEFAULT_CAMERA

  return [fovh ?? a, nearplane ?? b, farplane ?? c, hvaspect ?? d].map(
    Math.fround,
  ) as unknown as CameraProps
}

/** `FThornScene`'s playback states, as far as a tick tells them apart. */
export type PlaybackState = 'loaded' | 'playing' | 'looping' | 'stopped' | 'done'

/** Host classes that place their engine object at `C · T`: the rest take thorn's frame as it is. */
const PLACED_BY_C: ReadonlySet<Entity['type']> = new Set([
  'COMPOUND',
  'DEFORMABLE',
  'CAMERA',
  'MONITOR',
  'MARKER',
])

/** The game's compound and character hosts, as far as thorn drives them. */
export interface CharacterHost {
  startMotion?(entity: string, motion: MotionRecord): boolean
  stopMotion?(entity: string, motion: MotionRecord): void
  startAim?(entity: string, aim: AimRecord): boolean
  updateAim?(entity: string, aim: AimRecord): void
  stopAim?(entity: string, aim: AimRecord): void
  /** `IDeformable +0x60`: the root's floor, which each motion applies at its next evaluation. */
  setFloor?(entity: string, height: number): void
  /**
   * A character's root (`0x452ab0`–`0x452c20`): a position write keeps `x` and `z` and discards `y`,
   * and `root` is where it stands now, root motion and all, which thorn reads back. In thorn's space.
   */
  setPosition?(entity: string, position: Vector3): void
  setOrientation?(entity: string, orientation: Frame): void
  root?(entity: string): Frame | undefined
  /** `ICompoundControl +0x18`, with the clock. */
  advance?(entity: string, milliseconds: number): void
}

/** What a `REFERENCE` can name (`FUN_00456790`'s callers). */
const REFERABLE: ReadonlySet<Entity['type']> = new Set(['MARKER', 'CAMERA', 'LIGHT', 'SOUND'])

/** Advanced by the clock (`RegisterFrameEntity`). */
const ADVANCED: ReadonlySet<Entity['type']> = new Set(['COMPOUND', 'DEFORMABLE', 'PSYS'])

/**
 * VC6's `std::sort`, as thorn sorts its master list and each active group: median-of-three
 * partitions above 16 (`SortMasterPartitions`, `PartitionActiveEventTypes`), then insertion. Equal
 * keys keep their order only in a range of 16 or fewer.
 */
export const retailSort = <T>(items: T[], key: (item: T) => number): T[] => {
  const k = (index: number) => key(items[index]!)

  const partition = (begin: number, end: number) => {
    while (end - begin > 16) {
      const a = k(begin)
      const b = k(begin + Math.trunc((end - begin) / 2))
      const c = k(end - 1)
      const pivot = a < b ? (b < c ? b : c <= a ? a : c) : a < c ? a : b < c ? c : b
      let left = begin
      let right = end

      // Hoare scan: swap pairs on the wrong side of the pivot until the cursors cross.
      for (;;) {
        while (k(left) < pivot) left++

        do right--
        while (pivot < k(right))

        if (right <= left) break

        const swap = items[left]!

        items[left] = items[right]!
        items[right] = swap
        left++
      }

      // Recurse into the smaller half and loop on the larger.
      if (end - left <= left - begin) {
        partition(left, end)
        end = left
      } else {
        partition(begin, left)
        begin = left
      }
    }
  }
  if (items.length > 16) partition(0, items.length)

  for (let index = 1; index < items.length; index++) {
    const item = items[index]!
    let at = index

    while (at > 0 && key(item) < k(at - 1)) {
      items[at] = items[at - 1]!
      at--
    }

    items[at] = item
  }

  return items
}

interface EntityState {
  readonly entity: Entity
  frame: Frame
  readonly path: Path | undefined
  /** A camera's or monitor's slots. */
  props: CameraProps
  /** A camera's monitors, or a monitor's camera (`MonitorLinks`). */
  links: number[]
  /** A `REFERENCE`'s live entity in another script, which its reads and writes go to. */
  target: { playback: Playback; id: number } | undefined
  /** A `SOUND`'s `audioprops`: its record's, or the defaults for a `REFERENCE` (`0x6f4255f`). */
  audio: AudioState | undefined
  /** A `LIGHT`'s block, and the type it was made with, which the host keeps. */
  light: LightState | undefined
  readonly madeAs: number
}

export class Playback implements Stage {
  readonly script: Script
  /** Milliseconds: `trunc(duration · 1000)`. */
  readonly duration: number
  readonly loop: boolean
  readonly host: ThornHost
  /** `C`. */
  readonly sceneFrame: Frame
  readonly sceneUp: number
  readonly sceneFront: number
  /** Actions in the script that are scheduled and timed, but whose effect a later step brings. */
  readonly ignored: readonly EventTypeName[]

  #state: PlaybackState = 'loaded'
  #clock = 0
  readonly #entities: EntityState[]
  readonly #ids = new Map<string, number>()
  readonly #master: ThornEvent[]
  #pending: ThornEvent[] = []
  #active: ThornEvent[] = []
  /** Every end instant still to come, ascending, each once. */
  #stops: number[] = []
  #connections: Connection[] = []
  readonly #fog: { state: FogState }
  readonly #sounds = new Map<number, SoundRecord>()
  readonly #motions: { entity: number; motion: MotionRecord }[] = []
  readonly #aims = new Map<number, AimRecord>()
  readonly #floors = new Map<number, number>()
  readonly #characters: CharacterHost
  #now = 0
  readonly #effects = new Map<number, { instance?: EffectInstance; sparam: number }>()
  readonly #createEffect: PlaybackOptions['createEffect']
  readonly #spawn: SpawnOptions
  readonly #fogEnabled: boolean

  constructor(script: Script, options: PlaybackOptions = {}) {
    const { loop = false, frame = Matrix4.identity, host = {} } = options

    this.script = script
    this.duration = milliseconds(script.duration)
    this.loop = loop
    this.host = host
    this.sceneFrame = frame
    this.#fog = options.fog ?? { state: NO_FOG }
    this.#fogEnabled = options.fogEnabled ?? true
    this.#createEffect = options.createEffect
    this.#spawn = options.spawn ?? {}
    this.#characters = options.characters ?? {}
    // The second pass sets a character's floor from its record, after its pose (`0x44f1d2`).
    script.entities.forEach((entity, id) => {
      if (entity.type === 'DEFORMABLE')
        this.#floors.set(id, Math.fround(entity.compoundprops?.floor_height ?? 0))
    })

    // The first SCENE's axes; only LOOK_AT reads them, and 6 means Y and Z.
    const scene = script.entities.find((entity) => entity.type === 'SCENE')

    this.sceneUp = scene?.type === 'SCENE' ? axisIndex(scene.up, 6) : 6
    this.sceneFront = scene?.type === 'SCENE' ? axisIndex(scene.front, 6) : 6
    // Thorn pushes no initial state: every host starts from the record.
    this.#entities = script.entities.map((entity) => ({
      entity,
      target: undefined,
      frame:
        'spatialprops' in entity
          ? placement(entity.spatialprops?.pos, entity.spatialprops?.orient)
          : Matrix4.identity,
      path: entity.type === 'MOTION_PATH' ? createPath(entity.pathprops) : undefined,
      props: cameraPropsOf(entity),
      light: entity.type === 'LIGHT' ? lightOf(entity.lightprops) : undefined,
      audio:
        entity.type !== 'SOUND'
          ? undefined
          : entity.flags?.includes('REFERENCE')
            ? DEFAULT_AUDIO
            : readAudio(entity.audioprops ?? {}, DEFAULT_AUDIO).audio,
      madeAs: entity.type === 'LIGHT' ? lightOf(entity.lightprops).type : 0,
      links: [],
    }))
    script.entities.forEach(({ entity_name }, index) => {
      if (!this.#ids.has(entity_name)) this.#ids.set(entity_name, index)
    })
    // At spawn (`FGfScript::Spawn`): a `REFERENCE` marker, camera, light or sound binds to a live one.
    this.#entities.forEach((state) => {
      const { entity } = state
      if (!entity.flags?.includes('REFERENCE') || !REFERABLE.has(entity.type)) return

      const found = options.resolve?.(entity.type, entity.entity_name)
      if (!found) return

      if ('frame' in found) state.frame = found.frame
      else {
        const id = found.playback.#ids.get(found.name)
        if (id !== undefined) state.target = { playback: found.playback, id }
      }
    })
    // Loaded in script order, each after the equal starts before it, then sorted again (`FinalizeLoad`).
    this.#master = retailSort(
      eventsOf(script).sort((a, b) => (a.start >>> 0) - (b.start >>> 0)),
      (event) => event.start >>> 0,
    )
    this.ignored = [
      ...new Set(this.#master.map((event) => event.action).filter((action) => !RUN.has(action))),
    ]
  }

  get state(): PlaybackState {
    return this.#state
  }

  /** `ClockMs_`: the last instant every active event was updated at. */
  get clock(): number {
    return this.#clock
  }

  /** The events running now, in the order they update. */
  get active(): readonly ThornEvent[] {
    return this.#active
  }

  /** Every `CONNECT_HARDPOINTS` running, in the order made: the host links each child part. */
  get connections(): readonly Connection[] {
    return this.#connections
  }

  /** An entity's frame in thorn's scene space, by name. */
  frameOf(name: string): Frame | undefined {
    const id = this.#ids.get(name)

    return id === undefined ? undefined : this.#entities[id]!.frame
  }

  /**
   * Where the host puts an entity: `C · T` for a compound, deformable, camera, monitor or marker,
   * thorn's `T` as it is for a light, sound or effect (`Thorn_Psys` never applies `C`). A player
   * ship's `HpMount` offset after it is the host's.
   */
  world(name: string): Frame | undefined {
    const id = this.#ids.get(name)
    if (id === undefined) return undefined

    const { entity } = this.#entities[id]!
    const frame = this.#engineFrame(id)

    return PLACED_BY_C.has(entity.type) ? Matrix4.multiply(this.sceneFrame, frame) : frame
  }

  /** `StartPlayback` (`LAB_06f39460`), then a tick by `milliseconds`. The game starts at 0. */
  start(milliseconds = 0): void {
    if (this.#state === 'loaded' || this.#state === 'stopped' || this.#state === 'done') {
      this.#clock = 0
      this.#pending = this.#master.slice()
    } else if (this.#state === 'looping') this.#pending = this.#master.slice()

    this.#state = this.loop ? 'looping' : 'playing'
    this.tick(milliseconds)
  }

  /** `StopPlayback`: every running event finished, the clock back at 0. */
  stop(): void {
    this.#clock = 0
    this.#pending = this.#master.slice()
    this.#stopAll()
    this.#state = 'stopped'
  }

  /**
   * `Tick` (engine `+0x68`): forward by whole milliseconds. A negative step rewinds to 0 and replays,
   * **restoring no transform**. Past the end a loop restarts at exactly 0; a script that doesn't
   * loop finishes every running event and is done.
   */
  tick(milliseconds: number): void {
    // Clock times are int32, so `>>> 0` below compares them unsigned.
    let next = (this.#clock + Math.trunc(milliseconds)) | 0

    if (milliseconds < 0) {
      if (next < 0) next = 0
      this.#stopAll()
      this.#clock = 0
      this.#pending = this.#master.slice()
    }

    const from = this.#clock

    this.#now = next
    if (next >>> 0 < from >>> 0) return
    if (this.#state !== 'playing' && this.#state !== 'looping') return

    this.#dispatch(from, next)
    this.#drain(next)
    this.#update(next)
    // Every control once more by 0, so an effect gets the frame this tick's events wrote.
    if (this.#clock !== 0) this.#advance(this.#clock)

    if (next >>> 0 > this.duration >>> 0) {
      if (this.loop) {
        this.stop()
        this.start(0)
        return
      }

      this.#stopAll()
      this.#state = 'done'
    }
  }

  // Stage: what events read and write.

  frame(entity: number): Frame {
    const state = this.#entities[entity]
    if (state?.target) return state.target.playback.frame(state.target.id)

    if (state?.entity.type === 'DEFORMABLE') {
      const root = this.#characters.root?.(state.entity.entity_name)
      if (root) return root
    }

    return state?.frame ?? Matrix4.identity
  }

  /**
   * Where the engine has an entity: its thorn frame, unless a running `CONNECT_HARDPOINTS` links it
   * under a parent, the last made winning. Then its hardpoint sits on the parent's, `parent ·
   * H_parent · inverse(H_child)`, both relative to their roots; thorn's own frame is left as it was
   * (THORN.md, `CONNECT_HARDPOINTS`). The child's hardpoint is taken on its root part, which moves the
   * whole object; on another part retail moves that part alone, which is not reproduced.
   */
  #engineFrame(entity: number, depth = 0): Frame {
    const state = this.#entities[entity]
    const name = state?.entity.entity_name
    const link =
      depth < 8 && !state?.target
        ? this.#connections.filter((connection) => connection.child === name).at(-1)
        : undefined
    const parent = link && this.#ids.get(link.parent)
    const parentHardpoint = link && this.host.hardpoint?.(link.parent, link.parentHardpoint)
    const childHardpoint = link && this.host.hardpoint?.(link.child, link.hardpoint)

    if (parent === undefined || !parentHardpoint || !childHardpoint) return this.frame(entity)

    return connectedFrame(this.#engineFrame(parent, depth + 1), parentHardpoint, childHardpoint)
  }

  /** A camera's write goes on to every monitor linked to it (`0x6f41490`, `0x6f414d0`). */
  setPosition(entity: number, position: Vector3): void {
    const state = this.#entities[entity]
    if (!state) return
    // A reference's host forwards to its target's (`ThornReferenceSetPosition`), thorn's frame raw.
    if (state.target) return state.target.playback.setPosition(state.target.id, position)
    state.frame = withPosition(state.frame, position)

    if (state.entity.type === 'DEFORMABLE')
      this.#characters.setPosition?.(state.entity.entity_name, position)

    if (state.entity.type === 'CAMERA')
      for (const link of state.links) this.setPosition(link, position)
  }

  setOrientation(entity: number, orientation: Frame): void {
    const state = this.#entities[entity]
    if (!state) return
    if (state.target) return state.target.playback.setOrientation(state.target.id, orientation)
    state.frame = withRotation(state.frame, orientation)

    if (state.entity.type === 'DEFORMABLE')
      this.#characters.setOrientation?.(state.entity.entity_name, orientation)

    if (state.entity.type === 'CAMERA')
      for (const link of state.links) this.setOrientation(link, orientation)
  }

  cameraProps(entity: number): CameraProps {
    return this.#entities[entity]?.props ?? DEFAULT_CAMERA
  }

  setCameraProps(entity: number, props: CameraProps): void {
    const state = this.#entities[entity]
    if (!state) return
    state.props = props

    if (state.entity.type !== 'MONITOR')
      for (const link of state.links) this.setCameraProps(link, props)
  }

  light(entity: number): LightState | undefined {
    return this.#entities[entity]?.light
  }

  setLight(entity: number, light: LightState): void {
    const state = this.#entities[entity]
    if (state?.light) state.light = light
  }

  fog(): FogState {
    const { state } = this.#fog

    return { ...state, on: state.on && this.#fogEnabled }
  }

  setFog(fog: FogState, mask: number): void {
    const state = { ...this.#fog.state }
    if (mask & 1) state.on = fog.on && this.#fogEnabled
    if (mask & 0xa) ((state.table = fog.table), (state.mode = fog.mode))

    if (mask & 0x70)
      ((state.start = fog.start), (state.end = fog.end), (state.density = fog.density))

    if (mask & 4) state.color = fog.color
    this.#fog.state = state
  }

  psysStart(entity: number): boolean {
    const state = this.#entities[entity]
    if (!state || !spawns(state.entity, this.#spawn)) return false

    const { entity_name, template_name } = state.entity
    const template = template_name === 'NULL' ? '' : (template_name ?? entity_name)
    const effect = this.#effects.get(entity) ?? { sparam: 0 }

    // An instance already running is abandoned, not stopped; none starts at the cached sparam.
    effect.instance = this.#createEffect?.(entity_name, template)
    this.#effects.set(entity, effect)
    return true
  }

  psysStop(entity: number): void {
    const effect = this.#effects.get(entity)
    if (effect) effect.instance = undefined
  }

  sparam(entity: number): number {
    return this.#effects.get(entity)?.sparam ?? 0
  }

  setSparam(entity: number, value: number): void {
    const effect = this.#effects.get(entity) ?? { sparam: 0 }

    effect.sparam = value
    this.#effects.set(entity, effect)
    if (effect.instance) effect.instance.context.sparam = value
  }

  /** Every running effect, in the order made: what the room draws of this script's `PSYS`es. */
  get effects(): { entity: string; instance: EffectInstance }[] {
    return [...this.#effects.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([id, { instance }]) =>
        instance ? [{ entity: this.#entities[id]!.entity.entity_name, instance }] : [],
      )
  }

  motionStart(entity: number, motion: MotionRecord): boolean {
    const state = this.#entities[entity]
    if (!state || !spawns(state.entity, this.#spawn)) return false
    if (this.#characters.startMotion?.(state.entity.entity_name, motion) === false) return false
    this.#motions.push({ entity, motion })
    return true
  }

  motionStop(entity: number, motion: MotionRecord): void {
    const at = this.#motions.findIndex((each) => each.motion === motion)
    if (at >= 0) this.#motions.splice(at, 1)
    this.#characters.stopMotion?.(this.#entities[entity]!.entity.entity_name, motion)
  }

  aimStart(entity: number, aim: AimRecord): boolean {
    const state = this.#entities[entity]
    if (!state || !spawns(state.entity, this.#spawn)) return false
    if (this.#characters.startAim?.(state.entity.entity_name, aim) === false) return false
    this.#aims.set(entity, aim)
    return true
  }

  aimUpdate(entity: number, aim: AimRecord): void {
    this.#aims.set(entity, aim)
    this.#characters.updateAim?.(this.#entities[entity]!.entity.entity_name, aim)
  }

  aimStop(entity: number, aim: AimRecord): void {
    if (this.#aims.get(entity) === aim) this.#aims.delete(entity)
    this.#characters.stopAim?.(this.#entities[entity]!.entity.entity_name, aim)
  }

  floor(entity: number): number | undefined {
    return this.#floors.get(entity)
  }

  setFloor(entity: number, height: number): void {
    if (!this.#floors.has(entity)) return
    this.#floors.set(entity, height)
    this.#characters.setFloor?.(this.#entities[entity]!.entity.entity_name, height)
  }

  /** The scripts running on compounds and characters, in the order started. */
  get motions(): { entity: string; motion: MotionRecord }[] {
    return this.#motions.map(({ entity, motion }) => ({
      entity: this.#entities[entity]!.entity.entity_name,
      motion,
    }))
  }

  /** Every character's running aim, its target as of the last update. */
  get aims(): { entity: string; aim: AimRecord }[] {
    return [...this.#aims.entries()].map(([id, aim]) => ({
      entity: this.#entities[id]!.entity.entity_name,
      aim,
    }))
  }

  /** A character's floor height: its record's, then what `START_FLR_HEIGHT_ANIM` sets. */
  floorOf(name: string): number | undefined {
    const id = this.#ids.get(name)

    return id === undefined ? undefined : this.#floors.get(id)
  }

  get now(): number {
    return this.#now
  }

  soundStart(
    entity: number,
    { offset, loop, spatial }: { offset: number; loop: boolean; spatial: boolean },
  ): boolean {
    const state = this.#entities[entity]
    if (!state || !spawns(state.entity, this.#spawn)) return false

    const { entity_name, template_name } = state.entity

    this.#sounds.set(entity, {
      entity: entity_name,
      template: template_name === 'NULL' ? '' : (template_name ?? ''),
      offset,
      loop,
      spatial: spatial || (state.entity.flags?.includes('SPATIAL') ?? false),
      started: this.#now,
    })
    return true
  }

  soundStop(entity: number): void {
    this.#sounds.delete(entity)
  }

  audio(entity: number): AudioState | undefined {
    return this.#entities[entity]?.audio
  }

  setAudio(entity: number, audio: AudioState): void {
    const state = this.#entities[entity]
    if (state?.audio) state.audio = audio
  }

  /**
   * Every sound playing, in the order made, with its entity's `audioprops` now and, for a 3D one,
   * where thorn has it. The host plays, cuts and adjusts them to match.
   */
  get sounds(): (SoundRecord & { audio: AudioState; position: Vector3 })[] {
    return [...this.#sounds.entries()]
      .sort(([a], [b]) => a - b)
      .map(([id, record]) => {
        const { audio, frame } = this.#entities[id]!

        return { ...record, audio: audio ?? DEFAULT_AUDIO, position: positionOf(frame) }
      })
  }

  kind(entity: number): string | undefined {
    return this.#entities[entity]?.entity.type
  }

  /** The room's fog as the frame takes it, or none. */
  get roomFog(): Fog | undefined {
    return roomFogOf(this.#fog.state)
  }

  /** The `SCENE`'s `ambient`, 0 to 255, as the record writes it: nothing animates it in the game. */
  get ambient(): Vector3 | undefined {
    const scene = this.script.entities.find((entity) => entity.type === 'SCENE')

    return scene?.type === 'SCENE' ? scene.ambient : undefined
  }

  /**
   * Every `LIGHT` that's on and spawned, in the order made, as the room's (`0x44b450`). A
   * `REFERENCE` is another script's light.
   */
  roomLights(options: SpawnOptions = {}): RoomLight[] {
    return this.#entities.flatMap(({ entity, light, madeAs, frame }) =>
      light?.on && !entity.flags?.includes('REFERENCE') && spawns(entity, options)
        ? [roomLightOf(light, madeAs, frame, entity.lt_grp ?? 0)]
        : [],
    )
  }

  camera(entity: number): boolean {
    return this.#entities[entity]?.entity.type === 'CAMERA'
  }

  cut(monitor: number, camera: number): void {
    const to = this.#entities[monitor]
    const from = this.#entities[camera]
    if (!to || !from) return

    if (!from.links.includes(monitor)) {
      from.links.push(monitor)

      // `UnbindMonitorChildren` (`0x6f41660`) skips the node after each it unlinks.
      const kept: number[] = []

      to.links.forEach((link, index) => {
        if (index % 2 === 1) return kept.push(link)

        const other = this.#entities[link]
        if (other) other.links = other.links.filter((each) => each !== monitor)
      })
      to.links = kept
      if (!to.links.includes(camera)) to.links.push(camera)
    }

    this.setCameraProps(monitor, from.props)
    this.setPosition(monitor, positionOf(from.frame))
    this.setOrientation(monitor, from.frame)
  }

  /** A camera's or monitor's view in the world: its placement through `C`, and its slots. */
  view(name: string): CameraView | undefined {
    const id = this.#ids.get(name)
    const state = id === undefined ? undefined : this.#entities[id]

    if (!state || (state.entity.type !== 'CAMERA' && state.entity.type !== 'MONITOR'))
      return undefined

    const [fovh, near, far, aspect] = state.props

    return { world: Matrix4.multiply(this.sceneFrame, state.frame), fovh, near, far, aspect }
  }

  /** The camera a monitor follows, by name. */
  linkedCamera(monitor: string): string | undefined {
    const id = this.#ids.get(monitor)
    const state = id === undefined ? undefined : this.#entities[id]
    const link = state?.entity.type === 'MONITOR' ? state.links[0] : undefined

    return link === undefined ? undefined : this.#entities[link]?.entity.entity_name
  }

  compound(entity: number): boolean {
    const type = this.#entities[entity]?.entity.type

    return type === 'COMPOUND' || type === 'DEFORMABLE'
  }

  /**
   * `ICompoundControl +0x24`. A compound answers a hardpoint, or `PART` `root` or `""` with its root,
   * in **world** space (`0x451b90`: `C` is not undone, and thorn takes it as scene space); any other
   * part writes nothing. A deformable answers a hardpoint or a bone in scene space (`0x452730`).
   */
  part(entity: number, type: number, name: string): Frame | undefined {
    const state = this.#entities[entity]
    if (!state) return undefined

    const { entity_name, type: kind } = state.entity
    const own = (local: Frame | undefined) =>
      local && Matrix4.multiply(this.#engineFrame(entity), local)

    if (kind === 'COMPOUND') {
      const scene =
        type === data.TARGET_TYPES.HARDPOINT
          ? own(this.host.hardpoint?.(entity_name, name))
          : name === '' || name.toLowerCase() === 'root'
            ? state.frame
            : undefined

      return scene && Matrix4.multiply(this.sceneFrame, scene)
    }

    if (kind === 'DEFORMABLE')
      return own(
        type === data.TARGET_TYPES.HARDPOINT
          ? this.host.hardpoint?.(entity_name, name)
          : this.host.bone?.(entity_name, name),
      )

    return undefined
  }

  path(entity: number): Path | undefined {
    return this.#entities[entity]?.path
  }

  connect(event: ThornEvent): void {
    if (event.source.action !== 'CONNECT_HARDPOINTS') return

    const [child = '', parent = ''] = event.source.targets

    this.#connections.push({
      event,
      child,
      hardpoint: event.source.hardpoint ?? '',
      parent,
      parentHardpoint: event.source.parent_hardpoint ?? '',
    })
  }

  disconnect(event: ThornEvent): void {
    this.#connections = this.#connections.filter((connection) => connection.event !== event)
  }

  // The schedule.

  /** `FrameUpdateEntities`: each compound, deformable and effect moves on to `now`. */
  #advance(now: number): void {
    const elapsed = (now - this.#clock) | 0

    this.#entities.forEach(({ entity, frame }, id) => {
      if (!ADVANCED.has(entity.type)) return
      this.host.advance?.(entity.entity_name, elapsed)
      if (entity.type !== 'PSYS') this.#characters.advance?.(entity.entity_name, elapsed)

      // `Thorn_Psys` (`0x453ff0`): seconds, the override placement from thorn's frame, `C` never
      // applied, then both passes. Only while an instance exists.
      const instance = this.#effects.get(id)?.instance
      if (instance)
        instance.advance(Math.fround(elapsed * 0.001), { placement: frame, placing: 'override' })
    })
    this.#clock = now
  }

  /** `UpdateActive`: the controls move on, then every running event updates; the finished drop out. */
  #update(now: number): void {
    this.#advance(now)

    for (let index = 0; index < this.#active.length;) {
      const event = this.#active[index]!

      event.update(this, now)

      if (now >>> 0 < event.end >>> 0 || event.end < 0) index++
      else {
        this.#active.splice(index, 1)
        event.finish?.(this)
      }
    }
  }

  /** `StopAll`: every running event finished, with no last update. */
  #stopAll(): void {
    this.#stops = []
    for (const event of this.#active.splice(0)) event.finish?.(this)
  }

  /** `DrainTimedStops` in a tick: an update at every end instant before `now`. */
  #drain(now: number): void {
    while (this.#stops.length && this.#stops[0]! < now) this.#update(this.#stops.shift()!)
  }

  /**
   * `DispatchWindow`: every pending event starting in `[from, to]`, in order. Before each, the ends
   * before its instant are updated at, then everything at its instant once, so it starts against the
   * world as it stands then.
   */
  #dispatch(from: number, to: number): void {
    const first = this.#pending.findIndex((event) => event.start >>> 0 >= from >>> 0)
    if (first < 0 || this.#pending[first]!.start >>> 0 > to >>> 0) return

    let last = first

    while (last < this.#pending.length && this.#pending[last]!.start >>> 0 <= to >>> 0) last++

    const updated = new Set<number>()

    for (const event of this.#pending.slice(first, last)) {
      while (this.#stops.length && this.#stops[0]! >>> 0 < event.start >>> 0) {
        const stop = this.#stops.shift()!

        this.#update(stop)
        updated.add(stop)
      }

      if (!updated.has(event.start)) {
        this.#update(event.start)
        updated.add(event.start)
      }

      if (event.begin(this)) {
        this.#active.push(event)

        if (event.end >= 0) {
          this.#stops = this.#stops.filter((stop) => stop !== event.end)
          this.#stops.push(event.end)
          this.#stops.sort((a, b) => a - b)
        }
      }

      this.#regroup()
    }

    this.#pending.splice(first, last - first)
  }

  /**
   * `RebuildActiveGroups`: grouped by the entity acted on, groups by entity id, each sorted by action
   * number (`EmitActiveGroup`), and an event's second target's group emitted just before it, so a
   * parent updates before its children however long the chain.
   */
  #regroup(): void {
    const groups = new Map<number, { events: ThornEvent[]; visited: boolean }>()

    for (const event of this.#active) {
      const group = groups.get(event.primary)

      if (group) group.events.push(event)
      else groups.set(event.primary, { events: [event], visited: false })
    }

    const out: ThornEvent[] = []

    const emit = (group: { events: ThornEvent[]; visited: boolean }) => {
      if (group.visited) return
      group.visited = true
      retailSort(group.events, (event) => event.type)

      for (const event of group.events) {
        const parent = event.secondary === -1 ? undefined : groups.get(event.secondary)
        if (parent) emit(parent)
        out.push(event)
      }
    }
    for (const id of [...groups.keys()].sort((a, b) => a - b)) emit(groups.get(id)!)
    this.#active = out
  }
}

/** A live, spawned entity by type and name: what another script's `REFERENCE` can bind to. */
export const findEntity = (playback: Playback, type: Entity['type'], name: string): boolean =>
  playback.script.entities.some(
    (entity) =>
      entity.type === type && entity.entity_name === name && !entity.flags?.includes('REFERENCE'),
  )
