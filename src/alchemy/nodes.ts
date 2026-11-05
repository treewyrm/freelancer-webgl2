/** An Alchemy node read into what the simulation and draw use. Absent properties stay absent here. */
import type {
  AnimatedColor,
  AnimatedCurve,
  AnimatedFloat,
  AnimatedTransform,
  Blending,
  Node,
  PropertyName,
} from '@treewyrm/freelancer/alchemy'

interface Common {
  name: string
  /** Absent, 3 (`0x623f7b0`). `FLT_MAX` and `Infinity` both mean never. */
  lifeSpan: number
  transform?: AnimatedTransform
}

interface EmitterCommon extends Common {
  category: 'emitter'
  lodCurve?: AnimatedFloat
  /** Signed: one retail cone holds `0xCDCDCDCD`, which the DLL adds as it stands (`0x6245cf6`). */
  initialParticles: number
  frequency?: AnimatedCurve
  maxParticles?: AnimatedCurve
  initLifeSpan?: AnimatedCurve
  pressure?: AnimatedCurve
  emitCount?: AnimatedCurve
  velocityApproach?: AnimatedCurve
}

export interface CubeEmitter extends EmitterCommon {
  kind: 'cube-emitter'
  width?: AnimatedCurve
  height?: AnimatedCurve
  depth?: AnimatedCurve
  minSpread?: AnimatedCurve
  maxSpread?: AnimatedCurve
}

export interface SphereEmitter extends EmitterCommon {
  kind: 'sphere-emitter'
  minRadius?: AnimatedCurve
  maxRadius?: AnimatedCurve
}

export interface ConeEmitter extends EmitterCommon {
  kind: 'cone-emitter'
  minRadius?: AnimatedCurve
  maxRadius?: AnimatedCurve
  minSpread?: AnimatedCurve
  maxSpread?: AnimatedCurve
}

export interface Sprite {
  color?: AnimatedColor
  alpha?: AnimatedFloat
  texture?: string
  blend?: Blending
  texFrame?: AnimatedFloat
  commonTexFrame?: AnimatedCurve
  useCommonTexFrame: boolean
  flipU: boolean
  flipV: boolean
}

interface AppearanceCommon extends Common {
  category: 'appearance'
  lodCurve?: AnimatedFloat
}

export interface BasicAppearance extends AppearanceCommon, Sprite {
  kind: 'basic-appearance'
  triTexture: boolean
  quadTexture: boolean
  motionBlur: boolean
  size?: AnimatedFloat
  rotate?: AnimatedFloat
  aspect?: AnimatedFloat
}

export interface DustAppearance extends AppearanceCommon, Sprite {
  kind: 'dust-appearance'
  size?: AnimatedFloat
}

export interface PerpAppearance extends AppearanceCommon, Sprite {
  kind: 'perp-appearance'
  size?: AnimatedFloat
  viewingAngleFade: boolean
}

export interface RectAppearance extends AppearanceCommon, Sprite {
  kind: 'rect-appearance'
  motionBlur: boolean
  centerOnPos: boolean
  viewingAngleFade: boolean
  scale?: AnimatedFloat
  length?: AnimatedFloat
  width?: AnimatedFloat
}

export interface BeamAppearance extends AppearanceCommon, Sprite {
  kind: 'beam-appearance'
  quadTexture: boolean
  disablePlaceHolder: boolean
  dupeFirstParticle: boolean
  scale?: AnimatedFloat
  width?: AnimatedFloat
}

export interface OrientedAppearance extends AppearanceCommon, Sprite {
  kind: 'oriented-appearance'
  scale?: AnimatedFloat
  width?: AnimatedFloat
  height?: AnimatedFloat
  viewingAngleFade: boolean
}

export interface ParticleAppearance extends AppearanceCommon {
  kind: 'particle-appearance'
  lifeName?: string
  deathName?: string
  useDynamicRotation: boolean
  smoothRotation: boolean
}

export interface MeshAppearance extends AppearanceCommon {
  kind: 'mesh-appearance'
}

interface FieldCommon extends Common {
  category: 'field'
}

export interface RadialField extends FieldCommon {
  kind: 'radial-field'
  radius?: AnimatedCurve
  attenuation?: AnimatedFloat
  magnitude?: AnimatedCurve
  approach?: AnimatedCurve
}

export interface CollideField extends FieldCommon {
  kind: 'collide-field'
  reflectivity?: AnimatedCurve
}

export interface TurbulenceField extends FieldCommon {
  kind: 'turbulence-field'
  magnitude?: AnimatedCurve
  approach?: AnimatedCurve
}

export interface AirField extends FieldCommon {
  kind: 'air-field'
  magnitude?: AnimatedCurve
  approach?: AnimatedCurve
}

export interface GravityField extends FieldCommon {
  kind: 'gravity-field'
  gravity?: AnimatedCurve
}

export interface DustField extends FieldCommon {
  kind: 'dust-field'
  maxRadius?: AnimatedCurve
}

export interface BeamField extends FieldCommon {
  kind: 'beam-field'
}

export interface FolderNode extends Common {
  category: 'folder'
  kind: 'folder'
}

export type NodeDescriptor =
  | CubeEmitter
  | SphereEmitter
  | ConeEmitter
  | BasicAppearance
  | DustAppearance
  | PerpAppearance
  | RectAppearance
  | BeamAppearance
  | OrientedAppearance
  | ParticleAppearance
  | MeshAppearance
  | RadialField
  | CollideField
  | TurbulenceField
  | AirField
  | GravityField
  | DustField
  | BeamField
  | FolderNode

export type Emitter = Extract<NodeDescriptor, { category: 'emitter' }>
export type Appearance = Extract<NodeDescriptor, { category: 'appearance' }>
export type Field = Extract<NodeDescriptor, { category: 'field' }>

/** A node's descriptor, or `undefined` for a type no DLL registers. */
export const describeNode = (node: Node): NodeDescriptor | undefined => {
  const find = (name: PropertyName) => node.properties.find((one) => one.name === name)
  const flag = (name: PropertyName, fallback = false) => {
    const found = find(name)
    return found?.type === 'boolean' ? found.value : fallback
  }
  const scalar = (name: PropertyName, fallback: number) => {
    const found = find(name)
    return found?.type === 'float' || found?.type === 'integer' ? found.value : fallback
  }
  const text = (name: PropertyName) => {
    const found = find(name)
    return found?.type === 'string' ? found.value : undefined
  }
  const float = (name: PropertyName) => {
    const found = find(name)
    return found?.type === 'animatedFloat' ? found.value : undefined
  }
  const curve = (name: PropertyName) => {
    const found = find(name)
    return found?.type === 'animatedCurve' ? found.value : undefined
  }
  const color = () => {
    const found = find('BasicApp_Color')
    return found?.type === 'animatedColor' ? found.value : undefined
  }
  const blend = () => {
    const found = find('BasicApp_BlendInfo')
    return found?.type === 'blending' ? found.value : undefined
  }
  const transform = () => {
    const found = find('Node_Transform')
    return found?.type === 'transform' ? found.value : undefined
  }

  const common: Common = {
    name: text('Node_Name') ?? '',
    lifeSpan: scalar('Node_LifeSpan', 3),
    transform: transform(),
  }
  const emitter = (): EmitterCommon => ({
    ...common,
    category: 'emitter',
    lodCurve: float('Emitter_LODCurve'),
    initialParticles: scalar('Emitter_InitialParticles', 0),
    frequency: curve('Emitter_Frequency'),
    maxParticles: curve('Emitter_MaxParticles'),
    initLifeSpan: curve('Emitter_InitLifeSpan'),
    pressure: curve('Emitter_Pressure'),
    emitCount: curve('Emitter_EmitCount'),
    velocityApproach: curve('Emitter_VelocityApproach'),
  })
  const appearance = (): AppearanceCommon => ({
    ...common,
    category: 'appearance',
    lodCurve: float('Appearance_LODCurve'),
  })
  const sprite = (): Sprite => ({
    color: color(),
    alpha: float('BasicApp_Alpha'),
    texture: text('BasicApp_TexName'),
    blend: blend(),
    texFrame: float('BasicApp_TexFrame'),
    commonTexFrame: curve('BasicApp_CommonTexFrame'),
    useCommonTexFrame: flag('BasicApp_UseCommonTexFrame'),
    flipU: flag('BasicApp_FlipTexU'),
    flipV: flag('BasicApp_FlipTexV'),
  })
  const field = (): FieldCommon => ({ ...common, category: 'field' })

  switch (node.type) {
    case 'FxCubeEmitter':
      return {
        ...emitter(),
        kind: 'cube-emitter',
        width: curve('CubeEmitter_Width'),
        height: curve('CubeEmitter_Height'),
        depth: curve('CubeEmitter_Depth'),
        minSpread: curve('CubeEmitter_MinSpread'),
        maxSpread: curve('CubeEmitter_MaxSpread'),
      }
    case 'FxSphereEmitter':
      return {
        ...emitter(),
        kind: 'sphere-emitter',
        minRadius: curve('SphereEmitter_MinRadius'),
        maxRadius: curve('SphereEmitter_MaxRadius'),
      }
    case 'FxConeEmitter':
      return {
        ...emitter(),
        kind: 'cone-emitter',
        minRadius: curve('ConeEmitter_MinRadius'),
        maxRadius: curve('ConeEmitter_MaxRadius'),
        minSpread: curve('ConeEmitter_MinSpread'),
        maxSpread: curve('ConeEmitter_MaxSpread'),
      }
    case 'FxBasicAppearance':
      return {
        ...appearance(),
        ...sprite(),
        kind: 'basic-appearance',
        triTexture: flag('BasicApp_TriTexture'),
        quadTexture: flag('BasicApp_QuadTexture'),
        motionBlur: flag('BasicApp_MotionBlur'),
        size: float('BasicApp_Size'),
        rotate: float('BasicApp_Rotate'),
        aspect: float('BasicApp_HToVAspect'),
      }
    case 'FLDustAppearance':
      return { ...appearance(), ...sprite(), kind: 'dust-appearance', size: float('BasicApp_Size') }
    case 'FxPerpAppearance':
      return {
        ...appearance(),
        ...sprite(),
        kind: 'perp-appearance',
        size: float('BasicApp_Size'),
        viewingAngleFade: flag('RectApp_ViewingAngleFade'),
      }
    case 'FxRectAppearance':
      return {
        ...appearance(),
        ...sprite(),
        kind: 'rect-appearance',
        motionBlur: flag('BasicApp_MotionBlur'),
        centerOnPos: flag('RectApp_CenterOnPos'),
        viewingAngleFade: flag('RectApp_ViewingAngleFade'),
        scale: float('RectApp_Scale'),
        length: float('RectApp_Length'),
        width: float('RectApp_Width'),
      }
    case 'FLBeamAppearance':
      return {
        ...appearance(),
        ...sprite(),
        kind: 'beam-appearance',
        // On unless the file says otherwise: the constructor's flag word is 2 (`0x6204a47`).
        quadTexture: flag('BasicApp_QuadTexture', true),
        disablePlaceHolder: flag('BeamApp_DisablePlaceHolder'),
        dupeFirstParticle: flag('BeamApp_DupeFirstParticle'),
        scale: float('RectApp_Scale'),
        width: float('RectApp_Width'),
      }
    case 'FxOrientedAppearance':
      return {
        ...appearance(),
        ...sprite(),
        kind: 'oriented-appearance',
        scale: float('RectApp_Scale'),
        width: float('OrientedApp_Width'),
        height: float('OrientedApp_Height'),
        viewingAngleFade: flag('RectApp_ViewingAngleFade'),
      }
    case 'FxParticleAppearance':
      return {
        ...appearance(),
        kind: 'particle-appearance',
        lifeName: text('ParticleApp_LifeName'),
        deathName: text('ParticleApp_DeathName'),
        useDynamicRotation: flag('ParticleApp_UseDynamicRotation'),
        smoothRotation: flag('ParticleApp_SmoothRotation'),
      }
    case 'FxMeshAppearance':
      return { ...appearance(), kind: 'mesh-appearance' }
    case 'FxRadialField':
      return {
        ...field(),
        kind: 'radial-field',
        radius: curve('RadialField_Radius'),
        attenuation: float('RadialField_Attenuation'),
        magnitude: curve('RadialField_Magnitude'),
        approach: curve('RadialField_Approach'),
      }
    case 'FxCollideField':
      return {
        ...field(),
        kind: 'collide-field',
        reflectivity: curve('CollideField_Reflectivity'),
      }
    case 'FxTurbulenceField':
      return {
        ...field(),
        kind: 'turbulence-field',
        magnitude: curve('TurbulenceField_Magnitude'),
        approach: curve('TurbulenceField_Approach'),
      }
    case 'FxAirField':
      return {
        ...field(),
        kind: 'air-field',
        magnitude: curve('AirField_Magnitude'),
        approach: curve('AirField_Approach'),
      }
    case 'FxGravityField':
      return { ...field(), kind: 'gravity-field', gravity: curve('GravityField_Gravity') }
    // It borrows an emitter's property name (`0x6212c20`).
    case 'FLDustField':
      return { ...field(), kind: 'dust-field', maxRadius: curve('SphereEmitter_MaxRadius') }
    case 'FLBeamField':
      return { ...field(), kind: 'beam-field' }
    case 'FxNode':
      return { ...common, category: 'folder', kind: 'folder' }
    default:
      return undefined
  }
}
