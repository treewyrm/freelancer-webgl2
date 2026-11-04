/** WebGL2 renderer for Freelancer. The host supplies bytes, time, camera and a canvas. */
export { createContext } from '#/gl/context.js'
export { createProgram, type Program } from '#/gl/program.js'
export { createRenderer, type FrameHooks, type HookContext, type Renderer } from '#/scene/render.js'
export {
  collectFrame,
  placeParts,
  type Draw,
  type DrawTexture,
  type Frame,
  type FrameHook,
  type HookName,
  type PlacedPart,
  type PlaceOptions,
  type Scene,
  type SceneLight,
  type SceneModel,
} from '#/scene/frame.js'
export { projectionMatrix, viewMatrix, type Camera } from '#/scene/camera.js'
export { partTransforms } from '#/scene/hierarchy.js'
export { levelAt, levelEnds, levelMetric, type LodList } from '#/scene/level.js'
export {
  ATTRIBUTE_LOCATIONS,
  planReference,
  vertexLayout,
  type GroupDraw,
  type ReferencePlan,
  type VertexLayout,
} from '#/mesh/plan.js'
