/** A frame as data: what is drawn, in what order, in GL terms. Pure, no GL. */
import type { CompoundNode, JointState } from '@treewyrm/freelancer/compound'
import {
  getAddress,
  getMapIndex,
  TextureAddress,
  type Material,
  type TextureReference,
} from '@treewyrm/freelancer/material'
import type { Matrix4, Vector3 } from '@treewyrm/freelancer/math'
import type { RigidPart } from '@treewyrm/freelancer/rigid'
import type { CubeTexture, Texture, TextureEntry } from '@treewyrm/freelancer/texture'
import { getMeshDraw, type VMeshData, type VMeshRef } from '@treewyrm/freelancer/vmesh'
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
  texture?: DrawTexture
  /** A cube, reflected in camera space, as `2 × cube × colour`. */
  environment?: string
  environmentTexture?: CubeTexture

  cull: 'back' | 'front'
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
}

// `[MaterialMap]` in `dacom.ini`, for now only as far as telling these apart. M3 does it in full.
const HIGH_GLASS = /^(c|cv|b|k|l|r|bw|o)_glass$/i
const OTHER_NAME_RULE =
  /^(alpha_mask|detailmap_|tlr_(material|energy)$|nomad|n-texture|ui_|exclusion_|anim_hud|sea_anim|planet.*_glass$|null$)/i

type MaterialClass = 'single' | 'singleTwo' | 'glass'

const classOf = ({ name, type }: Material): MaterialClass | undefined => {
  if (HIGH_GLASS.test(name)) return 'glass'
  if (OTHER_NAME_RULE.test(name)) return undefined
  if (type === 'DcDt' || type === 'DcDtEc') return 'single'
  if (type === 'DcDtTwo' || type === 'DcDtEcTwo') return 'singleTwo'
  return undefined
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
): DrawTexture => ({
  name,
  entry,
  sampler: {
    ...DEFAULT_SAMPLER,
    wrapU: wrapOf(getAddress(flags, 'u')),
    wrapV: wrapOf(getAddress(flags, 'v')),
  },
  uvSet: getMapIndex(flags),
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
> & { alpha?: number }

const NO_ENVIRONMENT: Pick<Pass, 'normalizeNormals'> = { normalizeNormals: false }

// `BindEnvMap` also turns these on for the draw it adds a stage to.
const withEnvironment = (
  name: string | undefined,
): Pick<Pass, 'normalizeNormals' | 'environment'> =>
  name ? { normalizeNormals: true, environment: name } : NO_ENVIRONMENT

const passesOf = (kind: MaterialClass, material: Material, model: SceneModel): Pass[] => {
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

  const entry = material.diffuseTexture && model.texture(material.diffuseTexture.name)
  const bits = alphaBits(entry)
  const front: Pass = {
    cull: 'back',
    negateNormals: false,
    blend: opacity < 1 || bits > 1,
    alphaReference: bits === 1 ? CUT_ALPHA_REFERENCE : DEVICE_ALPHA_REFERENCE,
    ...withEnvironment(model.environment),
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
  root: CompoundNode<RigidPart>,
  transform: Matrix4,
  { level = 0, visible, jointState }: PlaceOptions = {},
): PlacedPart[] => {
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

/** Lists a model's draws, its parts in the order given and each part's groups in order. */
const collectModel = (model: SceneModel, draws: Draw[], unsupported: Set<string>): void => {
  for (const { reference, world } of model.parts) {
    const mesh = model.mesh(reference.meshId)
    if (!mesh) {
      unsupported.add(`mesh ${reference.meshId}`)
      continue
    }

    for (const { materialId, startIndex, elementCount } of getMeshDraw(mesh, reference)) {
      const material = model.material(materialId)
      const kind = material && classOf(material)
      if (!material || !kind) {
        unsupported.add(material?.name ?? `material ${materialId}`)
        continue
      }

      const { x, y, z } = material.diffuse ?? WHITE
      const slot = material.diffuseTexture
      const entry = slot && entryOf(slot.name, model, unsupported)

      for (const { alpha, ...pass } of passesOf(kind, material, model)) {
        const cube = pass.environment ? entryOf(pass.environment, model, unsupported) : undefined
        draws.push({
          mesh,
          reference,
          byteOffset: (startIndex - reference.indexStart) * Uint16Array.BYTES_PER_ELEMENT,
          count: elementCount,
          world,
          materialName: material.name,
          diffuse: [x, y, z, alpha ?? material.opacity ?? 1],
          ambient: material.ambient ?? { x, y, z },
          emissive: material.emission ?? BLACK,
          // A slot with no texture draws as an empty stage, which reads as white.
          ...(slot && entry ? { texture: drawTexture(slot, entry) } : {}),
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
  for (const model of models) collectModel(model, draws, unsupported)
  return {
    background: background ?? BLACK_BACKGROUND,
    hooks: hooksOf(draws),
    view: viewMatrix(camera),
    projection: projectionMatrix(camera, aspect),
    ambient,
    lights,
    draws,
    unsupported: [...unsupported],
  }
}
