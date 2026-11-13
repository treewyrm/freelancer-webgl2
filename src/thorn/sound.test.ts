import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Event, Script } from '@treewyrm/freelancer/thn/scene'
import { Playback } from './playback.js'
import { soundLevel } from './sound.js'

const script = (events: Event[]): Script => ({
  duration: 10,
  entities: [
    { type: 'SCENE', entity_name: 'scene' },
    {
      type: 'SOUND',
      entity_name: 'voice',
      template_name: 'dx_line',
      flags: ['SPATIAL'],
      spatialprops: { pos: { x: 3, y: 0, z: 0 } },
      audioprops: { attenuation: -10, pan: 0 },
    },
  ],
  events,
})

test("a sound plays from start_time plus how late its tick's clock is, loops by flag, and is cut at its end", () => {
  const playback = new Playback(
    script([
      {
        action: 'START_SOUND',
        time: 1,
        duration: 2,
        targets: ['voice'],
        start_time: 250,
        flags: ['LOOP'],
      },
    ]),
  )

  playback.start()
  playback.tick(1100)

  const [sound] = playback.sounds

  assert.deepEqual(
    { ...sound, audio: undefined },
    {
      entity: 'voice',
      template: 'dx_line',
      offset: 350,
      loop: true,
      spatial: true,
      started: 1100,
      audio: undefined,
      position: { x: 3, y: 0, z: 0 },
    },
  )
  playback.tick(2000)
  assert.equal(playback.sounds.length, 0)
})

test('an audio animation lerps attenuation in decibels from where it stood', () => {
  const playback = new Playback(
    script([
      { action: 'START_SOUND', time: 0, duration: 5, targets: ['voice'] },
      {
        action: 'START_AUDIO_PROP_ANIM',
        time: 0,
        duration: 2,
        targets: ['voice'],
        audioprops: { attenuation: -100 },
      },
    ]),
  )

  playback.start()
  playback.tick(1000)
  assert.equal(playback.sounds[0]!.audio.attenuation, -55)
  // Silent from −96, whatever the room and archetype add.
  assert.deepEqual(soundLevel(-3, { ...playback.sounds[0]!.audio, attenuation: -97 }), {
    volume: -96,
    pan: 0,
  })
  assert.deepEqual(soundLevel(-3, { ...playback.sounds[0]!.audio, pan: 200 }, -5), {
    volume: -63,
    pan: 10000,
  })
})

test('a START_SOUND with flags bit 2 makes its sound spatial for every start, as the parser does', () => {
  const base = script([])
  const plain = { ...base.entities[1]!, flags: [] } as Script['entities'][number]
  const playback = new Playback({
    ...base,
    entities: [base.entities[0]!, plain],
    events: [
      { action: 'START_SOUND', time: 0, duration: 1, targets: ['voice'] },
      {
        action: 'START_SOUND',
        time: 2,
        duration: 1,
        targets: ['voice'],
        unknown: { flags: { type: 'number', literal: '2' } },
      } as Event,
    ],
  })

  playback.start()
  playback.tick(500)
  assert.equal(playback.sounds[0]!.spatial, true)
})
