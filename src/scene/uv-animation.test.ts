import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MaterialAnim } from '@treewyrm/freelancer/rigid'
import { sampleUvAnimation } from './uv-animation.js'

const ZERO = { uOffset: 0, vOffset: 0, uScale: 0, vScale: 0 }

const anim = {
  name: 'x',
  flags: 0,
  segments: [
    { duration: 2, start: ZERO, velocity: { ...ZERO, uOffset: 1 } },
    { duration: 1, start: { ...ZERO, uOffset: 2, uScale: 0.5 }, velocity: { ...ZERO, vOffset: 3 } },
  ],
} as unknown as MaterialAnim

const at = (time: number) => sampleUvAnimation(anim, time)

test('zero is the identity, as stored scales are displacements from 1', () => {
  assert.deepEqual(at(0), { offset: [0, 0], scale: [1, 1] })
})

test('a velocity is a rate within its segment, from where that segment starts', () => {
  assert.deepEqual(at(1).offset, [1, 0])
  assert.deepEqual(at(2.5), { offset: [2, 1.5], scale: [1.5, 1] })
})

test('the walk moves on only strictly past a duration', () => {
  assert.deepEqual(at(2).offset, [2, 0])
})

test('it wraps, always, to the first segment', () => {
  assert.deepEqual(at(3.5).offset, [0.5, 0])
})

test('no segments, or none with length, is the identity', () => {
  const empty = { name: 'x', flags: 0, segments: [] } as unknown as MaterialAnim
  assert.deepEqual(sampleUvAnimation(empty, 5), { offset: [0, 0], scale: [1, 1] })
})
