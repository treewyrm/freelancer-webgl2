/**
 * Reference scenes for THN playback, and what playback says each holds once its motion has ended:
 * the model and the monitor where `src/thorn` puts them at the scene's `settle`.
 */
import { value } from '@treewyrm/freelancer/thn'
import { read } from '@treewyrm/freelancer/thn/text'
import * as thnScene from '@treewyrm/freelancer/thn/scene'
import { replay } from '#/thorn/playback.js'
import { milliseconds } from '#/thorn/events.js'
import type { Frame } from '#/thorn/frame.js'
import { IDENTITY, rotation, sceneScript, toRows, type ReferenceScene } from './scene.js'
import type { Played, ReadAsset } from './load.js'
import { readAnimationLibrary } from '@treewyrm/freelancer/animation'
import type { CompoundNode } from '@treewyrm/freelancer/compound'
import { getBoneModel } from '@treewyrm/freelancer/deformable'
import { Directory } from '@treewyrm/freelancer/utf'
import { Mixer, type MixerJoint } from '#/deformable/mixer.js'
import { mixerCharacters } from '#/thorn/character.js'
import { placement, quaternionOf } from '#/thorn/frame.js'
import { Playback, type PlaybackOptions } from '#/thorn/playback.js'
import { frameMilliseconds, ScriptRun } from '#/thorn/script.js'

type Vector = readonly [number, number, number]

const vector = (v: Vector) => value.list(...v)
const time = (seconds: number) => value.number(seconds)

const LIT = {
  ambient: [40, 40, 40] as Vector,
  lights: [{ color: [255, 255, 255] as Vector, direction: [0.5, -0.5, -1] as Vector }],
}

const SHIP = {
  archetype: 'li_elite',
  category: 'Spaceship' as const,
  position: [0, 0, -40] as Vector,
  orientation: rotation(150, 20),
}

const CAMERA = {
  position: [0, 0, 0] as Vector,
  orientation: IDENTITY,
  fovh: 30,
  near: 1,
  far: 10000,
}

/** One event, shaped as retail writes them: `{ time, action, targets, props }`. */
const event = (at: number, action: string, targets: string[], props: Record<string, unknown>) =>
  value.list(
    time(at),
    value.identifier(action),
    value.list(...targets),
    value.table(props as never),
  )

/** A path, its keys `{x,y,z}, {w,x,y,z}` as `path_data` writes them. */
const pathData = (keys: { at: Vector; q: readonly [number, number, number, number] }[]) =>
  `OPEN ${keys.map(({ at, q }) => `{${at.join(',')}}, {${q.join(',')}}, `).join('')}`

const motionPath = (name: string, at: Vector, yaw: number, keys: Parameters<typeof pathData>[0]) =>
  value.table({
    entity_name: name,
    type: value.identifier('MOTION_PATH'),
    template_name: '',
    lt_grp: 0,
    srt_grp: 0,
    usr_flg: 0,
    spatialprops: value.table({
      pos: vector(at),
      orient: value.list(...rotation(yaw, 0).map(vector)),
    }),
    pathprops: value.table({
      path_type: 'CV_CROrientationSplinePath',
      path_data: pathData(keys),
    }),
  })

const SMOOTH = value.table({
  CLSID: 'FreeFormPCurve',
  points: value.list(
    value.list(0, 0, 0, 0),
    value.list(0.4, 0.7, 1.5, 1.5),
    value.list(1, 1, 0, 0),
  ),
})

/** A light, in the model's light group, shaped as retail's (every one carries all eleven keys). */
const light = (
  name: string,
  at: Vector,
  yaw: number,
  pitch: number,
  props: {
    type: 'L_POINT' | 'L_SPOT'
    diffuse: Vector
    ambient: Vector
    range: number
    cutoff: number
    theta: number
    atten: Vector
  },
) =>
  value.table({
    entity_name: name,
    type: value.identifier('LIGHT'),
    template_name: '',
    lt_grp: 1,
    srt_grp: 0,
    usr_flg: 0,
    spatialprops: value.table({
      pos: vector(at),
      orient: value.list(...rotation(yaw, pitch).map(vector)),
    }),
    lightprops: value.table({
      on: value.identifier('Y'),
      color: value.list(255, 255, 255),
      diffuse: vector(props.diffuse),
      specular: value.list(0, 0, 0),
      ambient: vector(props.ambient),
      direction: value.list(0, 0, -1),
      range: props.range,
      cutoff: props.cutoff,
      type: value.identifier(props.type),
      theta: props.theta,
      atten: vector(props.atten),
    }),
  })

export const thornScenes: ReferenceScene[] = [
  {
    // M8 placement and spatial animation: the ship moves and turns by `START_SPATIAL_PROP_ANIM`, a
    // `q_orient` chase then an `axisrot` spin, while the camera, standing still, follows it by a
    // `LOOK_AT` attach. Everything ends by 4 s; press F9 after 5.
    name: 'thorn_attach',
    model: SHIP,
    camera: { ...CAMERA, position: [12, 6, 0] },
    ...LIT,
    thorn: {
      entities: [],
      settle: 5,
      events: [
        event(0, 'START_SPATIAL_PROP_ANIM', ['Model_Reference'], {
          duration: 2,
          spatialprops: value.table({
            pos: vector([-8, 3, -55]),
            q_orient: value.list(0.8660254, 0.25, 0.4330127, 0),
          }),
        }),
        event(2.2, 'START_SPATIAL_PROP_ANIM', ['Model_Reference'], {
          duration: 1.5,
          param_curve: SMOOTH,
          spatialprops: value.table({ axisrot: value.list(137, value.identifier('NEG_X_AXIS')) }),
        }),
        event(0, 'ATTACH_ENTITY', ['Camera_Reference', 'Model_Reference'], {
          duration: 3600,
          flags: value.identifier('LOOK_AT', 'ENTITY_RELATIVE'),
          offset: vector([0, 2, 0]),
          up: value.identifier('Y_AXIS'),
          front: value.identifier('NEG_Z_AXIS'),
        }),
      ],
    },
  },
  {
    // M8 paths: the ship flies a turned path with `LOOK_AT` along its tangent, through a free-form
    // curve, stopping 0.37 of the way along; the camera looks on. Press F9 after 5 s.
    name: 'thorn_path',
    model: SHIP,
    camera: { ...CAMERA, position: [0, 10, 20], orientation: rotation(0, -20) },
    ...LIT,
    thorn: {
      settle: 5,
      entities: [
        motionPath('Path_Reference', [0, 0, -50], 30, [
          { at: [-20, 0, 0], q: [1, 0, 0, 0] },
          { at: [-5, 4, 6], q: [1, 0, 0, 0] },
          { at: [10, -2, 0], q: [1, 0, 0, 0] },
          { at: [20, 0, -15], q: [1, 0, 0, 0] },
        ]),
      ],
      events: [
        event(0, 'START_PATH_ANIMATION', ['Model_Reference', 'Path_Reference'], {
          duration: 4,
          start_percent: 0,
          stop_percent: 0.37,
          flags: value.identifier('POSITION', 'ORIENTATION', 'LOOK_AT'),
          offset: vector([0, 1, 0]),
          up: value.identifier('Y_AXIS'),
          front: value.identifier('NEG_Z_AXIS'),
          param_curve: SMOOTH,
        }),
      ],
    },
  },
  {
    // M8 lights and fog: a point light with its own ambient, which D3D adds whichever way a face
    // turns, and a spot on the ship, both in its light group; the point's diffuse animates from
    // blue to orange, and linear fog comes on. No directional light. Press F9 after 5 s.
    name: 'thorn_lights',
    model: SHIP,
    camera: CAMERA,
    ambient: [20, 20, 20],
    lights: [],
    thorn: {
      settle: 5,
      entities: [
        light('Light_Point', [10, 8, -30], 0, 0, {
          type: 'L_POINT',
          diffuse: [0.2, 0.3, 1],
          ambient: [0.15, 0.05, 0.05],
          range: 60,
          cutoff: 180,
          theta: 180,
          atten: [1, 0.02, 0],
        }),
        light('Light_Spot', [-15, 10, -20], -60, -25, {
          type: 'L_SPOT',
          diffuse: [1, 1, 0.8],
          ambient: [0, 0, 0],
          range: 100,
          cutoff: 30,
          theta: 15,
          atten: [1, 0, 0],
        }),
      ],
      events: [
        event(1, 'START_LIGHT_PROP_ANIM', ['Light_Point'], {
          duration: 2,
          lightprops: value.table({ diffuse: vector([1, 0.5, 0.1]) }),
        }),
        event(0, 'START_FOG_PROP_ANIM', ['Scene_Reference'], {
          duration: 0,
          fogprops: value.table({
            fogon: value.identifier('Y'),
            fogmode: value.identifier('F_LINEAR'),
            fogcolor: value.list(40, 60, 90),
            fogstart: 20,
            fogend: 120,
            fogtable: value.identifier('N'),
          }),
        }),
      ],
    },
  },
  {
    // M8 `BackdropMaterial`: a base's `skydome_*` at `usr_flg` 2 and `srt_grp` -100, as the planetscapes
    // carry theirs, behind the ship. Nothing moves; press F9 any time.
    name: 'backdrop_skydome',
    sky: [
      {
        archetype: 'skydome_clouds_fluffy',
        category: 'Prop',
        file: 'skydome_clouds_fluffy.3db',
        folder: 'BASES/GENERIC',
        backdrop: true,
      },
    ],
    model: SHIP,
    camera: { ...CAMERA, orientation: rotation(0, 15) },
    ...LIT,
  },
  {
    // M8 the view: the camera rides a path by its keys' orientations, 0.6 of the way, while
    // `START_CAMERA_PROP_ANIM` widens it from 30 to 38; the monitor follows the cut camera. The ship
    // stands still as something to draw. Press F9 after 5 s.
    name: 'thorn_camera_path',
    model: SHIP,
    camera: CAMERA,
    ...LIT,
    thorn: {
      settle: 5,
      entities: [
        motionPath('Path_Reference', [0, 0, 0], 0, [
          { at: [0, 0, 10], q: [1, 0, 0, 0] },
          { at: [15, 5, 0], q: [0.9238795, 0, 0.3826834, 0] },
          { at: [20, 10, -30], q: [0.7071068, -0.1, 0.7071068, 0] },
        ]),
      ],
      events: [
        event(0, 'START_PATH_ANIMATION', ['Camera_Reference', 'Path_Reference'], {
          duration: 4,
          start_percent: 0,
          stop_percent: 0.6,
          flags: value.identifier('POSITION', 'ORIENTATION'),
        }),
        event(0.5, 'START_CAMERA_PROP_ANIM', ['Camera_Reference'], {
          duration: 3,
          cameraprops: value.table({ fovh: 38 }),
        }),
      ],
    },
  },
]

// A frame's x, y, z axes as three `Rows`, its translation dropped.
const rowsOf = ({ x, y, z }: Frame) =>
  [
    [x.x, x.y, x.z],
    [y.x, y.y, y.z],
    [z.x, z.y, z.z],
  ] as const

const at = ({ w }: Frame): Vector => [w.x, w.y, w.z]

/**
 * The scene as it stands once its motion has ended: the generated script played to `settle` as the
 * game starts it, the model and camera moved to where playback leaves them.
 */
export const settled = (scene: ReferenceScene): ReferenceScene => {
  if (!scene.thorn) return scene

  const script = thnScene.read(read(sceneScript(scene)))
  const playback = replay(script, milliseconds(scene.thorn.settle))
  const model = playback.world('Model_Reference')
  const view = playback.view('Monitor_Reference')!

  return {
    ...scene,
    ...(scene.model &&
      model && { model: { ...scene.model, position: at(model), orientation: rowsOf(model) } }),
    camera: {
      ...scene.camera,
      position: at(view.world),
      orientation: rowsOf(view.world),
      fovh: view.fovh,
      near: view.near,
      far: view.far,
    },
  }
}

const REED_PARTS = [
  'CHARACTERS/BODIES/li_rockford_body.dfm',
  'CHARACTERS/HEADS/li_captain_head.dfm',
  'CHARACTERS/HANDS/benchmarkmalehandleft.dfm',
  'CHARACTERS/HANDS/benchmarkmalehandright.dfm',
]

/** The scenes for what the mixer and the effect host decide, which need assets to settle. */
export const playedScenes: ReferenceScene[] = [
  {
    // M8 characters: a one-shot gesture, a second fading in over it at 1 s for half a second without
    // keep-beneath, so the first is dropped; the floor raised 0.3 over the first second. Both end by
    // 4 s and hold. Press F9 after 5 s.
    name: 'thorn_character',
    character: {
      costume: 'reed',
      parts: REED_PARTS,
      animations: 'CHARACTERS/ANIMATIONS/bodygenericmale.anm',
      script: 'Sc_MLBODY_CHRB_GESTL_WHAT_000LV_XA_03',
      duration: 1.77,
      position: [0, 0, 0],
      orientation: rotation(150, 0),
    },
    camera: { position: [0, 0.6, 4], orientation: IDENTITY, fovh: 25, near: 0.1, far: 100 },
    ambient: [40, 40, 40],
    lights: [{ color: [255, 255, 255], direction: [0.5, -0.5, -1] }],
    thorn: {
      settle: 5,
      entities: [],
      events: [
        event(1, 'START_MOTION', ['Char_Reference'], {
          animation: 'Sc_MLBODY_CHRB_GESTR_STOP_000LV_XA_03',
          duration: 3,
          time_scale: 1,
          weight: 1,
          heading: -1,
          trans_time: 0.5,
        }),
        event(0, 'START_FLR_HEIGHT_ANIM', ['Char_Reference'], { duration: 1, floor_height: 0.3 }),
      ],
    },
  },
  {
    // M8 effects: the generated sprites hung on a marker that crosses the view in 2 s, `sparam`
    // animated to 1 meanwhile. Press F9 at 5 s, as `effect_sprites`' particles want.
    name: 'thorn_psys',
    effect: { kind: 'sprites', seconds: 5 },
    camera: { position: [0, 0, 60], orientation: IDENTITY, fovh: 30, near: 1, far: 10000 },
    ambient: [0, 0, 0],
    lights: [],
    thorn: {
      settle: 5,
      entities: [
        value.table({
          entity_name: 'Mover',
          type: value.identifier('MARKER'),
          template_name: '',
          lt_grp: 0,
          srt_grp: 0,
          usr_flg: 0,
          spatialprops: value.table({
            pos: vector([-10, 0, 0]),
            orient: value.list(...IDENTITY.map(vector)),
          }),
        }),
      ],
      events: [
        event(0, 'START_SPATIAL_PROP_ANIM', ['Mover'], {
          duration: 2,
          spatialprops: value.table({ pos: vector([10, 0, 0]) }),
        }),
        event(0, 'ATTACH_ENTITY', ['Psys_Reference', 'Mover'], {
          duration: 3600,
          flags: value.identifier('POSITION', 'ORIENTATION'),
        }),
        event(1, 'START_PSYS_PROP_ANIM', ['Psys_Reference'], {
          duration: 2,
          psysprops: value.table({ sparam: 1 }),
        }),
      ],
    },
  },
]

// Every jointed descendant as { name, parent, joint }, depth first.
const jointsOf = <T>(node: CompoundNode<T>): MixerJoint[] =>
  node.children.flatMap((child) => [
    ...(child.joint ? [{ name: child.name, parent: node.name, joint: child.joint }] : []),
    ...jointsOf(child),
  ])

/** Plays a scene's generated script as the game would, frame by frame at 60 a second, to `seconds`. */
const playFrames = (scene: ReferenceScene, seconds: number, options: PlaybackOptions) => {
  const script = thnScene.read(read(sceneScript(scene)))
  const run = new ScriptRun(new Playback(script, options))
  let carry = 0

  // Fixed 1/60 s frames: `frameMilliseconds` floors each to whole ms and carries the remainder on.
  for (let frame = 0; frame < seconds * 60; frame++) {
    const next = frameMilliseconds(carry, 1 / 60)

    carry = next.carry
    run.update(next.milliseconds)
  }

  return run.playback
}

/**
 * What a THN scene's playback decides for the loader: the character posed by the mixer under the
 * script's motions and floor, and the effect stepped, placed and given `sparam` by `Thorn_Psys`.
 */
export const playedOf = async (scene: ReferenceScene, readAsset: ReadAsset): Promise<Played> => {
  if (!scene.thorn) return {}

  const settle = scene.thorn.settle

  if (scene.character) {
    const library = readAnimationLibrary(
      Directory.read(await readAsset(scene.character.animations)),
    )

    return {
      pose: (models) => {
        const root = getBoneModel(models[0]!)!

        const joints = models.flatMap((model) => {
          const bones = getBoneModel(model)

          return bones ? jointsOf(bones) : []
        })

        const [x, y, z] = scene.character!.position
        const turned = placement(undefined, toRows(scene.character!.orientation))
        const mixer = new Mixer({
          root: root.name,
          // Each joint name once, the first part's winning.
          joints: joints.filter(
            (each, at) => joints.findIndex(({ name }) => name === each.name) === at,
          ),
          position: { x, y, z },
          orientation: quaternionOf(turned),
        })
        const characters = mixerCharacters({
          mixer: (entity) => (entity === 'Char_Reference' ? mixer : undefined),
          animation: (name) =>
            library.find((each) => each.name.toLowerCase() === name.toLowerCase()),
        })
        const playback = playFrames(scene, settle, { characters })

        return {
          root: playback.world('Char_Reference')!,
          jointState: (name) => mixer.jointState(name),
        }
      },
    }
  }

  if (scene.effect)
    return {
      effect: (instance) => {
        playFrames(scene, scene.effect!.seconds, { createEffect: () => instance })
      },
    }

  return {}
}
