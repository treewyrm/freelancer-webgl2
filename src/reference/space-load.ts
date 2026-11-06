/**
 * A reference system as a `SpaceScene`, from retail's archetype tables: what a host does with its
 * INI sections. Test-only.
 */
import { getMaterial, readMaterialLibrary } from '@treewyrm/freelancer/material'
import { Document, type Section } from '@treewyrm/freelancer/ini'
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import { readRigidModel, type RigidModel } from '@treewyrm/freelancer/rigid'
import { readTextureLibrary } from '@treewyrm/freelancer/texture'
import { readSurfaceLibrary } from '@treewyrm/freelancer/surface'
import { Directory } from '@treewyrm/freelancer/utf'
import { BufferView } from '@treewyrm/freelancer/utility'
import { getMesh, readVMeshLibrary } from '@treewyrm/freelancer/vmesh'
import type { CompoundNode } from '@treewyrm/freelancer/compound'
import type { RigidPart } from '@treewyrm/freelancer/rigid'
import type { Camera } from '#/scene/camera.js'
import { placeParts, type SceneModel } from '#/scene/frame.js'
import { partTransforms } from '#/scene/hierarchy.js'
import { lodRange, type LodList } from '#/scene/level.js'
import type { Graph, SpaceLight } from '#/scene/light.js'
import { placeSphere } from '#/scene/sphere.js'
import { skyLayers, type SpaceObject, type SpaceScene } from '#/scene/space.js'
import type { ReadAsset } from './load.js'
import { loadSky } from './load.js'
import type { ReferenceSystem } from './systems.js'

const pathOf = (value: string) => value.replaceAll('\\', '/')

const numbers = (section: Section, name: string): number[] =>
  (section.getValues(name) ?? []).map(({ value }) => Number(value))

const strings = (section: Section, name: string): string[] =>
  section.filterProperties(name).map(({ values }) => String(values[0]!.value))

const vector = ([x, y, z]: readonly number[]): Vector3 => ({ x: x!, y: y!, z: z! })

/** Every section of these files, by nickname, folded. */
const sectionsOf = async (read: ReadAsset, files: string[]): Promise<Map<string, Section>> => {
  const found = new Map<string, Section>()
  for (const file of files)
    for (const section of Document.read(await read(file))) {
      const nickname = section.getNickname()
      if (nickname && !found.has(nickname.toLowerCase())) found.set(nickname.toLowerCase(), section)
    }
  return found
}

interface Archetype {
  section: Section
  model: RigidModel
  lists: LodList[]
  /** Builds the model where the host puts it, its parts placed against `camera`. */
  place: (world: Matrix4) => SceneModel
}

const loadArchetype = async (
  section: Section,
  read: ReadAsset,
  camera: Camera,
  detail: number,
): Promise<Archetype> => {
  const root = Directory.read(await read(pathOf(strings(section, 'DA_archetype')[0]!)))
  const libraries = await Promise.all(
    strings(section, 'material_library').map(async (path) =>
      Directory.read(await read(pathOf(path))),
    ),
  )
  const meshes = readVMeshLibrary(root)
  const materials = [root, ...libraries].flatMap((library) => [...readMaterialLibrary(library)])
  const textures = [root, ...libraries].flatMap((library) => [...readTextureLibrary(library)])
  const model = readRigidModel(root)
  const ranges = numbers(section, 'LODranges')
  const minSpecLod = section.getValue('MinSpecLOD')
  // Its own list only: none of these archetypes has a `[LOD]` block.
  const lists: LodList[] = ranges.length
    ? [{ ranges, ...(minSpecLod ? { minSpecLod: Number(minSpecLod.value) } : {}) }]
    : []
  const environment = strings(section, 'envmap_material')[0]
  const material = (id: number) => getMaterial(materials, id)
  const place = (world: Matrix4): SceneModel => ({
    parts:
      model.type === 'sphere'
        ? placeSphere(model, world, { camera, width: 1024, material })
        : placeParts(model, world, { camera, lod: lists, detail }),
    mesh: (id) => getMesh(meshes, id),
    material,
    texture: (name) => textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase()),
    ...(environment ? { environment } : {}),
  })
  return { section, model, lists, place }
}

/** The parts `lodRange` walks: each with geometry, by name, a `.3db`'s as `Root`. */
const sources = (model: RigidModel) => {
  if (model.type === 'sphere') return []
  if (model.type !== 'compound')
    return model.type === 'rigid' && model.part ? [{ source: model.part, name: 'Root' }] : []
  const found: {
    source: NonNullable<Extract<RigidPart, { type: 'rigid' }>['part']>
    name: string
  }[] = []
  for (const node of partTransforms(model, Matrix4.identity).keys())
    if (node.part.type === 'rigid' && node.part.part)
      found.push({ source: node.part.part, name: node.name })
  return found
}

/** A hardpoint's frame in the model, wherever in the hierarchy it is. */
const hardpoint = (model: RigidModel, name: string): Matrix4 | undefined => {
  const nodes: [RigidPart, Matrix4][] =
    model.type === 'compound'
      ? [...partTransforms(model as CompoundNode<RigidPart>, Matrix4.identity)].map(
          ([node, world]) => [node.part, world],
        )
      : [[model, Matrix4.identity]]
  for (const [part, world] of nodes) {
    if (part.type !== 'rigid') continue
    const found = part.hardpoints.find((point) => point.name.toLowerCase() === name.toLowerCase())
    if (found)
      return Matrix4.multiply(
        world,
        Matrix4.fromRotationTranslation(found.orientation, found.position ?? { x: 0, y: 0, z: 0 }),
      )
  }
  return undefined
}

const SPHERE_TYPES = new Set(['PLANET', 'MOON'])

/**
 * What the game tests an object with, `get_physical_radius_r`: its body's `get_upper_limit_radius`
 * about its centre of mass (`PhySys::GetRadiusR`). Read as the `.sur` root part's radius and mass
 * centre, which is an inference: IVP's limit isn't traced to the file. Unturned, as every object here.
 */
const bodySphere = async (
  section: Section,
  at: Vector3,
  read: ReadAsset,
): Promise<{ center: Vector3; radius: number }> => {
  const path = pathOf(strings(section, 'DA_archetype')[0]!).replace(/\.[^.]+$/, '.sur')
  const [root] = readSurfaceLibrary(BufferView.from(await read(path)))
  const { massCenter: c, radius } = root!
  return { center: { x: at.x + c.x, y: at.y + c.y, z: at.z + c.z }, radius }
}

export interface SystemOptions {
  camera: Camera
  /** Where the game had moved the player's ship to, which the save only starts it at. */
  ship: Vector3
  /** `level_of_detail` from the run's `PerfOptions.ini`. */
  detail: number
  /** `star_sphere` from it. */
  starSphere: number
}

export const loadSystem = async (
  system: ReferenceSystem,
  read: ReadAsset,
  { camera, ship, detail, starSphere }: SystemOptions,
): Promise<SpaceScene> => {
  const archetypes = await sectionsOf(read, ['SOLAR/solararch.ini', 'SHIPS/shiparch.ini'])
  const graphs = await sectionsOf(read, ['igraph.ini'])
  const graph = (name: string): Graph => ({
    points: graphs
      .get(name.toLowerCase())!
      .filterProperties('point')
      .map(({ values }) => [Number(values[0]!.value), Number(values[1]!.value)] as const),
  })
  const archetype = (nickname: string) =>
    loadArchetype(archetypes.get(nickname.toLowerCase())!, read, camera, detail)

  const objects: SpaceObject[] = []
  for (const { archetype: nickname, position } of system.objects) {
    const { section, model, lists, place } = await archetype(nickname)
    const at = vector(position)
    const type = String(section.getValue('type')!.value).toUpperCase()
    const planet = SPHERE_TYPES.has(type)
    // A planet's is its instance's extent (`FClientSolarGameobj::Slot178`), the sphere's own.
    const sphere =
      planet && model.type === 'sphere'
        ? { center: at, radius: model.radius }
        : await bodySphere(section, at, read)
    const { radius } = sphere
    const range = lodRange(sources(model), lists, { detail })
    objects.push({
      model: place(Matrix4.translation(at)),
      position: at,
      sphere,
      solar: { large: radius > 200, planet },
      ...(range > 0 ? { lodRange: range } : {}),
    })
  }

  const hull = await archetype(system.player.ship)
  const world = Matrix4.translation(ship)
  const pilotName = strings(hull.section, 'pilot_mesh')[0]
  let pilot: SceneModel | undefined
  if (pilotName) {
    const simple = await archetype(pilotName)
    // `AttachPilotMesh`: `HpPilot`'s orientation, and its position less `HpConnect`'s, unturned.
    const seat = hardpoint(hull.model, 'HpPilot')!
    const connect = hardpoint(simple.model, 'HpConnect')?.w ?? { x: 0, y: 0, z: 0 }
    const offset = {
      ...seat,
      w: { x: seat.w.x - connect.x, y: seat.w.y - connect.y, z: seat.w.z - connect.z, w: 1 },
    }
    pilot = simple.place(Matrix4.multiply(world, offset))
  }
  const range = lodRange(sources(hull.model), hull.lists, { detail })
  const distanceRender = hull.section.getValue('distance_render')
  objects.push({
    model: hull.place(world),
    position: ship,
    sphere: await bodySphere(hull.section, ship, read),
    ...(pilot ? { pilot } : {}),
    ...(range > 0 ? { lodRange: range } : {}),
    ...(distanceRender ? { distanceRender: Number(distanceRender.value) } : {}),
  })

  const lights: SpaceLight[] = system.lights.map((light) => ({
    type: light.type === 'DIRECTIONAL' ? 'directional' : 'point',
    position: vector(light.position),
    color: vector(light.color),
    range: light.range,
    ...(light.attenuation ? { attenuation: vector(light.attenuation) } : {}),
    ...(light.curve ? { attenuationCurve: graph(light.curve) } : {}),
  }))

  const sky = await Promise.all(
    skyLayers(starSphere).map((layer) =>
      loadSky(pathOf(system.background[layer]).split('/').at(-1)!, read, { space: true }),
    ),
  )
  return {
    camera,
    aspect: 1024 / 768,
    ambient: vector(system.ambient),
    lights,
    objects,
    sky,
  }
}
