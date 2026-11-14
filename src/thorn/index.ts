/** THN playback: thorn's engine, over the library's `thn/scene` `Script`. It renders nothing. */
export { createCurve, progress, type Curve, type Timing } from './curve.js'
export {
  eventsOf,
  type AimRecord,
  type CameraProps,
  type MotionRecord,
  flagWord,
  FLAGS,
  milliseconds,
  RUN,
  type Stage,
  type ThornEvent,
} from './events.js'
export {
  axisTurn,
  inverse,
  lookAt,
  nlerp,
  placement,
  quaternionOf,
  rotationOf,
  type Frame,
  type Quaternion,
} from './frame.js'
export { createPath, type Path } from './path.js'
export {
  connectedFrame,
  Playback,
  replay,
  retailSort,
  type CameraView,
  type CharacterHost,
  type Connection,
  type PlaybackOptions,
  type PlaybackState,
  type ThornHost,
} from './playback.js'
export { frameMilliseconds, ScriptRun, type FrameMilliseconds } from './script.js'
export { cameraOf, Letterbox, rowsOf, ViewTable } from './view.js'
export {
  blendFog,
  blendLight,
  DEFAULT_LIGHT,
  LIGHT_BITS,
  lightOf,
  NO_FOG,
  readFog,
  readLight,
  roomFogOf,
  roomLightOf,
  type FogState,
  type LightState,
} from './light.js'
export {
  renderTypeOf,
  roomEntities,
  rtcEnabled,
  spawns,
  userProp,
  type RoomEntity,
  type RtcSetting,
  type SpawnOptions,
} from './room.js'
export {
  blendAudio,
  DEFAULT_AUDIO,
  readAudio,
  soundLevel,
  type AudioState,
  type SoundRecord,
} from './sound.js'
export {
  ambientSequence,
  anchoredFrame,
  readSetScript,
  scriptAnchor,
  Sequence,
  SequenceManager,
  type EntryKind,
  type SequenceEntry,
  type SequenceFlags,
  type SetCamera,
  type SetProp,
  type SetScript,
  type SetSource,
} from './sequence.js'
export { mixerCharacters, type MixerCharacters } from './character.js'
export {
  compoundHardpoint,
  RoomStage,
  stageTemplates,
  type SceneLine,
  type SceneMode,
  type StageOptions,
  type StagePlayHost,
  type StageScene,
  type StageSceneHost,
  type StageSceneOptions,
  type StageTemplate,
} from './stage.js'
export { castEntities, createCast, type Cast, type CastSource, type CostumePart } from './cast.js'
