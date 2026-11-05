/** Draws hand-built effects on the GPU and reads back what landed. */
import type { TextureEntry } from '@treewyrm/freelancer/texture'
import type { Fixture } from '#/harness.js'
import { collectFrame } from '#/scene/frame.js'
import { createRenderer, type FrameHooks } from '#/scene/render.js'
import type { Camera } from '#/scene/camera.js'
import { EffectInstance } from './effect.js'
import { basic, eased, emitter, flat, node, sceneOf, tint } from './fixtures.js'
import type { EffectLookup, EffectScene } from './tree.js'

export interface EffectReport {
  error: number
  /** A quad of half-extent 1 at 5 units a half-screen, so 2/10 of the width. */
  basicSpan: number
  basicCentre: number[]
  alphaWrapped: number[]
  rolled: { above: number; right: number }
  triangle: { apexRow: number; baseRow: number; baseSpan: number }
  blurSpan: { x: number; y: number }
  rect: { above: number; below: number; span: number }
  rectCentered: { above: number; below: number }
  rectEndOn: number
  perp: { span: number; perpFadeEdgeOn: number; roll: { left: number[]; right: number[] } }
  beam: { lit: number; offChain: number[]; onChain: number[] }
  blendOrder: { under: number[]; over: number[] }
  hookSeesEffects: { opaque: number[]; end: number[] }
  emptyHookMatches: boolean
  afterRestore: { before: number[]; after: number[] }
  scaleMovesBasic: number
  scaleResizesPerp: number
}

const SIZE = 64

// Looks down -Z from +Z, seeing a width of 10 at the origin.
const front: Camera = {
  position: { x: 0, y: 0, z: 10 },
  orientation: { x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 } },
  fovh: (Math.atan(0.5) * 180) / Math.PI,
  near: 1,
  far: 100,
}

// Looks down -Y from +Y, along what a cone emits.
const above: Camera = {
  ...front,
  position: { x: 0, y: 10, z: 0 },
  orientation: { x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 0, z: 1 }, z: { x: 0, y: -1, z: 0 } },
}

const oneShot = (properties: Record<string, unknown> = {}) =>
  emitter('e', {
    Emitter_Frequency: flat(0),
    Emitter_InitialParticles: 1,
    Emitter_InitLifeSpan: flat(100),
    ...properties,
  })

const fixture: Fixture<EffectReport> = (gl) => {
  const renderer = createRenderer(gl)
  const pixelAt = (x: number, y: number) => {
    const out = new Uint8Array(4)
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out)
    return [...out]
  }
  const shot = (
    scene: EffectScene,
    {
      camera = front,
      lookup,
      steps = 1,
      hooks,
      texture,
    }: {
      camera?: Camera
      lookup?: EffectLookup
      steps?: number
      hooks?: FrameHooks
      texture?: TextureEntry
    } = {},
  ) => {
    const instance = new EffectInstance(scene, { lookup })
    for (let n = 0; n < steps; n++) instance.advance(1 / 60)
    const frame = collectFrame({
      camera,
      aspect: 1,
      ambient: { x: 0, y: 0, z: 0 },
      lights: [],
      models: [],
      effects: [{ instance, texture: () => texture }],
    })
    renderer.render(frame, hooks)
  }
  // Pixels bright on a row or a column through the screen's middle, in GL's y-up rows.
  const litRow = (y: number) => {
    let count = 0
    for (let x = 0; x < SIZE; x++) if (pixelAt(x, y)[0]! + pixelAt(x, y)[1]! > 8) count++
    return count
  }
  const litColumn = (x: number, from = 0, to = SIZE) => {
    let count = 0
    for (let y = from; y < to; y++) if (pixelAt(x, y)[0]! + pixelAt(x, y)[1]! > 8) count++
    return count
  }

  const quad = (properties: Record<string, unknown> = {}, emit: Record<string, unknown> = {}) =>
    sceneOf([{ node: basic('a', properties) }, { node: oneShot(emit), targets: ['a'] }]).scene

  shot(quad({ BasicApp_Color: tint(1, 0, 0), BasicApp_Alpha: eased(0.5) }))
  const basicSpan = litRow(32)
  const basicCentre = pixelAt(32, 32)

  shot(quad({ BasicApp_Alpha: eased(1.5) }))
  const alphaWrapped = pixelAt(32, 32)

  // A quarter turn, with an aspect of 3: `R·cos − U·sin` puts the wide axis along -U.
  shot(quad({ BasicApp_Rotate: eased(Math.PI / 2), BasicApp_HToVAspect: eased(3) }))
  const rolled = { above: litColumn(32), right: litRow(32) }

  shot(quad({ BasicApp_QuadTexture: false }))
  let apexRow = 0
  let baseRow = SIZE
  for (let y = 0; y < SIZE; y++) {
    if (litRow(y) === 0) continue
    apexRow = Math.max(apexRow, y)
    baseRow = Math.min(baseRow, y)
  }
  const triangle = { apexRow, baseRow, baseSpan: litRow(baseRow + 1) }

  // Moving up at 60: a streak from Size behind where it was a thirtieth ago to Size ahead.
  shot(quad({ BasicApp_MotionBlur: true }, { Emitter_Pressure: flat(60) }))
  const blurSpan = { x: litRow(32), y: litColumn(32) }

  const rect = (properties: Record<string, unknown>) =>
    sceneOf([
      {
        node: node('a', 'FxRectAppearance', {
          Node_LifeSpan: Infinity,
          BasicApp_Color: tint(1, 1, 1),
          BasicApp_Alpha: eased(1),
          RectApp_Scale: eased(1),
          RectApp_Width: eased(1),
          RectApp_Length: eased(4),
          ...properties,
        }),
      },
      { node: oneShot({ Emitter_Pressure: flat(0.001) }), targets: ['a'] },
    ]).scene
  shot(rect({}))
  const rectResult = {
    above: litColumn(32, 33, SIZE),
    below: litColumn(32, 0, 31),
    span: litRow(40),
  }
  shot(rect({ RectApp_CenterOnPos: true }))
  const rectCentered = { above: litColumn(32, 33, SIZE), below: litColumn(32, 0, 31) }
  shot(rect({}), { camera: above })
  const rectEndOn = litRow(32) + litColumn(32)

  const perp = (properties: Record<string, unknown> = {}) =>
    sceneOf([
      {
        node: node('a', 'FxPerpAppearance', {
          Node_LifeSpan: Infinity,
          BasicApp_Color: tint(1, 1, 1),
          BasicApp_Alpha: eased(1),
          BasicApp_Size: eased(2),
          ...properties,
        }),
      },
      { node: oneShot({ Emitter_Pressure: flat(0.001) }), targets: ['a'] },
    ]).scene
  shot(perp(), { camera: above })
  const perpSpan = litRow(32)
  // Red in the frame's u1, green in its u2, so the roll shows: u follows the seed's +X.
  shot(perp({ BasicApp_TexName: 'two' }), {
    camera: above,
    texture: {
      name: 'two',
      type: 'image',
      storage: 'targa',
      format: 'rgba32_8888',
      width: 2,
      height: 1,
      flip: false,
      levels: [new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255])],
    },
  })
  const perpRoll = { left: pixelAt(28, 32), right: pixelAt(36, 32) }
  shot(perp({ RectApp_ViewingAngleFade: true }), { camera: front })
  const perpFadeEdgeOn = litRow(32) + litColumn(32)

  const beam = sceneOf([
    {
      node: node('a', 'FLBeamAppearance', {
        Node_LifeSpan: Infinity,
        BasicApp_Color: tint(1, 1, 1),
        BasicApp_Alpha: eased(1),
        RectApp_Width: eased(1),
        RectApp_Scale: eased(1),
      }),
    },
    {
      node: emitter('e', {
        Emitter_Frequency: flat(61),
        Emitter_InitLifeSpan: flat(100),
        Emitter_Pressure: flat(30),
      }),
      targets: ['a'],
    },
  ]).scene
  shot(beam, { steps: 6 })
  const beamResult = {
    lit: litColumn(32),
    offChain: pixelAt(10, 40),
    onChain: pixelAt(32, 40),
  }

  // Tree order under an order-dependent blend: appearance beside the root first, then the one under it.
  const opaque = (color: ReturnType<typeof tint>, name: string, emit: string) =>
    [
      {
        node: basic(name, {
          BasicApp_Color: color,
          BasicApp_BlendInfo: { source: 2, target: 1 },
        }),
      },
      {
        node: emitter(emit, {
          Emitter_Frequency: flat(0),
          Emitter_InitialParticles: 1,
          Emitter_InitLifeSpan: flat(100),
        }),
        targets: [name],
      },
    ] as const
  const [underApp, underEmit] = opaque(tint(0, 1, 0), 'u', 'eu')
  const [overApp, overEmit] = opaque(tint(1, 0, 0), 'o', 'eo')
  shot(sceneOf([{ root: true, children: [underApp, underEmit] }, overApp, overEmit]).scene)
  const beside = pixelAt(32, 32)
  shot(sceneOf([underApp, underEmit, overApp, overEmit]).scene)
  const inFile = pixelAt(32, 32)

  const plain = quad({ BasicApp_Color: tint(1, 0, 0) })
  shot(plain)
  const without = pixelAt(32, 32)
  let opaqueHook: number[] = []
  let endHook: number[] = []
  shot(plain, {
    hooks: {
      opaque: () => void (opaqueHook = pixelAt(32, 32)),
      end: () => void (endHook = pixelAt(32, 32)),
    },
  })
  const withHooks = pixelAt(32, 32)

  const before = pixelAt(32, 32)
  const lose = gl.getExtension('WEBGL_lose_context')!
  const nextEvent = (name: string) =>
    new Promise<void>((resolve) =>
      gl.canvas.addEventListener(name, () => resolve(), { once: true }),
    )
  const lost = nextEvent('webglcontextlost')
  lose.loseContext()
  const done = lost
    // Restoring is refused until the lost event's task has finished.
    .then(() => new Promise((resolve) => setTimeout(resolve)))
    .then(() => {
      const restored = nextEvent('webglcontextrestored')
      lose.restoreContext()
      return restored
    })

  return done.then(() => {
    shot(plain)
    const after = pixelAt(32, 32)
    const scale = (kind: 'basic' | 'perp') => {
      const curves = (value: number) => ({ x: flat(value), y: flat(value), z: flat(value) })
      const transform = {
        order: [4, 3, 5],
        curves: { position: curves(0), rotation: curves(0), scale: curves(2) },
      }
      const app =
        kind === 'basic'
          ? basic('a', { Node_Transform: transform })
          : node('a', 'FxPerpAppearance', {
              Node_LifeSpan: Infinity,
              Node_Transform: transform,
              BasicApp_Color: tint(1, 1, 1),
              BasicApp_Alpha: eased(1),
              BasicApp_Size: eased(2),
            })
      app.properties.find((one) => one.name === 'Node_Transform')!.type = 'transform'
      shot(
        sceneOf([
          { node: app },
          { node: oneShot({ Emitter_Pressure: flat(0.001) }), targets: ['a'] },
        ]).scene,
        {
          camera: kind === 'perp' ? above : front,
        },
      )
      return litRow(32)
    }
    return {
      error: gl.getError(),
      basicSpan,
      basicCentre,
      alphaWrapped,
      rolled,
      triangle,
      blurSpan,
      rect: rectResult,
      rectCentered,
      rectEndOn,
      perp: { span: perpSpan, perpFadeEdgeOn, roll: perpRoll },
      beam: beamResult,
      blendOrder: { under: beside, over: inFile },
      hookSeesEffects: { opaque: opaqueHook, end: endHook },
      emptyHookMatches: withHooks.join() === without.join(),
      afterRestore: { before, after },
      scaleMovesBasic: scale('basic'),
      scaleResizesPerp: scale('perp'),
    }
  })
}

export default fixture
