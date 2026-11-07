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
import {
  getMaterialAnim,
  type MaterialAnimLibrary,
  type RigidModel,
  type RigidPart,
} from '@treewyrm/freelancer/rigid'
import type { CubeTexture, Texture, TextureEntry } from '@treewyrm/freelancer/texture'
import {
  getMeshDraw,
  vertexByteLength,
  VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import { collectEffect, type EffectDraw } from '#/alchemy/draw.js'
import type { EffectInstance } from '#/alchemy/effect.js'
import type { EffectNode } from '#/alchemy/tree.js'
import { mapMaterialType, REGISTERED_TYPES, type MaterialMapRule } from '#/material/map.js'
import { DEFAULT_SAMPLER, type SamplerState, type TextureWrap } from '#/texture/texture.js'
import { projectionMatrix, sphereInFrustum, viewMatrix, type Camera } from './camera.js'
import { partTransforms } from './hierarchy.js'
import { sampleUvAnimation, type UvTransform } from './uv-animation.js'
import { largestAxis, levelAt, levelEnds, levelMetric, type LodList } from './level.js'
import type { ScreenQuad } from './flare.js'
import type { Fog } from './nebula.js'

export interface SceneLight {
  color: Vector3
  /** World space, the way the light shines. A point light's is unused. */
  direction: Vector3
  /** In world space, which makes it a point light: D3D8's, with no light past `range`. */
  position?: Vector3
  range?: number
  /** Constant, linear and quadratic, of the distance. */
  attenuation?: Vector3
  /** With a position, a spot along `direction`: D3D8's angles, inner and outer, in radians. */
  spot?: Spot
}

/** `D3DLIGHT8`'s `Theta`, `Phi` and `Falloff`: full angles in radians, no light outside `phi`. */
export interface Spot {
  theta: number
  phi: number
  falloff: number
}

/** What a skinned mesh adds: `skinMesh`'s influences and `boneTable`'s matrices, column-major. */
export interface DrawSkin {
  influences: Float32Array
  bones: Float32Array
}

/** One piece of geometry where the host has posed it, at the detail level it chose. */
export interface PlacedPart {
  reference: VMeshRef
  world: Matrix4
  /** A generated mesh, which no library holds: a sphere's patch. */
  mesh?: VMeshData
  /** Over each group's own, as a sphere's face names its material and its patch can't. */
  materialId?: number
  /** That material's name, as the file writes it, for a report: an id can't be read back. */
  materialName?: string
  skin?: DrawSkin
  /** Added to an `EyeMaterial` group's UVs, as its eye bone turns. */
  eyeOffset?: [number, number]
  /** What the engine tells a sphere's shell of its size. Anything else reads 1 (`Field20` unset). */
  extent?: number
}

export interface SceneModel {
  parts: PlacedPart[]
  mesh: (id: number) => VMeshData | undefined
  material: (id: number) => Material | undefined
  texture: (name: string) => TextureEntry | undefined
  /** The archetype's `envmap_material`: the model does not say. Absent means no reflection. */
  environment?: string
  /** 0 to 1, the engine's per-object value that nomad surfaces and `cloaked` read. 1 when absent. */
  fade?: number
  /** Drawn through `CloakMaterial`, which the host decides: the game spares nomad archetypes. */
  cloaked?: boolean
  /** UV animations, found by material name as the game does. */
  materialAnimations?: MaterialAnimLibrary
  /** `[MaterialMap]` from the host's own `dacom.ini`, in file order. Retail's when absent. */
  materialMap?: readonly MaterialMapRule[]
  /**
   * Drawn through `StarsphereMaterial`: at the camera, turned with the view alone, under white ambient
   * and no lights. Or `BackdropMaterial`, where the camera stands, on planes of its own. Both ignore
   * depth. The host orders models, so a sky goes first.
   */
  sky?: 'starsphere' | 'backdrop'
  /**
   * The instance's user data, which HUD icons and exclusion zones read: over `Ac` and `Oc`. The engine
   * sets it, so without it they use the material's own.
   */
  instance?: { ambient: Vector3; alpha: number }
}

export interface PlaceOptions {
  /** Choose each part's level as the game does, from this camera. Unless `level` pins one. */
  camera?: Camera
  /** The archetype's level-of-detail lists, in matching order, over the model's own `Switch2`. */
  lod?: readonly LodList[]
  /** The `level_of_detail` option, 0 to 1, which the lists answer to. 0.75 changes nothing. */
  detail?: number
  /** Pins a level, clamped to what a part has. The top one when there is no `camera` either. */
  level?: number
  /** A part left out draws nothing, and its children still do. */
  visible?: (part: CompoundNode<RigidPart>) => boolean
  jointState?: (part: CompoundNode<RigidPart>) => JointState | undefined
}

/** A running effect, advanced by the host, and where its textures come from. */
export interface SceneEffect {
  instance: EffectInstance
  texture: (name: string) => TextureEntry | undefined
  /** An appearance left out isn't drawn, and still runs: a way of looking. Every one when absent. */
  visible?: (node: EffectNode) => boolean
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
  /** Seconds, the host's clock, for material UV animation. 0 when absent. */
  time?: number
  /** After the models, in the order given. `collectSpaceFrame` has the game's order. */
  effects?: readonly SceneEffect[]
  /** Over `RETAIL_FRAME_LIMITS`, for a mod that patches them. */
  limits?: Partial<FrameLimits>
}

/** What the material and appearance DLLs hardcode, and a mod can patch. */
export interface FrameLimits {
  /** The least alpha glass draws at, whatever its `Oc` (`FMaterialImpl::BindGlass`). */
  glassLeastAlpha: number
  /** A backdrop's own near and far planes (`FFLAppearanceBase::DrawBackdrop`, `BindArg`'s first flag). */
  backdropNear: number
  backdropFar: number
}

export const RETAIL_FRAME_LIMITS: Readonly<FrameLimits> = {
  glassLeastAlpha: 0.8,
  backdropNear: 1,
  backdropFar: 200000,
}

export interface DrawTexture {
  name: string
  entry: Texture | CubeTexture
  sampler: SamplerState
  /** Which of the mesh's UV sets it samples. */
  uvSet: number
}

/**
 * Texture stage 1, in the classes that use it. With no texture the rig's picture is as if the stage were
 * off (`bands`), so that's what draws, though a real D3D8 driver may read it as white: see VALIDATION.md.
 */
export interface DrawStage {
  operation: 'add' | 'modulate2x'
  texture?: DrawTexture
  /** A planet mask's `diag(tile, tile)` texture matrix, on UV0 (`SetDetailTileTransform`). */
  tile?: number
}

/** What `SubmitAtmosphereLock` needs for each vertex's UV, the rest being the same for a draw. */
export interface DrawAtmosphere {
  /** Towards the camera, in the object's space. */
  direction: Vector3
  /** The cosine of the horizon, where `u` starts. */
  threshold: number
  /** `u` where the vertex faces the camera. */
  gain: number
  /** The row of the fade texture, the whole draw's. */
  v: number
}

/**
 * Source and destination: `SRCALPHA / INVSRCALPHA`, `ONE / ONE`, `SRCALPHA / ONE`, `DESTCOLOR / ZERO`,
 * `ONE / INVSRCCOLOR`.
 */
export type BlendMode = 'alpha' | 'add' | 'alphaAdd' | 'multiply' | 'screen'

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
  uvTransform?: UvTransform

  cull: 'back' | 'front' | 'none'
  depthWrite: boolean
  /** `D3DCMP_LESS` for most. `always` is `ZENABLE 0`, a sky's or the far list's: the same pixels. */
  depthFunc: 'less' | 'lequal' | 'always'
  /** Scene ambient in place of the frame's, for this draw. */
  sceneAmbient?: Vector3
  /** The frame's lights don't reach it. */
  lightless?: boolean
  /** In place of the frame's, for this draw: space lights each object by its own. */
  lights?: SceneLight[]
  /** In place of the frame's, for this draw. */
  projection?: Matrix4
  /** D3D's table fog, on depth: a nebula's, for what it holds (`StarSysApplyObjectLighting`). */
  fog?: Fog
  negateNormals: boolean
  normalizeNormals: boolean
  blend: boolean
  /** `alpha` unless a class sets its own (`bands`). */
  blendMode: BlendMode
  /** Lighting off: white, or the vertex colour, at `diffuse`'s alpha. */
  unlit: boolean
  /** Compared with this, of 255: `D3DRS_ALPHAFUNC`, or `always` with the test off. */
  alphaReference: number
  alphaFunction: 'greater' | 'less' | 'always'
  atmosphere?: DrawAtmosphere
  skin?: DrawSkin
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

export interface ScreenQuadBatch {
  texture: Texture
  quads: ScreenQuad[]
}

export interface Frame {
  background: Vector3
  hooks: FrameHook[]
  view: Matrix4
  projection: Matrix4
  ambient: Vector3
  lights: SceneLight[]
  draws: Draw[]
  /** Each appearance of each effect, after `draws`, in the game's tree order. */
  effects: EffectDraw[]
  /** Over every effect, as `SpaceObjDrawPass` sets it in a nebula. */
  effectFog?: Fog
  /** `less` when absent, as the menu's effects capture it; space's are `lequal`. */
  effectDepthFunc?: 'less' | 'lequal'
  /**
   * Screen quads, after the effects, in D3D's pixels: added, the texture times each quad's colour,
   * `lequal` without writing depth (`ScreenQuadFlush` in `SpaceEffectsDrawFrame`). Each batch is one
   * texture's.
   */
  screenQuads?: ScreenQuadBatch[]
  /** What didn't draw as authored: materials M3 is to cover, and any mesh or texture not found. */
  unsupported: string[]
  /** Materials of a type no DLL registers. They draw nothing in retail either. */
  unregistered: string[]
}

type MaterialClass =
  | 'single'
  | 'singleTwo'
  | 'glass'
  | 'emission'
  | 'detail'
  | 'detailTwo'
  | 'nomad'
  | 'hudIcon'
  | 'hudAnim'
  | 'exclusion'
  | 'water'
  | 'emissive'
  | 'lightMap'
  | 'glow'
  | 'nebula'
  | 'detailMap'
  | 'masked'
  | 'illum'
  | 'atmosphere'

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
  EcEt: 'emissive',
  EcEtTwo: 'emissive',
  LightMap: 'lightMap',
  EngineGlowMaterial: 'glow',
  Nebula: 'nebula',
  NebulaTwo: 'nebula',
  HUDIconMaterial: 'hudIcon',
  HUDAnimMaterial: 'hudAnim',
  ExclusionZoneMaterial: 'exclusion',
  PlanetWaterMaterial: 'water',
  // One class for the two names: the clock that sets them apart is read by nothing (`0x66f88bd`).
  NomadMaterial: 'nomad',
  NomadMaterialNoBendy: 'nomad',
  // One class for the three names (`flmaterials.dll`).
  HighGlassMaterial: 'glass',
  GlassMaterial: 'glass',
  GFGlassMaterial: 'glass',
  // `FEyeMaterial::Bind` and `UpdateTranslucency` come to the same states, leaving stage 1 off. Its other
  // part, the eye bone's offset, is written where a 2D coordinate never reads it: see VALIDATION.md.
  EyeMaterial: 'single',
  DetailMapMaterial: 'detailMap',
  // Only which masks they read sets these two apart.
  DetailMap2Dm1Msk2PassMaterial: 'masked',
  Masked2DetailMapMaterial: 'masked',
  IllumDetailMapMaterial: 'illum',
  AtmosphereMaterial: 'atmosphere',
}

/** Whether `collectFrame` draws this type, the one `[MaterialMap]` gives. */
export const isBuiltType = (type: string): boolean => type in CLASSES

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
  // Kept even for a set the mesh hasn't got, as 52 retail draws ask: that reads (0, 0) (`bands_one_uv`).
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

const WHITE: Vector3 = { x: 1, y: 1, z: 1 }

// These declare no `Dc`, so the material block stays white (`bands`).
const FIXED_COLOUR: ReadonlySet<MaterialClass> = new Set(['emissive', 'lightMap', 'nebula'])

// `bands`: what a `EngineGlowMaterial` with no `Ec` draws with. Whether `Ec` can replace it is read.
const ENGINE_GLOW: Vector3 = { x: 0.75, y: 0.7, z: 0.7 }
const BLACK: Vector3 = { x: 0, y: 0, z: 0 }

type Pass = Pick<
  Draw,
  'cull' | 'negateNormals' | 'normalizeNormals' | 'blend' | 'alphaReference' | 'environment'
> & {
  alpha?: number
  depthWrite?: boolean
  depthFunc?: 'less' | 'lequal'
  blendMode?: BlendMode
  alphaFunction?: Draw['alphaFunction']
  unlit?: boolean
  /** Stage 1, for the classes whose passes differ in it. `null` turns it off. */
  mask?: { slot: TextureReference | undefined; tile: number } | null
}

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

/**
 * `BindCloak` binds the material as usual, so its texture stays, then sets alpha to the object's value
 * times the material's, and a blend table on that alpha alone. Below 1 there's no cut either
 * (`Flag64_`, `0x400`). A cloaked object passes this in place of `EnvMapMaterial`, so nothing reflects
 * (`0x539a87`). A batched material binds again at submit, undoing the alpha, so it only loses the
 * reflection. Read from `flmaterials.dll`, uncaptured: only flight has a cloak.
 */
const cloak = (
  pass: Pass,
  kind: MaterialClass,
  type: string,
  material: Material,
  fade: number,
): Pass => {
  const plain: Pass = { ...pass, normalizeNormals: false }
  delete plain.environment
  if (BATCHED.test(type)) return plain
  const alpha = (pass.alpha ?? material.opacity ?? 1) * fade
  // Glass sets its own blend for each pass as it draws.
  if (kind === 'glass') return { ...plain, alpha }
  return alpha < 1
    ? { ...plain, alpha, blend: true, alphaReference: DEVICE_ALPHA_REFERENCE }
    : { ...plain, alpha, blend: false }
}

// Truncated to the byte `SubmitNomadGeometry` writes, after the smoothstep of `NomadFadeFromValue`.
const nomadAlpha = (fade: number): number => {
  const delta = Math.min(Math.max(1 - fade, 0), 1)
  return Math.trunc((1 - (3 - 2 * delta) * delta * delta) * 255) / 255
}

// `TileRate`'s default in each planet class's property schema.
const DEFAULT_TILE = 4

// `Scale`'s default in the atmosphere's property schema.
export const DEFAULT_SHELL_SCALE = 1.025

/**
 * The planet surfaces (`src/Shading/Material.cpp`, `FMaterial::Submit`), whose state `bands_planet`
 * captured. Pass A is opaque, with its stage 1 on UV0 through a tile matrix, and B blends over it. An
 * environment map turns on normalized normals on the two-pass classes, and has no stage free. These
 * assume `[PerfOptions]`' multipass record on, as a retail install has it.
 */
const planetPasses = (
  kind: 'detailMap' | 'masked' | 'illum',
  type: string,
  material: Material,
  model: SceneModel,
): Pass[] => {
  const shared = {
    cull: 'back' as const,
    negateNormals: false,
    alpha: 1,
    normalizeNormals: model.environment !== undefined,
  }
  if (kind === 'detailMap')
    return [
      {
        ...shared,
        normalizeNormals: false,
        blend: false,
        alphaReference: DEVICE_ALPHA_REFERENCE,
        mask: { slot: material.maskTexture, tile: material.tileRate ?? DEFAULT_TILE },
      },
    ]

  // `DetailMap2Dm1Msk2PassMaterial` reads `Dm1` and `TileRate` for A, and B leaves stage 1 off.
  const single = type === 'DetailMap2Dm1Msk2PassMaterial'
  const first = single
    ? { slot: material.maskTexture1, tile: material.tileRate ?? DEFAULT_TILE }
    : { slot: material.maskTexture0, tile: material.tileRate0 ?? DEFAULT_TILE }
  const second = single
    ? null
    : { slot: material.maskTexture1, tile: material.tileRate1 ?? DEFAULT_TILE }
  const over = {
    ...shared,
    blend: true,
    alphaReference: 1,
    depthFunc: 'lequal',
    mask: second,
  } as const
  if (kind === 'illum')
    return [
      // The test off, so a texel at zero alpha still draws, and B unlit: the night side's lights.
      {
        ...shared,
        blend: false,
        alphaReference: DEVICE_ALPHA_REFERENCE,
        alphaFunction: 'always',
        mask: first,
      },
      { ...over, depthWrite: false, unlit: true },
    ]
  return [
    { ...shared, blend: false, alphaReference: 0xfe, alphaFunction: 'less', mask: first },
    over,
  ]
}

const passesOf = (
  kind: MaterialClass,
  type: string,
  material: Material,
  model: SceneModel,
  { glassLeastAlpha }: FrameLimits,
): Pass[] => {
  if (kind === 'detailMap' || kind === 'masked' || kind === 'illum')
    return planetPasses(kind, type, material, model)

  // `GAtmosphereRs`, and `SubmitAtmosphereLock`'s depth. Stage 1 stays free for a reflection (`bands_planet`).
  if (kind === 'atmosphere')
    return [
      {
        cull: 'back',
        negateNormals: false,
        blend: true,
        alphaReference: DEVICE_ALPHA_REFERENCE,
        alpha: 1,
        depthWrite: false,
        depthFunc: 'lequal',
        ...withEnvironment(model.environment),
      },
    ]

  // The fixed classes, whose tables `bands` captured. Each leaves stage 1 free. Two names draw twice.
  if (kind === 'emissive' || kind === 'lightMap' || kind === 'glow' || kind === 'nebula') {
    const front: Pass = {
      cull: 'back',
      negateNormals: false,
      blend: kind !== 'glow',
      alphaReference: DEVICE_ALPHA_REFERENCE,
      alpha: 1,
      ...(kind === 'emissive' ? { blendMode: 'add' as const } : {}),
      ...(kind === 'nebula' ? { blendMode: 'alphaAdd' as const } : {}),
      // `Submit`'s temporary `ZFUNC` 4.
      ...(kind === 'lightMap'
        ? { blendMode: 'multiply' as const, depthFunc: 'lequal' as const }
        : {}),
      ...withEnvironment(model.environment),
    }
    return type.endsWith('Two')
      ? [front, { ...front, cull: 'front', negateNormals: true }]
      : [front]
  }

  if (kind === 'hudIcon' || kind === 'hudAnim' || kind === 'exclusion' || kind === 'water') {
    const entry = material.diffuseTexture && model.texture(material.diffuseTexture.name)
    const alpha =
      (kind !== 'hudAnim' && kind !== 'water' && model.instance?.alpha) || material.opacity
    return [
      {
        // None sets an alpha test, and all leave stage 1 free for a reflection. `kExclusionRs` always
        // blends, and the others by `RecomputeOpacityFlags`: alpha below 1, or more than one bit.
        cull: 'back',
        negateNormals: false,
        blend: kind === 'exclusion' || (alpha ?? 1) < 1 || alphaBits(entry) > 1,
        alphaReference: DEVICE_ALPHA_REFERENCE,
        ...(alpha === undefined ? {} : { alpha }),
        // `SubmitPlanetWaterGeometry`.
        ...(kind === 'water' ? { depthWrite: false, depthFunc: 'lequal' as const } : {}),
        ...withEnvironment(model.environment),
      },
    ]
  }

  if (kind === 'nomad')
    return [
      {
        // `kNomadRs`, then `SubmitNomadGeometry`. Stage 1 is taken, so no reflection.
        cull: 'none',
        depthWrite: false,
        negateNormals: false,
        blend: true,
        alphaReference: DEVICE_ALPHA_REFERENCE,
        // The object's value is one slot, and an environment override keeps a pointer to its cube's
        // name there (`SetAppearanceInstanceValue`). Read as a float it's near 0, and so is the fade:
        // retail's surface is invisible on an environment-mapped object (`bands`). A cloaked object
        // doesn't pass that override, so keeps its fade.
        alpha: model.environment && !model.cloaked ? 0 : nomadAlpha(model.fade ?? 1),
        ...NO_ENVIRONMENT,
      },
    ]

  const opacity = material.opacity ?? 1

  if (kind === 'glass') {
    // `SubmitGlassGeometry`: inner faces opaque, then outer faces blended. Only those reflect.
    const alpha = Math.max(opacity, glassLeastAlpha)
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

const referenceOf = (
  part: RigidPart,
  name: string,
  world: Matrix4,
  transform: Matrix4,
  { level, camera, lod, detail }: PlaceOptions,
): VMeshRef | undefined => {
  if (part.type !== 'rigid' || !part.part) return undefined
  const source = part.part
  if (level === undefined && camera)
    return levelAt(
      source,
      levelMetric(source, world, transform, camera),
      levelEnds(source, name, lod, { detail }),
    )?.reference
  if (source.type !== 'multilevel') return source.reference
  return source.levels[Math.min(level ?? 0, source.levels.length - 1)]?.reference
}

/** A compound model's parts, depth first (`li_elite`), for a host that doesn't pose its own. */
export const placeParts = (
  root: RigidModel,
  transform: Matrix4,
  options: PlaceOptions = {},
): PlacedPart[] => {
  // A `.3db` is one part, with no hierarchy to walk. The game matches it as `Root`.
  if (root.type !== 'compound') {
    const reference = referenceOf(root, 'Root', transform, transform, options)
    return reference ? [{ reference, world: transform }] : []
  }
  const parts: PlacedPart[] = []
  for (const [node, world] of partTransforms(root, transform, options.jointState)) {
    if (options.visible && !options.visible(node)) continue
    const reference = referenceOf(node.part, node.name, world, transform, options)
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

/** A planet mask: an empty slot draws as an empty stage, and one not found drops the stage. */
const maskStage = (
  { slot, tile }: { slot: TextureReference | undefined; tile: number },
  model: SceneModel,
  unsupported: Set<string>,
): DrawStage | undefined => {
  if (!slot) return { operation: 'modulate2x', tile }
  const entry = entryOf(slot.name, model, unsupported)
  if (!entry) return undefined
  return { operation: 'modulate2x', tile, texture: { ...drawTexture(slot, entry), uvSet: 0 } }
}

const SHELL_FLOOR = 1e-7

/**
 * `SubmitAtmosphereLock`'s values for a draw, from the camera in the unscaled object's space. Each
 * face has its own space, and retail reads its patch's normals, so this holds for the turned face.
 */
const atmosphereOf = (
  material: Material,
  world: Matrix4,
  view: Matrix4,
  radius: number,
): { atmosphere: DrawAtmosphere; scale: number } => {
  const scale = material.scale ?? DEFAULT_SHELL_SCALE
  const fade = material.fade ?? 1
  // Defaults from its property schema.
  const alpha = material.alpha ?? 0.75
  const camera = Matrix4.transformPoint(
    { x: 0, y: 0, z: 0 },
    Matrix4.invert(Matrix4.multiply(view, world)),
  )
  const length = Math.hypot(camera.x, camera.y, camera.z) || SHELL_FLOOR
  const shell = (scale - 1) * (radius / scale)
  const distance = length - radius
  const factor = distance / ((shell > 0 ? shell : SHELL_FLOOR) + distance)
  const cubed = factor * factor * factor
  return {
    scale,
    atmosphere: {
      direction: { x: camera.x / length, y: camera.y / length, z: camera.z / length },
      threshold: radius / length,
      gain: fade * cubed,
      v: cubed < 0.5 ? 2 * (1 - alpha) * cubed : 1 - alpha,
    },
  }
}

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
    return { operation: 'add', texture: { ...drawTexture(slot, entry), uvSet: 1 } }
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
  return { operation, texture: drawTexture(slot, entry) }
}

/**
 * `DrawBackdrop`, `DrawStarsphere` and the draw they share. A starsphere's zeroed view translation is
 * a world moved to the camera, as one view serves a frame. Which lights a room leaves on for it
 * isn't read: space turns them off (`0x4101e0`), and no reference scene has any.
 */
const skyState = (
  sky: 'starsphere' | 'backdrop',
  world: Matrix4,
  camera: Camera,
  aspect: number,
  { backdropNear, backdropFar }: FrameLimits,
): Partial<Draw> => ({
  depthWrite: false,
  depthFunc: 'always',
  ...(sky === 'backdrop'
    ? {
        projection: projectionMatrix({ ...camera, near: backdropNear, far: backdropFar }, aspect),
      }
    : {
        world: Matrix4.multiply(Matrix4.translation(camera.position), world),
        sceneAmbient: WHITE,
        lightless: true,
      }),
})

export interface Queued {
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

/** The batcher's bin 1, far before near. Stable, where retail's qsort leaves equal keys in no set order. */
export const flushQueued = (queued: Queued[], draws: Draw[]): void => {
  queued.sort((a, b) => a.depth - b.depth)
  for (const queue of queued) draws.push(...queue.draws)
  queued.length = 0
}

/** Lists a model's draws, its parts in the order given and each part's groups in order. */
export const collectModel = (
  model: SceneModel,
  camera: Camera,
  aspect: number,
  view: Matrix4,
  time: number,
  draws: Draw[],
  queued: Queued[],
  unsupported: Set<string>,
  unregistered: Set<string>,
  limits: FrameLimits = RETAIL_FRAME_LIMITS,
  /** `kDrawNoCull`: the object was found wholly inside, so its parts aren't tested. */
  noCull = false,
): void => {
  for (const part of model.parts) {
    const {
      reference,
      world,
      mesh: generated,
      materialId: faceMaterial,
      materialName,
      extent,
    } = part
    const mesh = generated ?? model.mesh(reference.meshId)
    if (!mesh) {
      unsupported.add(`mesh ${reference.meshId}`)
      continue
    }

    // `RenderInstance`, per part: a compound's children recurse whatever became of their parent. A
    // sky is tested as it's drawn, at the camera. Reports below come first, so none depends on the view.
    const placed =
      model.sky === 'starsphere'
        ? Matrix4.multiply(Matrix4.translation(camera.position), world)
        : world
    const { center, radius } = reference.boundingSphere
    const visible =
      noCull ||
      sphereInFrustum(
        Matrix4.transformPoint(center, Matrix4.multiply(view, placed)),
        (radius < 0.001 ? 1 : radius) * largestAxis(world),
        camera,
        aspect,
      )

    for (const { materialId, startIndex, elementCount } of getMeshDraw(mesh, reference)) {
      const material = model.material(faceMaterial ?? materialId)
      if (!material) {
        unsupported.add(`material ${materialName ?? faceMaterial ?? materialId}`)
        continue
      }
      const type = mapMaterialType(material, model.materialMap)
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
      // `EcEt` draws its `Et` on stage 0, and engine glow has no texture at all.
      const slot =
        kind === 'emissive'
          ? material.emissionTexture
          : kind === 'glow'
            ? undefined
            : material.diffuseTexture
      const entry = slot && entryOf(slot.name, model, unsupported)
      const second = secondStage(kind, material, mesh, model, unsupported)
      // Only the single-pass family asks for an instance (`ApplyVerifyMatAnim`) among those built.
      const anim =
        (kind === 'single' || kind === 'singleTwo' || kind === 'hudAnim' || kind === 'water') &&
        model.materialAnimations
          ? getMaterialAnim(model.materialAnimations, material.name)
          : undefined
      const animated =
        type === 'EyeMaterial' && part.eyeOffset
          ? { offset: part.eyeOffset, scale: [1, 1] as [number, number] }
          : anim && sampleUvAnimation(anim, time)

      if (!visible) continue

      // A queued material's passes stay together, being one submission (`ProcessQueuedBin`).
      const passes = passesOf(kind, type, material, model, limits).map((pass) =>
        model.cloaked && kind !== 'nomad'
          ? cloak(pass, kind, type, material, model.fade ?? 1)
          : pass,
      )
      const target: Draw[] = []
      // The sky's override calls the batched face's `Submit` itself, so it never reaches a queue
      // (`FMaterialImpl::DrawBackdrop`), and draws where it stands.
      const queuedHere = !model.sky && BATCHED.test(type) && passes[0]!.blend
      if (queuedHere)
        queued.push({ depth: batchDepth(mesh, reference, world, view), draws: target })

      const shell =
        kind === 'atmosphere' ? atmosphereOf(material, world, view, extent ?? 1) : undefined

      for (const {
        alpha,
        depthWrite,
        depthFunc,
        blendMode,
        alphaFunction,
        unlit,
        mask,
        ...pass
      } of passes) {
        const cube = pass.environment ? entryOf(pass.environment, model, unsupported) : undefined
        const stage = mask === undefined ? second : mask && maskStage(mask, model, unsupported)
        ;(queuedHere ? target : draws).push({
          mesh,
          reference,
          byteOffset: (startIndex - reference.indexStart) * Uint16Array.BYTES_PER_ELEMENT,
          count: elementCount,
          // `SubmitAtmosphereLock` scales only what it draws: its UVs come from the unscaled object.
          world: shell ? Matrix4.multiply(world, Matrix4.scaling(shell.scale)) : world,
          materialName: material.name,
          // `Dc` is never read by the nomad class.
          diffuse:
            kind === 'nomad' || FIXED_COLOUR.has(kind)
              ? [1, 1, 1, alpha!]
              : kind === 'glow'
                ? [0, 0, 0, 1]
                : [x, y, z, alpha ?? material.opacity ?? 1],
          // Setting `Dc` overwrites `Ac` (`0x6eb2439`), and both start white. 37 retail materials differ.
          ambient: FIXED_COLOUR.has(kind)
            ? WHITE
            : kind === 'glow'
              ? BLACK
              : ((kind === 'hudIcon' || kind === 'exclusion'
                  ? model.instance?.ambient
                  : undefined) ??
                material.diffuse ??
                material.ambient ??
                WHITE),
          emissive:
            kind === 'glow'
              ? (material.emission ?? ENGINE_GLOW)
              : (kind !== 'emission' &&
                  kind !== 'lightMap' &&
                  kind !== 'nebula' &&
                  material.emission) ||
                BLACK,
          colorVertex: (mesh.format & VertexFormat.Diffuse) !== 0,
          nomad: kind === 'nomad',
          depthWrite: depthWrite ?? true,
          depthFunc: depthFunc ?? 'less',
          blendMode: blendMode ?? 'alpha',
          unlit: unlit ?? (kind === 'lightMap' || kind === 'nebula'),
          alphaFunction: alphaFunction ?? 'greater',
          ...(shell ? { atmosphere: shell.atmosphere } : {}),
          // `SubmitExclusionGeometry` draws with `D3DRS_AMBIENT` white, so `Ac` arrives unscaled.
          ...(kind === 'exclusion' ? { sceneAmbient: WHITE } : {}),
          // A slot with no texture draws as an empty stage, which reads as white.
          ...(slot && entry ? { texture: drawTexture(slot, entry) } : {}),
          ...(stage ? { second: stage } : {}),
          ...(animated ? { uvTransform: animated } : {}),
          ...pass,
          ...(cube?.type === 'cube' ? { environmentTexture: cube } : {}),
          ...(part.skin ? { skin: part.skin } : {}),
          ...(model.sky ? skyState(model.sky, world, camera, aspect, limits) : {}),
        })
      }
    }
  }
}

export const BLACK_BACKGROUND: Vector3 = { x: 0, y: 0, z: 0 }

export const hooksOf = (draws: Draw[]): FrameHook[] => {
  // A sky blends before anything opaque, and isn't what this hook waits for.
  const firstBlended = draws.findIndex(({ blend, depthFunc }) => blend && depthFunc !== 'always')
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
  time = 0,
  effects = [],
  limits,
}: Scene): Frame => {
  const resolved = { ...RETAIL_FRAME_LIMITS, ...limits }
  const draws: Draw[] = []
  const unsupported = new Set<string>()
  const unregistered = new Set<string>()
  const view = viewMatrix(camera)
  const queued: Queued[] = []
  for (const model of models)
    collectModel(
      model,
      camera,
      aspect,
      view,
      time,
      draws,
      queued,
      unsupported,
      unregistered,
      resolved,
    )
  // A room flushes its queue once, after all its objects (`RoomBatcherEnd`, `ku_dragon_pair`).
  flushQueued(queued, draws)
  const effectDraws: EffectDraw[] = []
  for (const { instance, texture, visible } of effects)
    collectEffect(instance, view, texture, effectDraws, unsupported, visible)
  return {
    background: background ?? BLACK_BACKGROUND,
    hooks: hooksOf(draws),
    view,
    projection: projectionMatrix(camera, aspect),
    ambient,
    lights,
    draws,
    effects: effectDraws,
    unsupported: [...unsupported],
    unregistered: [...unregistered],
  }
}
