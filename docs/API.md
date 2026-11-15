# API

What the package is made of and what it exports. Everything public comes from the one entry point,
`@treewyrm/freelancer-webgl2`; THN playback is the `thorn` namespace on it. Each export's doc
comment in the source says which retail function it follows. This page says what it's for, and how
the pieces fit.

[README.md](../README.md) has a first example, and [ARCHITECTURE.md](ARCHITECTURE.md) explains why
the design is shaped this way.

- [What's what](#whats-what)
- [Conventions](#conventions)
- [Rendering](#rendering): context, renderer, frames, hooks
- [Preview frames](#preview-frames): models and effects under the host's lights
- [Models](#models): placement, level of detail, materials, meshes
- [Planets and spheres](#planets-and-spheres)
- [Characters](#characters): skinning and the animation mixer
- [Effects](#effects): Alchemy
- [Space frames](#space-frames): a whole system
- [Room frames](#room-frames): bases
- [Cutscenes](#cutscenes-thorn): the `thorn` namespace
- [Recipes](#recipes)
- [Gaps](#gaps)

## What's what

```
host: bytes, camera, time, seed, canvas
        │  read with @treewyrm/freelancer
        ▼
scene        plain data the host builds: Scene, SpaceScene, RoomScene or InterfaceScene
        │  collectFrame, collectSpaceFrame, collectRoomFrame, collectInterfaceFrame: no GL
        ▼
frame        Frame: an ordered list of draws, effects and hook points
        │  renderer.render(frame, hooks): all the GL is here
        ▼
canvas       the host's hooks draw at their points
```

The host reads game files with [`@treewyrm/freelancer`](https://www.npmjs.com/package/@treewyrm/freelancer),
describes what is on screen as a **scene**, and collects a **frame** from it. Collecting is pure: it
decides order, level of detail, lighting and fog without touching GL, so it's testable in Node and
comparable with a capture from retail. The **renderer** draws a frame and owns every GPU resource.

### Source layout

| Directory          | Holds                                                         | Public |
| ------------------ | ------------------------------------------------------------- | ------ |
| `src/index.ts`     | The entry point: every public export                          | Yes    |
| `src/gl/`          | Context and program creation                                  | Partly |
| `src/texture/`     | Texture upload plans and samplers                             | No     |
| `src/mesh/`        | Vertex layouts, index plans, generated sphere patches         | Partly |
| `src/material/`    | `[MaterialMap]`, one GLSL program per material family         | Partly |
| `src/scene/`       | Camera, frames, lights, space, rooms, everything in a system  | Yes    |
| `src/deformable/`  | Skinned meshes, bone tables, switch tables, animation mixer   | Yes    |
| `src/alchemy/`     | Effect trees, the particle simulation, effect draws           | Yes    |
| `src/thorn/`       | THN playback: clock, events, paths, lights, fog, sequences    | `thorn` |
| `src/capture/`     | Reads d3d8log captures; tests only                            | Never  |
| `src/reference/`   | Reference scenes, retail loaders, `view`, `bench`; tools only | Never  |
| `src/harness.ts`   | Runs GPU tests in headless Chromium                           | Never  |
| `tools/d3d8log/`   | Proxy `d3d8.dll` that captures retail frames, C++             | Never  |

`src/reference/` is not public, but it's the most complete example of a host: `space-load.ts` builds
a whole retail system into a `SpaceScene`, `retail-room.ts` builds a base, and `thorn.ts` plays a
cutscene.

## Conventions

**Math types** are `@treewyrm/freelancer/math`'s: `Vector3`, `Vector4`, `Matrix3`, `Matrix4`, `Quat`.
Matrices are column-major. World space is the game's, right-handed with +Y up.

**`Camera`** is `{ position, orientation, fovh, near, far }`. `orientation` is a `Matrix3` of
**rows**, as a THN `orient` reads; the camera looks down its local −Z with +Y up. `fovh` is **half**
the horizontal angle, in degrees. Aspect is passed beside it, as width over height.

**Colours come in two scales.** Where a field mirrors an INI key, it takes the value **as written**,
0 to 255: `SpaceScene.ambient`, `SpaceLight.color`, `RoomScene.ambient`, `SpaceNebula.ambient`. A
colour already in device terms is 0 to 1: `Scene.ambient`, `SceneLight.color`, `background`. Each
field's comment says which.

**Time is the host's.** Nothing reads a clock. `time` is the host's clock in seconds, for texture and
UV animation. `step` is seconds since the last frame, for what advances: blinks, lightning, dust, rocks.
`thorn` counts whole milliseconds, as the game does.

**Randomness is the host's.** Anything that rolls dice takes a `Random`, a function returning whole
numbers 0 to 32767 like C's `rand()`. Left out, it falls back to `Math.random`, so pass one to get
the same frames twice. Retail draws from one global stream, so its exact rolls can't be matched,
only their kind.

**Hardcoded engine numbers are defaults.** Each `RETAIL_*` export is what retail hardcodes. Where a mod
could patch it, the scene takes a `Partial` override, such as `SpaceScene.limits` over
`RETAIL_SPACE_LIMITS`.

**Absence is `undefined`.** An optional key left out means the retail default, which its comment names.

**GPU caches are keyed on object identity.** The renderer builds buffers and textures for the
`VMeshData` and `Texture` objects a frame holds, and reuses them while the same object comes back.
Pass the raw objects, not reactive proxies. After editing one in place, call `renderer.invalidate`.

**The INI is the host's.** This library never parses a game format. A type like `CloudSettings` or
`Star` is a section's keys, already read; the host fills it from `@treewyrm/freelancer/ini`.

**Supporting types are named for what they configure**, and this page doesn't list them all.
`XSettings` is an INI section's keys (`CloudSettings`, `BandSettings`), `XOptions` a call's options
(`DustOptions`, `SphereOptions`), `XLimits` the shape of `RETAIL_X_LIMITS`, and `XField` or `XView`
what a class or function needs from its surroundings. Every one is exported, with a comment on each
field.

**Classes hold state across frames.** Anything that runs over time is a class the host keeps for
as long as the thing exists: `EffectInstance`, `Clouds`, `NebulaLightning`, `AsteroidBillboards`,
`SpaceDust`, `BeamEffect`, `LightBlink`, `Mixer`, `thorn.Playback`. Everything else is a function.

## Rendering

| Export           | Is                                                                  |
| ---------------- | ------------------------------------------------------------------- |
| `createContext`  | `(canvas, attributes?) → WebGL2RenderingContext`, or throws         |
| `createRenderer` | `(gl) → Renderer`                                                   |
| `Renderer`       | `render(frame, hooks?, options?)`, `invalidate(asset)`, `dispose()` |
| `RenderOptions`  | `{ viewport?, over? }`: a `ViewportRect` `{ x, y, width, height }` to draw in, and whether to draw over what the target holds |
| `FrameHooks`     | `{ begin?, opaque?, end? }`, each `(context: HookContext) => void`  |
| `HookContext`    | `{ gl, frame, viewProjection, outlineEffects }`                     |
| `createProgram`  | Compiles GLSL ES 3.00 and looks up named uniforms, for a host's own |
| `Program`        | `{ handle, uniforms }`                                              |

`createContext` accepts an `HTMLCanvasElement` or `OffscreenCanvas`, so the whole library runs in a
worker. It needs WebGL2, and `WEBGL_compressed_texture_s3tc` for DXT textures.

**Give it an opaque canvas: `{ alpha: false }`.** The game's back buffer has no say in the picture,
so its passes write whatever alpha their stages compute and nothing reads it back. A canvas with an
alpha channel hands those values to the page, which composites through them. The planet surfaces
show it worst ([MATERIALS.md](retail/MATERIALS.md#the-planet-surfaces)): pass A leaves its texels'
alpha, 0 under a `DetailMap2Dm1Msk2PassMaterial`'s land, and pass B blends a partial alpha over
cloud, so the surface turns white and the cloud into holes, while every draw is right. A blended
effect or glass leaves the same marks, fainter. `createContext` takes the attributes as given.

`render` returns `false` while the context is lost. The renderer keeps nothing but GPU handles keyed on
what frames hold, so after a restore the next frame rebuilds everything; the host does nothing.

`options.viewport` draws and clears that rectangle alone, as D3D's viewport and `Clear` do, and
leaves the rest of the target as it was. It's how a cinematic's letterbox is drawn: with `Letterbox`'s
`bar`, the picture is `{ x: 0, y: bar, width, height: height − 2·bar }`, and the scene's `aspect` is
the picture's, so the horizontal angle holds. The host paints the bars. Without it the frame fills
the target, as before.

`options.over` keeps the target's colour and clears depth alone, so a frame lies over the one drawn
before it, as the interface lies over a room. The frame's `background` is then not drawn.

`invalidate(asset)` frees what was built from a `VMeshData`, `Texture` or `CubeTexture` the host
edited; the next frame uploads it afresh. `dispose()` frees everything.

### Hooks

A hook is where the host draws its own visuals, such as guides, gizmos, outlines and selection.
`begin` runs after the clear, `opaque` before the first blended draw, and `end` after everything.
Hooks sit between draws and never reorder them.

A hook gets the depth buffer as the game path left it and a `viewProjection` that includes D3D's
half-pixel shift, so its lines land on the pixels the model did. It may change any GL state: the
renderer restores its own afterwards. A frame whose hooks draw nothing is identical, pixel for
pixel, to one with no hooks.

`outlineEffects(effects, style)` draws each sprite of the given effects as this frame's camera sees
it: an outline, two axes and a normal, styled by `SpriteFrameStyle`. It's for an effect editor.

### Frame

`Frame` is what every collector returns, plain data the host can read or test:

| Field                         | Holds                                                        |
| ----------------------------- | ------------------------------------------------------------ |
| `draws`                       | `Draw[]`, in the game's order                                |
| `effects`                     | `EffectDraw[]`, after `draws`, in each effect's tree order   |
| `hooks`                       | `FrameHook[]`: each hook's name and the draw it precedes      |
| `view`, `projection`          | The camera's matrices                                         |
| `ambient`, `lights`, `background` | Frame-wide lighting and the clear colour                 |
| `tractors`, `beams`, `screenQuads`, `afterEffects`, `atEnd`, `clearDepth` | Space only: the later passes, in order |
| `effectFog`, `effectDepthFunc` | Fog and depth test over every effect                        |
| `unsupported`                 | What didn't draw as authored: a mesh, texture or material not found |
| `unregistered`                | Materials of a type no DLL registers: retail draws nothing either |

A `Draw` is one indexed draw call with everything it needs in GL terms: mesh range, world matrix,
material colours, up to two texture stages, cull, depth and blend state, alpha test, fog, lights and an
optional bone table. Retail's D3D values are translated where they're collected. `SpaceFrame` adds
`effectViews` and `RoomFrame` adds `shadowScale`; see their sections.

## Preview frames

`collectFrame(scene: Scene) → Frame` draws models and effects under lights the host chooses. It has no
game frame to match, so it's what a model viewer, character editor or material preview uses.

| `Scene` field  | Is                                                                    |
| -------------- | --------------------------------------------------------------------- |
| `camera`, `aspect` | The view                                                          |
| `ambient`      | 0 to 1                                                                |
| `lights`       | `SceneLight[]`: directional, or point with `position` and `range`, or a spot with `spot` |
| `models`       | `SceneModel[]`, drawn in the order given                              |
| `effects`      | `SceneEffect[]`, after the models                                     |
| `background`   | The clear, 0 to 1. Black when absent                                  |
| `time`         | Seconds, for texture and UV animation                                 |
| `limits`       | Over `RETAIL_FRAME_LIMITS`                                            |

**`SceneModel`** is one placed model and the lookups its draws resolve through:

| Field                  | Is                                                                      |
| ---------------------- | ----------------------------------------------------------------------- |
| `parts`                | `PlacedPart[]`: each mesh reference and its world matrix                |
| `mesh`, `material`, `texture` | Lookups by mesh id, material id and texture name               |
| `environment`          | The archetype's `envmap_material`: a cube to reflect                    |
| `fade`                 | 0 to 1, read by nomad surfaces and the cloak                            |
| `cloaked`              | Draw through `CloakMaterial`                                            |
| `materialAnimations`   | UV animations, found by material name                                   |
| `materialMap`          | A mod's `[MaterialMap]`; retail's `MATERIAL_MAP` when absent            |
| `sky`                  | `'starsphere'` or `'backdrop'`: drawn at the camera, ignoring depth     |
| `instance`             | Per-instance ambient and alpha, over the material's                     |

**`SceneEffect`** is `{ instance: EffectInstance, texture, visible? }`. `visible` hides appearances
without stopping them, which is for an editor.

`isBuiltType(type)` says whether `collectFrame` draws a material type. `RETAIL_FRAME_LIMITS` holds
glass's least alpha and the backdrop's own near and far planes.

## Models

### Placing parts

| Export           | Does                                                                        |
| ---------------- | --------------------------------------------------------------------------- |
| `placeParts`     | `(model: RigidModel, transform, options?) → PlacedPart[]`, depth first      |
| `PlaceOptions`   | `camera` for the game's LOD pick, `lod` lists, `detail`, a pinned `level`, `visible`, `jointState` |
| `partTransforms` | Every part's world transform, `W_child = W_parent · L_child`                |
| `attachJoint`    | The joint that hangs a child's hardpoint on a parent's, as equipment mounts |
| `instanceExtent` | A model's bounding sphere as it loads                                       |

A `PlacedPart` is a mesh reference and its world matrix. It may also carry a generated `mesh`, a
`materialId` override, a `skin`, an eye offset or a sphere's `extent`. A host that poses its own parts
can build them directly.

### Level of detail

`placeParts` picks levels itself when given a `camera`. These are the pieces, for a host that needs them:

| Export        | Does                                                                         |
| ------------- | ---------------------------------------------------------------------------- |
| `LodList`     | An archetype's `LODranges`, or one `[LOD]` block's                           |
| `lodScale`    | The `level_of_detail` option's effect: low detail, and the far scale         |
| `lodRange`    | The archetype's `LodPick`: past it the object draws nothing                  |
| `levelEnds`   | Each level's end for a part, the lists over the model's own `Switch2`        |
| `levelMetric` | What a level is picked by: the view depth of the part's centre, by the view's width |
| `levelAt`     | The level for a metric, or none past the last                                |

### Camera

| Export             | Does                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| `viewMatrix`       | `Mᵀ(p − position)`: world to the game's view space                       |
| `projectionMatrix` | `(camera, aspect)`: D3D's projection, expressed for GL's clip space      |
| `underPixel`       | Whether a sphere at a depth covers under one pixel, as a room culls      |
| `Viewport`         | `{ width, height }` in pixels                                            |

### Materials and meshes

| Export                | Does                                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| `MATERIAL_MAP`        | Retail's `[MaterialMap]` rules, in file order                          |
| `mapMaterialType`     | The type a material is created as, after the rules; the last match wins |
| `MaterialMapRule`     | `{ on: 'name' \| 'type', pattern, to }`                                |
| `sampleUvAnimation`   | A material's UV animation at a time, as `{ offset, scale }`            |
| `vertexLayout`        | An FVF's attribute layout                                              |
| `ATTRIBUTE_LOCATIONS` | The fixed attribute slots every program shares                         |
| `planReference`       | A mesh reference's indices made absolute, and its groups               |

A material's `type` isn't its class: `[MaterialMap]` maps it first, and an unregistered result draws
nothing. Pass a mod's own rules as `SceneModel.materialMap`. [COVERAGE.md](COVERAGE.md) lists each
material class and how well it's verified.

## Planets and spheres

| Export                 | Does                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `placeSphere`          | A sphere's visible faces as parts, then its atmosphere shell's           |
| `SphereOptions`        | `camera`, viewport `width`, a pinned `level`, the `material` lookup, `levels` |
| `sphereLevel`          | The tessellation level for a radius and a pixel's world size             |
| `RETAIL_SPHERE_LEVELS` | The level's bounds and bias                                              |
| `solarSphereLevels`    | What the `level_of_detail` slider sets them to (see its comment for when) |

The sphere's mesh is generated, so its parts carry their own `mesh` and are rebuilt as the camera moves.

## Characters

### Skinning

| Export          | Does                                                                        |
| --------------- | --------------------------------------------------------------------------- |
| `placeCostume`  | A character's parts, body first, their skeletons joined by hardpoint name  |
| `costumeWorlds` | Every bone's world, joined as `placeCostume` joins them: a THN host's `bone` and `hardpoint` for a character |
| `placeSkin`     | One deformable model as a one-part costume                                  |
| `poseSkin`      | One level, for a host that poses and joins its own bones                    |
| `SkinOptions`   | `level` or `lod`, `skinnedLevels`, `jointState`, `pose: 'chain' \| 'bind'`  |
| `skinMesh`      | A level's mesh and per-vertex influences, cached so characters share buffers |
| `boneTable`     | The bone matrices a skinned draw reads                                      |
| `MAX_BONES`     | 150, the game's table size                                                  |

`pose: 'bind'` shows the skin as modelled. `'chain'`, the default and what the game draws, applies the
joints' rest pose and `jointState`. A body's rest pose only looks right under a script.

**Switch tables** pick a character part's level from `bodyparts.ini`'s `[DetailSwitchTable]`:
`switchDistance`, `adjustedDistance`, `costumeLevel`, `SwitchTable` and `RETAIL_SWITCH_FOVX`. Pass them
as `SkinOptions.lod.tables`.

### Animation mixer

`Mixer` plays `.anm` scripts on a character's joints, as `Deformable2`'s mixer does: stacked motions,
fades, a root that walks, and single-joint aims.

| Member                                 | Does                                                        |
| -------------------------------------- | ----------------------------------------------------------- |
| `new Mixer({ root, joints, position?, orientation? })` | Joints listed parent first, from the bone hierarchy |
| `start(script, options?)`              | Starts a motion: `MotionOptions` has start time, speed, weight, fade, flags, heading. Returns a handle |
| `stop(handle)`, `playing(handle)`      | Ends a motion at once, or asks whether it still runs        |
| `aim(joint, options)`, `setAimTarget`, `stopAim` | Points one joint at a rotation                    |
| `lock(name)`, `unlock(name)`           | Keeps later motions off a joint                             |
| `advance(dt)`                          | Ticks every stack and writes the joints, then the root      |
| `jointState(name)`                     | A joint's state, to pass as `SkinOptions.jointState`        |
| `root`, `floor`, `setRootPosition`, `setRootOrientation`, `setFloor` | The character's placement |

`MotionFlag` holds the event flags (backwards, loop, bounce, keep beneath). `EASE` and `fadeWeight`
are the mixer's fade curve.

## Effects

Alchemy effects are CPU simulations that the host steps. Each frame they add sprite and triangle draws,
and the vertex shader carries each particle from its birth record to now.

| Export           | Does                                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| `buildEffect`    | `(effect, resolve) → EffectScene`: the node tree, with every CRC resolved    |
| `lookupOver`     | `(effects, resolve) → EffectLookup`: effects by name, for particle appearances that spawn effects |
| `ResolveNode`    | `(crc) → Node \| undefined`: the host's index over every loaded `.ale`       |
| `EffectInstance` | One running effect                                                           |
| `createPools`    | `(seed?, sizes?) → EffectPools`: shared particle pools and random stream     |
| `RETAIL_POOLS`   | Each appearance kind's pool size, from `dacom.ini`                           |

| `EffectInstance` member | Does                                                                  |
| ----------------------- | --------------------------------------------------------------------- |
| `new EffectInstance(scene, { lookup?, pools? })` | Effects sharing `pools` compete for particles as in the game |
| `advance(dt, { sparam?, lod?, placement?, view? })` | One game frame. `sparam` keys animated properties, such as an engine's throttle. `placement` is where it is. `view` is the camera's, which dust reads |
| `stop()`                | Emitters stop and what they made lives out                            |
| `release()`             | Gone at once; frees its share of the pools                            |
| `finished`              | Nothing left to show or make                                          |
| `time`                  | Its clock, in seconds                                                 |
| `eachParticle(visit)`   | Every live particle's node, age, life, world position and velocity    |

An effect reaches a frame as a `SceneEffect`. `EffectDraw` is `SpriteDraw | TriangleDraw`, the frame's
`effects` entries, exported for hosts that inspect them.

## Space frames

`collectSpaceFrame(scene: SpaceScene) → SpaceFrame` frames a system as the game frames space: the
starsphere, its far list of distant solars and nebulae, objects lit by their own nearest lights and
fogged by the nebula they're in, asteroid fields, rings, dust, effects by type, laser shots, tractor
beams, light flares, suns' coronas and flares, and the cockpit.

Several things in space keep state from frame to frame, such as nebula lightning, clouds, rocks and
dust. `collectSpaceFrame` advances them by `step`, so **call it once per displayed frame**, with
`cut: true` on the first.

### `SpaceScene`

Only `camera`, `aspect`, `ambient`, `lights` and `objects` are required. Everything else adds a layer.

| Field                                   | Is                                                          |
| --------------------------------------- | ----------------------------------------------------------- |
| `camera`, `aspect`                      | The view; its `far` is replaced by `farClip`                |
| `ambient`                               | `[Ambient] color`, 0 to 255                                 |
| `lights`                                | `SpaceLight[]`, the system's `[LightSource]`s in file order |
| `objects`                               | `SpaceObject[]`: solars, ships, anything with a model       |
| `sky`                                   | Starsphere layers as `SceneModel`s, picked by `skyLayers(detail)` |
| `farClip`                               | `[SystemInfo] space_farclip`                                |
| `background`                            | `[System] space_color`, 0 to 1                              |
| `nebulae`                               | `SpaceNebula[]`, in file order                              |
| `asteroids`                             | `SpaceAsteroidField[]`, in file order                       |
| `rings`                                 | `PlanetRing[]` from `buildRing`                             |
| `effects`, `effectView`                 | `SpaceEffect[]`, and the options and tables their view test reads |
| `dust`, `dustZones`, `dustOptions`      | `SpaceDust`, the zones with `spacedust`, and its options    |
| `beams`, `beamTexture`                  | `BeamEffect[]` in flight, newest first, and `code_beam`     |
| `tractors`, `lineTexture`, `tractorRandom`, `tractorLimits` | Working tractors and what they need     |
| `viewport`, `shine`                     | Pixels, and `shine`'s texture: both needed for light flares |
| `sunEffect`, `rayHits`, `player`        | The `SunEffect` option, and what blocks a sun's rays        |
| `firstPerson`, `hud`, `cockpit`, `cockpitLimits`, `effectsOff` | The cockpit camera and its pass, over `RETAIL_COCKPIT_LIMITS` |
| `jump`                                  | The player's jump: see [Jump tunnels](#jump-tunnels)        |
| `time`, `step`, `cameraStep`, `cut`, `lane` | Clocks, a camera cut, and the trade-lane flag           |
| `limits`                                | Over `RETAIL_SPACE_LIMITS`, which also holds the nebula and frame limits |

**`SpaceObject`** is one object: its `model`, `position` and bounding `sphere`, and optionally `solar`
(large, planet, extent), `pilot`, `attached` equipment models, `flares`, a `star` for a sun, a `hitbox`
for corona rays, `nomad`, `distanceRender`, `lodRange` and a `nebula` hint. Its lighting is computed
per object; the host doesn't light it.

**`SpaceFrame.effectViews`** gives each of `scene.effects` its fate this frame, in order: `draw`,
`run` unseen, `die`, or `hold`, and the `lod` to step it at next. `PlacedEffects` acts on these for
you. **`SpaceFrame.asteroidCubes`** gives each of `scene.asteroids`, in order, the cubes drawn and the
centres tested, which an editor reads as a field's cost.

### Lights

| Export                | Does                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| `SpaceLight`          | A `[LightSource]`: type, position, direction, colour, range, curves       |
| `lightSet`            | `(lights) → LightSet`: the lights and their search grid, built once a frame |
| `lightObject`         | An object's four lights and ambient, as the game picks them               |
| `directionalLightsAt` | The directional lights at a point, as a band or billboards bake them      |
| `systemAmbient`       | `[Ambient] color` as the device takes it                                  |
| `equipmentLight`      | A `[Light]` equipment's light, which retail gives the player's ship       |
| `effectLight`         | An effect's light and its `[LightAnim]`                                   |
| `evaluateGraph`, `evaluateColorGraph`, `Graph` | `[IGraph]` curves, as the engine reads them      |

`collectSpaceFrame` builds the light set itself. These are for hosts that light things outside it.

### Nebulae

| Export                | Does                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| `zoneOf`              | `(shape, written?) → Zone`: a zone's geometry queries, for every shape    |
| `Zone`                | Position, radius, size, axes, `radiusAlong`, `surfacePoint`, `holds`, `meets` |
| `SpaceNebula`         | A `[Nebula]`: zone, fog, ambient, burnthrough, exclusions, lightning, fill, exterior, clouds |
| `nebulaState`         | Where the camera is in a nebula: depth, fog range, exclusion              |
| `listNebulae`, `pickField` | The nebula the camera answers to, and the rest for the far list      |
| `findNebula`          | The nebula a point is in                                                  |
| `fogEnd`, `fogFar`, `exteriorFactor`, `immersion` | The fog and depth queries behind them         |
| `NebulaLightning`     | One nebula's flashes: fog and light. Keep one per nebula; `fire` flashes now |
| `NebulaExterior`      | `[Exterior]`'s bits, seen from outside                                    |
| `Clouds`              | `[Clouds]`' puffs about the camera, in a nebula or a ring; `fire` flashes one |
| `fillSheetsDraw`, `fogOverlayDraw` | The two sheets across a nebula, and the fog overlay inside one |
| `textureHasAlpha`     | Whether the game blends a texture by its alpha, which exterior bits depend on |
| `RETAIL_NEBULA_LIMITS`, `RETAIL_EXTERIOR_LIMITS`, `RETAIL_BACKGROUND_LIGHTNING`, `RETAIL_DYNAMIC_LIGHTNING`, `NEBULA_CLOUD_VISIBILITY` | Defaults |

### Asteroid fields

A `SpaceAsteroidField` is a `CubeField` with its merged cube mesh, colours and optional parts:

| Export                 | Does                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| `mergeCube`            | A `[Cube]`'s asteroids merged into one mesh                             |
| `fieldCubes`, `nearField` | The cubes the walk draws from a camera, and how many centres it tested |
| `cubeOrientation`, `cubeId`, `closestCubePosition`, `entryOrientation`, `cubeRotations`, `RETAIL_CUBE_ROTATIONS` | The walk's pieces |
| `AsteroidBand`         | `[Band]` and `[ExclusionBand]`: the ring of texture around a field      |
| `AsteroidBillboards`   | `[AsteroidBillboards]`: distant rocks as triangles                       |
| `DynamicAsteroids`     | `[DynamicAsteroids]`: rocks that drift past the camera, with their effects |
| `CubeExclusion`        | An exclusion zone, and what it thins or takes                           |

### Rings, suns and flares

| Export                 | Does                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| `buildRing`            | A planet's ring from its `[Exterior]` and zone                          |
| `ringPieceDraw`, `ringImmersion`, `RING_CLOUD_VISIBILITY` | Its draws, the camera's depth in it, its clouds |
| `textureShape`         | A `[Shape]`'s rectangle in its texture, which rings, clouds and stars name |
| `Star`                 | A `[star]` and its glow, centre, lens glow, spines and lens flare        |
| `starRadius`           | The sun's sphere, for `SpaceObject.sphere`                              |
| `starGlowDraws`        | The sun's billboard glow                                                |
| `starCorona`, `starFlare`, `updateStar`, `starIntensity`, `starSettled` | Its corona, its lens flare, and their fades |
| `sunEffectQuality`, `sunLeastLod` | The `SunEffect` option's reach                                |
| `castRay`, `Hitbox`, `HitboxObject` | Rays against `.sur` hulls, which block a corona              |
| `FlareLight`, `RETAIL_FLARE_LIGHT` | A `[Light]`'s bulb and glow                                   |
| `LightBlink`           | Its blink. Keep one per light                                           |
| `flareQuads`           | Its screen quads                                                        |
| `SpaceFlare`           | `{ light, world, blink? }`, for `SpaceObject.flares`                    |

### Effects in space

| Export                 | Does                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| `PlacedEffects`        | Keeps effects alive across frames by key, and steps them as the game's walk does |
| `EffectPlacement`      | `{ key, start, world, sparam?, watched?, generic?, released? }`        |
| `viewEffect`           | One effect's view test                                                  |
| `RETAIL_EFFECT_TYPES`, `EFFECT_TYPE_NAMES`, `effectTypeIndex`, `effectLodType`, `effectLodRow` | `effect_types.ini`'s table and its names |
| `EffectViewOptions`    | `generic_effect_perf`, `[EffectType]` overrides, `[EffectLOD]` rows, viewport width |
| `SpaceDust`, `smallestDustZone`, `RETAIL_DUST_LIMITS` | Space dust about the camera                |

`PlacedEffects` is the usual way in. Each frame the host lists every effect that exists, keyed by
whatever names it (an engine, a hardpoint). `place` starts the new ones and returns the scene's
`effects`. After collecting, `step(scene, frame)` advances, ends or destroys each one by its view.

### Weapons

| Export                 | Does                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| `beamArchetype`        | A `[BeamSpear]` or `[BeamBolt]` section, held as retail holds it        |
| `BeamEffect`           | One shot: `place` it each frame, `kill(velocity)` when its life ends, drop it once `dead` |
| `lookMatrix`           | The turn a player's gun fires along                                     |
| `beamBatch`, `RETAIL_BEAM_LIMITS` | The frame's shot vertices, and the defaults                  |
| `TractorBeam`, `TractorArm`, `RETAIL_TRACTOR_LIMITS` | A working tractor, as plain data each frame  |

### Jump tunnels

| Export                 | Does                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| `GateTunnel`           | One loaded `[gate_tunnel]`: its curves, its layers' scroll, the ship's ride and the tunnel's light |
| `TunnelSettings`, `RETAIL_TUNNEL` | A `[gate_tunnel]`'s keys, and the constructor's defaults under them |
| `TunnelLayer`, `RETAIL_TUNNEL_LAYER` | A `[layer]`'s keys, at most two, and their defaults        |
| `TunnelState`          | 0 idle, 1 built for the jump out, 2 in the tunnel, 3 jumping in         |
| `SpaceJump`            | `{ ship, tunnel?, ambient, background }`, for `SpaceScene.jump`         |

The host plays the jump. It places the tunnel at the gate's `jump_out_hp` by setting `frame`, drives
it with `setState` and `update(step)`, and moves its ship to `tunnel.ship`. While `SpaceScene.jump`
is set, `collectSpaceFrame` draws the tunnel, the ship lit by `tunnel.light` over the jump's
ambient, and the jump and engine effects, and nothing else in the system. An editor can also call
`draws()` itself. Loading rolls the tunnel's curves, and so does each jump out, so pass a seeded
`random` to get the same tunnel every time.

## Room frames

`collectRoomFrame(scene: RoomScene) → RoomFrame` draws a base room: objects by sort layer, each lit by
its group's best four THN lights, with the room's fog, shadows and flashlights.

| `RoomScene` field  | Is                                                                      |
| ------------------ | ----------------------------------------------------------------------- |
| `camera`, `aspect`, `viewport` | The view; parts under a pixel are culled when `viewport` is given |
| `ambient`          | The `SCENE` entity's, 0 to 255. White when absent                       |
| `lights`           | `RoomLight[]`: THN lights that are on, with their `group`               |
| `objects`          | `RoomObject[]`, in the order made                                       |
| `fog`              | The `SCENE`'s fog, when on                                              |
| `shadows`          | `{ texture, scale?, limits? }`. Pass the last frame's `shadowScale` back as `scale` |
| `flashlights`, `flashlightTextures` | The room's `[FlashlightSet]`s and `[FlashlightLine]`s       |
| `effects`          | The scripts' `PSYS` effects                                             |
| `background`, `time`, `limits` | As in `Scene`                                               |

**`RoomObject`** is a `model` and `position`, with `layer` (sort group), `lightGroup`, `visible`,
`lit`, `fog`, `ambient`, its own `effects`, a `shadow` and its `flashlights`. `thorn.roomEntities`
fills everything but the model.

| Export                 | Does                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| `pickRoomLights`, `lightScore`, `lightRoomObject`, `ROOM_LIGHTS_PER_OBJECT` | How an object's lights are chosen |
| `FlashLight`           | One blinking light: `ofSet` for a room's set, `fromLight` for a prop's `[Light]`; `update(step)` each frame |
| `flashlightDraws`, `coneLevel`, `FLASHLIGHTS_PER_SET` | Their draws                              |
| `RoomShadow`, `shadowQuad`, `shadowDraw`, `RETAIL_SHADOW_LIMITS` | The floor shadows             |

## Interface frames

`collectInterfaceFrame(scene: InterfaceScene) → Frame` draws Win3D's 3D interface, its buttons, frames
and tabs, over another frame: render it with `{ over: true }` after that one. See
[retail/INTERFACE.md](retail/INTERFACE.md).

| `InterfaceScene` field | Is |
| ---------------------- | -- |
| `aspect`               | The surface's: the interface spans it whole, whatever a room letterboxes |
| `models`               | In draw order, the only order there is. Each placed in interface space, its tint in `instance` |
| `time`, `limits`       | As in `Scene` |

Every draw is unculled and tests no depth, under white ambient and no lights. A model's meshes are
the host's to give: every retail interface model takes them from `INTERFACE/interface.generic.vms`.

| Export                 | Does |
| ---------------------- | ---- |
| `INTERFACE_CAMERA`     | Win3D's camera: identity at the origin, `fovh` 27.216, near 0.1, far 1000 |
| `interfaceWorld`       | `(position, angle?) → Matrix4`: where a control's model stands, turned about +Y |
| `tintOf`               | `(colour) → instance`: a control's colour as `SetHolderTint` writes it, which only `ui_*` materials read |
| `InterfaceColour`      | `[r, g, b, a]`, bytes |
| `INTERFACE_CYAN`, `INTERFACE_AMBER`, `INTERFACE_GREY` | The palette: idle, and the pulse's far end and middle |
| `BUTTON_SELECTED`, `BUTTON_INACTIVE` | A selected button's yellow, an inactive one's grey |
| `InterfacePulse`       | The hover pulse: `reset()` on entering a button, `advance(seconds)` each frame, `colour` |
| `spinAngle`, `SPIN_SPEED` | `(angle, hovered, seconds) → angle`: a tab's spin, forward while hovered, home otherwise |

## Cutscenes: `thorn`

`import { thorn } from '@treewyrm/freelancer-webgl2'`. THN playback reproduces the game's clock,
event schedule, placement, paths, curves, lights, fog, cameras and sounds. It draws nothing. It says
where everything is, and a room or space frame draws that.

Scripts come from `@treewyrm/freelancer/thn/scene`. Entities are addressed by name.

### Playing a script

| Export                 | Does                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| `Playback`             | One script's state: `start`, `tick(ms)`, `stop`, `state`, `clock`       |
| `PlaybackOptions`      | `loop`, scene frame, `host`, shared `fog`, `createEffect`, `spawn` detail, `characters`, `resolve` |
| `ScriptRun`            | A script as a sequence plays it: `update(ms)` until `finished`; `skip()` |
| `frameMilliseconds`    | A frame's seconds to whole milliseconds, carrying the rest, as the game does |
| `replay`               | A fresh playback jumped to a time, as the game starts one               |
| `milliseconds`         | Seconds to the game's whole milliseconds                                |

What a playback answers each frame:

| `Playback` member      | Gives                                                                   |
| ---------------------- | ----------------------------------------------------------------------- |
| `world(name)`          | Where the host puts an entity                                           |
| `view(name)`           | A camera's or monitor's view, for `cameraOf` to make a `Camera`         |
| `roomLights()`         | Every light that's on, as `RoomLight[]`                                 |
| `roomFog`, `ambient`   | The `SCENE`'s fog and ambient                                           |
| `effects`              | Each running `PSYS`'s `EffectInstance`                                  |
| `motions`, `aims`      | Animations running on characters                                        |
| `sounds`               | Sounds playing, for the host to play                                    |
| `connections`          | `CONNECT_HARDPOINTS` links the host must make                           |
| `ignored`              | Event types in the script this library doesn't run yet                  |

The host answers back through `ThornHost` (hardpoints, bones, advance) and `CharacterHost` (motions,
aims, floor, root). `mixerCharacters({ mixer, animation })` is a `CharacterHost` built on `Mixer`.

### Rooms and sequences

| Export                 | Does                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| `RoomStage`            | A base room, live: the set script, its `scene` lines started by group behind their settings, `play` for any sequence over them, `advance(seconds)` on the game's clock, `view`, and `scene(host, options)` for the `RoomScene` it leaves |
| `StageSceneHost`       | What a frame asks the host: `model(category, template, world, camera, sky)`, `character`, `effectTexture`, each answered at once |
| `stageTemplates`       | Every `{ category, template }` a room with these scripts can ask for, to load ahead |
| `compoundHardpoint`    | A compound's hardpoint at rest, the last of a name winning: a `ThornHost['hardpoint']` from a loaded model |
| `createCast`, `castEntities` | A scene's characters, one mixer each at its record, from the costume parts and animations the host gives through `CastSource` |
| `readSetScript`        | A room's set script as data: props, cameras, setpoints, shadow and glare sources |
| `roomEntities`         | A playback's compounds and characters, with their `RoomObject` fields   |
| `Sequence`, `SequenceManager` | Scripts played in sequence, with offers, info boxes and skipping |
| `ambientSequence`      | A room's `scene = ambient, …` line, as a looping sequence               |
| `scriptAnchor`, `anchoredFrame` | Where a room character's script stands                         |
| `ViewTable`            | Which monitor shows, by priority                                        |
| `Letterbox`            | The cinematic bars, and the picture's aspect between them               |
| `cameraOf`, `rowsOf`   | A script camera as a renderer `Camera`                                  |
| `spawns`, `rtcEnabled`, `RtcSetting`, `renderTypeOf`, `userProp` | Which entities exist at a detail setting |

### Lower level

The namespace also exports the building blocks the playback is made of, for tests and tools: the event
factory (`eventsOf`, `flagWord`, `RUN`, `FLAGS`, `ThornEvent`, `Stage`), frames (`placement`,
`inverse`, `rotationOf`, `quaternionOf`, `nlerp`, `lookAt`, `axisTurn`, `connectedFrame`), curves and
paths (`createCurve`, `progress`, `createPath`), light, fog and audio blocks (`readLight`,
`blendLight`, `lightOf`, `roomLightOf`, `readFog`, `blendFog`, `roomFogOf`, `readAudio`, `blendAudio`,
`soundLevel`, with `DEFAULT_LIGHT`, `DEFAULT_AUDIO`, `NO_FOG` and `LIGHT_BITS`), and `retailSort`. Inside `thorn`, `Frame` is a `Matrix4`, not the
renderer's `Frame`.

## Recipes

Types and functions below are this package's unless imported otherwise. Each assumes a `renderer` from
`createRenderer(createContext(canvas, { alpha: false }))`.

### A model with a running effect

```ts
import { getResourceId } from '@treewyrm/freelancer'
import { getNodeName, readAlchemy, type Node } from '@treewyrm/freelancer/alchemy'
import { Directory } from '@treewyrm/freelancer/utf'

const alchemy = readAlchemy(Directory.read(aleBytes))!
const nodes = new Map<number, Node>()
for (const node of alchemy.nodes.nodes) nodes.set(getResourceId(getNodeName(node) ?? '', true), node)
const resolve = (crc: number) => nodes.get(crc)

const effect = new EffectInstance(buildEffect(alchemy.effects.effects[0]!, resolve), {
  lookup: lookupOver(alchemy.effects.effects, resolve),
})

const frame = (dt: number) => {
  effect.advance(dt, { view: viewMatrix(scene.camera) })
  renderer.render(collectFrame({ ...scene, effects: [{ instance: effect, texture }] }))
}
```

`texture` looks up `fx/efx.txm`'s entries by name, as a `SceneModel`'s does.

### A system, frame by frame

```ts
const placed = new PlacedEffects()
let first = true

const frame = (step: number) => {
  const effects = placed.place(placements(), effectView) // every engine, light, hardpoint effect
  const scene: SpaceScene = { ...system, camera, effects, effectView, step, cut: first }
  const collected = collectSpaceFrame(scene)
  placed.step(scene, collected) // ends, destroys or advances each effect by its view
  renderer.render(collected, { end: drawOverlays })
  first = false
}
```

`system` holds what's fixed for the system: its lights, objects, nebulae with their `NebulaLightning`,
`Clouds` and `NebulaExterior`, its fields, rings, `SpaceDust` and textures. Build it once.
`src/reference/space-load.ts` builds one from a retail install.

### A room with its button bar

```ts
const pulse = new InterfacePulse()

const frame = (seconds: number) => {
  pulse.advance(seconds)
  renderer.render(collectRoomFrame(room)) // or within the letterbox's viewport

  const models = bar.map(({ model, position, angle, state }) => ({
    ...placed(model, interfaceWorld(position, angle)), // the host's model, its meshes the generic library's
    instance: tintOf(state === 'selected' ? BUTTON_SELECTED : state === 'hovered' ? pulse.colour : INTERFACE_CYAN),
  }))

  renderer.render(collectInterfaceFrame({ aspect: width / height, models }), {}, { over: true })
}
```

### A room with its scripts

```ts
const stage = new thorn.RoomStage({
  set: thorn.readSetScript(setScript),
  scenes: sceneLines, // [Room_Info] scene, read: { mode, script, setting? }, in file order
  camera: roomCamera, // [Camera] name
  spawn: { rtc, slider }, // rtcslider.ini and the cutscene-detail setting
  host: {
    // A character's hardpoints are its cast's; a compound's, its model's (thorn.compoundHardpoint).
    hardpoint: (entity, name) => cast.hardpoint(entity, name) ?? propHardpoint(entity, name),
    bone: cast.bone,
    characters: cast.characters, // cast = thorn.createCast(scripts, { costume, animation })
    createEffect,
  },
})
stage.play([{ script: landing }], { cinematic: true, priority: 1 }) // anything over the room

// Ahead: every model the frame can ask for, since it asks at once.
for (const { category, template } of thorn.stageTemplates(stage.set, scripts))
  await load(category, template)

const frame = (seconds: number) => {
  stage.advance(seconds)

  const { scene, skipped } = stage.scene(
    { model: placed, character: cast.place, effectTexture },
    { aspect, spawn: { rtc, slider } },
  )
  renderer.render(collectRoomFrame(scene))
}
```

`placed`, `load` and `effectTexture` are the host's: which model file a `category` and template name
is (`petaldb.ini`, the archetype tables), the model placed at the given frame, and an effect's
textures. A host that reads a mod resolves those through `freelancer.ini`'s `[Data]`. The library
reads no INI. `src/reference/retail-room.ts` and `retail-cast.ts` are retail's answers, for the
captures and the reference tools.

## Gaps

- **Some sections only accept internal types**, such as `EffectScene` nodes (`NodeDescriptor`) and
  `Lane`. They're reachable from return values but not importable by name.
- **What's uncaptured** in retail, and so unverified, is listed per material in
  [COVERAGE.md](COVERAGE.md) and among the [open questions](VALIDATION.md#open-questions).
