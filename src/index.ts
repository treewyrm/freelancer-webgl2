/** WebGL2 renderer for Freelancer. The host supplies bytes, time, camera and a canvas. */
export { createContext } from '#/gl/context.js'
export { createProgram, type Program } from '#/gl/program.js'
export {
  createRenderer,
  type FrameHooks,
  type HookContext,
  type Renderer,
  type RenderOptions,
  type ViewportRect,
} from '#/scene/render.js'
export {
  collectFrame,
  isBuiltType,
  placeParts,
  RETAIL_FRAME_LIMITS,
  type Draw,
  type DrawSkin,
  type DrawTexture,
  type Frame,
  type FrameLimits,
  type FrameHook,
  type HookName,
  type PlacedPart,
  type PlaceOptions,
  type Scene,
  type ScreenQuadBatch,
  type SceneEffect,
  type SceneLight,
  type SceneModel,
  type Spot,
} from '#/scene/frame.js'
export { instanceExtent, type Extent } from '#/scene/extent.js'
export {
  collectPlanFrame,
  collectSpaceFrame,
  RETAIL_COCKPIT_LIMITS,
  RETAIL_SPACE_LIMITS,
  skyLayers,
  type CockpitLimits,
  type SkyLayer,
  type SpaceCockpit,
  type SpaceEffect,
  type SpaceFrame,
  type SpaceJump,
  type SpaceLimits,
  type SpaceObject,
  type SpaceScene,
} from '#/scene/space.js'
export {
  directionalLightsAt,
  effectLight,
  equipmentLight,
  evaluateColorGraph,
  evaluateGraph,
  lightObject,
  lightSet,
  systemAmbient,
  type EffectLight,
  type EquipmentLight,
  type LightAnimation,
  type Graph,
  type LightSet,
  type NebulaAmbient,
  type ObjectLighting,
  type SpaceLight,
} from '#/scene/light.js'
export {
  exteriorFactor,
  findNebula,
  fogEnd,
  fogFar,
  immersion,
  listNebulae,
  nebulaState,
  pickField,
  RETAIL_NEBULA_LIMITS,
  zoneOf,
  type Fog,
  type DeferredNebula,
  type InExclusion,
  type ExclusionShell,
  type NebulaExclusion,
  type NebulaLimits,
  type NebulaList,
  type NebulaState,
  type SpaceField,
  type SpaceNebula,
  type Within,
  type WrittenZone,
  type Zone,
} from '#/scene/nebula.js'
export {
  BUTTON_INACTIVE,
  BUTTON_SELECTED,
  collectInterfaceFrame,
  INTERFACE_AMBER,
  INTERFACE_CAMERA,
  INTERFACE_CYAN,
  INTERFACE_GREY,
  InterfacePulse,
  interfaceWorld,
  SPIN_SPEED,
  spinAngle,
  tintOf,
  type InterfaceColour,
  type InterfaceScene,
} from '#/scene/interface.js'
export { fogOverlayDraw } from '#/scene/overlay.js'
export {
  collectRoomFrame,
  lightRoomObject,
  lightScore,
  pickRoomLights,
  ROOM_LIGHTS_PER_OBJECT,
  type RoomFrame,
  type RoomLight,
  type RoomObject,
  type RoomScene,
  type RoomShadows,
} from '#/scene/room.js'
export {
  coneLevel,
  FlashLight,
  FLASHLIGHTS_PER_SET,
  flashlightDraws,
  type FlashlightSet,
  type FlashlightTextures,
} from '#/scene/flashlight.js'
export {
  RETAIL_SHADOW_LIMITS,
  shadowDraw,
  shadowQuad,
  type RoomShadow,
  type ShadowLimits,
  type ShadowQuad,
} from '#/scene/shadow.js'
export { starGlowDraws, starRadius, type Star, type StarGlow } from '#/scene/star.js'
export { castRay, type Hitbox, type HitboxObject, type HitboxSurface } from '#/scene/hitbox.js'
export {
  starCorona,
  starFlare,
  starIntensity,
  starSettled,
  sunEffectQuality,
  sunLeastLod,
  updateStar,
  type CoronaView,
  type FlareBead,
  type LensGlow,
  type RayHit,
  type StarLensFlare,
  type StarSpine,
  type StarSpines,
} from '#/scene/corona.js'
export { fillSheetsDraw } from '#/scene/sheets.js'
export {
  RETAIL_DUST_LIMITS,
  SpaceDust,
  smallestDustZone,
  type DustEffect,
  type DustLimits,
  type DustOptions,
  type DustZone,
} from '#/scene/dust.js'
export {
  AsteroidBillboards,
  type BillboardField,
  type BillboardLighting,
  type BillboardSettings,
} from '#/scene/billboards.js'
export {
  DynamicAsteroids,
  type DynamicDraw,
  type DynamicEffect,
  type DynamicField,
  type DynamicSettings,
} from '#/scene/dynamic.js'
export {
  NebulaExterior,
  RETAIL_EXTERIOR_LIMITS,
  textureHasAlpha,
  type ExteriorLimits,
  type ExteriorSettings,
} from '#/scene/exterior.js'
export {
  NebulaLightning,
  RETAIL_BACKGROUND_LIGHTNING,
  RETAIL_DYNAMIC_LIGHTNING,
  type BackgroundLightningSettings,
  type DynamicLightningSettings,
  type Random,
} from '#/scene/lightning.js'
export {
  BeamEffect,
  beamArchetype,
  beamBatch,
  lookMatrix,
  RETAIL_BEAM_LIMITS,
  type BeamArchetype,
  type BeamLimits,
  type BeamSection,
  type BeamStart,
} from '#/scene/beam.js'
export {
  RETAIL_TRACTOR_LIMITS,
  type TractorArm,
  type TractorBeam,
  type TractorLimits,
} from '#/scene/tractor.js'
export {
  GateTunnel,
  RETAIL_TUNNEL,
  RETAIL_TUNNEL_LAYER,
  type TunnelLayer,
  type TunnelSettings,
  type TunnelState,
} from '#/scene/tunnel.js'
export {
  EFFECT_TYPE_NAMES,
  effectLodRow,
  effectLodType,
  effectTypeIndex,
  RETAIL_EFFECT_TYPES,
  viewEffect,
  type EffectLodSizes,
  type EffectType,
  type EffectView,
  type EffectViewFrame,
  type EffectViewOptions,
  type PlacedEffect,
} from '#/scene/effect-view.js'
export { PlacedEffects, type EffectPlacement } from '#/scene/placed.js'
export {
  eyeFor,
  projectionMatrix,
  sizeDepth,
  underPixel,
  unitsPerPixel,
  viewMatrix,
  type Camera,
  type Viewport,
} from '#/scene/camera.js'
export { attachJoint, partTransforms } from '#/scene/hierarchy.js'
export {
  flareQuads,
  LightBlink,
  RETAIL_FLARE_LIGHT,
  type FlareLight,
  type FlareView,
  type FrameRect,
  type ScreenQuad,
  type SpaceFlare,
} from '#/scene/flare.js'
export {
  closestCubePosition,
  cubeId,
  cubeOrientation,
  cubeRotations,
  entryOrientation,
  fieldCubes,
  mergeCube,
  nearField,
  RETAIL_CUBE_ROTATIONS,
  type CubeAsteroid,
  type CubeDraw,
  type CubeExclusion,
  type CubeField,
  type CubeRotations,
  type SpaceAsteroidField,
} from '#/scene/asteroids.js'
export {
  AsteroidBand,
  type BandField,
  type BandLighting,
  type BandPiece,
  type BandSettings,
} from '#/scene/band.js'
export {
  Clouds,
  NEBULA_CLOUD_VISIBILITY,
  RING_CLOUD_VISIBILITY,
  type CloudDrawOptions,
  type CloudSettings,
  type CloudVisibility,
} from '#/scene/clouds.js'
export {
  buildRing,
  ringImmersion,
  ringPieceDraw,
  textureShape,
  type PlanetRing,
  type RingExterior,
  type RingOptions,
  type RingPiece,
  type TextureShape,
} from '#/scene/ring.js'
export {
  adjustedDistance,
  costumeLevel,
  RETAIL_SWITCH_FOVX,
  switchDistance,
  type SwitchTable,
} from '#/deformable/level.js'
export {
  boneTable,
  costumeWorlds,
  MAX_BONES,
  placeCostume,
  placeSkin,
  poseSkin,
  type SkinPose,
  skinMesh,
  type SkinMesh,
  type SkinOptions,
} from '#/deformable/skin.js'
export {
  buildEffect,
  lookupOver,
  type EffectLookup,
  type EffectNode,
  type EffectScene,
  type ResolveNode,
} from '#/alchemy/tree.js'
export {
  createPools,
  EffectInstance,
  RETAIL_POOLS,
  type AdvanceOptions,
  type EffectPools,
  type PoolSizes,
} from '#/alchemy/effect.js'
export type { TriangleDraw, EffectDraw, SpriteDraw } from '#/alchemy/draw.js'
export type { Rgb, SpriteFrameStyle } from '#/alchemy/program.js'
export {
  placeSphere,
  RETAIL_SPHERE_LEVELS,
  solarSphereLevels,
  sphereLevel,
  type SphereLevels,
  type SphereOptions,
} from '#/scene/sphere.js'
export { MATERIAL_MAP, mapMaterialType, type MaterialMapRule } from '#/material/map.js'
export { sampleUvAnimation, type UvTransform } from '#/scene/uv-animation.js'
export {
  levelAt,
  levelEnds,
  levelMetric,
  lodRange,
  lodScale,
  type LodDetail,
  type LodList,
} from '#/scene/level.js'
export {
  ATTRIBUTE_LOCATIONS,
  planReference,
  vertexLayout,
  type GroupDraw,
  type ReferencePlan,
  type VertexLayout,
} from '#/mesh/plan.js'
/** THN playback: thorn's clock, schedule, placement, curves, paths and spatial animation. */
export * as thorn from '#/thorn/index.js'
export {
  EASE,
  fadeWeight,
  Mixer,
  MotionFlag,
  type AimOptions,
  type MixerJoint,
  type MixerOptions,
  type MotionOptions,
} from '#/deformable/mixer.js'
