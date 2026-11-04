/** A frame as data: what is drawn, in what order, in GL terms. Pure, no GL. */
import type { CompoundNode } from '@treewyrm/freelancer/compound'
import {
  getAddress,
  getMapIndex,
  TextureAddress,
  type Material,
  type TextureReference,
} from '@treewyrm/freelancer/material'
import type { Matrix4, Vector3 } from '@treewyrm/freelancer/math'
import type { RigidPart } from '@treewyrm/freelancer/rigid'
import type { TextureEntry } from '@treewyrm/freelancer/texture'
import { getMeshDraw, type VMeshData, type VMeshRef } from '@treewyrm/freelancer/vmesh'
import { DEFAULT_SAMPLER, type SamplerState, type TextureWrap } from '#/texture/texture.js'
import { projectionMatrix, viewMatrix, type Camera } from './camera.js'
import { partTransforms } from './hierarchy.js'

export interface SceneLight {
  color: Vector3
  /** World space, the way the light shines. */
  direction: Vector3
}

export interface SceneModel {
  root: CompoundNode<RigidPart>
  transform: Matrix4
  mesh: (id: number) => VMeshData | undefined
  material: (id: number) => Material | undefined
  texture: (name: string) => TextureEntry | undefined
  /** The archetype's `envmap_material`: the model does not say. Absent means no reflection. */
  environment?: string
}

export interface Scene {
  camera: Camera
  /** Width over height of the viewport. */
  aspect: number
  /** 0 to 1. */
  ambient: Vector3
  lights: SceneLight[]
  models: SceneModel[]
}

export interface DrawTexture {
  name: string
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

  cull: 'back' | 'front'
  negateNormals: boolean
  normalizeNormals: boolean
  blend: boolean
  /** Discards at or below this, of 255. */
  alphaReference: number
}

export interface Frame {
  view: Matrix4
  projection: Matrix4
  ambient: Vector3
  lights: SceneLight[]
  draws: Draw[]
  /** Materials not drawn, which M3 is to cover or which have no class in retail. */
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

const drawTexture = ({ name, flags }: TextureReference): DrawTexture => ({
  name,
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

const topLevelOf = (part: RigidPart): VMeshRef | undefined => {
  if (part.type !== 'rigid' || !part.part) return undefined
  // LOD selection comes with M3. The top level is what `li_elite` draws at its distance.
  return part.part.type === 'multilevel' ? part.part.levels[0]?.reference : part.part.reference
}

/** Lists a model's draws, parts depth first and each part's groups in order (`li_elite`). */
const collectModel = (model: SceneModel, draws: Draw[], unsupported: Set<string>): void => {
  for (const [{ part }, world] of partTransforms(model.root, model.transform)) {
    const reference = topLevelOf(part)
    if (!reference) continue
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
      for (const { alpha, ...pass } of passesOf(kind, material, model))
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
          ...(material.diffuseTexture ? { texture: drawTexture(material.diffuseTexture) } : {}),
          ...pass,
        })
    }
  }
}

export const collectFrame = ({ camera, aspect, ambient, lights, models }: Scene): Frame => {
  const draws: Draw[] = []
  const unsupported = new Set<string>()
  for (const model of models) collectModel(model, draws, unsupported)
  return {
    view: viewMatrix(camera),
    projection: projectionMatrix(camera, aspect),
    ambient,
    lights,
    draws,
    unsupported: [...unsupported],
  }
}
