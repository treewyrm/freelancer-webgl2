/** WebGL2 renderer for Freelancer. The host supplies bytes, time, camera and a canvas. */
export { createContext } from '#/gl/context.js'
export { createProgram, type Program } from '#/gl/program.js'
export { createRenderer, type FrameHooks, type HookContext, type Renderer } from '#/scene/render.js'
export {
  collectFrame,
  isBuiltType,
  placeParts,
  type Draw,
  type DrawSkin,
  type DrawTexture,
  type Frame,
  type FrameHook,
  type HookName,
  type PlacedPart,
  type PlaceOptions,
  type Scene,
  type SceneEffect,
  type SceneLight,
  type SceneModel,
} from '#/scene/frame.js'
export { projectionMatrix, viewMatrix, type Camera } from '#/scene/camera.js'
export { partTransforms } from '#/scene/hierarchy.js'
export {
  adjustedDistance,
  costumeLevel,
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
export { placeSphere, sphereLevel, type SphereOptions } from '#/scene/sphere.js'
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
