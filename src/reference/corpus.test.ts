/** Every retail model plans a frame, and what it can't draw yet is a known list, by material type. */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { test } from 'node:test'
import { getResourceId } from '@treewyrm/freelancer'
import { readMaterialLibrary, type Material } from '@treewyrm/freelancer/material'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import { readRigidModel, type RigidModel } from '@treewyrm/freelancer/rigid'
import { readTextureLibrary, type TextureEntry } from '@treewyrm/freelancer/texture'
import { Directory } from '@treewyrm/freelancer/utf'
import { readVMeshLibrary, type VMeshData } from '@treewyrm/freelancer/vmesh'
import { mapMaterialType } from '#/material/map.js'
import { collectFrame, placeParts, type SceneModel } from '#/scene/frame.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const skip = existsSync(data) ? false : `no retail data at ${data}`

const LIBRARIES = ['.mat', '.txm', '.vms', '.cmp', '.3db', '.sph', '.dfm', '.utf']

const load = () => {
  const files: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (LIBRARIES.includes(extname(path).toLowerCase())) files.push(path)
    }
  }
  walk(data)
  const read = files.map((path) => [path, Directory.read(readFileSync(path))] as const)

  // One namespace, as the game's libraries are once loaded. A model's own meshes are looked at first.
  const materials = new Map<number, Material>()
  const textures = new Map<number, TextureEntry>()
  const meshes = new Map<number, VMeshData>()
  for (const [, directory] of read) {
    for (const material of readMaterialLibrary(directory))
      materials.set(getResourceId(material.name), material)
    for (const texture of readTextureLibrary(directory))
      textures.set(getResourceId(texture.name), texture)
    for (const mesh of readVMeshLibrary(directory)) meshes.set(getResourceId(mesh.name), mesh)
  }
  return { read, materials, textures, meshes }
}

test('every retail model plans a frame, and what is left is known', { skip }, () => {
  const { read, materials, textures, meshes } = load()
  const camera = {
    position: { x: 0, y: 0, z: 0 },
    orientation: Matrix3.identity,
    fovh: 30,
    near: 1,
    far: 10000,
  }

  let models = 0
  let draws = 0
  let failed = 0
  const undrawn = new Map<string, number>()
  const unregistered = new Set<string>()
  const missing = new Map<string, string[]>()
  const byName = new Map([...materials.values()].map((m) => [m.name, m]))

  for (const [path, directory] of read) {
    if (!['.cmp', '.3db'].includes(extname(path).toLowerCase())) continue
    let root: RigidModel
    try {
      root = readRigidModel(directory)
    } catch {
      failed++
      continue
    }
    models++
    const own = new Map(readVMeshLibrary(directory).map((m) => [getResourceId(m.name), m]))
    const seen = new Set<string>()
    // Every level, since the types can differ between them. The deepest any retail part has is under 8.
    for (let level = 0; level < 8; level++) {
      const model: SceneModel = {
        parts: placeParts(root, Matrix4.translation({ x: 0, y: 0, z: -40 }), { level }),
        mesh: (id) => own.get(id) ?? meshes.get(id),
        material: (id) => materials.get(id),
        texture: (name) => textures.get(getResourceId(name)),
      }
      const frame = collectFrame({
        camera,
        aspect: 4 / 3,
        ambient: { x: 0, y: 0, z: 0 },
        lights: [],
        models: [model],
      })
      if (level === 0) draws += frame.draws.length
      for (const name of frame.unregistered) unregistered.add(name)
      for (const entry of frame.unsupported) seen.add(entry)
    }
    for (const entry of seen) {
      const material = byName.get(entry)
      if (material) {
        const type = mapMaterialType(material)
        undrawn.set(type, (undrawn.get(type) ?? 0) + 1)
      } else {
        const kind = entry.replace(/ .*/, '')
        missing.set(kind, [...(missing.get(kind) ?? []), `${entry} in ${path.slice(data.length)}`])
      }
    }
  }

  assert.deepEqual([models, failed, draws], [1852, 0, 16976])

  // Registered by no DLL, so they draw nothing in retail either: the two the map can't rescue.
  assert.deepEqual([...unregistered].sort(), ['Helicopter.tga030123140205', 'lib_eq_08.tga'])

  // Materials per model, across its levels. Each is a class still to build, and M4 has `Nebula`.
  assert.deepEqual(Object.fromEntries(undrawn), {
    HUDIconMaterial: 195,
    Nebula: 188,
    HUDAnimMaterial: 24,
    ExclusionZoneMaterial: 20,
    PlanetWaterMaterial: 4,
  })

  // Animated textures, which M8 has, in four base models.
  assert.deepEqual(
    missing.get('texture')!.map((entry) => entry.split(' in ')[0]),
    [
      'texture boxes.avi',
      'texture Pylon.avi',
      'texture Pylon.avi010829125438',
      'texture boxes.avi021118171959',
    ],
  )

  // Materials no retail file defines, on 7 ids, in nomad turrets and ice asteroids. A null material
  // is skipped (`FVMeshPart::Draw`), so retail draws nothing for those groups either.
  assert.equal(missing.get('material')!.length, 15)
  assert.equal(new Set(missing.get('material')!.map((entry) => entry.split(' in ')[0])).size, 7)
})
