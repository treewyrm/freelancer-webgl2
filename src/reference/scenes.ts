import { BAND_ANIMATIONS, BANDS, ONE_UV_BANDS, PLANET_BANDS } from './bands.js'
import { IDENTITY, rotation, type ReferenceScene } from './scene.js'

/** Identity orientation looks down -Z, as in the lab rig's `freelancer-testing/tests/mount.ts`. */
const CAMERA = {
  position: [0, 0, 0],
  orientation: IDENTITY,
  fovh: 30,
  near: 1,
  far: 10000,
} as const

const starsphere = (name: string, sky: NonNullable<ReferenceScene['sky']>): ReferenceScene => ({
  name,
  sky,
  camera: {
    position: [500, -200, 900],
    orientation: rotation(40, -15),
    fovh: 40,
    near: 1,
    far: 100000,
  },
  ambient: [0, 0, 0],
  lights: [],
})

export const scenes: ReadonlyMap<string, ReferenceScene> = new Map(
  [
    {
      // M1: a lit hull, three quarters on, so that no face is edge-on to the light.
      name: 'li_elite',
      model: {
        archetype: 'li_elite',
        category: 'Spaceship',
        position: [0, 0, -40],
        orientation: rotation(150, 20),
      },
      camera: CAMERA,
      ambient: [40, 40, 40],
      lights: [{ color: [255, 255, 255], direction: [0.5, -0.5, -1] }],
    } satisfies ReferenceScene,
    {
      // M1: a moved, turned camera, the one thing `li_elite` can't check. Its back axis, the third
      // row of a rotation here, points from the ship at the origin to the camera.
      name: 'li_elite_turned',
      model: {
        archetype: 'li_elite',
        category: 'Spaceship',
        position: [0, 0, 0],
        orientation: rotation(150, 20),
      },
      camera: {
        ...CAMERA,
        position: [-14, -8.293, 22.787],
        orientation: rotation(30, -20),
      },
      ambient: [40, 40, 40],
      lights: [{ color: [255, 255, 255], direction: [0.5, -0.5, -1] }],
    } satisfies ReferenceScene,
    {
      // M3: `D_glass` is a blended `DcDtOcOt` on an environment-mapped ship, so whether batching drops
      // the reflection, and whether it keeps submit order.
      name: 'ku_dragon',
      model: {
        archetype: 'ku_dragon',
        category: 'Spaceship',
        position: [0, 0, -40],
        orientation: rotation(150, 20),
      },
      camera: CAMERA,
      ambient: [40, 40, 40],
      lights: [{ color: [255, 255, 255], direction: [0.5, -0.5, -1] }],
    } satisfies ReferenceScene,
    {
      // M3: two objects' queued glass. The nearer comes first in the script, so far before near can't
      // be submit order, and if a room flushes once then both come after all of both hulls.
      name: 'ku_dragon_pair',
      model: {
        archetype: 'ku_dragon',
        category: 'Spaceship',
        position: [-8, 0, -40],
        orientation: rotation(150, 20),
        copies: [{ position: [12, 0, -70], orientation: rotation(150, 20) }],
      },
      camera: CAMERA,
      ambient: [40, 40, 40],
      lights: [{ color: [255, 255, 255], direction: [0.5, -0.5, -1] }],
    } satisfies ReferenceScene,
    {
      // M3: `DcDtEt`, `DcDtEc`, `BtDetailMapMaterial` and a queued glass on one environment-mapped
      // solar, far enough back to fit its radius of 303.
      name: 'prison',
      model: {
        archetype: 'prison',
        category: 'Solar',
        position: [0, 0, -800],
        orientation: rotation(150, 20),
      },
      camera: CAMERA,
      ambient: [40, 40, 40],
      lights: [{ color: [255, 255, 255], direction: [0.5, -0.5, -1] }],
    } satisfies ReferenceScene,
    {
      // M3: `DcDtOcOtTwo`, `DcDtEt` and `BtDetailMapMaterial` with no environment map. Its radius is
      // 2,558, and the far plane has to reach past it.
      name: 'lair_core',
      model: {
        archetype: 'lair_core',
        category: 'Solar',
        position: [0, 0, -6500],
        orientation: rotation(150, 20),
      },
      camera: { ...CAMERA, far: 20000 },
      ambient: [40, 40, 40],
      lights: [{ color: [255, 255, 255], direction: [0.5, -0.5, -1] }],
    } satisfies ReferenceScene,
    {
      // M3: a nomad surface, alone on a `.3db`. Its radius is 703.
      name: 'dyson_door_shield',
      model: {
        archetype: 'dyson_door_shield',
        category: 'Solar',
        position: [0, 0, -1800],
        orientation: rotation(150, 20),
      },
      camera: { ...CAMERA, far: 20000 },
      ambient: [40, 40, 40],
      lights: [{ color: [255, 255, 255], direction: [0.5, -0.5, -1] }],
    } satisfies ReferenceScene,
    {
      // M3: a nomad surface with its ramp, preloaded. Without that, this menu scene binds no ramp: its
      // materials resolve when the model loads, before the archetype's `nomad_fx.txm`.
      name: 'no_fighter',
      model: {
        archetype: 'no_fighter',
        category: 'Spaceship',
        position: [0, 0, -40],
        orientation: rotation(150, 20),
      },
      preload: [{ file: 'ships\\nomad\\nomad_fx.txm', texture: 'NomadRGB1_NomadAlpha1' }],
      camera: CAMERA,
      ambient: [40, 40, 40],
      lights: [{ color: [255, 255, 255], direction: [0.5, -0.5, -1] }],
    } satisfies ReferenceScene,
    {
      // M3: a material UV animation, on the one archetype in retail with any.
      name: 'lair',
      model: {
        archetype: 'lair',
        category: 'Solar',
        position: [0, 0, -7000],
        orientation: rotation(150, 20),
      },
      camera: { ...CAMERA, far: 30000 },
      ambient: [40, 40, 40],
      lights: [{ color: [255, 255, 255], direction: [0.5, -0.5, -1] }],
    } satisfies ReferenceScene,
    {
      // M3: every band its own material, for what retail barely uses and mods can name. Reflecting,
      // so the capture also shows which classes leave stage 1 free.
      name: 'bands',
      generated: { materials: BANDS, animations: BAND_ANIMATIONS },
      model: {
        archetype: 'reference_bands',
        category: 'Solar',
        position: [0, 0, -40],
        orientation: rotation(30, 20),
      },
      camera: CAMERA,
      ambient: [40, 40, 40],
      lights: [{ color: [255, 255, 255], direction: [0.5, -0.5, -1] }],
    } satisfies ReferenceScene,
    {
      // M3: a stage asking for a second UV set the mesh has not got.
      name: 'bands_one_uv',
      generated: { materials: ONE_UV_BANDS, uvSets: 1 },
      model: {
        archetype: 'reference_bands',
        category: 'Solar',
        position: [0, 0, -40],
        orientation: rotation(30, 20),
      },
      camera: CAMERA,
      ambient: [40, 40, 40],
      lights: [{ color: [255, 255, 255], direction: [0.5, -0.5, -1] }],
    } satisfies ReferenceScene,
    {
      // M3 and M4: the planet classes, which retail only has on spheres.
      name: 'bands_planet',
      generated: { materials: PLANET_BANDS },
      model: {
        archetype: 'reference_bands',
        category: 'Solar',
        position: [0, 0, -40],
        orientation: rotation(30, 20),
      },
      camera: CAMERA,
      ambient: [40, 40, 40],
      lights: [{ color: [255, 255, 255], direction: [0.5, -0.5, -1] }],
    } satisfies ReferenceScene,
    {
      // M4: a real `.sph`, `Masked2DetailMapMaterial` under its shell. Lit from the side, for the
      // terminator and the limb.
      name: 'planet_earth',
      model: {
        archetype: 'planet_earth_3000',
        category: 'Solar',
        position: [0, 0, -11500],
        orientation: rotation(30, 20),
      },
      camera: { position: [0, 0, 0], orientation: IDENTITY, fovh: 30, near: 10, far: 50000 },
      ambient: [40, 40, 40],
      lights: [{ color: [255, 255, 255], direction: [1, -0.3, -0.6], range: 100000 }],
    } satisfies ReferenceScene,
    {
      // M5: a body at the last keyframe of a one-shot gesture, turned to the camera and lit from the side.
      name: 'character_reed',
      character: {
        costume: 'reed',
        parts: [
          'CHARACTERS/BODIES/li_rockford_body.dfm',
          'CHARACTERS/HEADS/li_captain_head.dfm',
          'CHARACTERS/HANDS/benchmarkmalehandleft.dfm',
          'CHARACTERS/HANDS/benchmarkmalehandright.dfm',
        ],
        animations: 'CHARACTERS/ANIMATIONS/bodygenericmale.anm',
        script: 'Sc_MLBODY_CHRB_GESTL_WHAT_000LV_XA_03',
        duration: 1.77,
        position: [0, 0, 0],
        orientation: rotation(150, 0),
      },
      camera: {
        position: [0, 0.4, 4],
        orientation: IDENTITY,
        fovh: 25,
        near: 0.1,
        far: 100,
      },
      ambient: [40, 40, 40],
      lights: [{ color: [255, 255, 255], direction: [0.5, -0.5, -1] }],
    } satisfies ReferenceScene,
    {
      // M5: do retail's eyes move? The same pose in close-up, the eyes held on a marker off to one side.
      name: 'character_eyes',
      character: {
        costume: 'reed',
        parts: [
          'CHARACTERS/BODIES/li_rockford_body.dfm',
          'CHARACTERS/HEADS/li_captain_head.dfm',
          'CHARACTERS/HANDS/benchmarkmalehandleft.dfm',
          'CHARACTERS/HANDS/benchmarkmalehandright.dfm',
        ],
        animations: 'CHARACTERS/ANIMATIONS/bodygenericmale.anm',
        script: 'Sc_MLBODY_CHRB_GESTL_WHAT_000LV_XA_03',
        duration: 1.77,
        position: [0, 0, 0],
        orientation: rotation(150, 0),
        gaze: [3, 2.5, 2],
      },
      camera: {
        position: [0, 1.22, 4],
        orientation: IDENTITY,
        fovh: 5,
        near: 0.1,
        far: 100,
      },
      ambient: [40, 40, 40],
      lights: [{ color: [255, 255, 255], direction: [0.5, -0.5, -1] }],
    } satisfies ReferenceScene,
    // M4: the sky, four ways. A camera away from the origin, turned, shows it stays locked to it.
    starsphere('starsphere_li01', [
      { archetype: 'starsphere_Li01_stars', category: 'Prop', file: 'starsphere_li01_stars.cmp' },
      { archetype: 'starsphere_Li01', category: 'Prop', file: 'starsphere_li01.cmp' },
    ]),
    // `DcDt` alone, some of it with no normals or UVs, and reaching past 40,000.
    starsphere('starsphere_st03b', [
      { archetype: 'starsphere_St03b', category: 'Prop', file: 'starsphere_st03b.cmp' },
    ]),
    // No retail table names these two, as only their systems load them.
    starsphere('starsphere_ew05', [
      { archetype: 'reference_sky_ew05', category: 'Solar', file: 'starsphere_ew05.cmp' },
    ]),
    starsphere('starsphere_ew06', [
      { archetype: 'reference_sky_ew06', category: 'Solar', file: 'starsphere_ew06.cmp' },
    ]),
  ].map((scene) => [scene.name, scene]),
)
