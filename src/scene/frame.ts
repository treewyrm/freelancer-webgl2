/** A frame as data: what is drawn, in what order, in GL terms. Pure, no GL. */
import type { CompoundNode, JointState } from '@treewyrm/freelancer/compound'
import {
  getAddress,
  DEFAULT_NOMAD_TEXTURE_NAME,
  getMapIndex,
  TextureAddress,
  type Material,
  type TextureReference,
} from '@treewyrm/freelancer/material'
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { RigidModel, RigidPart } from '@treewyrm/freelancer/rigid'
import type { CubeTexture, Texture, TextureEntry } from '@treewyrm/freelancer/texture'
import {
  getMapCount,
  getMeshDraw,
  vertexByteLength,
  VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import { mapMaterialType, REGISTERED_TYPES } from '#/material/map.js'
import { DEFAULT_SAMPLER, type SamplerState, type TextureWrap } from '#/texture/texture.js'
import { projectionMatrix, viewMatrix, type Camera } from './camera.js'
import { partTransforms } from './hierarchy.js'

export interface SceneLight {
  color: Vector3
  /** World space, the way the light shines. */
  direction: Vector3
}

/** One piece of geometry where the host has posed it, at the detail level it chose. */
export interface PlacedPart {
  reference: VMeshRef
  world: Matrix4
}

export interface SceneModel {
  parts: PlacedPart[]
  mesh: (id: number) => VMeshData | undefined
  material: (id: number) => Material | undefined
  texture: (name: string) => TextureEntry | undefined
  /** The archetype's `envmap_material`: the model does not say. Absent means no reflection. */
  environment?: string
  /** 0 to 1, the engine's per-object fade a nomad surface reads. 1 when absent. */
  fade?: number
}

export interface PlaceOptions {
  /** Which detail level to take, clamped to what a part has. The top one when absent. */
  level?: number
  /** A part left out draws nothing, and its children still do. */
  visible?: (part: CompoundNode<RigidPart>) => boolean
  jointState?: (part: CompoundNode<RigidPart>) => JointState | undefined
}

export interface Scene {
  camera: Camera
  /** Width over height of the viewport. */
  aspect: number
  /** 0 to 1. */
  ambient: Vector3
  lights: SceneLight[]
  models: SceneModel[]
  /** 0 to 1. Black when absent, which is what the menu clears to. */
  background?: Vector3
}

export interface DrawTexture {
  name: string
  entry: Texture | CubeTexture
  sampler: SamplerState
  /** Which of the mesh's UV sets it samples. */
  uvSet: number
}

/** Texture stage 1, in the classes that use it. No texture reads as white. */
export interface DrawStage {
  operation: 'add' | 'modulate2x'
  texture?: DrawTexture
}

export interface Draw {
  mesh: VMeshData
  reference: VMeshRef
  /** Into the reference's planned index buffer. */
  byteOffset: number
  count: number
  world: Matrix4

  materialName: string
  diffuse: [number, number, number, number]
  ambient: Vector3
  emissive: Vector3
  /** The mesh has vertex colours, which take the place of `diffuse`. */
  colorVertex: boolean
  /** Unlit white at `diffuse`'s alpha, and stage 1 reads the nomad ramp. */
  nomad: boolean
  texture?: DrawTexture
  /** A cube, reflected in camera space, as `2 × cube × colour`. */
  environment?: string
  environmentTexture?: CubeTexture
  second?: DrawStage

  cull: 'back' | 'front' | 'none'
  depthWrite: boolean
  negateNormals: boolean
  normalizeNormals: boolean
  blend: boolean
  /** Discards at or below this, of 255. */
  alphaReference: number
}

/**
 * Where a host's own drawing goes. `begin` is after the clear, `opaque` before the first blended draw,
 * and `end` after everything. None of them changes the game's order.
 */
export type HookName = 'begin' | 'opaque' | 'end'

export interface FrameHook {
  name: HookName
  /** Index of the draw it goes in front of, so the length of `draws` is after the last. */
  before: number
}

export interface Frame {
  background: Vector3
  hooks: FrameHook[]
  view: Matrix4
  projection: Matrix4
  ambient: Vector3
  lights: SceneLight[]
  draws: Draw[]
  /** What didn't draw as authored: materials M3 is to cover, and any mesh or texture not found. */
  unsupported: string[]
  /** Materials of a type no DLL registers. They draw nothing in retail either. */
  unregistered: string[]
}

type MaterialClass =
  'single' | 'singleTwo' | 'glass' | 'emission' | 'detail' | 'detailTwo' | 'nomad'

// What M3 has built so far. Other registered types are reported, not drawn. The eight single-pass
// names share one bind and submit (`kMaterialTypes`, `src/Shading/Material.cpp`), and `Ec` and `OcOt`
// are properties: the latter only batches.
const CLASSES: Readonly<Record<string, MaterialClass>> = {
  DcDt: 'single',
  DcDtEc: 'single',
  DcDtOcOt: 'single',
  DcDtEcOcOt: 'single',
  DcDtTwo: 'singleTwo',
  DcDtEcTwo: 'singleTwo',
  DcDtOcOtTwo: 'singleTwo',
  DcDtEcOcOtTwo: 'singleTwo',
  DcDtEt: 'emission',
  BtDetailMapMaterial: 'detail',
  BtDetailMapTwoMaterial: 'detailTwo',
  // One class for the two names: the clock that sets them apart is read by nothing (`0x66f88bd`).
  NomadMaterial: 'nomad',
  NomadMaterialNoBendy: 'nomad',
  // One class for the three names (`flmaterials.dll`).
  HighGlassMaterial: 'glass',
  GlassMaterial: 'glass',
  GFGlassMaterial: 'glass',
}

const wrapOf = (address: TextureAddress): TextureWrap => {
  if (address === TextureAddress.Wrap) return 'repeat'
  if (address === TextureAddress.Mirror) return 'mirror'
  if (address === TextureAddress.Clamp) return 'clamp'
  throw new RangeError('WebGL2 has no border address mode, and retail uses none')
}

const drawTexture = (
  { name, flags }: TextureReference,
  entry: Texture | CubeTexture,
  mesh: VMeshData,
): DrawTexture => ({
  name,
  entry,
  sampler: {
    ...DEFAULT_SAMPLER,
    wrapU: wrapOf(getAddress(flags, 'u')),
    wrapV: wrapOf(getAddress(flags, 'v')),
  },
  // 52 retail draws name a set their mesh hasn't got. What D3D8 reads then is unmeasured: UV0 here is
  // what Librelancer and the extension do, and neither is evidence.
  uvSet: Math.min(getMapIndex(flags), Math.max(0, getMapCount(mesh.format) - 1)),
})

/** One alpha bit is cut, more is blended (`FMaterial` after `PixelFormatAlphaBits`). */
const alphaBits = (entry: TextureEntry | undefined): number => {
  if (!entry || entry.type === 'animated') return 0
  switch (entry.format) {
    case 'dxt1':
    case 'rgba16_5551':
      return 1
    case 'dxt3':
    case 'dxt5':
    case 'rgba32_8888':
      return 8
    default:
      return 0
  }
}

// `[RenderPipeline]`'s device-wide reference, and the one `FMaterial::SubmitAlphaTest` sets.
const DEVICE_ALPHA_REFERENCE = 0
const CUT_ALPHA_REFERENCE = 0x80

// `FMaterialImpl::BindGlass`.
const GLASS_LEAST_ALPHA = 0.8

const WHITE: Vector3 = { x: 1, y: 1, z: 1 }
const BLACK: Vector3 = { x: 0, y: 0, z: 0 }

type Pass = Pick<
  Draw,
  'cull' | 'negateNormals' | 'normalizeNormals' | 'blend' | 'alphaReference' | 'environment'
> & { alpha?: number; depthWrite?: boolean }

const NO_ENVIRONMENT: Pick<Pass, 'normalizeNormals'> = { normalizeNormals: false }

// `BindEnvMap` also turns these on for the draw it adds a stage to.
const withEnvironment = (
  name: string | undefined,
): Pick<Pass, 'normalizeNormals' | 'environment'> =>
  name ? { normalizeNormals: true, environment: name } : NO_ENVIRONMENT

/**
 * `[BatchedMaterials] Type = .*OcOt`. A batched material takes bin 1 if it blends and bin 0 if not
 * (`0x6eb4133`). Bin 1 waits for the flush, past the end of the environment override, so it has neither
 * its stage nor its normalized normals (`ku_dragon`). Bin 0 submits at once (`0x6ec9589`) and binds
 * again over the stage. No environment-mapped ship has that, so it stands as read, and uncaptured.
 */
const BATCHED = /.*OcOt/

// Truncated to the byte `SubmitNomadGeometry` writes, after the smoothstep of `NomadFadeFromValue`.
const nomadAlpha = (fade: number): number => {
  const delta = Math.min(Math.max(1 - fade, 0), 1)
  return Math.trunc((1 - (3 - 2 * delta) * delta * delta) * 255) / 255
}

const passesOf = (
  kind: MaterialClass,
  type: string,
  material: Material,
  model: SceneModel,
): Pass[] => {
  if (kind === 'nomad')
    return [
      {
        // `kNomadRs`, then `SubmitNomadGeometry`. Stage 1 is taken, so no reflection.
        cull: 'none',
        depthWrite: false,
        negateNormals: false,
        blend: true,
        alphaReference: DEVICE_ALPHA_REFERENCE,
        alpha: nomadAlpha(model.fade ?? 1),
        ...NO_ENVIRONMENT,
      },
    ]

  const opacity = material.opacity ?? 1

  if (kind === 'glass') {
    // `SubmitGlassGeometry`: inner faces opaque, then outer faces blended. Only those reflect.
    const alpha = Math.max(opacity, GLASS_LEAST_ALPHA)
    const shared = { negateNormals: false, alphaReference: DEVICE_ALPHA_REFERENCE, alpha }
    return [
      { ...shared, cull: 'front', blend: false, ...NO_ENVIRONMENT },
      {
        ...shared,
        cull: 'back',
        blend: true,
        ...withEnvironment(model.environment && 'envmapglass'),
      },
    ]
  }

  if (kind === 'emission' || kind === 'detail' || kind === 'detailTwo') {
    // Neither ever blends or cuts (`0x6ed16cc`, `0x6ed1484`). `BindEnvMap` needs stage 1 free: `DcDtEt`
    // without an `Et` leaves it so, and `BtDetailMapMaterial` always takes it (`0x6eb5100`).
    const free = kind === 'emission' && !material.emissionTexture
    const front: Pass = {
      cull: 'back',
      negateNormals: false,
      blend: false,
      alphaReference: DEVICE_ALPHA_REFERENCE,
      ...(free ? withEnvironment(model.environment) : NO_ENVIRONMENT),
    }
    // `DcDtEt` loads only `Dc`, `Dt` and `Et` (`0x6eb60b0`), so its opacity stays 1.
    if (kind === 'emission') front.alpha = 1
    return kind === 'detailTwo'
      ? [front, { ...front, cull: 'front', negateNormals: true }]
      : [front]
  }

  const entry = material.diffuseTexture && model.texture(material.diffuseTexture.name)
  const bits = alphaBits(entry)
  const blend = opacity < 1 || bits > 1
  const front: Pass = {
    cull: 'back',
    negateNormals: false,
    blend,
    // An `Oc` below 1 leaves before the format is read, so it isn't cut (`0x6eb6d63`).
    alphaReference: opacity >= 1 && bits === 1 ? CUT_ALPHA_REFERENCE : DEVICE_ALPHA_REFERENCE,
    ...(!BATCHED.test(type)
      ? withEnvironment(model.environment)
      : { normalizeNormals: !blend && model.environment !== undefined }),
  }
  if (kind === 'single') return [front]

  // `FMaterial::SubmitDcDtTwoSecondPass`: reversed, normals negated, outside the alpha test's scope.
  return [
    front,
    { ...front, cull: 'front', negateNormals: true, alphaReference: DEVICE_ALPHA_REFERENCE },
  ]
}

const referenceOf = (part: RigidPart, level: number): VMeshRef | undefined => {
  if (part.type !== 'rigid' || !part.part) return undefined
  if (part.part.type !== 'multilevel') return part.part.reference
  const { levels } = part.part
  return levels[Math.min(level, levels.length - 1)]?.reference
}

/**
 * A compound model's parts, depth first (`li_elite`), for a host that doesn't pose its own. The game's
 * own LOD selection comes with M3; the top level is what `li_elite` draws at its distance.
 */
export const placeParts = (
  root: RigidModel,
  transform: Matrix4,
  { level = 0, visible, jointState }: PlaceOptions = {},
): PlacedPart[] => {
  // A `.3db` is one part, with no hierarchy to walk.
  if (root.type !== 'compound') {
    const reference = referenceOf(root, level)
    return reference ? [{ reference, world: transform }] : []
  }
  const parts: PlacedPart[] = []
  for (const [node, world] of partTransforms(root, transform, jointState)) {
    if (visible && !visible(node)) continue
    const reference = referenceOf(node.part, level)
    if (reference) parts.push({ reference, world })
  }
  return parts
}

/** A slot's texture, reporting what the library doesn't hold or M3 has yet to animate. */
const entryOf = (
  name: string,
  model: SceneModel,
  unsupported: Set<string>,
): Texture | CubeTexture | undefined => {
  const entry = model.texture(name)
  if (entry && entry.type !== 'animated') return entry
  unsupported.add(`texture ${name}`)
  return undefined
}

// `nt_name`'s default (`FlmNomadParamsBase`), which wraps both ways.
const NOMAD_RAMP: TextureReference = { name: DEFAULT_NOMAD_TEXTURE_NAME, flags: 0x40 }

const secondStage = (
  kind: MaterialClass,
  { emissionTexture, detailTexture, nomadTexture }: Material,
  mesh: VMeshData,
  model: SceneModel,
  unsupported: Set<string>,
): DrawStage | undefined => {
  if (kind === 'nomad') {
    // No retail material names its own. Stage 1 reads the second set `NomadWriteVert` generates.
    const slot = nomadTexture ?? NOMAD_RAMP
    const entry = entryOf(slot.name, model, unsupported)
    if (!entry) return undefined
    return { operation: 'add', texture: { ...drawTexture(slot, entry, mesh), uvSet: 1 } }
  }
  // Without an `Et`, `DcDtEt` disables the stage. `BtDetailMapMaterial` applies it regardless, and so
  // doubles without a `Bt`: two retail materials, uncaptured.
  if (kind === 'emission' && !emissionTexture) return undefined
  if (kind !== 'emission' && kind !== 'detail' && kind !== 'detailTwo') return undefined
  const operation = kind === 'emission' ? 'add' : 'modulate2x'
  const slot = kind === 'emission' ? emissionTexture : detailTexture
  if (!slot) return { operation }
  const entry = entryOf(slot.name, model, unsupported)
  // Not in the host's libraries: retail always has them, and a white `add` would hide the model.
  if (!entry) return undefined
  return { operation, texture: drawTexture(slot, entry, mesh) }
}

interface Queued {
  depth: number
  draws: Draw[]
}

/**
 * `ComputeBatchDepth`: the mean of a reference's vertices along the view's Z. It is negative ahead of
 * the camera, so ascending is back to front, `Bin1SortOrder`'s default of 2 (`ku_dragon_pair`, whose
 * objects are 30 apart: the order is measured, but that the key is this mean is only read).
 */
const batchDepth = (
  mesh: VMeshData,
  reference: VMeshRef,
  world: Matrix4,
  view: Matrix4,
): number => {
  const { x, y, z, w } = Matrix4.multiply(view, world)
  const stride = vertexByteLength(mesh.format)
  const bytes = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset)
  let sum = 0
  for (let at = 0; at < reference.vertexCount; at++) {
    const offset = (reference.vertexStart + at) * stride
    const px = bytes.getFloat32(offset, true)
    const py = bytes.getFloat32(offset + 4, true)
    const pz = bytes.getFloat32(offset + 8, true)
    sum += x.z * px + y.z * py + z.z * pz + w.z
  }
  return sum / reference.vertexCount
}

/** Lists a model's draws, its parts in the order given and each part's groups in order. */
const collectModel = (
  model: SceneModel,
  view: Matrix4,
  draws: Draw[],
  queued: Queued[],
  unsupported: Set<string>,
  unregistered: Set<string>,
): void => {
  for (const { reference, world } of model.parts) {
    const mesh = model.mesh(reference.meshId)
    if (!mesh) {
      unsupported.add(`mesh ${reference.meshId}`)
      continue
    }

    for (const { materialId, startIndex, elementCount } of getMeshDraw(mesh, reference)) {
      const material = model.material(materialId)
      if (!material) {
        unsupported.add(`material ${materialId}`)
        continue
      }
      const type = mapMaterialType(material)
      // `SubmitNull` draws nothing, and an unregistered type has no fallback (`0x6ecc47e`).
      if (type === 'NullMaterial') continue
      if (!REGISTERED_TYPES.has(type)) {
        unregistered.add(material.name)
        continue
      }
      const kind = CLASSES[type]
      if (!kind) {
        unsupported.add(material.name)
        continue
      }

      const { x, y, z } = material.diffuse ?? WHITE
      const slot = material.diffuseTexture
      const entry = slot && entryOf(slot.name, model, unsupported)
      const second = secondStage(kind, material, mesh, model, unsupported)

      // A queued material's passes stay together, being one submission (`ProcessQueuedBin`).
      const passes = passesOf(kind, type, material, model)
      const target: Draw[] = []
      const queuedHere = BATCHED.test(type) && passes[0]!.blend
      if (queuedHere)
        queued.push({ depth: batchDepth(mesh, reference, world, view), draws: target })

      for (const { alpha, depthWrite, ...pass } of passes) {
        const cube = pass.environment ? entryOf(pass.environment, model, unsupported) : undefined
        ;(queuedHere ? target : draws).push({
          mesh,
          reference,
          byteOffset: (startIndex - reference.indexStart) * Uint16Array.BYTES_PER_ELEMENT,
          count: elementCount,
          world,
          materialName: material.name,
          // `Dc` is never read by the nomad class.
          diffuse: kind === 'nomad' ? [1, 1, 1, alpha!] : [x, y, z, alpha ?? material.opacity ?? 1],
          // Setting `Dc` overwrites `Ac` (`0x6eb2439`), and both start white. 37 retail materials differ.
          ambient: material.diffuse ?? material.ambient ?? WHITE,
          emissive: (kind !== 'emission' && material.emission) || BLACK,
          colorVertex: (mesh.format & VertexFormat.Diffuse) !== 0,
          nomad: kind === 'nomad',
          depthWrite: depthWrite ?? true,
          // A slot with no texture draws as an empty stage, which reads as white.
          ...(slot && entry ? { texture: drawTexture(slot, entry, mesh) } : {}),
          ...(second ? { second } : {}),
          ...pass,
          ...(cube?.type === 'cube' ? { environmentTexture: cube } : {}),
        })
      }
    }
  }
}

const BLACK_BACKGROUND: Vector3 = { x: 0, y: 0, z: 0 }

const hooksOf = (draws: Draw[]): FrameHook[] => {
  const firstBlended = draws.findIndex(({ blend }) => blend)
  return [
    { name: 'begin', before: 0 },
    { name: 'opaque', before: firstBlended === -1 ? draws.length : firstBlended },
    { name: 'end', before: draws.length },
  ]
}

export const collectFrame = ({
  camera,
  aspect,
  ambient,
  lights,
  models,
  background,
}: Scene): Frame => {
  const draws: Draw[] = []
  const unsupported = new Set<string>()
  const unregistered = new Set<string>()
  const view = viewMatrix(camera)
  const queued: Queued[] = []
  for (const model of models) collectModel(model, view, draws, queued, unsupported, unregistered)
  // A room flushes its queue once, after all its objects (`RoomBatcherEnd`, `ku_dragon_pair`). Space
  // does so per object, which M7 will need. Stable, where retail's qsort leaves equal keys in no set order.
  queued.sort((a, b) => a.depth - b.depth)
  for (const queue of queued) draws.push(...queue.draws)
  return {
    background: background ?? BLACK_BACKGROUND,
    hooks: hooksOf(draws),
    view,
    projection: projectionMatrix(camera, aspect),
    ambient,
    lights,
    draws,
    unsupported: [...unsupported],
    unregistered: [...unregistered],
  }
}
