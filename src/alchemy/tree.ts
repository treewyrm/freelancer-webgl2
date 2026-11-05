/** One effect as a list of nodes, each knowing its parent, children and links. Holds no run state. */
import {
  CONTROL_ROOT_ID,
  type Effect,
  type Node,
  type NodeInstance,
} from '@treewyrm/freelancer/alchemy'
import { describeNode, type NodeDescriptor } from './nodes.js'

export interface EffectNode {
  /** The file's entry this came from, which is how a host names it. */
  instance: NodeInstance
  /** What a CRC resolves to. A flagged entry is a folder and never looked up (`0x621efe7`). */
  descriptor?: NodeDescriptor
  /** The CRC, as text, when it resolved to nothing or to a type no DLL registers. */
  missing?: string
  /** Index in `EffectScene.nodes`, or -1 at the top level. */
  parent: number
  /** In the order they're inserted into their parent, which is entry order. */
  children: number[]
  /** From the `Pair` records, in file order. */
  targets: number[]
  /** Sorts siblings: appearances 100, fields 200, emitters 300, folders 400 (`+0x38`). */
  key: number
}

export interface EffectScene {
  name: string
  nodes: EffectNode[]
  /** Top-level nodes, in entry order. */
  top: number[]
  /** The node a placement reaches, or none, in which case every top-level node takes it. */
  root?: number
}

/** Finds a node by CRC. The namespace is one across all loaded files, so which file is the host's. */
export type ResolveNode = (crc: number) => Node | undefined

/** An effect by name, for `FxParticleAppearance`. Names no library defines mean no particle. */
export type EffectLookup = (name: string) => EffectScene | undefined

const CLASS_KEY = { appearance: 100, field: 200, emitter: 300, folder: 400 } as const

export const buildEffect = (effect: Effect, resolve: ResolveNode): EffectScene => {
  const scene: EffectScene = { name: effect.name, nodes: [], top: [] }
  const indices = new Map<NodeInstance, number>()
  const flat: NodeInstance[] = []

  const gather = (instance: NodeInstance) => {
    flat.push(instance)
    for (const child of instance.children) gather(child)
  }
  for (const instance of effect.children) gather(instance)
  // What the game builds from is the array, whose order the tree doesn't keep.
  const sorted = flat
    .map((instance, walked) => ({ instance, order: instance.sort ?? flat.length + walked }))
    .sort((a, b) => a.order - b.order)
    .map(({ instance }) => instance)

  for (const instance of sorted) {
    indices.set(instance, scene.nodes.length)
    const node = instance.flags ? undefined : resolve(instance.crc)
    const descriptor: NodeDescriptor | undefined = instance.flags
      ? { name: '', lifeSpan: 3, category: 'folder', kind: 'folder' }
      : node && describeNode(node)
    scene.nodes.push({
      instance,
      descriptor,
      missing: descriptor ? undefined : `0x${(instance.crc >>> 0).toString(16)}`,
      parent: -1,
      children: [],
      targets: [],
      key: CLASS_KEY[descriptor?.category ?? 'folder'],
    })
    // The last flagged `Control Root` in entry order: each overwrites the one before (`0x621f088`).
    if (instance.flags && instance.crc === CONTROL_ROOT_ID) scene.root = scene.nodes.length - 1
  }

  sorted.forEach((instance, index) => {
    const node = scene.nodes[index]!
    for (const child of instance.children) {
      const at = indices.get(child)!
      scene.nodes[at]!.parent = index
      node.children.push(at)
    }
    node.children.sort((a, b) => a - b)
    for (const target of instance.targets) {
      const at = indices.get(target)
      if (at !== undefined) node.targets.push(at)
    }
  })
  scene.nodes.forEach((node, index) => {
    if (node.parent < 0) scene.top.push(index)
  })
  return scene
}

/** Builds and caches effects by name, the first of a name winning. */
export const lookupOver = (effects: readonly Effect[], resolve: ResolveNode): EffectLookup => {
  const byName = new Map<string, Effect>()
  for (const effect of effects) if (!byName.has(effect.name)) byName.set(effect.name, effect)
  const built = new Map<string, EffectScene>()
  return (name) => {
    const known = built.get(name)
    if (known) return known
    const effect = byName.get(name)
    if (!effect) return undefined
    const scene = buildEffect(effect, resolve)
    built.set(name, scene)
    return scene
  }
}
