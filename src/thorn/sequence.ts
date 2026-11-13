/**
 * How the game plays scripts in a room: sequences of entries, one live at a time
 * (`FGfScriptSequence`, `gf_script_object.cpp`), the manager that updates them all with the same
 * milliseconds and finds the entities they export (`FGfScriptManager`), and a room's set script read
 * as data, never played (`RoomData::read_set_script`, `common_roomdata.cpp`).
 */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { Entity, Script } from '@treewyrm/freelancer/thn/scene'
import type { RoomLight } from '#/scene/room.js'
import { inverse, placement, positionOf, type Frame } from './frame.js'
import { lightOf, roomLightOf } from './light.js'
import { findEntity, Playback, type PlaybackOptions } from './playback.js'
import { renderTypeOf, userProp } from './room.js'
import { ScriptRun } from './script.js'

/**
 * An entry's kind: 0 plain, 1 an offer's decision, 2 accept, 3 decline or reject, 4 an info box,
 * 5 a room's traffic, which repeats, 6 a group offer's other branch.
 */
export type EntryKind = 0 | 1 | 2 | 3 | 4 | 5 | 6

export interface SequenceEntry {
  script: Script
  kind?: EntryKind
  /** The host's scene frame `C`: a room character's setpoint over its actor, else the identity. */
  frame?: Frame
}

/** A sequence's flags (`0x454920`). The host acts on most of them: letterbox, ducking, fades. */
export interface SequenceFlags {
  loop?: boolean
  /** Letterboxed, the UI hidden. */
  cinematic?: boolean
  skippable?: boolean
  /** Its live entities are what other scripts' `REFERENCE`s find (`+0x2f`). */
  exported?: boolean
  /** Its monitors' camera priority: 1 for landing, launch and transitions, else 0. */
  priority?: number
}

/** `FindNextOfKinds` (`FUN_00455f50`): the offset of the next entry of one of `kinds`, or past the end. */
const nextOfKinds = (
  kinds: readonly EntryKind[],
  entries: readonly SequenceEntry[],
  current: number,
) => {
  for (let offset = 1; current + offset < entries.length; offset++)
    if (kinds.includes(entries[current + offset]!.kind ?? 0)) return offset

  return entries.length - current
}

export class Sequence {
  readonly entries: readonly SequenceEntry[]
  readonly flags: SequenceFlags
  /** The entry playing, or −1 once done. */
  current = -1
  run: ScriptRun | undefined
  /** The decision's answer, which the host sets from the offer dialog. */
  answered: boolean | undefined
  infoClosed = false
  #skip = false
  readonly #options: (frame: Frame | undefined) => PlaybackOptions

  constructor(
    entries: readonly SequenceEntry[],
    flags: SequenceFlags = {},
    options: (frame: Frame | undefined) => PlaybackOptions = (frame) => (frame ? { frame } : {}),
  ) {
    this.entries = entries
    this.flags = flags
    this.#options = options
  }

  /** `Play` (`FUN_00454f80`): the first entry starts, ticked by 0. */
  play(): void {
    this.#start(0)
  }

  get done(): boolean {
    return this.current === -1
  }

  get playback(): Playback | undefined {
    return this.run?.playback
  }

  /** The skip key (`0x456840`): a cinematic, skippable sequence skips to its decision, which plays. */
  skip(): void {
    if (this.flags.cinematic && this.flags.skippable && !this.done) this.#skip = true
  }

  #start(index: number): void {
    this.current = index

    const entry = this.entries[index]!
    const options = this.#options(entry.frame)

    this.run = new ScriptRun(
      new Playback(entry.script, { ...options, loop: this.flags.loop ?? false }),
    )
    if (entry.kind === 1) this.answered = undefined
  }

  /** The offer answered: the looping decision jumps to its end, so the branch starts next update. */
  answer(accepted: boolean): void {
    this.answered = accepted
    this.run?.skip()
  }

  /** `NextEntryIndex` (`FUN_00455fc0`), single player. */
  next(): number {
    const kind = this.entries[this.current]?.kind ?? 0
    const step = (kinds: EntryKind[]) => nextOfKinds(kinds, this.entries, this.current)

    switch (kind) {
      case 0:
        return this.current + 1
      case 1:
        return (
          this.current +
          (this.answered === undefined ? 0 : step(this.answered ? [0, 2, 4] : [0, 3]))
        )
      case 2:
        return this.current + step([0, 2, 4])
      case 3:
        return this.current + step([0, 3])
      case 4:
        return this.current + (this.infoClosed ? step([0, 2, 4]) : 0)
      case 6:
        return this.current + step([0, 6])
      default:
        // A traffic script repeats.
        return this.current
    }
  }

  /**
   * `FGfScriptSequence::Update` (`FUN_00456150`): skipping runs each entry out to its end, stopping
   * at a decision or info box; then the live script by `milliseconds`, and the next entry when it
   * finishes. True once done.
   */
  update(milliseconds: number, catchup = 0): boolean {
    if (this.done) return true

    while (this.#skip) {
      this.run!.skip()
      this.run!.update(0)

      const next = this.next()

      if (next >= this.entries.length) {
        this.current = -1
        this.run = undefined
        return true
      }

      const kind = this.entries[next]!.kind ?? 0
      if (kind === 1 || kind === 4) this.#skip = false
      this.#start(next)
    }

    if (!this.run!.update(milliseconds, catchup)) return false

    const next = this.next()

    if (next < this.entries.length) {
      // A decision not yet answered starts again: it loops until the offer is answered.
      this.#start(next)
      return false
    }

    this.current = -1
    this.run = undefined
    return true
  }
}

/** `FGfScriptManager`: every sequence, updated in the order made with the same milliseconds. */
export class SequenceManager {
  readonly sequences: Sequence[] = []

  add(sequence: Sequence): Sequence {
    this.sequences.push(sequence)
    sequence.play()
    return sequence
  }

  /** `FUN_00456650`: each updated; the finished dropped. */
  update(milliseconds: number): void {
    for (const sequence of this.sequences.slice())
      if (sequence.update(milliseconds)) this.sequences.splice(this.sequences.indexOf(sequence), 1)
  }

  skip(): void {
    for (const sequence of this.sequences) sequence.skip()
  }

  /**
   * `FindCreatedEntity` (`FUN_00456790`): the first live entity of that type and name in the current
   * script of an exporting sequence, by the order the sequences were made.
   */
  find(type: Entity['type'], name: string): { playback: Playback; name: string } | undefined {
    for (const sequence of this.sequences) {
      const playback = sequence.playback

      if (sequence.flags.exported && playback && findEntity(playback, type, name))
        return { playback, name }
    }

    return undefined
  }
}

/** A prop the set script lists: the room's own models. */
export interface SetProp {
  entity: Entity
  template: string
  category: string
  frame: Frame
  /** `LIT_AMBIENT`, `LIT_DYNAMIC`, fog unless `nofog`. */
  visible: boolean
  lit: boolean
  fog: boolean
  /** A `Room` category or a `hardpoint` userprop: the room's main prop. */
  main: boolean
  lightGroup: number
  layer: number
  sky: 'starsphere' | 'backdrop' | undefined
  loadout: string
  priority: string | undefined
  runningLights: boolean
}

export interface SetCamera {
  name: string
  frame: Frame
  fovh: number
  near: number
  far: number
}

/** A shadow or glare source: directional along its turned direction, else at its position. */
export interface SetSource {
  direction?: Vector3
  position?: Vector3
  color: Vector3
}

export interface SetScript {
  props: SetProp[]
  /** Every camera, which is a setpoint of the same name too. */
  cameras: SetCamera[]
  setpoints: { name: string; frame: Frame }[]
  /** `LtShadowSource` and `LtGlareSource`. */
  shadow?: SetSource
  glare?: SetSource
  /** Any other light that's on: none in retail. */
  lights: RoomLight[]
  /** The `SCENE`'s, 0 to 255. */
  ambient?: Vector3
}

/**
 * `RoomData::read_set_script` (`common!0x6274ea0`): the set script as data. Its compounds with a `category`
 * become props, its cameras cameras and setpoints, its markers setpoints, two lights by name the
 * shadow and glare sources, and the rest of the lights only when on. No event runs.
 */
export const readSetScript = (script: Script): SetScript => {
  const out: SetScript = { props: [], cameras: [], setpoints: [], lights: [] }

  for (const entity of script.entities) {
    const frame =
      'spatialprops' in entity
        ? placement(entity.spatialprops?.pos, entity.spatialprops?.orient)
        : Matrix4.identity
    const flags = 'flags' in entity ? (entity.flags ?? []) : []
    const name = entity.entity_name

    if (entity.type === 'COMPOUND') {
      const category = userProp(entity, 'category')
      // Reported and skipped without one.
      if (category === undefined) continue
      out.props.push({
        entity,
        template: entity.template_name === 'NULL' ? '' : (entity.template_name ?? name),
        category,
        frame,
        visible: flags.includes('LIT_AMBIENT'),
        lit: flags.includes('LIT_DYNAMIC'),
        fog: userProp(entity, 'nofog') === undefined,
        main: category === 'Room' || userProp(entity, 'hardpoint') !== undefined,
        lightGroup: entity.lt_grp ?? 0,
        layer: entity.srt_grp ?? 0,
        sky: renderTypeOf(entity),
        loadout: userProp(entity, 'loadout') ?? '',
        priority: userProp(entity, 'priority'),
        runningLights: userProp(entity, 'running_lights') !== undefined,
      })
    } else if (entity.type === 'CAMERA') {
      const { fovh = 60, nearplane = 0.1, farplane = 100000 } = entity.cameraprops ?? {}

      out.cameras.push({ name, frame, fovh, near: nearplane, far: farplane })
      out.setpoints.push({ name, frame })
    } else if (entity.type === 'MARKER') out.setpoints.push({ name, frame })
    else if (entity.type === 'LIGHT') {
      const light = lightOf(entity.lightprops)
      const source = (): SetSource =>
        light.type === 3
          ? { direction: Matrix4.transformDirection(light.direction, frame), color: light.diffuse }
          : { position: positionOf(frame), color: light.diffuse }

      if (name.toLowerCase() === 'ltshadowsource') out.shadow = source()
      else if (name.toLowerCase() === 'ltglaresource') out.glare = source()
      else if (light.on) out.lights.push(roomLightOf(light, light.type, frame, entity.lt_grp ?? 0))
    } else if (entity.type === 'SCENE' && entity.ambient) out.ambient = entity.ambient
  }

  return out
}

/**
 * `ThornScriptGetCsys` (`0x627be8f`): the first `DEFORMABLE` whose `actor` isn't `player`, upright at
 * its floor height: `[R | (x, floor_height, z)]`. The identity with none.
 */
export const scriptAnchor = (script: Script): Frame => {
  const actor = script.entities.find(
    (entity) =>
      entity.type === 'DEFORMABLE' && userProp(entity, 'actor')?.toLowerCase() !== 'player',
  )
  if (actor?.type !== 'DEFORMABLE') return Matrix4.identity

  const { pos, orient } = actor.spatialprops ?? {}
  const frame = placement(pos, orient)

  return {
    ...frame,
    w: { x: frame.w.x, y: actor.compoundprops?.floor_height ?? 0, z: frame.w.z, w: 1 },
  }
}

/**
 * A room character's fidget (`0x445340`): `C = setpoint · G⁻¹`, so its actor lands there. A
 * conversation runs at `C = I`.
 */
export const anchoredFrame = (setpoint: Frame, script: Script): Frame =>
  Matrix4.multiply(setpoint, inverse(scriptAnchor(script)))

/**
 * A room's `scene = ambient, path` line (`0x44a540`): a looping, exporting sequence at `C = I`,
 * priority 0, not cinematic.
 */
export const ambientSequence = (
  script: Script,
  options?: (frame: Frame | undefined) => PlaybackOptions,
): Sequence => new Sequence([{ script }], { loop: true, exported: true, priority: 0 }, options)
