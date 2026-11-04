/** Writes a reference scene as a `.thn`, for the game to play in place of its menu room. */
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import { value } from '@treewyrm/freelancer/thn'
import { write } from '@treewyrm/freelancer/thn/text'
import type { Camera } from '#/scene/camera.js'
import type { Generated } from './generate.js'

type Vector = readonly [number, number, number]
type Rows = readonly [Vector, Vector, Vector]

export interface ReferenceScene {
  name: string
  model: {
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
  /** 0 to 255, given to the model through `LIT_AMBIENT`. */
  ambient: Vector
  lights: { color: Vector; direction: Vector }[]
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
  const { model, camera, ambient, lights } = scene

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
    value.table({
      ...common('Model_Reference', 'COMPOUND', model.archetype, LIGHT_GROUP),
      flags: value.identifier('LIT_DYNAMIC', 'LIT_AMBIENT'),
      spatialprops: spatial(model.position, model.orientation),
      userprops: value.table({ category: model.category }),
    }),
    ...(model.copies ?? []).map(({ position, orientation }, index) =>
      value.table({
        ...common(`Model_Reference_${index + 2}`, 'COMPOUND', model.archetype, LIGHT_GROUP),
        flags: value.identifier('LIT_DYNAMIC', 'LIT_AMBIENT'),
        spatialprops: spatial(position, orientation),
        userprops: value.table({ category: model.category }),
      }),
    ),
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
          range: 2000,
          cutoff: value.number('98.999977'),
          type: value.identifier('L_DIRECT'),
          theta: 90,
          atten: value.list(1, 0, 0),
        }),
      }),
    ),
  ]

  const events = [
    value.list(
      0,
      value.identifier('SET_CAMERA'),
      value.list('Monitor_Reference', 'Camera_Reference'),
    ),
  ]

  return write([
    { name: 'duration', value: value.number(3600) },
    { name: 'entities', value: value.list(...entities) },
    { name: 'events', value: value.list(...events) },
  ])
}

type Rowed = { x: Vector3; y: Vector3; z: Vector3 }

/** THN triples are columns (library `THORN.md`); a `Matrix3` holds rows. */
const toRows = ([a, b, c]: Rows): Rowed => ({
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

/** Where the scene stands its model. */
export const modelMatrixOf = ({ model }: ReferenceScene): Matrix4 =>
  Matrix4.fromRotationTranslation(toRows(model.orientation), toVector(model.position))
