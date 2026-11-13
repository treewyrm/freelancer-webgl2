/** Hand-built effects for the tests, never shipped. */
import type {
  AnimatedColor,
  AnimatedCurve,
  AnimatedFloat,
  Effect,
  Node,
  NodeInstance,
  NodeType,
  Property,
} from '@treewyrm/freelancer/alchemy'
import { getResourceId } from '@treewyrm/freelancer'
import { buildEffect, type EffectScene } from './tree.js'

/** A curve holding one value. */
export const flat = (value: number): AnimatedCurve => ({
  easing: 1,
  keyframes: [
    {
      key: 0,
      fallback: value,
      before: 0,
      after: 0,
      keyframes: [],
    } as AnimatedCurve['keyframes'][0],
  ],
})

/** An eased list holding one value. */
export const eased = (value: number): AnimatedFloat => ({
  easing: 1,
  keyframes: [{ key: 0, easing: 1, keyframes: [{ key: 0, value }] }],
})

/** An eased list running from `a` to `b` over a particle's life. */
export const ramp = (a: number, b: number): AnimatedFloat => ({
  easing: 1,
  keyframes: [
    {
      key: 0,
      easing: 1,
      keyframes: [
        { key: 0, value: a },
        { key: 1, value: b },
      ],
    },
  ],
})

export const tint = (x: number, y: number, z: number): AnimatedColor => ({
  easing: 1,
  keyframes: [{ key: 0, easing: 1, keyframes: [{ key: 0, value: { x, y, z } }] }],
})

const typed = (name: string, value: unknown): Property => {
  const type =
    typeof value === 'boolean'
      ? 'boolean'
      : typeof value === 'string'
        ? 'string'
        : typeof value === 'number'
          ? name === 'Emitter_InitialParticles'
            ? 'integer'
            : 'float'
          : name === 'BasicApp_BlendInfo'
            ? 'blending'
            : name === 'BasicApp_Color'
              ? 'animatedColor'
              : /^(BasicApp_(Size|Alpha|Rotate|HToVAspect|TexFrame)|RectApp_|OrientedApp_|RadialField_Attenuation|Emitter_LODCurve|Appearance_LODCurve)/.test(
                    name,
                  )
                ? 'animatedFloat'
                : 'animatedCurve'

  return { name, type, value } as unknown as Property
}

export const node = (name: string, type: NodeType, properties: Record<string, unknown>): Node => ({
  type,
  properties: [
    typed('Node_Name', name),
    ...Object.entries(properties).map(([key, value]) => typed(key, value)),
  ],
})

interface Entry {
  node?: Node
  folder?: boolean
  root?: boolean
  children?: Entry[]
  targets?: string[]
}

/** A tree of nodes, linked by name, under a `Control Root` unless a top entry says otherwise. */
export const sceneOf = (entries: Entry[]): { effect: Effect; scene: EffectScene } => {
  const byName = new Map<string, NodeInstance>()
  const nodes = new Map<number, Node>()
  let sort = 0
  const links: [NodeInstance, string[]][] = []

  const build = (entry: Entry): NodeInstance => {
    const name = entry.node?.properties[0]?.value as string | undefined
    const crc = entry.root ? 0xee223b51 | 0 : name ? getResourceId(name, true) : 0
    if (entry.node) nodes.set(crc, entry.node)

    const instance: NodeInstance = {
      crc,
      flags: entry.folder || entry.root ? 1 : 0,
      sort: sort++,
      children: [],
      targets: [],
    }
    if (name) byName.set(name, instance)
    if (entry.targets) links.push([instance, entry.targets])
    instance.children = (entry.children ?? []).map(build)
    return instance
  }

  const effect: Effect = { name: 'test', children: entries.map(build) }

  for (const [instance, names] of links) instance.targets = names.map((name) => byName.get(name)!)
  return { effect, scene: buildEffect(effect, (crc) => nodes.get(crc)) }
}

/** A sphere emitter of `frequency` at one point, firing up +Y at `pressure` if it were a cone. */
export const emitter = (name: string, properties: Record<string, unknown> = {}): Node =>
  node(name, 'FxConeEmitter', {
    Node_LifeSpan: Infinity,
    Emitter_Frequency: flat(61),
    Emitter_InitLifeSpan: flat(10),
    Emitter_Pressure: flat(0),
    Emitter_MaxParticles: flat(10000),
    ConeEmitter_MinRadius: flat(0),
    ConeEmitter_MaxRadius: flat(0),
    ConeEmitter_MinSpread: flat(0),
    ConeEmitter_MaxSpread: flat(0),
    ...properties,
  })

export const basic = (name: string, properties: Record<string, unknown> = {}): Node =>
  node(name, 'FxBasicAppearance', {
    Node_LifeSpan: Infinity,
    BasicApp_QuadTexture: true,
    BasicApp_Size: eased(1),
    BasicApp_Alpha: eased(1),
    BasicApp_Color: tint(1, 1, 1),
    ...properties,
  })
