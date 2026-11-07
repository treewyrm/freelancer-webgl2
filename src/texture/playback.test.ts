import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AnimatedTexture, Texture } from '@treewyrm/freelancer/texture'
import { frameAtlas, playbackFrame } from './playback.js'

const animation = (count: number, rate: number, atlas = (n: number) => n): AnimatedTexture => ({
  name: 'boxes.avi',
  type: 'animated',
  rate,
  frames: Array.from({ length: count }, (_, n) => ({
    index: atlas(n),
    u1: 0,
    v1: 0,
    u2: 1,
    v2: 1,
  })),
})

test('a loop moves on a frame every 1 / FPS and wraps at the count (FUN_06ebe660, case 1)', () => {
  // `boxes.avi`: 16 frames at 30.
  const boxes = animation(16, 30)
  const at = (seconds: number) => playbackFrame(boxes, seconds, 'loop')
  assert.deepEqual(
    [0, 0.02, 1 / 30 + 1e-4, 0.5 - 1e-4, 0.5 + 1e-4, 0.55, 10].map(at),
    [0, 0, 1, 14, 15, 0, 12],
  )
})

test('a clamp holds on the last frame, as the duration stops 1e-6 short (case 0)', () => {
  // `SetWrapMode(Id, 0)` in `FFxTextureWrapper::Resolve`: 16 frames at 15.
  const impact = animation(16, 15)
  const at = (seconds: number) => playbackFrame(impact, seconds, 'clamp')
  assert.deepEqual([0, 0.5, 16 / 15 - 0.01, 16 / 15, 100].map(at), [0, 7, 15, 15, 15])
})

test('one frame, or a rate within 1e-5, stays on frame 0 (InitializePlayback)', () => {
  assert.equal(playbackFrame(animation(1, 30), 5, 'loop'), 0)
  assert.equal(playbackFrame(animation(4, 0), 5, 'loop'), 0)
  assert.equal(playbackFrame(animation(4, 1e-6), 5, 'clamp'), 0)
})

test('a negative rate falls below frame 0, where retail reads out of bounds', () => {
  assert.ok(playbackFrame(animation(4, -15), 0.1, 'loop') < 0)
  // The clamp reaches 0 first, as the duration is negative.
  assert.equal(playbackFrame(animation(4, -15), 0.1, 'clamp'), 0)
})

test("a frame's atlas is the sibling named by its index, and nothing for a frame past the list", () => {
  const atlas = { name: 'boxes.avi_3', type: 'image' } as unknown as Texture
  const library = (name: string) => (name === 'boxes.avi_3' ? atlas : undefined)
  const shared = animation(4, 15, () => 3)
  assert.deepEqual(frameAtlas(shared, 2, library), { name: 'boxes.avi_3', entry: atlas })
  assert.equal(frameAtlas(shared, 4, library), undefined)
  assert.equal(frameAtlas(animation(4, 15), 0, library), undefined)
})
