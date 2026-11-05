/** Every retail effect runs, and what it asks of the draw is known. Skips without retail data. */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { test } from 'node:test'
import { getResourceId } from '@treewyrm/freelancer'
import { getNodeName, readAlchemy, type Effect, type Node } from '@treewyrm/freelancer/alchemy'
import { Matrix4 } from '@treewyrm/freelancer/math'
import { Directory } from '@treewyrm/freelancer/utf'
import { collectEffect, type EffectDraw } from './draw.js'
import { createPools, EffectInstance, RECORD } from './effect.js'
import { buildEffect, lookupOver, type ResolveNode } from './tree.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const skip = existsSync(data) ? false : `no retail data at ${data}`

const load = () => {
  const effects: { effect: Effect; resolve: ResolveNode; all: Effect[] }[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (extname(path).toLowerCase() === '.ale') {
        const alchemy = readAlchemy(Directory.read(new Uint8Array(readFileSync(path))))
        if (!alchemy) continue
        const nodes = new Map<number, Node>()
        for (const node of alchemy.nodes.nodes)
          nodes.set(getResourceId(getNodeName(node) ?? '', true), node)
        const resolve: ResolveNode = (crc) => nodes.get(crc)
        for (const effect of alchemy.effects.effects)
          effects.push({ effect, resolve, all: alchemy.effects.effects })
      }
    }
  }
  walk(data)
  return effects
}

const VIEW = Matrix4.translation({ x: 0, y: 0, z: -100 })

test('every retail effect runs for five seconds, finite, at each end of sparam', { skip }, () => {
  const effects = load()
  assert.equal(effects.length, 1213)
  const unsupported = new Set<string>()
  const unresolved = new Set<string>()
  let drawn = 0
  for (const { effect, resolve, all } of effects)
    for (const sparam of [0, 1]) {
      const scene = buildEffect(effect, resolve)
      for (const node of scene.nodes) if (node.missing) unresolved.add(node.missing)
      const instance = new EffectInstance(scene, {
        lookup: lookupOver(all, resolve),
        pools: createPools(1),
      })
      for (let n = 0; n < 300; n++) {
        instance.advance(1 / 60, { sparam, view: VIEW })
        const draws: EffectDraw[] = []
        collectEffect(instance, VIEW, () => undefined, draws, unsupported)
        if (n % 60 !== 0) continue
        for (const draw of draws) {
          drawn++
          if (draw.type !== 'sprite') {
            for (let i = 0; i < draw.count * 9; i++)
              assert.ok(Number.isFinite(draw.vertices[i]), `${effect.name} beam`)
            continue
          }
          const { lane } = draw
          for (let i = lane.tail; i < lane.head; i++)
            for (let f = 0; f < 6; f++)
              assert.ok(
                Number.isFinite(lane.records[i * RECORD + f]),
                `${effect.name} record ${i} field ${f}`,
              )
        }
      }
    }
  assert.ok(drawn > 1000, `${drawn}`)
  assert.deepEqual([...unresolved], [])
  // The game crashes on these, so they're named and undrawn.
  assert.deepEqual(
    [...unsupported].filter(
      (name) => !name.startsWith('texture ') && !name.startsWith('FxMeshAppearance '),
    ),
    [],
  )
})
