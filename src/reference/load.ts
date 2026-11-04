/** Loads a reference scene's assets into a renderer scene, from whatever reads bytes. */
import { getMaterial, readMaterialLibrary } from '@treewyrm/freelancer/material'
import { readRigidModel, type RigidModel } from '@treewyrm/freelancer/rigid'
import { readTextureLibrary, type TextureEntry } from '@treewyrm/freelancer/texture'
import { Directory } from '@treewyrm/freelancer/utf'
import { getMesh, readVMeshLibrary } from '@treewyrm/freelancer/vmesh'
import type { CompoundNode } from '@treewyrm/freelancer/compound'
import type { RigidPart } from '@treewyrm/freelancer/rigid'
import type { Scene } from '#/scene/frame.js'
import { cameraOf, modelMatrixOf, type ReferenceScene } from './scene.js'

export type ReadAsset = (path: string) => Promise<Uint8Array>

export interface LoadedScene {
  scene: Scene
  texture: (name: string) => TextureEntry | undefined
}

/** Assets of the one archetype so far. `envmap_material` is its `shiparch.ini` value. */
const ASSETS: Record<string, { model: string; libraries: string[]; environment: string }> = {
  li_elite: {
    model: 'SHIPS/LIBERTY/LI_ELITE/li_elite.cmp',
    libraries: ['SHIPS/LIBERTY/li_playerships.mat', 'FX/envmapbasic.mat', 'FX/envmapglass.txm'],
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
  const materials = libraries.flatMap((library) => [...readMaterialLibrary(library)])
  const textures = [root, ...libraries].flatMap((library) => [...readTextureLibrary(library)])
  const texture = (name: string) =>
    textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase())

  const model: RigidModel = readRigidModel(root)
  return {
    texture,
    scene: {
      camera: cameraOf(definition),
      aspect: 1024 / 768,
      ambient: scaled(definition.ambient),
      lights: definition.lights.map(({ color, direction: [x, y, z] }) => ({
        color: scaled(color),
        direction: { x, y, z },
      })),
      models: [
        {
          root: model as CompoundNode<RigidPart>,
          transform: modelMatrixOf(definition),
          mesh: (id) => getMesh(meshes, id),
          material: (id) => getMaterial(materials, id),
          texture,
          environment: assets.environment,
        },
      ],
    },
  }
}
