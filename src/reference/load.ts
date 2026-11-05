/** Loads a reference scene's assets into a renderer scene, from whatever reads bytes. */
import { getMaterial, readMaterialLibrary } from '@treewyrm/freelancer/material'
import {
  readMaterialAnimLibrary,
  readRigidModel,
  type RigidModel,
} from '@treewyrm/freelancer/rigid'
import { readTextureLibrary, type TextureEntry } from '@treewyrm/freelancer/texture'
import { Directory } from '@treewyrm/freelancer/utf'
import { getMesh, readVMeshLibrary } from '@treewyrm/freelancer/vmesh'
import { placeParts, type Scene } from '#/scene/frame.js'
import { placeSphere } from '#/scene/sphere.js'
import { BAND_LIBRARIES } from './bands.js'
import { generateBands } from './generate.js'
import { cameraOf, modelMatrixOf, type ReferenceScene } from './scene.js'

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

export const loadScene = async (
  definition: ReferenceScene,
  read: ReadAsset,
): Promise<LoadedScene> => {
  const assets = ASSETS[definition.model.archetype]
  if (!assets) throw new Error(`No assets listed for ${definition.model.archetype}`)

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
      camera: cameraOf(definition),
      aspect: 1024 / 768,
      ambient: scaled(definition.ambient),
      lights: definition.lights.map(({ color, direction: [x, y, z] }) => ({
        color: scaled(color),
        direction: { x, y, z },
      })),
      models: [definition.model, ...(definition.model.copies ?? [])].map((placed) => ({
        parts:
          model.type === 'sphere'
            ? placeSphere(
                model,
                modelMatrixOf({ ...definition, model: { ...definition.model, ...placed } }),
                {
                  camera: cameraOf(definition),
                  width: 1024,
                  material: (id) => getMaterial(materials, id),
                },
              )
            : placeParts(
                model,
                modelMatrixOf({ ...definition, model: { ...definition.model, ...placed } }),
                { camera: cameraOf(definition), lod: [{ ranges: assets.lod }] },
              ),
        mesh: (id) => getMesh(meshes, id),
        material: (id) => getMaterial(materials, id),
        texture,
        materialAnimations,
        ...(assets.environment && !definition.generated?.noEnvironment
          ? { environment: assets.environment }
          : {}),
      })),
    },
  }
}
