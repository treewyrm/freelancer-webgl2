/** Writes a reference scene as a `.thn`, for the game to play in place of its menu room. */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import { value, type Value } from '@treewyrm/freelancer/thn'
import { write } from '@treewyrm/freelancer/thn/text'
import type { Camera } from '#/scene/camera.js'
import type { SwitchTable } from '#/deformable/level.js'
import type { Generated } from './generate.js'
import type { GeneratedEffect } from './effects.js'

type Vector = readonly [number, number, number]
type Rows = readonly [Vector, Vector, Vector]

export interface ReferenceScene {
  name: string
  /**
   * A sky, drawn first, in this order. `Prop` is `petaldb.ini`'s. `Solar` adds a lab-only archetype
   * for a file no retail table names.
   */
  sky?: {
    archetype: string
    category: 'Prop' | 'Solar'
    file: string
    /** `usr_flg` 2, `BackdropMaterial`'s path, rather than 1. */
    backdrop?: boolean
    /** Where `file` is under DATA. `SOLAR/STARSPHERE` when absent. */
    folder?: string
  }[]
  /** A `costumes.ini` costume, playing one script through to its end, where it holds. */
  character?: {
    costume: string
    /** Its `.dfm` files, body first, then head and hands, in the order the game lists them. */
    parts: string[]
    /** The `.anm` holding `script`. */
    animations: string
    script: string
    /** In seconds: the script's length, at which the game stops it and keeps its last values. */
    duration: number
    position: Vector
    orientation: Rows
    /** Each part's `[DetailSwitchTable]` from `bodyparts.ini`, to choose levels as the game does. */
    tables?: SwitchTable[]
    /** Aims the eyes at this point, through a `MARKER`, as 1,499 retail `START_IK` events do. */
    gaze?: Vector
  }
  model?: {
    /** Nickname in the table `category` selects. */
    archetype: string
    /** `Spaceship` is `[Ship]`, `Solar` is `[Solar]`. Exact, case included. */
    category: 'Spaceship' | 'Solar'
    position: Vector
    orientation: Rows
    /** More of the same model, each its own object, after this one in the script. */
    copies?: { position: Vector; orientation: Rows }[]
  }
  camera: {
    position: Vector
    orientation: Rows
    /** Degrees. */
    fovh: number
    near: number
    far: number
  }
  /** A generated model of this scene's bands, given a lab-only archetype, in place of a retail one. */
  generated?: Generated
  /**
   * Libraries for the lab install to load at startup, through `FX/effect_shapes.ini`: what the game
   * would have loaded by the time it needs them, where a menu scene alone hasn't.
   */
  preload?: { file: string; texture: string }[]
  /**
   * One generated effect, at the origin, through a `PSYS` and a lab-only `[VisEffect]`. `seconds` is
   * how long it has run when F9 is pressed, which only needs to be right to the nearest clock.
   */
  effect?: {
    kind: GeneratedEffect
    seconds: number
    /** Written over `dacom.ini`'s `[Alchemy]` for this run, as retail's pool of an oriented is 0. */
    pools?: Record<string, number>
    /** Carries camera and effect along together, at a steady speed, for the dust. */
    travel?: { by: Vector; duration: number }
  }
  /**
   * Playback to check: entities and events written after the rest, as a THN writes them, which may
   * name `Model_Reference`, `Camera_Reference` and `Monitor_Reference`. Every motion ends by `settle`
   * seconds and holds, so F9 any time after captures the state `settled` computes.
   */
  thorn?: { entities: Value[]; events: Value[]; settle: number }
  /** 0 to 255, given to the model through `LIT_AMBIENT`. */
  ambient: Vector
  /** `range` is 2000 unless a scene is too large for that. */
  lights: { color: Vector; direction: Vector; range?: number }[]
}

export const IDENTITY: Rows = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

/** Yaw about Y, then pitch about X, in degrees, rounded as retail scripts print them. */
export const rotation = (yaw: number, pitch: number): Rows => {
  const [sy, cy] = [Math.sin((yaw * Math.PI) / 180), Math.cos((yaw * Math.PI) / 180)]
  const [sp, cp] = [Math.sin((pitch * Math.PI) / 180), Math.cos((pitch * Math.PI) / 180)]
  const round = (rows: number[][]) =>
    rows.map((row) => row.map((cell) => Number(cell.toFixed(6)))) as unknown as Rows

  return round([
    [cy, sy * sp, sy * cp],
    [0, cp, -sp],
    [-sy, cy * sp, cy * cp],
  ])
}

const vector = (v: Vector) => value.list(...v)

const spatial = (position: Vector, orientation: Rows) =>
  value.table({ pos: vector(position), orient: value.list(...orientation.map(vector)) })

/** What every retail entity opens with, in retail's field order. */
const common = (name: string, type: string, template: string, group: number) => ({
  entity_name: name,
  type: value.identifier(type),
  template_name: template,
  lt_grp: group,
  srt_grp: 0,
  usr_flg: 0,
})

// A model only receives lights of its own group; see `lt_grp` in the library's THORN.md.
const LIGHT_GROUP = 1

/** Shapes and field order follow retail's `SCRIPTS/INTRO/gasminer3.thn`. */
export const sceneScript = (scene: ReferenceScene): string => {
  const { model, sky, character, effect, camera, ambient, lights } = scene

  const entities = [
    value.table({
      ...common('Scene_Reference', 'SCENE', '', 0),
      spatialprops: spatial([0, 0, 0], IDENTITY),
      up: value.identifier('Y_AXIS'),
      front: value.identifier('Z_AXIS'),
      ambient: vector(ambient),
    }),
    value.table({
      ...common('Camera_Reference', 'CAMERA', '', 0),
      spatialprops: spatial(camera.position, camera.orientation),
      cameraprops: value.table({
        fovh: camera.fovh,
        hvaspect: 1.333333,
        nearplane: camera.near,
        farplane: camera.far,
      }),
    }),
    value.table(common('Monitor_Reference', 'MONITOR', '', 0)),
    // `usr_flg` 1 is the starsphere path, and `srt_grp` orders a room's groups, signed.
    ...(sky ?? []).map(({ archetype, category, backdrop }, index) =>
      value.table({
        ...common(`Sky_Reference_${index + 1}`, 'COMPOUND', archetype, 0),
        srt_grp: index - (sky?.length ?? 0),
        usr_flg: backdrop ? 2 : 1,
        flags: value.identifier('LIT_DYNAMIC', 'LIT_AMBIENT'),
        spatialprops: spatial([0, 0, 0], IDENTITY),
        userprops: value.table({ category }),
      }),
    ),
    ...(character
      ? [
          value.table({
            ...common('Char_Reference', 'DEFORMABLE', character.costume, LIGHT_GROUP),
            flags: value.identifier('LIT_DYNAMIC', 'LIT_AMBIENT'),
            spatialprops: spatial(character.position, character.orientation),
            compoundprops: value.table({ floor_height: 0 }),
          }),
        ]
      : []),
    ...(character?.gaze
      ? [
          value.table({
            ...common('Gaze_Reference', 'MARKER', '', 0),
            spatialprops: spatial(character.gaze, IDENTITY),
          }),
        ]
      : []),
    ...(model
      ? [
          value.table({
            ...common('Model_Reference', 'COMPOUND', model.archetype, LIGHT_GROUP),
            flags: value.identifier('LIT_DYNAMIC', 'LIT_AMBIENT'),
            spatialprops: spatial(model.position, model.orientation),
            userprops: value.table({ category: model.category }),
          }),
        ]
      : []),
    ...(model?.copies ?? []).map(({ position, orientation }, index) =>
      value.table({
        ...common(`Model_Reference_${index + 2}`, 'COMPOUND', model!.archetype, LIGHT_GROUP),
        flags: value.identifier('LIT_DYNAMIC', 'LIT_AMBIENT'),
        spatialprops: spatial(position, orientation),
        userprops: value.table({ category: model!.category }),
      }),
    ),
    // Shaped as `SCRIPTS/INTRO/intro_waterplanet.thn` writes it. A `template_name` is a `[VisEffect]`.
    ...(effect
      ? [
          value.table({
            ...common('Psys_Reference', 'PSYS', `lab_${effect.kind}`, 0),
            flags: value.identifier('LIT_DYNAMIC', 'LIT_AMBIENT'),
            spatialprops: spatial([0, 0, 0], IDENTITY),
            psysprops: value.table({ sparam: 0 }),
          }),
        ]
      : []),
    ...lights.map((light, index) =>
      value.table({
        ...common(`Light_Reference_${index + 1}`, 'LIGHT', '', LIGHT_GROUP),
        spatialprops: spatial([0, 0, 0], IDENTITY),
        lightprops: value.table({
          on: value.identifier('Y'),
          color: vector(light.color),
          diffuse: value.list(1, 1, 1),
          specular: value.list(0, 0, 0),
          ambient: value.list(0, 0, 0),
          direction: vector(light.direction),
          range: light.range ?? 2000,
          cutoff: value.number('98.999977'),
          type: value.identifier('L_DIRECT'),
          theta: 90,
          atten: value.list(1, 0, 0),
        }),
      }),
    ),
    ...(scene.thorn?.entities ?? []),
  ]

  const events = [
    value.list(
      0,
      value.identifier('SET_CAMERA'),
      value.list('Monitor_Reference', 'Camera_Reference'),
    ),
    ...(effect
      ? [
          value.list(
            0,
            value.identifier('START_PSYS'),
            value.list('Psys_Reference'),
            value.table({ duration: 3600 }),
          ),
        ]
      : []),
    // Shaped as `SCRIPTS/INTRO/gasminer3.thn` writes it. Alone on an entity, position is a plain lerp.
    ...(effect?.travel
      ? [
          { name: 'Camera_Reference', from: camera.position },
          { name: 'Psys_Reference', from: [0, 0, 0] as Vector },
        ].map(({ name, from }) =>
          value.list(
            0,
            value.identifier('START_SPATIAL_PROP_ANIM'),
            value.list(name),
            value.table({
              duration: effect.travel!.duration,
              target_type: value.identifier('ROOT'),
              spatialprops: value.table({
                pos: vector([
                  from[0] + effect.travel!.by[0],
                  from[1] + effect.travel!.by[1],
                  from[2] + effect.travel!.by[2],
                ]),
              }),
            }),
          ),
        )
      : []),
    // Shaped as `SCRIPTS/STORY/s002xe_nrml_sinclair_li_01_cityscape_01.thn` writes them.
    ...(character
      ? [
          value.list(
            0,
            value.identifier('START_MOTION'),
            value.list('Char_Reference'),
            value.table({
              animation: character.script,
              duration: character.duration,
              time_scale: 1,
              weight: 1,
              heading: -1,
            }),
          ),
        ]
      : []),
    // Shaped as `SCRIPTS/GCS/gcs_fmsit_a01ag_01.thn` writes them, holding for the whole scene.
    ...(character?.gaze
      ? [
          value.list(
            0,
            value.identifier('START_IK'),
            value.list('Char_Reference', 'Gaze_Reference'),
            value.table({
              duration: 3600,
              end_effector: 'Eye IK Left',
              count_to_root: 1,
              target_part: '',
              target_type: value.identifier('ROOT'),
              damping: 1,
              up: value.identifier('Y_AXIS'),
              front: value.identifier('Z_AXIS'),
              point_at: 1,
              move_to: 0,
              transition_duration: 0.79,
              event_flags: 128,
            }),
          ),
        ]
      : []),
    ...(scene.thorn?.events ?? []),
  ]

  return write([
    { name: 'duration', value: value.number(3600) },
    { name: 'entities', value: value.list(...entities) },
    { name: 'events', value: value.list(...events) },
  ])
}

type Rowed = { x: Vector3; y: Vector3; z: Vector3 }

/** THN triples are columns (library `THORN.md`); a `Matrix3` holds rows. */
export const toRows = ([a, b, c]: Rows): Rowed => ({
  x: { x: a[0], y: b[0], z: c[0] },
  y: { x: a[1], y: b[1], z: c[1] },
  z: { x: a[2], y: b[2], z: c[2] },
})

const toVector = ([x, y, z]: Vector): Vector3 => ({ x, y, z })

/** The scene's camera, as the renderer takes one. */
export const cameraOf = ({ camera }: ReferenceScene): Camera => ({
  position: toVector(camera.position),
  orientation: toRows(camera.orientation),
  fovh: camera.fovh,
  near: camera.near,
  far: camera.far,
})

/** A THN `orient`, as a matrix. */
export const orientationMatrix = (orientation: Rows): Matrix4 =>
  Matrix4.fromRotationTranslation(toRows(orientation), { x: 0, y: 0, z: 0 })

/** Where the scene stands its model. */
export const modelMatrixOf = ({ model }: ReferenceScene): Matrix4 =>
  Matrix4.fromRotationTranslation(toRows(model!.orientation), toVector(model!.position))
