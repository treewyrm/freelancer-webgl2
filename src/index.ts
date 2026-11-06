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
  type SceneEffect,
  type SceneLight,
  type SceneModel,
  type Spot,
} from '#/scene/frame.js'
export {
  collectSpaceFrame,
  RETAIL_SPACE_LIMITS,
  type SpaceEffect,
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
export { projectionMatrix, viewMatrix, type Camera } from '#/scene/camera.js'
export { partTransforms } from '#/scene/hierarchy.js'
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
  sphereLevel,
  type SphereLevels,
  type SphereOptions,
} from '#/scene/sphere.js'
export { MATERIAL_MAP, mapMaterialType, type MaterialMapRule } from '#/material/map.js'
export { sampleUvAnimation, type UvTransform } from '#/scene/uv-animation.js'
export { levelAt, levelEnds, levelMetric, type LodList } from '#/scene/level.js'
export {
  ATTRIBUTE_LOCATIONS,
  planReference,
  vertexLayout,
  type GroupDraw,
  type ReferencePlan,
  type VertexLayout,
} from '#/mesh/plan.js'
