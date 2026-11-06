/** WebGL2 renderer for Freelancer. The host supplies bytes, time, camera and a canvas. */
export { createContext } from '#/gl/context.js'
export { createProgram, type Program } from '#/gl/program.js'
export { createRenderer, type FrameHooks, type HookContext, type Renderer } from '#/scene/render.js'
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
  collectSpaceFrame,
  RETAIL_SPACE_LIMITS,
  skyLayers,
  type SkyLayer,
  type SpaceEffect,
  type SpaceFrame,
  type SpaceLimits,
  type SpaceObject,
  type SpaceScene,
} from '#/scene/space.js'
export {
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
  nebulaState,
  pickField,
  RETAIL_NEBULA_LIMITS,
  zoneOf,
  type Fog,
  type InExclusion,
  type NebulaExclusion,
  type NebulaLimits,
  type NebulaState,
  type SpaceField,
  type SpaceNebula,
  type Within,
  type Zone,
} from '#/scene/nebula.js'
export {
  NebulaLightning,
  RETAIL_BACKGROUND_LIGHTNING,
  RETAIL_DYNAMIC_LIGHTNING,
  type BackgroundLightningSettings,
  type DynamicLightningSettings,
  type Random,
} from '#/scene/lightning.js'
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
export { projectionMatrix, viewMatrix, type Camera } from '#/scene/camera.js'
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
