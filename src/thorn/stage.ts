/**
 * A base room as the client hosts it (`0x44a7e2`–`0x44ab40`): the set script as data, its `scene`
 * lines started by group, every other sequence played over them, and the room frame they leave.
 * Live: the host advances it every frame and builds a scene when it draws. Which model a template
 * is, which costume a character wears and which effect a `PSYS` makes are the host's answers; this
 * module reads no file.
 */
import type { CompoundNode } from '@treewyrm/freelancer/compound'
import { Matrix4 } from '@treewyrm/freelancer/math'
import type { RigidModel } from '@treewyrm/freelancer/rigid'
import type { Script } from '@treewyrm/freelancer/thn/scene'
import type { EffectInstance } from '#/alchemy/effect.js'
import type { Camera } from '#/scene/camera.js'
import type { SceneEffect, SceneModel } from '#/scene/frame.js'
import { partTransforms } from '#/scene/hierarchy.js'
import type { RoomObject, RoomScene } from '#/scene/room.js'
import type { Frame } from './frame.js'
import { NO_FOG } from './light.js'
import type { CharacterHost, PlaybackOptions, ThornHost } from './playback.js'
import { roomEntities, rtcEnabled, spawns, userProp, type SpawnOptions } from './room.js'
import { frameMilliseconds } from './script.js'
import {
  ambientSequence,
  Sequence,
  SequenceManager,
  type SequenceEntry,
  type SequenceFlags,
  type SetScript,
} from './sequence.js'
import { cameraOf, ViewTable } from './view.js'

/** A `scene` line's type: `traffic` is obsolete but kept (`0x62752b0`). */
export type SceneMode = 'ambient' | 'traffic' | 'once'

/** One `[Room_Info] scene` line, read: its type, its script, and the `rtcslider.ini` setting it waits on. */
export interface SceneLine {
  mode: SceneMode
  script: Script
  /** Its third value. None is always on. */
  setting?: string
}

/** What the room's playback calls back into. */
export interface StagePlayHost {
  hardpoint?: ThornHost['hardpoint']
  /** A character's bones, which its aims and attachments read. */
  bone?: ThornHost['bone']
  characters?: CharacterHost
  createEffect?: PlaybackOptions['createEffect']
}

export interface StageOptions {
  /** The set script as data. An empty room when absent. */
  set?: SetScript
  /** The room's `scene` lines, in file order. */
  scenes?: readonly SceneLine[]
  /** `[Camera] name`: the set script's camera the room shows until a monitor takes the view. */
  camera?: string
  /** `animation` or `animation_oneshot` on the room: its main prop moves, which the stage doesn't play. */
  animated?: boolean
  /** The detail the room is entered at, which decides which `scene` lines start. All when absent. */
  spawn?: SpawnOptions
  host?: StagePlayHost
}

/** What a room's frame asks the host, answered at once from what it loaded ahead. */
export interface StageSceneHost {
  /**
   * A template of a category, placed at `world`, or nothing where no table answers. `entity` names a
   * compound a script spawned, absent for a set-script prop: a compound's motions are the host's
   * (`START_MOTION` through `CharacterHost`, by that name), so it poses the model by it.
   */
  model(
    category: string,
    template: string,
    world: Frame,
    camera: Camera,
    sky: 'starsphere' | 'backdrop' | undefined,
    entity?: string,
  ): SceneModel | undefined
  /** A character's parts where its mixer stands, one model each, or nothing for one not cast. */
  character?(entity: string, world: Frame, camera: Camera): SceneModel[] | undefined
  /** The textures a running effect draws with. */
  effectTexture?(instance: EffectInstance): SceneEffect['texture'] | undefined
}

export interface StageSceneOptions {
  aspect: number
  /** False: the set script's props alone, nothing the scripts spawn. */
  playing?: boolean
  /** Only what stands still: not the main prop of an animated room. */
  still?: boolean
  spawn?: SpawnOptions
}

export interface StageScene {
  scene: RoomScene
  /** What the frame left out, and why. */
  skipped: string[]
}

const EMPTY_SET = (): SetScript => ({ props: [], cameras: [], setpoints: [], lights: [] })

/** The modes in the order the client starts them, each group in file order (`0x44a540`). */
const MODES: readonly SceneMode[] = ['ambient', 'traffic', 'once']

export class RoomStage {
  readonly set: SetScript
  readonly manager = new SequenceManager()
  readonly camera: string | undefined
  readonly animated: boolean
  /** The `scene` lines not started, and why. */
  readonly skipped: string[] = []
  readonly #fog = { state: NO_FOG }
  readonly #host: StagePlayHost
  #carry = 0

  constructor({
    set = EMPTY_SET(),
    scenes = [],
    camera,
    animated = false,
    spawn = {},
    host = {},
  }: StageOptions = {}) {
    this.set = set
    this.camera = camera
    this.animated = animated
    this.#host = host

    const { rtc = [], slider = 1 } = spawn

    for (const mode of MODES)
      for (const { mode: each, script, setting } of scenes) {
        if (each !== mode) continue

        // Skipped unless `RtcSlider::is_enabled(setting)`; no setting is always on.
        if (setting !== undefined && !rtcEnabled(rtc, slider, setting)) {
          this.skipped.push(`scene ${mode}: ${setting} is off`)
          continue
        }

        this.manager.add(
          mode === 'ambient'
            ? ambientSequence(script, this.options)
            : // `traffic` is a kind-5 entry, which repeats; `once` a plain one. Neither exported.
              new Sequence([{ script, ...(mode === 'traffic' && { kind: 5 }) }], {}, this.options),
        )
      }
  }

  /**
   * What every sequence in the room plays with: one fog, the room's hosts, and its `REFERENCE`
   * chain, an earlier exporting script's entity first, then the set script's setpoint or camera.
   */
  readonly options = (frame: Frame | undefined): PlaybackOptions => {
    const { hardpoint, bone, characters, createEffect } = this.#host

    return {
      fog: this.#fog,
      ...(frame && { frame }),
      host: { ...(hardpoint && { hardpoint }), ...(bone && { bone }) },
      ...(characters && { characters }),
      ...(createEffect && { createEffect }),
      resolve: (type, name) => {
        const found = this.manager.find(type, name)
        if (found) return found

        // `RoomData::find_camera` and `find_setpoint` (`common.dll!0x6275fa0`, `0x62761c0`): the
        // last of the name, ignoring case.
        const wanted = name.toLowerCase()
        const at = (type === 'CAMERA' ? this.set.cameras : this.set.setpoints)
          .filter((each) => each.name.toLowerCase() === wanted)
          .at(-1)

        return at && { frame: at.frame }
      },
    }
  }

  /** A sequence over the room, started now: a mission ambient, a landing, a cutscene. */
  play(entries: readonly SequenceEntry[], flags: SequenceFlags = {}): Sequence {
    return this.manager.add(new Sequence(entries, flags, this.options))
  }

  /** Every sequence by whole milliseconds. */
  update(milliseconds: number): void {
    this.manager.update(milliseconds)
  }

  /** One frame of `seconds`, in whole milliseconds with the remainder carried, as the game's clock. */
  advance(seconds: number): void {
    const next = frameMilliseconds(this.#carry, seconds)

    this.#carry = next.carry
    this.manager.update(next.milliseconds)
  }

  /** The view: the highest-priority monitor's, else the room's `[Camera]`, else the set's first. */
  view(aspect: number, spawn?: SpawnOptions): Camera {
    const table = new ViewTable()
    const monitors = this.manager.sequences.flatMap((sequence) =>
      (sequence.playback?.script.entities ?? [])
        // A monitor the slider has off gets no host, so never takes the view.
        .filter((entity) => entity.type === 'MONITOR' && spawns(entity, spawn))
        .map((entity) => ({
          playback: sequence.playback!,
          name: entity.entity_name,
          slot: table.register(sequence.flags.priority ?? 0, true),
        })),
    )
    const shown = monitors.find(({ slot }) => slot === table.active)
    if (shown) return cameraOf(shown.playback.view(shown.name)!)

    const room = this.set.cameras.find(({ name }) => name === this.camera) ?? this.set.cameras[0]

    return cameraOf({
      world: room?.frame ?? Matrix4.identity,
      fovh: room?.fovh ?? 60,
      near: room?.near ?? 1,
      far: room?.far ?? 10000,
      aspect,
    })
  }

  /**
   * The frame the room leaves: the set script's props, then each playing script's compounds and
   * characters, its lights, the first script's fog, and the view.
   */
  scene(
    host: StageSceneHost,
    { aspect, playing = true, still = false, spawn }: StageSceneOptions,
  ): StageScene {
    const view = this.view(aspect, spawn)
    const skipped: string[] = []
    const objects: RoomObject[] = []
    const effects: SceneEffect[] = []

    for (const prop of this.set.props) {
      if (still && prop.main && this.animated) continue

      const model = host.model(prop.category, prop.template, prop.frame, view, prop.sky)

      if (!model) {
        skipped.push(`prop ${prop.template}: ${prop.category}`)
        continue
      }

      objects.push({
        model,
        position: { x: prop.frame.w.x, y: prop.frame.w.y, z: prop.frame.w.z },
        layer: prop.layer,
        lightGroup: prop.lightGroup,
        visible: prop.visible,
        lit: prop.lit,
        fog: prop.fog,
      })
    }

    for (const sequence of playing ? this.manager.sequences : []) {
      const playback = sequence.playback
      if (!playback) continue

      for (const entity of roomEntities(playback, spawn)) {
        const character =
          entity.entity.type === 'DEFORMABLE'
            ? host.character?.(entity.entity.entity_name, entity.world, view)
            : undefined

        if (character) {
          for (const model of character) objects.push({ ...entity.object, model })
          continue
        }

        const model = entity.category
          ? host.model(
              entity.category,
              entity.template,
              entity.world,
              view,
              entity.sky,
              entity.entity.entity_name,
            )
          : undefined

        if (!model) {
          skipped.push(
            `${entity.entity.entity_name}: ${entity.category ?? 'a character'} ${entity.template}`,
          )
          continue
        }

        objects.push({ ...entity.object, model })
      }

      for (const { entity, instance } of playback.effects) {
        const texture = host.effectTexture?.(instance)

        if (texture) effects.push({ instance, texture })
        else skipped.push(`effect ${entity}`)
      }

      if (!this.#host.createEffect) {
        const psys = playback.script.entities.filter(({ type }) => type === 'PSYS').length
        if (psys) skipped.push(`${psys} PSYS entities: no effects given`)
      }
    }

    const first = this.manager.sequences[0]?.playback

    return {
      scene: {
        camera: view,
        aspect,
        ...(this.set.ambient && { ambient: this.set.ambient }),
        lights: [
          ...this.set.lights,
          ...this.manager.sequences.flatMap((sequence) => sequence.playback?.roomLights() ?? []),
        ],
        objects,
        ...(effects.length && { effects }),
        ...(first?.roomFog && { fog: first.roomFog }),
      },
      skipped,
    }
  }
}

/** A template a room may ask its host for. */
export interface StageTemplate {
  category: string
  template: string
}

/**
 * Every model a room with these scripts can ask for, each once: the set script's props and every
 * compound with a `category` that is not a `REFERENCE`. A host loads these ahead, since a frame
 * asks for them at once.
 */
export const stageTemplates = (set: SetScript, scripts: readonly Script[]): StageTemplate[] => {
  const found = new Map<string, StageTemplate>()
  const add = (category: string, template: string) =>
    found.set(`${category}\n${template.toLowerCase()}`, { category, template })

  for (const { category, template } of set.props) add(category, template)

  for (const { entities } of scripts)
    for (const entity of entities) {
      if (entity.type !== 'COMPOUND' || entity.flags?.includes('REFERENCE')) continue

      const category = userProp(entity, 'category')
      const template =
        entity.template_name === 'NULL' ? '' : (entity.template_name ?? entity.entity_name)

      if (category !== undefined) add(category, template)
    }

  return [...found.values()]
}

/**
 * A compound's hardpoint at rest, relative to its root: every part searched, names ignoring case,
 * the last found winning as `HardpointSummary::find_name` has it. That the summary lists parts in
 * the order `partTransforms` walks them is assumed, not traced.
 */
export const compoundHardpoint = (model: RigidModel, name: string): Frame | undefined => {
  const parts: [RigidModel, Matrix4][] =
    model.type === 'compound'
      ? [...partTransforms(model as CompoundNode<RigidModel>, Matrix4.identity)].map(
          ([node, world]) => [node.part, world],
        )
      : [[model, Matrix4.identity]]
  const wanted = name.toLowerCase()
  let frame: Frame | undefined

  for (const [part, world] of parts) {
    if (part.type !== 'rigid') continue

    for (const point of part.hardpoints)
      if (point.name.toLowerCase() === wanted)
        frame = Matrix4.multiply(
          world,
          Matrix4.fromRotationTranslation(
            point.orientation,
            point.position ?? { x: 0, y: 0, z: 0 },
          ),
        )
  }

  return frame
}
