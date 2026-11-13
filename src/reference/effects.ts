/**
 * Generated effects for the lab install, whose picture doesn't depend on the game's `dt`: particles
 * that hold still under constant curves, or for `motion`, a shape read relative to each particle.
 */
import { getResourceId } from '@treewyrm/freelancer'
import {
  BlendingMode,
  CONTROL_ROOT_ID,
  DEFAULT_TRANSFORM_ORDER,
  EaseType,
  setNodeName,
  WrapMode,
  type Alchemy,
  type Effect,
  type Node,
  type NodeInstance,
  type Property,
} from '@treewyrm/freelancer/alchemy'

const FOREVER = 3.4028234663852886e38
const VERSION = 1.1
const TEXTURE = 'shine'

/** The library every sprite here names, loaded through the `[VisEffect]`. */
export const EFFECT_TEXTURES = 'fx\\efx.txm'

const float = (name: string, value: number): Property =>
  ({
    name,
    type: 'animatedFloat',
    value: {
      easing: EaseType.Linear,
      keyframes: [{ key: 0, easing: EaseType.Linear, keyframes: [{ key: 0, value }] }],
    },
  }) as Property

const color = (name: string, x: number, y: number, z: number): Property =>
  ({
    name,
    type: 'animatedColor',
    value: {
      easing: EaseType.Linear,
      keyframes: [{ key: 0, easing: EaseType.Linear, keyframes: [{ key: 0, value: { x, y, z } }] }],
    },
  }) as Property

const curveValue = (value: number) => ({
  easing: EaseType.Linear,
  keyframes: [
    {
      key: 0,
      fallback: value,
      before: WrapMode.Hold,
      after: WrapMode.Hold,
      keyframes: [{ key: 0, value: { x: value, y: 0, z: 0 } }],
    },
  ],
})

const curve = (name: string, value: number): Property =>
  ({ name, type: 'animatedCurve', value: curveValue(value) }) as Property

/** Runs from 0 to 1 over a particle's life. */
const ramped = (name: string): Property =>
  ({
    name,
    type: 'animatedFloat',
    value: {
      easing: EaseType.Linear,
      keyframes: [
        {
          key: 0,
          easing: EaseType.Linear,
          keyframes: [
            { key: 0, value: 0 },
            { key: 1, value: 1 },
          ],
        },
      ],
    },
  }) as Property

type Triple = readonly [number, number, number]

const point = ([x, y, z]: Triple) => ({ x: curveValue(x), y: curveValue(y), z: curveValue(z) })

const transform = (position?: Triple, rotation: Triple = [0, 0, 0]): Property =>
  ({
    name: 'Node_Transform',
    type: 'transform',
    value: {
      order: [...DEFAULT_TRANSFORM_ORDER],
      ...(position
        ? {
            curves: {
              position: point(position),
              rotation: point(rotation),
              scale: point([1, 1, 1]),
            },
          }
        : {}),
    },
  }) as Property

const named = (type: string, name: string, properties: Property[]): Node => {
  const node = { type, properties: [] } as unknown as Node

  setNodeName(node, name)
  node.properties.push(...properties)
  return node
}

const lifeSpan = (value = FOREVER) => ({ name: 'Node_LifeSpan', type: 'float', value }) as Property

const flag = (name: string, value = true) => ({ name, type: 'boolean', value }) as Property

/** One particle at `position`, firing along the turned +Y. */
const oneShot = (
  name: string,
  position: Triple,
  {
    rotation,
    pressure = 0,
    life = FOREVER,
    frequency = 0,
    initial = 1,
    span = FOREVER,
  }: {
    rotation?: Triple
    pressure?: number
    life?: number
    frequency?: number
    initial?: number
    span?: number
  } = {},
): Node =>
  named('FxConeEmitter', name, [
    lifeSpan(span),
    transform(position, rotation),
    { name: 'Emitter_InitialParticles', type: 'integer', value: initial } as Property,
    curve('Emitter_Frequency', frequency),
    curve('Emitter_MaxParticles', 1000),
    curve('Emitter_InitLifeSpan', life),
    curve('Emitter_Pressure', pressure),
    curve('ConeEmitter_MinRadius', 0),
    curve('ConeEmitter_MaxRadius', 0),
    curve('ConeEmitter_MinSpread', 0),
    curve('ConeEmitter_MaxSpread', 0),
  ])

const sprite = (alpha = 1, rgb: Triple = [1, 0.5, 0.25]): Property[] => [
  color('BasicApp_Color', ...rgb),
  float('BasicApp_Alpha', alpha),
  { name: 'BasicApp_TexName', type: 'string', value: TEXTURE } as Property,
  {
    name: 'BasicApp_BlendInfo',
    type: 'blending',
    value: { source: BlendingMode.SourceAlpha, target: BlendingMode.One },
  } as Property,
]

const basic = (name: string, extra: Property[] = [], alpha = 1, span = FOREVER) =>
  named('FxBasicAppearance', name, [
    lifeSpan(span),
    transform(),
    ...sprite(alpha),
    flag('BasicApp_QuadTexture'),
    float('BasicApp_Size', 3),
    ...extra,
  ])

const crcOf = (node: Node): number => {
  const name = node.properties.find((one) => one.name === 'Node_Name')

  return getResourceId(name!.value as string, true)
}

interface Pair {
  app: Node | Node[]
  emitter: Node | Node[]
  /** Linked from the appearance, and under the root. */
  fields?: Node[]
  /** The appearance stands beside the root, the shape `FX/SPACE/dust.ale` uses. */
  beside?: boolean
}

// `sort` counts creation order and `id` is that plus one.
const instanceOf = (counter: { sort: number }, node: Node): NodeInstance => ({
  crc: crcOf(node),
  flags: 0,
  id: counter.sort + 1,
  sort: counter.sort++,
  children: [],
  targets: [],
})

/** Everything under one control root, each emitter naming its appearances in the order given. */
const effectOf = (name: string, under: Pair[], beside: Pair[] = []): Effect => {
  const counter = { sort: 0 }
  const root: NodeInstance = {
    crc: CONTROL_ROOT_ID,
    flags: 1,
    id: 1,
    sort: counter.sort++,
    children: [],
    targets: [],
  }
  const top: NodeInstance[] = [root]

  // Wires emitters to their appearances and those to their fields through `targets`; the
  // appearances sit beside the root when `beside`, else with the fields and emitters in `into`.
  const link = (pair: Pair, into: NodeInstance[]) => {
    const apps = [pair.app].flat().map((node) => instanceOf(counter, node))
    const fields = (pair.fields ?? []).map((node) => instanceOf(counter, node))
    for (const app of apps) app.targets = fields

    const emitters = [pair.emitter].flat().map((node) => instanceOf(counter, node))

    for (const emitter of emitters) emitter.targets = apps
    ;(pair.beside ? top : into).push(...apps)
    into.push(...fields, ...emitters)
  }
  for (const pair of under) link(pair, root.children)
  for (const pair of beside) link(pair, top)
  return { name, children: top }
}

const nodesOf = (pairs: Pair[]): Node[] =>
  pairs.flatMap(({ app, emitter, fields = [] }) => [
    ...[app].flat(),
    ...fields,
    ...[emitter].flat(),
  ])

const alchemyOf = (
  effect: Effect,
  pairs: Pair[],
  others: { effect: Effect; pairs: Pair[] }[] = [],
): Alchemy => ({
  nodes: {
    version: VERSION,
    nodes: [...nodesOf(pairs), ...others.flatMap((other) => nodesOf(other.pairs))],
  },
  effects: { version: VERSION, effects: [effect, ...others.map((other) => other.effect)] },
})

/**
 * Where each of `sprites` stands: clear of the menu, a grid of 8 at 60 from the camera. Five to a
 * row, 8 apart, rows going down.
 */
const grid = (at: number): Triple => [-6 + (at % 5) * 8, 14 - Math.floor(at / 5) * 8, 0]

/** Each routine at rest. A velocity of 0.001 gives the ones that read it a heading, and barely moves. */
const sprites = (): Alchemy => {
  const slow = { pressure: 0.001 }
  const pair = (
    name: string,
    app: (name: string) => Node | Node[],
    at: number,
    options?: Parameters<typeof oneShot>[2],
  ): Pair => ({ app: app(`${name}.app`), emitter: oneShot(`${name}.emt`, grid(at), options) })
  const rect = (name: string, extra: Property[]) =>
    named('FxRectAppearance', name, [
      lifeSpan(),
      transform(),
      ...sprite(),
      float('RectApp_Scale', 1),
      float('RectApp_Width', 2),
      float('RectApp_Length', 6),
      ...extra,
    ])
  const perp = (name: string) =>
    named('FxPerpAppearance', name, [
      lifeSpan(),
      transform(),
      ...sprite(),
      float('BasicApp_Size', 6),
    ])
  const pairs: Pair[] = [
    pair('lab_quad', (name) => basic(name), 0),
    pair(
      'lab_rolled',
      (name) => basic(name, [float('BasicApp_Rotate', 0.5), float('BasicApp_HToVAspect', 0.5)]),
      1,
    ),
    // The decomp and retail disagree on this one: see DECOMP-ERRORS.md.
    pair('lab_triangle', (name) => basic(name, [flag('BasicApp_QuadTexture', false)]), 2),
    pair(
      'lab_tri_texture',
      (name) => basic(name, [flag('BasicApp_QuadTexture', false), flag('BasicApp_TriTexture')]),
      3,
    ),
    pair(
      'lab_flip',
      (name) => basic(name, [flag('BasicApp_FlipTexU'), flag('BasicApp_FlipTexV')]),
      4,
    ),
    pair('lab_wrap', (name) => basic(name, [], 1.5), 5),
    pair('lab_rect', (name) => rect(name, []), 6, slow),
    pair('lab_rect_centered', (name) => rect(name, [flag('RectApp_CenterOnPos')]), 7, slow),
    // Turned so +Y comes at the camera, and its roll starts from +X.
    pair('lab_perp', perp, 8, { pressure: 0.001, rotation: [90, 0, 0] }),
    // Which of two the one emitter draws through: the second, green, by the reading.
    pair(
      'lab_two',
      (name) => [
        named('FxBasicAppearance', `first_${name}`, [
          lifeSpan(),
          transform(),
          ...sprite(1, [1, 0, 0]),
          flag('BasicApp_QuadTexture'),
          float('BasicApp_Size', 3),
        ]),
        named('FxBasicAppearance', `second_${name}`, [
          lifeSpan(),
          transform(),
          ...sprite(1, [0, 1, 0]),
          flag('BasicApp_QuadTexture'),
          float('BasicApp_Size', 3),
        ]),
      ],
      9,
    ),
  ]

  return alchemyOf(effectOf('lab_sprites', pairs), pairs)
}

/** Under the root, a clock of 5 that the reading says takes the particle along. Beside it, a control. */
const folder = (): Alchemy => {
  const under: Pair = {
    app: basic('lab_under.app', [], 1, 5),
    emitter: oneShot('lab_under.emt', [-2, 0, 0], { span: 5 }),
  }
  const beside: Pair = {
    app: basic('lab_beside.app'),
    emitter: oneShot('lab_beside.emt', [6, 0, 0]),
  }

  return alchemyOf(effectOf('lab_folder', [under], [beside]), [under, beside])
}

/** A streak and a chain, moving, to read by shape: how far apart the ends, and which UVs where. */
const motion = (): Alchemy => {
  const moving = { frequency: 5, initial: 0, life: 0.4, pressure: 30 }
  const blur: Pair = {
    app: basic('lab_blur.app', [flag('BasicApp_MotionBlur')]),
    emitter: oneShot('lab_blur.emt', [-4, -15, 0], moving),
  }
  const stretch: Pair = {
    app: named('FxRectAppearance', 'lab_stretch.app', [
      lifeSpan(),
      transform(),
      ...sprite(),
      flag('BasicApp_MotionBlur'),
      float('RectApp_Scale', 1),
      float('RectApp_Width', 2),
      float('RectApp_Length', 2),
    ]),
    emitter: oneShot('lab_stretch.emt', [8, -15, 0], moving),
  }
  const beam: Pair = {
    app: named('FLBeamAppearance', 'lab_beam.app', [
      lifeSpan(),
      transform(),
      ...sprite(),
      float('RectApp_Scale', 1),
      float('RectApp_Width', 2),
    ]),
    emitter: oneShot('lab_beam.emt', [20, -15, 0], { ...moving, frequency: 10, life: 0.5 }),
  }
  // Leaving along +X at exactly 1 of speed, so its roll starts from +Z instead (`0x6235e15`).
  const perpX: Pair = {
    app: named('FxPerpAppearance', 'lab_perp_x.app', [
      lifeSpan(),
      transform(),
      ...sprite(),
      float('BasicApp_Size', 6),
    ]),
    emitter: oneShot('lab_perp_x.emt', [10, 10, 0], { pressure: 1, rotation: [0, 0, -90] }),
  }
  const pairs = [blur, stretch, beam, perpX]

  return alchemyOf(effectOf('lab_motion', pairs), pairs)
}

/** Beams at rest, fed one still particle by each of several emitters: the whole chain, with no `dt` in it. */
const beams = (): Alchemy => {
  const beam = (name: string, extra: Property[]) =>
    named('FLBeamAppearance', name, [
      lifeSpan(),
      transform(),
      ...sprite(),
      float('RectApp_Scale', 1),
      float('RectApp_Width', 2),
      ...extra,
    ])
  const none = flag('BeamApp_DisablePlaceHolder')
  const chain = (tag: string, x: number, count: number) =>
    Array.from({ length: count }, (_, n) => oneShot(`lab_${tag}_${n}.emt`, [x, 12 - n * 6, 0]))
  const anchor = (tag: string, x: number) =>
    named('FLBeamField', `lab_${tag}.fld`, [lifeSpan(), transform([x, 18, 0])])
  const pairs: Pair[] = [
    // An odd and an even birth count, which is the mirror's parity.
    { app: beam('lab_beam_odd.app', [none]), emitter: chain('odd', -8, 3) },
    { app: beam('lab_beam_even.app', [none]), emitter: chain('even', 0, 4) },
    {
      app: beam('lab_beam_plain.app', [none, flag('BasicApp_QuadTexture', false)]),
      emitter: chain('plain', 8, 3),
    },
    // A head from the field: positions lag properties, and the oldest position goes.
    {
      app: beam('lab_beam_anchor.app', []),
      emitter: chain('anchor', 16, 3),
      fields: [anchor('anchor', 16)],
    },
    {
      app: beam('lab_beam_dupe.app', [flag('BeamApp_DupeFirstParticle')]),
      emitter: chain('dupe', 24, 3),
      fields: [anchor('dupe', 24)],
    },
  ]

  return alchemyOf(effectOf('lab_beams', pairs), pairs)
}

/** Sub-effects: placed at a particle, turned onto its velocity, and started where one dies. */
const child = (): Alchemy => {
  const spawner = (name: string, extra: Property[]) =>
    named('FxParticleAppearance', name, [
      lifeSpan(),
      transform(),
      { name: 'ParticleApp_LifeName', type: 'string', value: 'lab_child_life' } as Property,
      ...extra,
    ])
  const tinted = (name: string, rgb: Triple) =>
    named('FxBasicAppearance', name, [
      lifeSpan(),
      transform(),
      ...sprite(1, rgb),
      flag('BasicApp_QuadTexture'),
      float('BasicApp_Size', 2),
    ])
  // Three up its own +Y, so it lands three along the parent's velocity when turned.
  const life: Pair = {
    app: tinted('lab_life.app', [1, 0.5, 0.25]),
    emitter: oneShot('lab_life.emt', [0, 3, 0]),
  }
  const death: Pair = {
    app: tinted('lab_death.app', [0, 1, 0]),
    emitter: oneShot('lab_death.emt', [0, 0, 0]),
  }
  const pairs: Pair[] = [
    { app: spawner('lab_still.app', []), emitter: oneShot('lab_still.emt', [-4, 10, 0]) },
    {
      app: spawner('lab_turned.app', [flag('ParticleApp_UseDynamicRotation')]),
      emitter: oneShot('lab_turned.emt', [10, 10, 0], { pressure: 0.001, rotation: [0, 0, -90] }),
    },
    {
      app: spawner('lab_dying.app', [
        { name: 'ParticleApp_DeathName', type: 'string', value: 'lab_child_death' } as Property,
      ]),
      emitter: oneShot('lab_dying.emt', [24, 2, 0], { life: 2 }),
    },
  ]

  return alchemyOf(effectOf('lab_child', pairs), pairs, [
    { effect: effectOf('lab_child_life', [life]), pairs: [life] },
    { effect: effectOf('lab_child_death', [death]), pairs: [death] },
  ])
}

/** `FxOrientedAppearance`, kept to its own scene: retail's pool of it is 0, and may not survive a spawn. */
const oriented = (): Alchemy => {
  const sprite2 = (name: string, frame: Property, extra: Property[] = []) =>
    named('FxOrientedAppearance', name, [
      lifeSpan(),
      frame,
      ...sprite(),
      float('RectApp_Scale', 1),
      float('OrientedApp_Width', 3),
      float('OrientedApp_Height', 2),
      ...extra,
    ])
  const pairs: Pair[] = [
    { app: sprite2('lab_flat.app', transform()), emitter: oneShot('lab_flat.emt', [-6, 10, 0]) },
    // The appearance's own frame turns it.
    {
      app: sprite2('lab_framed.app', transform([6, 10, 0], [0, 0, 30])),
      emitter: oneShot('lab_framed.emt', [6, 10, 0]),
    },
    {
      app: sprite2('lab_keyed.app', transform(), [
        { ...transform([1, 2, 0], [0, 0, 45]), name: 'MeshApp_ParticleTransform' } as Property,
      ]),
      emitter: oneShot('lab_keyed.emt', [18, 10, 0]),
    },
  ]

  return alchemyOf(effectOf('lab_oriented', pairs), pairs)
}

/** A dust field's age by depth, at rest, and an air field's velocity, read off a rect's stretch. */
const fields = (): Alchemy => {
  const dustField = named('FLDustField', 'lab_field_dust.fld', [
    lifeSpan(),
    transform([0, 0, 0]),
    curve('SphereEmitter_MaxRadius', 20),
  ])
  const aged: Pair = {
    app: named('FxBasicAppearance', 'lab_aged.app', [
      lifeSpan(),
      transform(),
      ...sprite(),
      flag('BasicApp_QuadTexture'),
      float('BasicApp_Size', 1),
      ramped('BasicApp_Alpha'),
    ]),
    fields: [dustField],
    emitter: [
      // Depths through the sphere of a quarter, a half and three quarters. Life 10, so alpha is depth.
      oneShot('lab_aged_0.emt', [0, 0, -10], { life: 10 }),
      oneShot('lab_aged_1.emt', [4, 0, 0], { life: 10 }),
      oneShot('lab_aged_2.emt', [8, 0, 10], { life: 10 }),
      // In the back's outer fifth, so faded: 1 - (356 - 320) / 80 of its depth of a tenth.
      oneShot('lab_aged_3.emt', [10, 0, -16], { life: 10 }),
      // Outside: age `FLT_MAX`, and gone.
      oneShot('lab_aged_4.emt', [16, 0, -25], { life: 10 }),
    ],
  }
  const air: Pair = {
    app: named('FxRectAppearance', 'lab_blown.app', [
      lifeSpan(),
      transform(),
      ...sprite(),
      flag('BasicApp_MotionBlur'),
      float('RectApp_Scale', 1),
      float('RectApp_Width', 2),
      float('RectApp_Length', 2),
    ]),
    // Turned so its +Y blows along +X, and an approach that reaches it in one step.
    fields: [
      named('FxAirField', 'lab_air.fld', [
        lifeSpan(),
        transform([0, 0, 0], [0, 0, -90]),
        curve('AirField_Magnitude', 30),
        curve('AirField_Approach', 100),
      ]),
    ],
    emitter: oneShot('lab_blown.emt', [-10, -12, 0], { frequency: 3, initial: 0, life: 0.5 }),
  }
  const pairs = [aged, air]

  return alchemyOf(effectOf('lab_fields', pairs), pairs)
}

/** The pool of 1,000 basics, overfilled by a second appearance, which evicts the first's oldest. */
const pool = (): Alchemy => {
  const faint = (name: string) => basic(name, [float('BasicApp_Size', 1)], 0.05)
  const pairs: Pair[] = [
    {
      app: faint('lab_pool_a.app'),
      emitter: oneShot('lab_pool_a.emt', [-4, 0, 0], { initial: 1000 }),
    },
    {
      app: faint('lab_pool_b.app'),
      emitter: oneShot('lab_pool_b.emt', [8, 0, 0], { initial: 100 }),
    },
  ]

  return alchemyOf(effectOf('lab_pool', pairs), pairs)
}

/** Dust around a travelling camera: few enough that a capture dumps every kite. */
const dust = (): Alchemy => {
  const pair: Pair = {
    app: named('FLDustAppearance', 'lab_dust.app', [
      lifeSpan(),
      transform(),
      ...sprite(),
      float('BasicApp_Size', 1),
    ]),
    beside: true,
    fields: [
      named('FLDustField', 'lab_dust.fld', [
        lifeSpan(),
        transform([0, 0, 0]),
        curve('SphereEmitter_MaxRadius', 50),
      ]),
    ],
    emitter: named('FxSphereEmitter', 'lab_dust.emt', [
      lifeSpan(),
      transform(),
      curve('Emitter_Frequency', 100),
      curve('Emitter_MaxParticles', 12),
      curve('Emitter_InitLifeSpan', 10),
      curve('Emitter_Pressure', 0),
      curve('SphereEmitter_MinRadius', 15),
      curve('SphereEmitter_MaxRadius', 40),
    ]),
  }

  return alchemyOf(effectOf('lab_dust', [pair]), [pair])
}

export const GENERATED_EFFECTS = {
  sprites,
  folder,
  motion,
  beams,
  child,
  oriented,
  fields,
  pool,
  dust,
} as const

export type GeneratedEffect = keyof typeof GENERATED_EFFECTS
