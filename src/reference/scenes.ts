import { IDENTITY, rotation, type ReferenceScene } from './scene.js'

/** Identity orientation looks down -Z, as in the lab rig's `freelancer-testing/tests/mount.ts`. */
const CAMERA = {
  position: [0, 0, 0],
  orientation: IDENTITY,
  fovh: 30,
  near: 1,
  far: 10000,
} as const

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
  ].map((scene) => [scene.name, scene]),
)
