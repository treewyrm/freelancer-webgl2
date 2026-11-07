import type { Material } from '@treewyrm/freelancer/material'
import { Matrix3, Matrix4, Quat } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import {
  Primitive,
  type VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import { EffectInstance } from '#/alchemy/effect.js'
import { basic, eased, emitter, flat, sceneOf, tint } from '#/alchemy/fixtures.js'
import type { Fixture } from '#/harness.js'
import { AsteroidBand } from './band.js'
import { equipmentLight } from './light.js'
import { zoneOf } from './nebula.js'
import { buildRing, textureShape, type RingExterior } from './ring.js'
import { createRenderer } from './render.js'
import { collectSpaceFrame, type SpaceObject, type SpaceScene } from './space.js'
import { starRadius, type Star } from './star.js'
import { GateTunnel, RETAIL_TUNNEL_LAYER } from './tunnel.js'

export interface SpaceReport {
  error: number
  /** The middle of the view, then near a corner, in each scene. */
  beyondFar: number[][]
  noDepth: number[][]
  withDepth: number[][]
  /** The middle, lit by a point light at full, half and no strength. */
  pointLit: number[]
  /** The same square under an equipment spot of 179°, 120° and 60°. */
  spotLit: number[]
  /** The middle, from 100 into a nebula's edge: a white square in it, then a red effect. */
  fogged: { square: number[]; effect: number[]; unfoggedEffect: number[] }
  /** An effect in the plane of a black square: drawn over it in space, and not where `LESS` holds. */
  coplanar: { space: number[]; less: number[] }
  /** A red ring's band across the middle: without a detail shape, then with a light grey one. */
  ring: { plain: number[]; detailed: number[] }
  /** A field's band across the middle, its face toward the camera: drawn, then culled by mode 2. */
  band: { drawn: number[]; culled: number[] }
  /** The middle, 100 into a nebula's edge, over a nearer green square: without a fill, then with. */
  sheets: { unfilled: number[]; filled: number[] }
  /**
   * Red suns filling the view: one on the far list behind a green square (middle, corner); one on
   * the main list over a square in front of it; and a grey one without alpha over dim green.
   */
  suns: { behind: number[][]; over: number[]; screen: number[] }
  /** A white corona added over a green square in front of its sun: the middle, then a bare corner. */
  corona: number[][]
  /**
   * From the ship, down a straight gate tunnel over the jump's white clear: the middle, open, then a
   * corner on its wall, an opaque blue layer under a green one at 31 / 255 added `ONE, INVSRCALPHA`.
   */
  tunnel: number[][]
}

// A square of half-size 1 facing +Z: FVF 0x112.
const vertices = new Float32Array(
  [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].flatMap(([x, y]) => [x!, y!, 0, 0, 0, 1, 0, 0]),
)
const mesh: VMeshData = {
  name: 'square',
  version: 1,
  primitive: Primitive.TriangleList,
  format: 0x112 as VertexFormat,
  groups: [{ materialId: 1, vertexStart: 0, vertexEnd: 3, elementCount: 6, padding: 0 }],
  indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  vertices: new Uint8Array(vertices.buffer),
}
const reference: VMeshRef = {
  meshId: 1,
  vertexStart: 0,
  vertexCount: 4,
  indexStart: 0,
  indexCount: 6,
  groupStart: 0,
  groupCount: 1,
  boundingBox: { min: { x: -1, y: -1, z: 0 }, max: { x: 1, y: 1, z: 0 } },
  boundingSphere: { center: { x: 0, y: 0, z: 0 }, radius: 1.5 },
}

const MATERIAL = { name: 'flat', type: 'DcDt' }

/** `distance` is where it sorts, and `drawnAt` where its square stands, as wide as `scale`. */
const square = (
  color: [number, number, number],
  distance: number,
  drawnAt: number,
  scale: number,
  fields: Partial<SpaceObject> = {},
): SpaceObject => {
  const material: Material = { ...MATERIAL, diffuse: { x: color[0], y: color[1], z: color[2] } }
  const position = { x: 0, y: 0, z: -distance }
  return {
    position,
    sphere: { center: position, radius: 1.5 * scale },
    model: {
      parts: [
        {
          reference,
          world: Matrix4.multiply(
            Matrix4.translation({ x: 0, y: 0, z: -drawnAt }),
            Matrix4.scaling(scale),
          ),
        },
      ],
      mesh: () => mesh,
      material: () => material,
      texture: () => undefined,
    },
    ...fields,
  }
}

const SOLAR = { solar: { large: true } }
const RED: [number, number, number] = [1, 0, 0]
const GREEN: [number, number, number] = [0, 1, 0]

export default (async (gl) => {
  const renderer = createRenderer(gl)
  const { width, height } = gl.canvas
  const read = (x: number, y: number): number[] => {
    const pixel = new Uint8Array(4)
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    return [...pixel.subarray(0, 3)]
  }
  const shot = (
    objects: SpaceObject[],
    lighting?: Pick<SpaceScene, 'ambient' | 'lights'>,
  ): number[][] => {
    renderer.render(
      collectSpaceFrame({
        camera: {
          position: { x: 0, y: 0, z: 0 },
          orientation: Matrix3.identity,
          fovh: 45,
          near: 1,
          far: 1,
        },
        aspect: width / height,
        // Ambient alone, so a square reads as its `Dc`.
        ambient: { x: 255, y: 255, z: 255 },
        lights: [],
        ...lighting,
        objects,
      }),
    )
    return [read(width >> 1, height >> 1), read(4, 4)]
  }

  const beyondFar = shot([
    // Far past the pass's plane of 21000, filling the view.
    square(RED, 100000, 100000, 200000, SOLAR),
    square(GREEN, 500, 500, 100),
  ])
  // The solar's square stands in front of the ship, and neither stops it nor leaves it depth to lose to.
  const noDepth = shot([square(RED, 30000, 50, 1000, SOLAR), square(GREEN, 500, 500, 100)])
  // The same two squares on the main list: now depth decides.
  const withDepth = shot([square(RED, 600, 50, 1000), square(GREEN, 500, 500, 100)])

  // A point light 5 in front of a white square 6 wide, 10 away: each corner is lit, by
  // `N·L / (a0 + a1 d)` at its own d of √43, and the middle blends four equal corners.
  const lightAt = (attenuation: { x: number; y: number; z: number }, range: number) =>
    shot([square([1, 1, 1], 10, 10, 3)], {
      ambient: { x: 0, y: 0, z: 0 },
      lights: [
        {
          type: 'point',
          position: { x: 0, y: 0, z: -5 },
          color: { x: 255, y: 255, z: 255 },
          range,
          attenuation,
        },
      ],
    })[0]![0]!
  const pointLit = [
    lightAt({ x: 1, y: 0, z: 0 }, 50),
    lightAt({ x: 0, y: 0.4, z: 0 }, 50),
    lightAt({ x: 1, y: 0, z: 0 }, 6.5),
  ]

  // A spot from the same place, down -Z, of range 50.
  const spotAt = (cone: number) =>
    shot([square([1, 1, 1], 10, 10, 3)], {
      ambient: { x: 0, y: 0, z: 0 },
      lights: [
        equipmentLight({
          world: Matrix4.translation({ x: 0, y: 0, z: -5 }),
          color: { x: 1, y: 1, z: 1 },
          intensity: 50,
          cone,
        })!,
      ],
    })[0]![0]!
  const spotLit = [spotAt(179), spotAt(120), spotAt(60)]

  // From 300 out on +Z, 100 into a nebula of 400 whose fog is 200 deep.
  const nebula = {
    zone: zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: 400 }),
    fog: { distance: 200, color: { x: 0.5, y: 0.25, z: 1 } },
  } as const
  const fogShot = (objects: SpaceObject[], effects: SpaceScene['effects'], nebulae = [nebula]) => {
    renderer.render(
      collectSpaceFrame({
        camera: {
          position: { x: 0, y: 0, z: 300 },
          orientation: Matrix3.identity,
          fovh: 45,
          near: 1,
          far: 1,
        },
        aspect: width / height,
        ambient: { x: 255, y: 255, z: 255 },
        lights: [],
        objects,
        effects,
        nebulae,
      }),
    )
    return read(width >> 1, height >> 1)
  }
  // Red at half alpha, over black, at the nebula's centre.
  const quad = sceneOf([
    {
      node: basic('a', {
        BasicApp_Color: tint(1, 0, 0),
        BasicApp_Alpha: eased(0.5),
        BasicApp_Size: eased(100),
      }),
    },
    {
      node: emitter('e', {
        Emitter_Frequency: flat(0),
        Emitter_InitialParticles: 1,
        Emitter_InitLifeSpan: flat(100),
      }),
      targets: ['a'],
    },
  ]).scene
  const effect = () => {
    const instance = new EffectInstance(quad)
    instance.advance(1 / 60)
    return [{ type: 0, instance, texture: () => undefined }]
  }
  const fogged = {
    // 50 from the camera, 250 from the centre.
    square: fogShot([square([1, 1, 1], -250, -250, 30)], []),
    effect: fogShot([], effect()),
    unfoggedEffect: fogShot([], effect(), []),
  }

  // The quad at the origin, and a white square in its plane, 300 ahead.
  // Black, as the effect adds.
  const plane = square([0, 0, 0], -0.5, 0, 30)
  const coplanarAt = (effectDepthFunc?: 'less') => {
    const frame = collectSpaceFrame({
      camera: {
        position: { x: 0, y: 0, z: 300 },
        orientation: Matrix3.identity,
        fovh: 45,
        near: 1,
        far: 1,
      },
      aspect: width / height,
      ambient: { x: 255, y: 255, z: 255 },
      lights: [],
      objects: [plane],
      effects: effect(),
    })
    renderer.render(effectDepthFunc ? { ...frame, effectDepthFunc } : frame)
    return read(width >> 1, height >> 1)
  }
  const coplanar = { space: coplanarAt(), less: coplanarAt('less') }

  // A 1×1 texture of one colour.
  const solid = (name: string, [r, g, b]: [number, number, number]): Texture =>
    ({
      name,
      type: 'image',
      storage: 'targa',
      format: 'rgba32_8888',
      width: 1,
      height: 1,
      flip: false,
      levels: [new Uint8Array([r, g, b, 255])],
    }) as Texture
  const white = textureShape(solid('white', [255, 255, 255]), {})
  // Its band, 50 to 150 from its centre, passes through the middle of the view.
  const ringShot = (exterior: RingExterior) => {
    const ring = buildRing(exterior, {
      type: 'ring',
      center: { x: -100, y: 0, z: -300 },
      orientation: Quat.axisAngle({ axis: { x: 1, y: 0, z: 0 }, angle: Math.PI / 2 }),
      radius: 150,
      innerRadius: 50,
      height: 10,
    })
    renderer.render(
      collectSpaceFrame({
        camera: {
          position: { x: 0, y: 0, z: 0 },
          orientation: Matrix3.identity,
          fovh: 45,
          near: 1,
          far: 1,
        },
        aspect: width / height,
        ambient: { x: 0, y: 0, z: 0 },
        lights: [],
        objects: [],
        rings: [ring],
      }),
    )
    return read(width >> 1, height >> 1)
  }
  const red = { x: 1, y: 0, z: 0 }
  const ring = {
    // No detail: the opacity halves, so half red over black.
    plain: ringShot({ shape: white, color: red, opacity: 1, segments: 16 }),
    // A detail of 191 doubles to past 1, which saturates: all red, at full opacity.
    detailed: ringShot({
      shape: white,
      detail: textureShape(solid('grey', [191, 191, 191]), {}),
      color: red,
      opacity: 1,
      segments: 16,
    }),
  }

  // A field 3000 ahead, its band's nearest point 2000 off and facing the camera. Unbaked with no
  // lights, its front is white, so it draws in its texture.
  const bandShot = (cullMode: number) => {
    const position = { x: 0, y: 0, z: -3000 }
    const band = new AsteroidBand(
      {
        shape: textureShape(solid('red', [255, 0, 0]), {}),
        vertIncrease: 4,
        fade: [0.5, 1, 100, 110],
        cullMode,
      },
      {
        position,
        orientation: Quat.identity,
        size: { x: 1000, y: 0, z: 0 },
        diffuse: { x: 1, y: 1, z: 1 },
        ambient: { x: 1, y: 1, z: 1 },
      },
    )
    renderer.render(
      collectSpaceFrame({
        camera: {
          position: { x: 0, y: 0, z: 0 },
          orientation: Matrix3.identity,
          fovh: 45,
          near: 1,
          far: 1,
        },
        aspect: width / height,
        ambient: { x: 0, y: 0, z: 0 },
        lights: [],
        objects: [],
        // No cube reaches the camera: only the band draws.
        asteroids: [
          {
            zone: zoneOf({ type: 'sphere', center: position, radius: 1000 }),
            cubeSize: 1,
            fillDistance: 0,
            cube: {
              mesh,
              reference,
              material: () => undefined,
              texture: () => undefined,
            },
            diffuse: { x: 1, y: 1, z: 1 },
            ambient: { x: 1, y: 1, z: 1 },
            band,
          },
        ],
      }),
    )
    return read(width >> 1, height >> 1)
  }
  const band = { drawn: bandShot(0), culled: bandShot(2) }

  // A red nebula of 2100 about a point 2000 ahead, the camera 100 into its fog of 1000, and a green
  // square 300 ahead that holds no nebula and isn't near, so on the main list. A sphere of one value:
  // sheet A alone.
  const sheetsShot = (filled: boolean) => {
    renderer.render(
      collectSpaceFrame({
        camera: {
          position: { x: 0, y: 0, z: 0 },
          orientation: Matrix3.identity,
          fovh: 45,
          near: 1,
          far: 1,
        },
        aspect: width / height,
        ambient: { x: 255, y: 255, z: 255 },
        lights: [],
        objects: [square(GREEN, 300, 300, 300, { nebula: null })],
        nebulae: [
          {
            zone: zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: -2000 }, radius: 2100 }),
            fog: { distance: 1000, color: { x: 1, y: 0, z: 0 } },
            ...(filled ? { fill: white } : {}),
          },
        ],
      }),
    )
    return read(width >> 1, height >> 1)
  }
  const sheets = { unfilled: sheetsShot(false), filled: sheetsShot(true) }

  // A sun `distance` straight ahead, its glow a square of one texel twice `radius` across.
  const sunAt = (distance: number, texture: Texture, radius = 1000): SpaceObject => {
    const star: Star = { radius, glow: { shape: textureShape(texture, {}) } }
    const position = { x: 0, y: 0, z: -distance }
    return {
      ...square([0, 0, 0], distance, distance, 1, SOLAR),
      star,
      sphere: { center: position, radius: starRadius(star) },
    }
  }
  const redGlow = solid('red', [255, 0, 0])
  // 128 grey in a 24-bit Targa, which uploads as R5G6B5: 16 / 31 and 32 / 63.
  const greyGlow = {
    ...solid('grey', [128, 128, 128]),
    format: 'rgb24_888',
    levels: [new Uint8Array([128, 128, 128])],
  } as Texture
  const suns = {
    behind: shot([sunAt(50000, redGlow, 100000), square(GREEN, 500, 500, 100)]),
    // Listed nearer than the square, which stands in front of it: drawn after it, and over it.
    over: shot([sunAt(900, redGlow), square(GREEN, 950, 50, 100)])[0]!,
    screen: shot([sunAt(400, greyGlow), square([0, 0.5, 0], 500, 500, 1000)])[0]!,
  }

  // A sun 4000 ahead behind a green square, its glow unshaped: only its corona, 8 pixels across.
  const coronaSun: SpaceObject = {
    ...sunAt(4000, redGlow),
    star: { radius: 1000, lensGlow: { shape: textureShape(solid('white', [255, 255, 255]), {}) } },
  }
  renderer.render(
    collectSpaceFrame({
      camera: {
        position: { x: 0, y: 0, z: 0 },
        orientation: Matrix3.identity,
        fovh: 45,
        near: 1,
        far: 1,
      },
      aspect: width / height,
      ambient: { x: 255, y: 255, z: 255 },
      lights: [],
      objects: [coronaSun, square(GREEN, 500, 500, 100)],
      viewport: { width, height },
      sunEffect: 1,
      step: 0.1,
    }),
  )
  const corona = [read(width >> 1, height >> 1), read(4, 4)]

  // Every curve at its most: brightness 1, no wander, a radius of 50 all along. The window ends
  // 0.1 of the path ahead, 178, where the opening still covers the middle pixel.
  const tunnel = new GateTunnel(
    {
      writeDepth: false,
      controlPoints: 9,
      range: { x: 0, y: 0, z: 2000 },
      layers: [
        {
          ...RETAIL_TUNNEL_LAYER,
          texture: solid('white', [255, 255, 255]),
          color: { x: 0, y: 0, z: 200 / 255 },
          nearAlpha: 1,
          farAlpha: 1,
        },
        {
          ...RETAIL_TUNNEL_LAYER,
          texture: solid('white', [255, 255, 255]),
          color: { x: 0, y: 1, z: 0 },
          nearAlpha: 0.5,
          farAlpha: 0.5,
        },
      ],
    },
    { random: () => 0x7fff },
  )
  tunnel.setState(1)
  tunnel.setState(2)
  tunnel.update(1 / 60)
  const ship = tunnel.ship!.w
  renderer.render(
    collectSpaceFrame({
      camera: { position: ship, orientation: Matrix3.identity, fovh: 45, near: 1, far: 1 },
      aspect: width / height,
      ambient: { x: 0, y: 0, z: 0 },
      lights: [],
      objects: [],
      jump: {
        ship: { ...square([0, 0, 0], 0, 0, 0), position: ship },
        tunnel,
        ambient: { x: 0, y: 0, z: 0 },
        background: { x: 255, y: 255, z: 255 },
      },
    }),
  )
  const tunnelPixels = [read(width >> 1, height >> 1), read(0, 0)]

  renderer.dispose()
  return {
    corona,
    tunnel: tunnelPixels,
    suns,
    sheets,
    band,
    ring,
    coplanar,
    error: gl.getError(),
    beyondFar,
    noDepth,
    withDepth,
    pointLit,
    spotLit,
    fogged,
  }
}) satisfies Fixture<SpaceReport>
