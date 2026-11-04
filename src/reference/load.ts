/** Loads a reference scene's assets into a renderer scene, from whatever reads bytes. */
import { getMaterial, readMaterialLibrary } from '@treewyrm/freelancer/material'
import { readRigidModel, type RigidModel } from '@treewyrm/freelancer/rigid'
import { readTextureLibrary, type TextureEntry } from '@treewyrm/freelancer/texture'
import { Directory } from '@treewyrm/freelancer/utf'
import { getMesh, readVMeshLibrary } from '@treewyrm/freelancer/vmesh'
import { placeParts, type Scene } from '#/scene/frame.js'
import { cameraOf, modelMatrixOf, type ReferenceScene } from './scene.js'

export type ReadAsset = (path: string) => Promise<Uint8Array>

export interface LoadedScene {
  scene: Scene
}

/** Assets of the one archetype so far. `envmap_material` is its `shiparch.ini` value. */
const ASSETS: Record<string, { model: string; libraries: string[]; environment?: string }> = {
  li_elite: {
    model: 'SHIPS/LIBERTY/LI_ELITE/li_elite.cmp',
    libraries: ['SHIPS/LIBERTY/li_playerships.mat', 'FX/envmapbasic.mat', 'FX/envmapglass.txm'],
    environment: 'envmapbasic',
  },
  lair_core: {
    model: 'SOLAR/DOCKABLE/nomad_lair_core.cmp',
    libraries: ['SOLAR/nomad.mat'],
  },
  prison: {
    model: 'SOLAR/DOCKABLE/prison_lod.cmp',
    libraries: ['SOLAR/Solar_mat_dockable01.mat', 'FX/envmapbasic.mat', 'FX/envmapglass.txm'],
    environment: 'envmapbasic',
  },
  // The archetype also lists `nomad_fx.txm`, after the `.mat`, and retail bound no ramp in the capture.
  dyson_door_shield: {
    model: 'SOLAR/MISC/dyson_door_shield.3db',
    libraries: ['SOLAR/Solar_mat_dyson.mat'],
  },
  no_fighter: {
    model: 'SHIPS/NOMAD/NO_FIGHTER/no_fighter.3db',
    libraries: ['SHIPS/NOMAD/nomad_fx.txm'],
  },
  ku_dragon: {
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

  const root = Directory.read(await read(assets.model))
  const libraries = await Promise.all(
    assets.libraries.map(async (path) => Directory.read(await read(path))),
  )
  const meshes = readVMeshLibrary(root)
  const materials = [root, ...libraries].flatMap((library) => [...readMaterialLibrary(library)])
  const textures = [root, ...libraries].flatMap((library) => [...readTextureLibrary(library)])
  const texture = (name: string) =>
    textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase())

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
        parts: placeParts(
          model,
          modelMatrixOf({ ...definition, model: { ...definition.model, ...placed } }),
        ),
        mesh: (id) => getMesh(meshes, id),
        material: (id) => getMaterial(materials, id),
        texture,
        ...(assets.environment ? { environment: assets.environment } : {}),
      })),
    },
  }
}
