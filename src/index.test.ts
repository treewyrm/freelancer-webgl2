import assert from 'node:assert/strict'
import { test } from 'node:test'

test('imports without a DOM or a GL context', async () => {
  const { createContext, createProgram } = await import('./index.js')

  assert.equal(typeof createContext, 'function')
  assert.equal(typeof createProgram, 'function')
})
