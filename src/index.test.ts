import assert from 'node:assert/strict'
import { test } from 'node:test'

test('imports without a DOM or a GL context', async () => {
  const { createContext, createProgram } = await import('./index.js')

  assert.equal(typeof createContext, 'function')
  assert.equal(typeof createProgram, 'function')
})

test('thorn plays a script without a host', async () => {
  const { thorn } = await import('./index.js')
  const playback = thorn.replay({ duration: 1, entities: [], events: [] }, 2000)

  assert.equal(playback.state, 'done')
})

test('a jump tunnel builds from the entry point, for a host that edits one', async () => {
  const { GateTunnel, RETAIL_TUNNEL, RETAIL_TUNNEL_LAYER } = await import('./index.js')
  const tunnel = new GateTunnel(
    { ...RETAIL_TUNNEL, layers: [RETAIL_TUNNEL_LAYER] },
    { random: () => 16384 },
  )

  assert.equal(tunnel.layers.length, 1)
  assert.equal(tunnel.state, 0)
})
