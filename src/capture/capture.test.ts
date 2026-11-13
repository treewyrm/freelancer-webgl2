import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readCapture } from './capture.js'

// The shape of real lines from run 1 of the stock menu, with made-up values.
const lines = {
  device:
    '{"ev":"device","w":1024,"h":768,"windowed":0,"behaviour":"0x00000040","adapter":"A","caps":{"maxLights":10}}',
  scene: '{"ev":"scene","i":7,"n":0,"at":"begin"}',
  clear:
    '{"ev":"clear","i":7,"n":0,"flags":3,"colour":"0xff000000","z":1,"stencil":0,"rects":0,"viewport":[0,0,1024,768,0,1]}',
  texture:
    '{"ev":"texture","p":"0x00000010","levels":2,"type":"2d","w":32,"h":32,"fmt":21,"usage":0,"pool":1,"hash":["00000000aaaaaaaa",null]}',
  draw: `{"ev":"draw","i":7,"n":0,"call":"DrawIndexedPrimitive","prim":"trilist","prims":1,"verts":3,"indices":3,"minIndex":0,"startIndex":0,"baseVertex":4,"fvf":"0x00000112","ps":"0x00000000","stride":32,"rs":{"LIGHTING":1},"world":[1],"view":[2],"proj":[3],"viewport":[0,0,1024,768,0,1],"material":{"diffuse":[1,1,1,1],"ambient":[1,1,1,1],"specular":[0,0,0,0],"emissive":[0,0,0,0],"power":0},"lights":[],"stages":[{"texture":"0x00000010","COLOROP":4,"transform":[9]},{"texture":null,"COLOROP":1}],"idx":[0,1,2]}`,
  frame: '{"ev":"frame","i":7,"draws":1}',
  shot: '{"ev":"shot","i":7,"red":[0],"green":[0],"blue":[0],"file":"d3d8log.f7.bmp","w":1024,"h":768}',
}

test('a frame keeps its events in order and resolves its textures', () => {
  const { device, frames } = readCapture(Object.values(lines).join('\n') + '\n')

  assert.equal(device?.behaviour, 0x40)
  assert.equal(device?.windowed, false)
  assert.equal(frames.length, 1)

  const frame = frames[0]!

  assert.deepEqual(
    frame.events.map(({ kind }) => kind),
    ['scene', 'clear', 'draw'],
  )
  assert.equal(frame.shot?.file, 'd3d8log.f7.bmp')

  const draw = frame.draws[0]!

  assert.equal(draw.fvf, 0x112)
  assert.equal(draw.baseVertex, 4)
  assert.equal(draw.states['LIGHTING'], 1)
  assert.deepEqual(draw.projection, [3])

  const [first, second] = draw.stages

  assert.equal(first?.texture?.width, 32)
  assert.deepEqual(first?.texture?.hash, ['00000000aaaaaaaa', undefined])
  assert.equal(first?.states['COLOROP'], 4)
  assert.deepEqual(first?.transform, [9])
  assert.equal(first?.states['transform'], undefined)
  assert.equal(second?.texture, undefined)
})

test("a frame carries the game's own dt, and none from a build it can't read", () => {
  const timed = lines.frame.replace(
    '}',
    ',"wall":0.0105,"dt":0.0104,"raw":0.0104,"paused":0,"t":12.5,"tick":1200}',
  )
  const [frame] = readCapture([lines.texture, lines.draw, timed].join('\n')).frames

  assert.equal(frame?.wall, 0.0105)
  assert.deepEqual(frame?.clock, {
    step: 0.0104,
    capped: 0.0104,
    raw: 0.0104,
    paused: 0,
    elapsed: 12.5,
    ticks: 1200,
  })

  const paused = timed.replace('"paused":0', '"paused":1')

  assert.equal(
    readCapture([lines.texture, lines.draw, paused].join('\n')).frames[0]?.clock?.step,
    0,
  )

  const untimed = lines.frame.replace('}', ',"wall":0.0105}')

  assert.equal(
    readCapture([lines.texture, lines.draw, untimed].join('\n')).frames[0]?.clock,
    undefined,
  )
})

test('a texture line binds only what follows it, so a reused address stays honest', () => {
  const replaced = lines.texture.replace('"w":32', '"w":64')
  const draw = lines.draw.replace('"n":0', '"n":1')
  const { frames } = readCapture(
    [lines.texture, lines.draw, replaced, draw, lines.frame.replace('"draws":1', '"draws":2')].join(
      '\n',
    ),
  )

  assert.deepEqual(
    frames[0]!.draws.map((entry) => entry.stages[0]?.texture?.width),
    [32, 64],
  )
})

test('refuses a capture it cannot account for', () => {
  assert.throws(() => readCapture(`${lines.texture}\n{"ev":"tru`), /line 2 is not JSON/)
  assert.throws(() => readCapture('{"ev":"truncated"}'), /overflowed/)
  assert.throws(
    () => readCapture([lines.texture, lines.draw, lines.frame.replace(':1}', ':2}')].join('\n')),
    /has 1 draws, says 2/,
  )
  assert.throws(() => readCapture(lines.draw), /no texture line/)
  assert.throws(() => readCapture([lines.texture, lines.draw].join('\n')), /inside a frame/)
  assert.throws(() => readCapture(lines.shot), /not captured/)
})
