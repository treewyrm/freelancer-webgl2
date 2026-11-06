/** Loads a reference scene's assets into a renderer scene, from whatever reads bytes. */
import {
  getMapDuration,
  getScript,
  readAnimationLibrary,
  sampleChannel,
  sampleObjectMap,
} from '@treewyrm/freelancer/animation'
import type { JointState } from '@treewyrm/freelancer/compound'
import { readDeformableModel } from '@treewyrm/freelancer/deformable'
import { getMaterial, readMaterialLibrary } from '@treewyrm/freelancer/material'
import { Matrix3, Matrix4, Quat } from '@treewyrm/freelancer/math'
import {
  readMaterialAnimLibrary,
  readRigidModel,
  type RigidModel,
} from '@treewyrm/freelancer/rigid'
import { readTextureLibrary, type TextureEntry } from '@treewyrm/freelancer/texture'
import { Directory } from '@treewyrm/freelancer/utf'
import { getMesh, readVMeshLibrary } from '@treewyrm/freelancer/vmesh'
import { placeParts, type Scene, type SceneModel } from '#/scene/frame.js'
import { placeSphere } from '#/scene/sphere.js'
import { instanceExtent } from '#/scene/extent.js'
import { placeCostume } from '#/deformable/skin.js'
import type { Camera } from '#/scene/camera.js'
import { getResourceId } from '@treewyrm/freelancer'
import { getNodeName, type Node } from '@treewyrm/freelancer/alchemy'
import { EffectInstance } from '#/alchemy/effect.js'
import { buildEffect, lookupOver } from '#/alchemy/tree.js'
import { viewMatrix } from '#/scene/camera.js'
import { BAND_LIBRARIES } from './bands.js'
import { EFFECT_TEXTURES, GENERATED_EFFECTS } from './effects.js'
import { generateBands } from './generate.js'
import { cameraOf, modelMatrixOf, orientationMatrix, type ReferenceScene } from './scene.js'

export type ReadAsset = (path: string) => Promise<Uint8Array>

export interface LoadedScene {
  scene: Scene
}

/** Assets of the one archetype so far. `envmap_material` is its `shiparch.ini` value. */
/** Assets as the archetype's section writes them, `lod` being its `LODranges`. */
const ASSETS: Record<
  string,
  { model: string; libraries: readonly string[]; environment?: string; lod: number[] }
> = {
  li_elite: {
    lod: [0, 75, 150, 1300],
    model: 'SHIPS/LIBERTY/LI_ELITE/li_elite.cmp',
    libraries: ['SHIPS/LIBERTY/li_playerships.mat', 'FX/envmapbasic.mat', 'FX/envmapglass.txm'],
    environment: 'envmapbasic',
  },
  lair: {
    lod: [0, 50000],
    model: 'SOLAR/DOCKABLE/nomad_lair.cmp',
    libraries: ['SOLAR/nomad_lair.mat'],
  },
  lair_core: {
    lod: [0, 20000],
    model: 'SOLAR/DOCKABLE/nomad_lair_core.cmp',
    libraries: ['SOLAR/nomad.mat'],
  },
  prison: {
    lod: [0, 1000, 2500, 6000, 20000],
    model: 'SOLAR/DOCKABLE/prison_lod.cmp',
    libraries: ['SOLAR/Solar_mat_dockable01.mat', 'FX/envmapbasic.mat', 'FX/envmapglass.txm'],
    environment: 'envmapbasic',
  },
  // The archetype also lists `nomad_fx.txm`, after the `.mat`, and retail bound no ramp in the capture.
  reference_bands: {
    lod: [0, 2000],
    model: '',
    libraries: BAND_LIBRARIES,
    environment: 'envmapbasic',
  },
  // Lines as `solararch.ini` writes them, textures first.
  planet_earth_3000: {
    lod: [],
    model: 'SOLAR/PLANETS/PLANET_EARTH/planet_earth_3000.sph',
    libraries: [
      'SOLAR/PLANETS/planet_earth.txm',
      'SOLAR/PLANETS/DETAILMAPS/detailmap_rock01.txm',
      'SOLAR/PLANETS/DETAILMAPS/detailmap_ocean.txm',
      'SOLAR/PLANETS/atmosphere.txm',
      'SOLAR/PLANETS/PLANET_EARTH/planet_earth.mat',
    ],
  },
  dyson_door_shield: {
    lod: [0, 50000],
    model: 'SOLAR/MISC/dyson_door_shield.3db',
    libraries: ['SOLAR/Solar_mat_dyson.mat'],
  },
  no_fighter: {
    lod: [0, 80, 120, 1000],
    model: 'SHIPS/NOMAD/NO_FIGHTER/no_fighter.3db',
    libraries: ['SHIPS/NOMAD/nomad_fx.txm'],
  },
  ku_dragon: {
    lod: [0, 40, 80, 180, 1000],
    model: 'SHIPS/KUSARI/KU_BLOOD_DRAGON/ku_dragon.cmp',
    libraries: ['SHIPS/KUSARI/ku_blood_dragon.mat', 'FX/envmapbasic.mat', 'FX/envmapglass.txm'],
    environment: 'envmapbasic',
  },
}

const scaled = ([x, y, z]: readonly [number, number, number]) => ({
  x: x / 255,
  y: y / 255,
  z: z / 255,
})

const EYE_BONE = 'Eye IK Left'

/**
 * A character where its script ends. A joint map's last sample is its joint's state (`DEFORMABLE.md`),
 * and the root stands at the script's height over its own place and yaw, carried by its object map.
 */
const loadCharacter = async (
  {
    parts,
    animations,
    script,
    position,
    orientation,
    gaze,
    tables,
  }: NonNullable<ReferenceScene['character']>,
  camera: Camera,
  read: ReadAsset,
): Promise<SceneModel[]> => {
  const roots = await Promise.all(parts.map(async (path) => Directory.read(await read(path))))
  const library = readAnimationLibrary(Directory.read(await read(animations)))
  const found = getScript(library, script)
  if (!found) throw new Error(`No script ${script}`)

  const states = new Map<string, JointState>()
  let motion: Matrix4 = Matrix4.identity
  for (const map of found.maps) {
    const end = getMapDuration(map)
    if (map.type === 'joint') states.set(map.child.toLowerCase(), sampleChannel(map.channel, end))
    else {
      const sample = sampleObjectMap(map, end)
      motion = Matrix4.fromRotationTranslation(
        Matrix3.fromQuaternion(sample.orientation),
        sample.position,
      )
    }
  }
  const start = Matrix4.multiply(
    Matrix4.translation({ x: position[0], y: found.height ?? 0, z: position[2] }),
    orientationMatrix(orientation),
  )
  const models = roots.map(readDeformableModel)
  const place = () =>
    placeCostume(models, Matrix4.multiply(start, motion), {
      jointState: ({ name }) => states.get(name.toLowerCase()),
      ...(tables ? { lod: { camera, tables } } : {}),
    })
  // `START_IK`'s solver is M8's. This turns the eye bone to the marker in its head's frame, which is
  // near enough where retail saturates at the bone's limits, as `character_eyes` does. The bone's Z
  // points out of the back of the head at rest, so -Z is what aims: measured, against `character_eyes`.
  if (gaze) {
    const head = place()[1]!.world
    const target = Matrix4.transformPoint(
      { x: gaze[0], y: gaze[1], z: gaze[2] },
      Matrix4.invert(head),
    )
    const { joint } = models[1]!.constraints.find(({ child }) => child === EYE_BONE)!
    const eye = joint.position!
    const away = { x: eye.x - target.x, y: eye.y - target.y, z: eye.z - target.z }
    const length = Math.hypot(away.x, away.y, away.z)
    const { z: rest } = Matrix4.fromRotationTranslation(joint.orientation!, { x: 0, y: 0, z: 0 })
    states.set(EYE_BONE.toLowerCase(), {
      orientation: Quat.fromTo(rest, {
        x: away.x / length,
        y: away.y / length,
        z: away.z / length,
      }),
    })
  }
  const placed = place()
  return placed.map((part, at) => {
    const materials = [...readMaterialLibrary(roots[at]!)]
    const textures = [...readTextureLibrary(roots[at]!)]
    return {
      parts: [part],
      mesh: () => undefined,
      material: (id: number) => getMaterial(materials, id),
      texture: (name: string) =>
        textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase()),
    }
  })
}

const SKY_FOLDER = 'SOLAR/STARSPHERE'

/**
 * A sky file as a model of its own: the libraries are inside it. A space sky stands at its extent's
 * centre (`StarSphereLoadLayer`); a menu prop at the origin.
 */
export const loadSky = async (
  file: string,
  read: ReadAsset,
  { space = false }: { space?: boolean } = {},
): Promise<SceneModel> => {
  const root = Directory.read(await read(`${SKY_FOLDER}/${file}`))
  const meshes = readVMeshLibrary(root)
  const materials = [...readMaterialLibrary(root)]
  const textures = [...readTextureLibrary(root)]
  const model = readRigidModel(root)
  return {
    sky: 'starsphere',
    parts: placeParts(
      model,
      space ? Matrix4.translation(instanceExtent(model).center) : Matrix4.identity,
    ),
    mesh: (id) => getMesh(meshes, id),
    material: (id) => getMaterial(materials, id),
    texture: (name) => textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase()),
  }
}

export const loadScene = async (
  definition: ReferenceScene,
  read: ReadAsset,
): Promise<LoadedScene> => {
  const skies = await Promise.all((definition.sky ?? []).map(({ file }) => loadSky(file, read)))
  const shared = {
    camera: cameraOf(definition),
    aspect: 1024 / 768,
    ambient: scaled(definition.ambient),
    lights: definition.lights.map(({ color, direction: [x, y, z] }) => ({
      color: scaled(color),
      direction: { x, y, z },
    })),
  }
  if (definition.character)
    return {
      scene: {
        ...shared,
        models: await loadCharacter(definition.character, cameraOf(definition), read),
      },
    }
  if (definition.effect) {
    const { kind, seconds } = definition.effect
    const alchemy = GENERATED_EFFECTS[kind]()
    const nodes = new Map<number, Node>()
    for (const node of alchemy.nodes.nodes)
      nodes.set(getResourceId(getNodeName(node) ?? '', true), node)
    const resolve = (crc: number) => nodes.get(crc)
    const [effect] = alchemy.effects.effects
    const instance = new EffectInstance(buildEffect(effect!, resolve), {
      lookup: lookupOver(alchemy.effects.effects, resolve),
    })
    const view = viewMatrix(shared.camera)
    // As `Thorn_Psys` steps it: each tick, then the tick's pass at 0 ms (`0x453ff0`).
    for (let step = 0; step < seconds * 60; step++) {
      instance.advance(1 / 60, { view })
      instance.advance(0, { view })
    }
    const library = Directory.read(await read(EFFECT_TEXTURES.replaceAll('\\', '/')))
    const textures = [...readTextureLibrary(library)]
    const texture = (name: string) =>
      textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
    return { scene: { ...shared, models: skies, effects: [{ instance, texture }] } }
  }
  const placedModel = definition.model
  if (!placedModel) return { scene: { ...shared, models: skies } }

  const assets = ASSETS[placedModel.archetype]
  if (!assets) throw new Error(`No assets listed for ${placedModel.archetype}`)

  const root = definition.generated
    ? Directory.read(generateBands(definition.generated).model)
    : Directory.read(await read(assets.model))
  const libraries = await Promise.all(
    assets.libraries.map(async (path) => Directory.read(await read(path))),
  )
  const meshes = readVMeshLibrary(root)
  const materials = [
    ...(definition.generated?.materials ?? []),
    ...[root, ...libraries].flatMap((library) => [...readMaterialLibrary(library)]),
  ]
  const textures = [root, ...libraries].flatMap((library) => [...readTextureLibrary(library)])
  const texture = (name: string) =>
    textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase())

  const materialAnimations = [
    ...(definition.generated?.animations ?? []),
    ...[root, ...libraries].flatMap((library) => [...readMaterialAnimLibrary(library)]),
  ]

  const model: RigidModel = readRigidModel(root)
  return {
    scene: {
      ...shared,
      models: [
        ...skies,
        ...[placedModel, ...(placedModel.copies ?? [])].map((placed) => ({
          parts:
            model.type === 'sphere'
              ? placeSphere(
                  model,
                  modelMatrixOf({ ...definition, model: { ...placedModel, ...placed } }),
                  {
                    camera: cameraOf(definition),
                    width: 1024,
                    material: (id: number) => getMaterial(materials, id),
                  },
                )
              : placeParts(
                  model,
                  modelMatrixOf({ ...definition, model: { ...placedModel, ...placed } }),
                  { camera: cameraOf(definition), lod: [{ ranges: assets.lod }] },
                ),
          mesh: (id: number) => getMesh(meshes, id),
          material: (id: number) => getMaterial(materials, id),
          texture,
          materialAnimations,
          ...(assets.environment && !definition.generated?.noEnvironment
            ? { environment: assets.environment }
            : {}),
        })),
      ],
    },
  }
}
