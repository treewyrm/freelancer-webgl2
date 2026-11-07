# Plan

The route from scaffold to replacing `freelancer-vscode`'s renderer. Update this file as work lands:
tick items, and change the plan when the evidence changes it.

**Why this project exists.** The extension's renderer began as guesswork and eyeballing, and later
disassembly brought it close to retail on top of foundations that were never derived from the game.
This project starts from the source so that new features build on structure rather than on patches.
An earlier attempt, `freelancer-render`, failed the other way, by transcribing the original.

## How to work through it

- **One item is one unit of work**, small enough to finish and verify in a session.
- **An item is done when its check passes**, not when the code exists.
- **Read the source first.** Note the decomp path and symbol in the code where it isn't obvious.
- **Update [COVERAGE.md](COVERAGE.md)** whenever a material's status moves.
- **"You"** marks a step that needs the running game. Everything else can be done without it.

## Status

| Milestone | Delivers | Status |
| --------- | -------- | ------ |
| [M0](#m0-retail-evidence) | Captures and screenshots from retail, on demand | Done |
| [M1](#m1-first-picture) | One static ship, matched against retail | Done, canopy deferred |
| [M2](#m2-in-the-model-viewer) | That ship in the real model viewer, with editor overlays | Done |
| [M3](#m3-every-rigid-model) | All materials on rigid models, with animation and LOD | Done, some override types untested |
| [M4](#m4-spheres-and-the-sky) | Planets, atmospheres, starspheres | Done, backdrop uncaptured |
| [M5](#m5-characters) | Skinned characters | Done, mid-script frames uncaptured |
| [M6](#m6-effects) | Alchemy effects | Done, dust and some fields uncaptured |
| [M7](#m7-the-space-frame) | A whole system, as the game frames it | **In progress** |
| [M8](#m8-rooms-and-cutscenes) | Bases and THN playback | |
| [M9](#m9-retire-the-old-renderer) | Old renderer deleted from the extension | |
| [M10](#m10-hud-and-2d-interface) | HUD and 2D interface | Later |

M0 to M3 run in order. **M4 to M6 are independent** and can follow whichever editor needs them first.
M7 needs M4 and M6 for a complete picture, and M8 needs M5 and M7.

## M0: Retail evidence

Later milestones are checked against this, so it comes first.
Details are in [VALIDATION.md](VALIDATION.md).

- [x] Bring `d3d8log` into `tools/d3d8log`; it builds from here.
- [x] Log texture stage state for every stage, material, lights and light enables.
- [x] Log fog, ambient, alpha reference and function, Z enable, specular, color-vertex and material
      source render states, texture transforms, the viewport, and textures on every stage.
- [x] Read device state with the `Get*` calls at each captured draw, so that state set before the key
      press, or never set, is known.
- [x] Log clears, scene boundaries and render target changes, and save the last frame's front buffer.
- [x] Identify textures by content hash, with a read-only lock. Run 1 hashed all of them.
- [x] Capture reader in `src/capture/`, typed and test-only, with tests over a hand-written sample
      shaped by the first real capture.
- [x] Texture name index: from a capture's hash to a library texture, for the "by name" check below.
      Every texture from a file now resolves at every level. Only the menu's text (format 25) and its
      1024x1024 logo have no library entry, and they may be built at runtime.
- [x] Reference scene generator: writes a `.thn` with `@treewyrm/freelancer/thn/text` from a small
      description of model, camera and lights. Leads: `freelancer-testing/tests/thn.ts` and its
      `npm run mount`.
- [x] **You:** run the stock menu and press F9, to prove the proxy on its own.
- [x] **You:** run the first scene, `li_elite` with a fixed camera, and press F9, at 4:3.

**Done when** the capture accounts for every draw in that frame, and one hull draw can be read end to
end: its texture by name, stage setup, material, lights and matrices. Pinned by
`src/reference/li-elite.test.ts`, which skips without the capture.

## M1: First picture

- [x] Texture upload: DXT and Targa, mip chains, vertical origin, addressing and filtering. Texels
      hash the same as both captures. Retail narrows 24-bit to R5G6B5 by rounding, and D3DX gives a
      cube's generated levels a rounded 2x2 box. **Not yet captured:** top-left Targas (the source
      and the library agree on reversing them), DXT3, 16-bit Targas, the two 24-bit surfaces.
- [x] VMesh buffers, including the base-vertex scheme (library `RENDERER.md` §3). Indices rebased per
      reference. They match `li_elite` exactly, and every hull vertex and normal matches
      `li_elite_turned`, second passes negated. All 9,322 retail references stay in range.
- [x] Camera: THN `cameraprops` to matrices and `CCW` (`RENDERER.md` §2). With the engine's own view
      it is a plain right-handed GL perspective, nothing negated. Reaches retail's clip space and depth
      in `li_elite`, and every part's modelview under a moved, turned camera in `li_elite_turned`.
- [x] Static `Cmpnd` hierarchy to world transforms (§5). All 19 hull groups stand where retail drew
      them in `li_elite`, the wings' turned rest orientations included.
- [x] Frame as data: a pure function from scene to ordered draw list ([ARCHITECTURE.md](ARCHITECTURE.md)).
      `li_elite`'s 22 hull draws match in order, cull, blend, alpha reference, colours and textures.
      Covers `DcDt`, `DcDtEc`, their `Two`s and the high glass names; the rest is reported, undrawn.
      **Beyond this capture:** ordering between models, and no-reflection and blended `DcDt` states.
- [x] Fixed-function vertex lighting, from `SetLight` and `SetMaterial` semantics, in a vertex shader.
      Directional lights only, and no vertex colour, which `0x152` and `0x252` meshes need in M3.
      Pinned by hand-worked pixels, and by the hull matching retail in the picture comparison.
- [x] `DcDt` as the first material program, with the `envmapbasic` cube from the archetype's
      `envmap_material` (library `RENDERER.md` §6). In a room any non-empty value means `envmapbasic`
      (`src/freelancer/Client/room_control.cpp`). The hull matches retail in pixels, reflection included.
- [x] The second passes in `li_elite`: `L_glass` draws back faces, then blended front faces with
      `envmapglass`; `DcDtTwo` draws front, then back with negated normals. 19 groups make 22 draws.
- [x] Comparator: draw list against capture, then canvas against screenshot, in `src/reference/`. D3D8
      samples pixels at integer coordinates, so the renderer shifts clip space by `x + 1/W`, `y - 1/H`;
      measured, it takes mean difference from 8.55 to 1.55 of 255.
- [ ] **Deferred: decide the canopy.** The capture has `envmapglass` bound and on, but the rig's picture
      shows none of it. Doesn't block M2, and the rest of M1 stands. Come back with a real-GPU
      screenshot if one turns up; what to do is in [VALIDATION.md](VALIDATION.md#open-questions).

**Done when** the reference scene matches in draw count, order, state and matrices, and the picture
matches within a stated tolerance.

## M2: In the model viewer

Early on purpose: it tests the API and the injection design while they are cheap to change.

- [x] Renderer API, first version: `collectFrame`, `createRenderer`, and what overlays need, from
      `src/index.ts`. Using it moved a model's input to posed parts, since a host holds them already
      (`placeParts` builds them from a compound), and released sampler objects around hooks.
- [x] Hook points in the frame, with the empty-hook pixel test: `begin`, `opaque` and `end`. Between
      layers comes with M8, which has them.
- [x] Resource ownership: explicit disposal, sharing between instances, context-loss recovery, and
      invalidating an edited asset.
- [x] Unsupported materials are reported to the host; none disappears silently. So is a mesh or
      texture that isn't found.
- [x] In `freelancer-vscode`, as its own change: a setting that switches the model viewer to this
      renderer, with at least hardpoints and wireframe drawn through hooks. Built on its
      `webgl2-model-viewer` branch as `freelancer.model.webgl2`, and its real viewport passes in
      headless Chromium: overlays, resizing, context loss and closing.
- [x] **You:** open `li_elite` in VS Code with the setting on. It displays in the model editor.

**Done when** `li_elite` opens in the extension behind the switch, overlays included, and resizing,
closing and losing the context all work. Then revise the API with what was learned.

## M3: Every rigid model

- [x] `[MaterialMap]` and the name rewrites; unregistered types draw nothing, as in retail. The table
      equals retail's `dacom.ini`, and the map rescues 443 of retail's 445 unregistered materials. It
      isn't read from an install, so a mod's edits don't reach it yet.
- [x] All `DcDt` classes, blending by value, the alpha test, two-sided variants, vertex colour. Pinned
      by reading and hand-worked pixels. Needs a reference scene to reach "state matched": what D3D8
      reads for ambient on a vertex-coloured mesh, from a `COLOR2` no mesh has, is uncaptured.
- [x] Transparency order and `MaterialBatcher`. A blended `OcOt` waits for the flush, far before near,
      with no environment stage or normalized normals; an opaque one submits at once. A room flushes
      once, after all its objects, and keeps them in script order. `ku_dragon` matches in state and
      picture, and `ku_dragon_pair` confirms the order. Space flushes per object, which M7 will need.
- [x] **You:** run `ku_dragon` and `ku_dragon_pair`, and press F9.
- [x] `DcDtEt`, `BtDetailMapMaterial`, glass, environment maps. `prison` matches in state and picture.
      **Unmeasured:** a `Bt` UV set the mesh hasn't got (52 draws, UV0 here), a `BtDetailMapMaterial`
      without a `Bt` (two materials), and the planet glass, whose class is `li_elite`'s glass.
- [x] **You:** run `prison` and press F9.
- [x] **`NomadMaterial` in shaders**, as the worked example of not transcribing. What retail writes to
      locked memory per vertex is computed in the vertex shader, and every written vertex of
      `no_fighter` and `dyson_door_shield` matches it. There's no animation to do: the ramp's `v` is
      fixed at 1, as every caller of the update passes 0. **Picture within a wider tolerance**: see
      [VALIDATION.md](VALIDATION.md#open-questions).
- [x] **You:** run `dyson_door_shield` and `no_fighter`, and press F9.
- [x] Engine overrides, where the game reaches them on a rigid model: `CloakMaterial`, set by the host.
      Read from `flmaterials.dll` and pinned by tests, **uncaptured**, as only flight has a cloak.
      `WireMaterial` and `ColorizeMaterial` are asked for by the interface controls, so M10's.
- [x] What retail barely uses and mods can name, on the generated `bands` sphere, where every band
      scores 99.4 to 100% against the screenshot: `EcEt`, `EcEtTwo`, `LightMap`, `EngineGlowMaterial`,
      `Nebula`, `NebulaTwo`, `BtDetailMapTwoMaterial`, `GlassMaterial`, `GFGlassMaterial`, and `DcDt` kin.
- [x] A stage asking for a UV set the mesh hasn't got reads (0, 0): `bands_one_uv`.
- [ ] **Skipped for now:** the override types as a material's `Type`. `VisibleCounterMaterial` and `ShadowMaterial` each crash
      the game alone, beside a plain band that doesn't. `ColorizeMaterial`, `CloakMaterial`,
      `BackdropMaterial`, `StarsphereMaterial`, `EnvMapMaterial`, `WireMaterial` and `WireMaterial2` are
      untested alone: they're reported as unsupported, and draw nothing.
- [x] LOD selection: `placeParts` with a camera and the archetype's lists, or `levelAt` for a host
      posing its own. `ku_dragon_pair`'s far ship matches at its lower level, in state and picture.
- [x] Material UV animation, from the host's clock on `Scene.time`. Live in retail (`0x41b2e0` passes the
      real delta), and `lair`'s transform matches in state and picture.
- [x] Joint animation needs nothing here: `sampleChannel` from the library feeds `placeParts`'
      `jointState`. Playing a script is the host's, or M8's.
- [x] Texture animation moved to M8, and built ahead of it there. Only base interiors and effects have
      animated textures, so no reference scene reaches it yet.
- [x] Corpus suite: all 1,852 retail models plan a frame at every level, and what's left is pinned by
      type (`src/reference/corpus.test.ts`): `HUDIconMaterial`, `HUDAnimMaterial`,
      `ExclusionZoneMaterial` and `PlanetWaterMaterial` to build, `Nebula` for M4, four animated
      textures for M8, and 7 materials no retail file defines. Since built: only the last two remain.
- [x] `HUDIconMaterial`, `HUDAnimMaterial`, `ExclusionZoneMaterial`, `PlanetWaterMaterial`, on `bands`.
      **Read only:** the per-object colour they take from `SceneModel.instance`, which needs the engine.
- [x] `[MaterialMap]` from the host: `SceneModel.materialMap`, for a mod's `dacom.ini`.
- [x] **You:** reference scenes for each new family.
      A material retail barely uses, or no spawnable model has, can still be checked: generate a small
      UV sphere carrying it, give it a lab-only archetype, and capture how the game draws it.
- [x] Move the extension's material and texture previews across. The material preview draws through
      the game path behind the same setting, its checkerboard in the `begin` hook. A `.sph`, which its
      default sphere and the thumbnails are, and the planet classes stay on the old renderer until M4.
      The texture previews paint a 2D canvas, so never used a renderer.

**Done when** every rigid-model row in [COVERAGE.md](COVERAGE.md) has reached "state matched", and
the model viewer's switch can default to on. Every rigid-model row has, bar `NomadMaterial`, the class
`NomadMaterialNoBendy` matched under another name, and `NullMaterial`, which draws nothing. **The switch
stayed off until M4**, when a `.sph` and the planet classes began drawing through it. **From here on, stop adding shading features to the old
renderer**, so the two don't diverge.

## M4: Spheres and the sky

- [x] Sphere patch tessellation and the `M0..M5` face order: `placeSphere`, which also chooses the level
      and culls faces as the game does. The stock menu's two planets match over all six captured frames:
      level, faces drawn, their matrices and order, all logged indices at levels 5 and 8, and level 5's
      vertices (`src/reference/sphere-menu.test.ts`), and `planet_earth` has every vertex and normal at
      level 8. The level's width is corroborated only by those three planets falling in range.
- [x] The four planet surface types and `AtmosphereMaterial`. `bands_planet` matches in state and
      picture, and the stock menu's planets draw for draw: `IllumDetailMapMaterial`,
      `DetailMapMaterial` and both shells, their matrices and each vertex's UV. That `r` is the shell's
      radius rests on those UVs. `planet_earth` matches in state, each vertex and normal, each shell
      UV, and picture: 99.9% within 2 of 255, mean 0.22. **Uncaptured:** `DetailMap2Dm1Msk2PassMaterial`
      on a real `.sph`, and the single-pass fallback, as these assume the multipass and atmosphere
      options on, as a retail install has them.
- [x] `Nebula` materials; starsphere and backdrop overrides, with the game's draw order for the layers.
      `SceneModel.sky`, in the order the host gives. All four skies below match in state, and in
      picture, `starsphere_ew05` at a wider mean: see [VALIDATION.md](VALIDATION.md#open-questions).
      Each part now culls against the frustum for every model (`RenderInstance`), which `starsphere_li01`
      needs, 18 draws of 47. **Read only:** `BackdropMaterial`, which retail uses for `skydome_*` in
      scenes, so M8's. **Uncaptured:** a position-only sky part, which `starsphere_st03b`'s camera culls,
      and any lights a room leaves on over a lit sky material.
- [x] The extension's model viewer and material preview draw a `.sph` and the planet classes through
      `placeSphere`, behind the same setting. Its thumbnails stay on the old renderer. Its model viewer has a *Draw as*
      dropdown: Model, Starsphere and Backdrop, starting on Starsphere for a `starsphere_*` file or one
      under `STARSPHERE`. Overlays and picking are off for Starsphere, since they keep to the orbit.
- [x] **You:** open a `.sph` and a starsphere in VS Code with the setting on, and the material preview on
      a planet material. All draw. **The switch stays off for now**, by choice.
- [x] **You:** reference scenes for a planet, `planet_earth`, and starspheres: `starsphere_li01`,
      `starsphere_st03b`, `starsphere_ew05`, `starsphere_ew06`.

**Done when** the sphere rows are state matched. The tessellation density is a budget in the game, so
compare its density-independent results only.

## M5: Characters

Adapted from `freelancer-vscode`'s GPU skinning; see [ADAPTING.md](ADAPTING.md#gpu-skinning-m5).

- [x] Adapt skinned geometry and the skinned vertex stage, with a root-relative bone table:
      `placeSkin`, in FVF `0x112` with strips expanded at load as `ExpandTristrip` does. All 204 retail `.dfm` files and
      1,220 levels plan. `character_reed` matches at a script's last keyframe: see below. Culling uses the
      bind pose's bound, where retail's `PartBoundSphere` isn't read.
- [x] `EyeMaterial`: `deformable2.dll`'s own `^eye*` rule, `DcDt`'s states, and its bone's UV offset,
      from `jointState`. `character_eyes` matches retail's matrix in state, and in picture: 99.98% within 2,
      a mean of 0.42. Only one gaze is captured, saturated at both limits, so the scale between them is
      as read. **`START_IK` itself is M8's**: the scene aims the bone's -Z by hand.
- [x] A detail level per part, and levels drawn rigid past the skinned count: `costumeLevel` over the host's
      `[DetailSwitchTable]`s, in `placeCostume`. `character_far` matches all nine draws, each part on its own
      level, with every vertex. With the rigid rule off, 34 to 51 seam vertices a part land elsewhere, so
      the capture does tell them apart. A room's script takes the base room's rule here, as measured.
      **Read only:** `low_character_lod`, and a part past its far cutoff, which draws nothing.
- [x] Costumes joined from four `.dfm` files: `placeCostume`, by shared hardpoint name, roots and seams.
- [x] **You:** a reference scene with a character. `character_reed`, at the last keyframe of a one-shot
      script, matches in draws, indices, every vertex and normal, each part's root, and picture: 99.92%
      within 2, a mean of 0.43. **Uncaptured:** frames mid-script and blending, and an unseated seam.

- [x] The extension's character editor and a `.dfm` in its model viewer draw through `poseSkin`, behind the
      same setting, with rigid props beside them. It poses and joins bones itself, as it did. A viewer has
      no switch tables yet, so its level is the pin or the top one.
- [x] **You:** open a costume in VS Code with the setting on, and scrub an animation. All looks right.

**Done when** the character editor runs on this renderer behind its switch and the eye and skin rows
are state matched.

## M6: Effects

Adapted from `freelancer-vscode`'s Alchemy; see [ADAPTING.md](ADAPTING.md#alchemy-m6).

- [x] Audit the rest of its ledger against the decomp and, where they differ, retail. Its readings hold
      and its structure doesn't: a folder's clock kills live particles in 33 retail effects, and more. The
      table is in [ADAPTING.md](ADAPTING.md#alchemy-m6), with what's still open.
- [x] Adapt the simulation and effect shaders, driven by host-supplied time and a seed: `EffectInstance`,
      on retail's own tree walk, and a vertex stage carrying each record to now. All 1,213 retail effects
      run, finite, and hand-worked pixels pin each facing (`src/alchemy/`). **Uncaptured.**
- [x] Rewrite the draw side against the frame list: `Frame.effects`, after `draws`, in tree order and with
      hooks either side. Gizmos stay in the extension, behind those hooks.
- [x] Settle the fixed step against retail's per-frame `dt`: the host's `dt`, as retail.
- [x] Effects mounted on model hardpoints: `advance`'s `placement`, the hardpoint's world, as the game's
      override. Pinned: it reaches the control root alone, and leaves a trail. The hardpoint's matrix is the host's.
- [x] Reference scene generator for effects: `effect_sprites`, `effect_folder` and `effect_motion`, one
      `PSYS` each, a generated `.ale`, and a lab-only `[VisEffect]`. Built so no capture needs the game's
      `dt`: what holds still under constant curves, or a moving particle's shape read relative to it. The
      comparison waits in `src/reference/effects.test.ts`, skipping until there's a capture.
- [x] **You:** `effect_sprites`, `effect_folder` and `effect_motion`. Each matches its capture in draws, states,
      and every corner and UV the scene pins; `effect_motion` by shape, as the game's `dt` is unknown. The folder
      cut is confirmed: both sprites early, only the control past 5 s. Pictures: `effect_sprites` 99.40% within
      2, a mean of 0.37, `effect_folder` 99.91%, 0.36. They also found a clamp and an alpha test the audit
      hadn't, and that the last of a repeated property stands.
- [x] Reference scenes for what's left: `effect_beams`, `effect_child`, `effect_oriented`, `effect_fields`,
      `effect_pool` and `effect_dust`. Its camera travels, since dust fades to nothing under a still one.
      `FxOrientedAppearance`'s `MeshApp_ParticleTransform` is built, on the CPU, for its scene to test.
- [x] **You:** those six. `effect_beams` matches its capture at every vertex of all five chains, parity and
      anchors included, and in picture: 99.72%, a mean of 0.43. `effect_child` in draws, order and place, and
      picture: 98.90%, 0.38. `effect_fields` in age by depth and air velocity. `effect_pool` in the eviction:
      1,800 and 200 triangles. `effect_oriented` crashed the game. `effect_dust` draws nothing, as below.
- [x] **You:** `effect_oriented` again, with `poolSize = 1000` written over `dacom.ini` for the run. It runs, so
      the crash is retail's 0. It matches in draws and every corner and UV, the frame's turn and the particle
      transform included, and in picture: 99.90%, a mean of 0.36.
- [x] The extension's effect editor on this renderer, behind the same setting: `effect/game-run.ts` there, which
      replays a scrub from 0 on a new instance. `SceneEffect.visible` hides an appearance, `eachParticle` feeds the
      age playheads. Gizmos stay the old renderer's. Particle markers and sprite frames are off under the setting,
      until M9: they read the old pool, whose particles aren't these.
- [x] **You:** effects in the editor with the setting on. Play, scrub, the eye, mounting on a model and moving the
      host all work.

**Done when** captured particle quads match by measurement, and the effect editor runs on this
renderer. Random streams need not match retail; each appearance's sizes, colours and blends must.

## M7: The space frame

- [x] The game's frame order: `collectSpaceFrame`, from `SpaceObjDrawPass` (`0x51c200`). Five lists sorted far
      to near, the far list on a plane of 250000 with no depth, the batcher flushed per object, effects by
      type. Pinned by reading and by pixels (`src/scene/space.*`). The drain order and its three constants were
      checked in `Freelancer-original.exe`. **Matched in `space_order`**: far list, main list and planet
      keys, draw for draw. The host supplies `lodRange`.
- [x] Light selection and ambient, per object: `lightObject`, from `StarSysApplyObjectLighting` and
      `engine_light.cpp`. Retail's XZ grid, four lights at most, the widest first and the file breaking ties,
      `atten_curve` turning a sun at each object, `color_curve` on the host's clock, ambient lights, and D3D8
      point lights in the shader. Pinned by reading and by pixels. **Matched in `space_order`**: a
      `DYNAMIC_DIRECTION` sun and a point light, colour, direction and position on every draw. The host
      reads `[IGraph]` and `[LightSource]` into `Graph` and `SpaceLight`.
- [x] Fog and nebula state: `collectSpaceFrame` takes the system's nebulae and picks the field as
      `SelectFieldControllers` (`0x51b730`) does, finds each object's nebula (`StarSysFindNebula`), and from
      `FNebulaEffect::Update`, `FogFactor` and `FogFarClamp` gives what a nebula holds its fog and its
      `[NebulaLight]` ambient, effects a black fog, and the clear the fog's colour deep inside. W-fog in the
      shaders, as retail picks it on a T&L device. `zoneOf` gives `ZONE`'s reach for each shape. Pinned by
      reading and by pixels (`src/scene/nebula.*`, `space.*`). **Uncaptured**, so the hardware's fog-factor
      precision is a guess. The host reads `[Fog]` and `[NebulaLight]` into `SpaceNebula`.
- [x] A nebula's exclusion zones: the camera's moves the fog's end toward its `fog_far` and widens
      `FogFarClamp`, and `FogFactor` blends by its immersion (`FNebulaEffect::Update`, `0x507194` on;
      `ZONE::GetImmersion`; `is_in_exclusion_zone`). Pinned by reading (`src/scene/nebula.*`). Retail
      keeps the camera's zone between frames while its immersion stays at 1e-4, and finds one above 1e-5;
      this finds it afresh, so only that band and overlapping zones can differ. **Uncaptured.** The host
      reads `[Exclusion Zones]` into `NebulaExclusion`.
- [x] `[BackgroundLightning]`: `NebulaLightning`, from `FillFogRgb`, flashes the clear colour deep in a
      nebula, on the scene's `step` and the host's random source. Every nebula has one by default, checked
      in `Freelancer-original.exe` (`0x504b06`). Pinned by reading. Retail's `rand()` is the game's own, so
      only the kind of flash can match. **Uncaptured.**
- [x] An object's nebula: retail keeps it from when the object moved and tries that one first
      (`StarSysFindNebula`'s hint), which `SpaceObject.nebula` gives. It matters only where nebulae overlap,
      and no two retail ones do: every pair whose spheres meet is a pair of ellipsoids, and sampled through
      `EulerMatrix`'s Rz·Ry·Rx they share no point. A mod's can.
- [x] A nebula's own light: a nebula file has no `[LightSource]`, but `[DynamicLightning]` flashes a
      directional light at the camera, deep inside, in a random direction and colour, brighter while the
      background flashes (`NebulaAmbientTick`, `0x5097c0`). Every nebula has one by default, checked in
      `Freelancer-original.exe` (`0x504b4e`). It joins the system's lights after them. Pinned by reading.
      **Uncaptured.**
- [x] Lights equipment carries: `equipmentLight`, from `CliEquipLightInit` (`0x4fda00`). A `[Light]` with an
      `intensity` is a point light of that range falling off by 16 / range² (`EngineLightSetRadius`), or a
      spot under 180° of `lightsource_cone`, its inner cone half the outer (`EngineLightSetConeAngle`).
      D3D8's spot factor in the shader. Retail makes one only for the player's ship, which the host decides.
      Pinned by reading and by pixels. **Uncaptured.** Its bulb and flare are drawing of their own, with
      projectiles.
- [x] Lights effects carry: `effectLight`. An `[Effect]`'s `lgt_radius` and `lgt_color` make a point light
      at the effect (`CreateEffectStart`, `0x544299`), run by the `[LightAnim]` its `lgt_effect` names, its
      keys scaled by `lgt_time_scale` and `lgt_range_scale` (`GameLightBindAnimKeys`, `GameLightTickAnim`),
      and out once the last key passes. Pinned by reading. **Uncaptured.** The host reads `[LightAnim]` into
      `LightAnimation`, and adds the light to the scene's in the order its effects started.
- [x] Compute `lodRange` from an archetype's lists: `lodRange`, from `ComputeLodPickThis` (`0x4021b0`) and
      `ApplyArchLodRanges` (`0x401ed0`), the largest range any part walked. The `level_of_detail` option
      (`ApplyLevelOfDetail`) skips the first list's `MinSpecLOD` levels below 0.75, and above it holds a near
      list's far ranges at 15000; `levelEnds` takes it too. The multiplier is 0.700208, read from
      `Freelancer-original.exe` (`0x5c7410`), not tan 35°. Pinned by reading. The option's retail default is
      a machine score, so the host gives it; 0.75 changes nothing.
- [x] `SpaceEffectsDrawFrame`'s depth test: `ZFUNC` 4 around every effect (`0x4f7480`), so a space frame
      draws effects with `LEQUAL` where the menu's capture has `LESS` (`effectDepthFunc`). Pinned by reading
      and by pixels: an effect in the plane of a model draws.
- [x] An effect's view test: `viewEffect`, from `FParticleEffect::UpdateVisibility` (`0x4f86c0`) and
      `EffectTypeBucketWalk`. A placed `SpaceEffect` draws only when seen; `effectViews` tells the host
      whether it draws, runs unseen (`EXIST_OFFSCREEN`) or ends, and its `ALCHEMY_LOD` blend. A cloaked
      watched ship, or one in another field than the camera's or past its fog, hides it; so does a priority
      under `generic_effect_perf`, the near plane, its type's `pbubble` and an `[EffectLOD]` row's least size.
      The retail `[EffectType]` table is `RETAIL_EFFECT_TYPES`. Pinned by reading. Retail keeps last frame's
      answer where it doesn't test, but clears it once an effect draws, so that is taken as unseen; a cruise
      effect's fade (`FParticleEffectCruise`) isn't built. Retail steps effects by at most 0.1 s. **Uncaptured.**
- [x] The screen quads `SpaceEffectsDrawFrame` flushes once its effects are walked, `LEQUAL` with no
      depth writes (`ScreenQuadFlush`): `Frame.screenQuads`, D3D's pre-transformed vertices, added,
      texture times colour. Equipment flares fill them (`flareQuads`, from `CliEquipLightDrawFlare` and
      `ScreenQuadEnqueueFlare`): a bulb and a glow sized by depth, each dropped under a pixel, clipped
      with its UVs, the glow fading by `flare_cone`. `SpaceObject.flares` link only when their object
      draws at the first tier, newest first (`GameobjSweepEffectList`, push-front), and `LightBlink`
      ticks only then, held to 0.1. The host reads `[Light]`, `inherit` included, into `FlareLight`,
      and gives `viewport` and `shine`. **Matched in `space_order`**: draw 130 is `mplatform`'s six
      `SlowLargeWhite` glows, every bulb under a pixel, in state, order, place to 0.0003 pixels and
      depth to 5e-10. The camera's rectangle ends on its last pixel, 1023 by 767, which the
      half-pixel offset showed. Each colour is no more than its fade allows, but a blink's phase is
      the game's `rand()` and the log has no clock, so brightness is uncaptured; so are flares in a
      nebula, whose fog isn't read here. Projectiles' quads come with projectiles.
- [x] `level_of_detail` on a space solar's sphere: `solarSphereLevels`, from `SolarSpheresApplyDetail`
      (`0x5488a0`), a maximum of 7 to 10 and a bias of 3 to 1. Retail applies it only as the option changes,
      to the solars then loaded (`SetPerfOptionValue`): none exist at startup, so in play a planet keeps
      `RETAIL_SPHERE_LEVELS` unless the slider moves in its system. The host decides; `placeSphere` takes
      either as `levels`. Pinned by reading.
- [x] A planet ring from outside: `buildRing` and `ringPieceDraw`, from `PlanetRing::Load` and
      `DrawPiece` (`texture_panels.cpp`). A flat band between its `RING` zone's radii, `num_segments`
      of them in eight pieces, each strip in world space: the shape's left edge on even segments and
      its right on odd, `detail_tile` on the second UV set, the colour and opacity in the vertex,
      the opacity halved without a detail shape. Unlit, blended, both sides, `LEQUAL` without depth
      writes, the detail ×2. `SpaceScene.rings`: each piece the view's sphere test keeps joins the
      main list keyed past its radius, or past the draw range less 5000 the far list
      (`EnqueueTexturePanelPieces`, `ringFarMargin`). `textureShape` turns a `[Shape]`'s pixels into
      UVs. `thickness_edge`, `inner_edge` and `outer_edge` are read and never used. Stage 0 wraps,
      read in `Freelancer-original.exe` where the decomp has filters
      ([ADAPTING.md](ADAPTING.md#win3dsettexturefilterlinear-and-win3dsettexturefilterpoint)).
      Pinned by reading and by pixels. **Matched in `ring_outside` and `ring_inside`**
      (`src/reference/rings.test.ts`): order among the planets, the far list, state, and every
      vertex's position to two float steps, colour and both UV sets; the picture is 99.97% within 2.
      What `DrawPiece` leaves to the frame is as captured: both stages wrapping, linear, mips point,
      the alpha test `GREATER 0`, no fog. In a nebula the fog left on is **uncaptured**.
- [x] **You:** `ring_outside` and `ring_inside` (`src/reference/systems.ts`): a tilted ringed planet
      ahead, and one off to the side whose pieces straddle the far threshold; then the ship inside the
      near band, where two pieces about the camera, keyed 0, draw after the ship.
- [x] A ring's `[Clouds]` from inside: `Clouds`, from `FNebulaClouds` (`cli_nebula.cpp`: parse,
      seed, update) and `TexturePanelDrawClouds` (`FUN_00551500`). Puffs in a sphere ahead of the
      camera, half `max_distance` plus a puff's radius, set ahead so the near fade's cone fits; each
      0.8 to 1.2 of `puff_radius`, coloured between `puff_colora` and `puff_colorb`, its shape by
      `puff_weights`, drifting. The ring's immersion (`ringImmersion`, `GetImmersion`) is their
      visibility: how many show, how opaque, and, under 1.1, where one may respawn. Drawn in view
      space, one list of squares turned to a kept up, fading near the camera and at the sphere's
      edge, far to near, after the main list and only outside a field (`TexturePanelsDrawAll`).
      A camera cut, as entering a system, places them afresh (`SpaceScene.cut`). Seeded by the
      game's `rand()`, so **matched in kind in `ring_inside`**: draw 66's states, view-space list,
      count, sizes, colours, order and sphere hold for retail's puffs and ours alike. Its picture
      can't be held pixel for pixel. A nebula's clouds, with bolts and exclusion zones, use the same
      class but aren't wired in.
- [x] **You:** `asteroid_inside`, `asteroid_nebula` and `asteroid_outside` (`src/reference/systems.ts`):
      a field of Cornwall's cubes and band with no `rand()` in it, a station in its exclusion zone,
      and a nebula over part of it, fog only, lightning off, with a shelled hole around a plant. A
      nebula file must have an `[Exterior]`: with none, `plane_slices` stays 1 and its bits pick from
      no shapes, which crashed the game.
- [x] Asteroid fields' cubes: `fieldCubes`, `mergeCube` and `SpaceScene.asteroids`, from
      `CliAsteroidDrawNearField` (`FUN_00522a60`), `CliAsteroidMergeCubeMesh` and Common's grid
      (`closest_cube_pos`, `compute_cube_id`, `compute_cube_orientation`). The `[Cube]`'s asteroids
      merged, each at its top level, drawn once per cube with the first's material; a box of cubes
      over the view out to `fill_dist`, kept by the side planes, the zone, the exclusion zones
      (nearest first, to `fill_dist · 1.25`, taking a cube or thinning it to their own
      `empty_cube_frequency`), and the id's LCG, which empties and turns it; faded over the last half
      cube; the camera's own cube if missed. Lit once at a point 100 behind the camera, ambient raised
      by `ambient_increase`; the D3D material the field's colours; fogged only with
      `contains_fog_zone`. Drawn after the main list, or inside a field after its own. **Matched in
      `asteroid_inside` and `asteroid_nebula`** (`src/reference/asteroids.test.ts`): all 87 cubes in
      order, place and turn to 6e-5, lights, ambient and state, and every other draw of both frames
      but the band and the nebula's overlay. It found: a solar finds its nebula once, as its
      `[Object]` is read (`FUN_005485c0`), so one listed before a `[Nebula]` has none
      (`SpaceObject.nebula = null`); and a nebula's fog, linear on depth, matched on the ship.
- [x] An asteroid field's `[Band]`: `AsteroidBand`, from `BandBuildExclusionRings` (`FUN_0054c8b0`),
      `BandUpdate`, `BandBakeLighting` and `BandDrawPiece` (`cli_asteroid.cpp`). A ring of points about
      its zone, its girth over `texture_aspect` × 1.15 × `height` segments times `vert_increase`, in
      from its size by `offset_dist` or scaled by `offset_percent`, cut into `render_parts`; each
      point's normal out and level. Each frame, a point fades in and out by `fade`'s four heights and
      edge-on below a cosine of 0.5, and keeps the side it was last seen from while faded past the far
      end. Lit once, at its zone: the system's ambient raised by `ambient_increase` and tinted, and up to
      four directional lights softened 0.75 round the back (`directionalLightsAt`). A piece draws its
      quads turned away first, both sides, `cull_mode` hiding one, U stepping by `vert_increase`.
      `SpaceObjDrawPass` lists it as the field's own node (`0x51ba40`): each piece the view keeps by
      distance, nearest first inside a quarter of the range, or one piece by its zone's surface; on
      either list with no depth and the 250000 plane, `ALPHAREF` 5. Pinned by reading and by pixels.
      **Matched in `asteroid_inside`, `asteroid_nebula` and `asteroid_outside`**
      (`src/reference/asteroids.test.ts`): order, state, and every vertex's place, colour, fade and UV
      to the byte. It found the decomp's bake reading the normal a float late
      ([ADAPTING.md](ADAPTING.md#bandbakelighting)), and an even piece's centre half a segment off, as
      retail has it. A one-piece band and a tilted zone are uncaptured.
- [x] `[ExclusionBand]`: `SpaceAsteroidField.exclusionBands`, each an `AsteroidBand` about its own
      `zone`, lit there, its alpha held under `nearFieldFraction` at 1000
      (`CAsteroidField::near_field_fraction`, `0x62a54e0`): 1 at the field's surface, 0 past 1000, and
      unclamped within. A field's pieces are numbered through, its own band's first (`FUN_00524740`,
      `FUN_00522850`), so a field of one piece in all takes the one-piece node. Retail uses it in
      `li01_pittsburgh_debris_field_001`, `bw02_minefield` (with no `[Band]`) and
      `bw04_von_rohe_lava_asteroids`. One whose zone isn't found counts pieces it never built, and is
      left out. Pinned by reading. **Matched in `asteroid_exband` and `asteroid_exband_edge`**
      (`src/reference/asteroids.test.ts`): both frames draw for draw, and every band vertex to the
      byte, the station's band sorted among the field's and the objects, and at half from 500 out.
- [x] **You:** `asteroid_exband` and `asteroid_exband_edge` (`src/reference/systems.ts`): the lab field
      with an exclusion band about the station, from in the field and from 500 past its surface,
      where it shows at half.
- [x] `asteroid_outside`'s frame around the band. Not a level of detail: retail's station levels were
      ours all along, and `space_solar_plant` is a small solar. `G_LargeSolars` (`0x540d18`) tests
      `CObject::Radius`, which the engine sets from its instance's extent, the root part's top level:
      the plant's 86.8, where its `.sur` is 264.6. So only the camera's query of 10000 finds it, and
      at 12700 it doesn't. `SpaceObject.solar.extent`; the query's reach is taken from it too, unread.
      **Matched in `asteroid_outside`** draw for draw.
- [x] A nebula's fog overlay: `fogOverlayDraw`, from `FNebulaEffect::DrawFogOverlay` (`0x508b00`). In
      a field, after the main lists and before its own (`DrainMeshAndAsteroids`, `0x51facc`), one
      untextured quad over the viewport to its last pixel, under `Win3DSetOrtho2DForCamera`, in the
      `[Fog]` colour as loaded, its alpha the camera's depth (`+0x294`). None at no depth; at full
      depth only the frame it's reached (`+0x2b8`), so the core's clear takes over. Pinned by reading
      and by pixels. **Matched in `asteroid_nebula`**: draw 30's place, four vertices, colour and
      alpha, and the frame draw for draw. `compare.ts` learnt that a disabled stage 0 ends the
      cascade, so stage 1's leftovers aren't read.
- [x] A nebula's exclusion shell: `ExclusionShell` on a `NebulaExclusion`, from
      `FNebulaEffect::DrawExclusionShell` (`0x508f20`) and the `[Exclusion Zones]` keys
      (`zone_shell`, `shell_scalar` raised to 1, `max_alpha` capped at 1, `exclusion_tint`; one shell
      per name, shared). In a field, after its own list and before the asteroid fields: the shell of
      the zone the camera is in, at its transform scaled by radius × `shell_scalar` / 1000, lit with
      no lights by a white ambient so the tint is its material's ambient, its diffuse alpha
      `(immersion − 0.2) · 1.25` held to [0, 1] times `max_alpha`, no depth writes or fog. In a core
      neither rings nor bands are listed (`0x51c352`). Pinned by reading. **Matched in
      `asteroid_hole` and `asteroid_hole_edge`** (`src/reference/asteroids.test.ts`): both frames
      draw for draw, the shell's place, scale, tint and alpha (0.8, and 0.409 in the edge), and the
      core's clear, with no sky, band, or plant. The comparison draws a frame before, as the game
      had: in a core the overlay's latch is set by then. A missing `exclusion_tint` is uninitialised
      in retail; the reference loader takes white.
- [x] **You:** `asteroid_hole` and `asteroid_hole_edge` (`src/reference/systems.ts`): deep in the
      nebula's hole, and in its edge.
- [x] A nebula's fill sheets: `fillSheetsDraw`, from `FNebulaEffect::DrawFogShell` (`0x508cf0`) and
      `FUN_005074e0`. Two quads through the zone's centre in `[Exterior] fill_shape` and the fog's
      colour: sheet A along the longer of its x and z, sheet B along its y, each `size` × 1.15 out,
      turned about that axis to face the camera and across to its surface × 1.15; A fades only within
      a cosine of 0.0049 of its axis, B by `(1 − |cos| − 0.2) · 5` on its y and again on the other
      axis, unclamped above. Unlit, both sides, alpha-blended, no depth test or writes, the far plane
      250000; none once the camera's depth reaches 1. Drawn where `DrawFogShell` is called: the
      field's from outside before its list (`0x51f9bc`), in its edge after the main lists and before
      the overlay (`0x51fa8a`), and every other nebula from the far list, keyed by the squared
      distance to its surface however far (`ZItemNebula`, `listNebulae`; none in a core). `Zone` gains
      `size`, as written with a missing value 0, and `axes`; `zoneOf` takes the written ones. Retail
      normalises by one Newton step (checked in `Freelancer-original.exe`, `0x507663`), so a sheet
      looked at along its axis keeps a little alpha, its corners 0/0, and an ellipsoid reaches 0.17%
      further. Every one of retail's 59 nebula files has a fill shape. Pinned by reading and by pixels.
      **Matched in `nebula_sheets` and `nebula_sheets_edge`** (`src/reference/sheets.test.ts`): both
      frames draw for draw, every corner to two float steps of the zone's centre, colour, alpha and
      UV, and the frame's state as taken: no fog, `ALPHAREF` 0. Pictures 99.99% and 99.94% within 2.
      They found the decomp's look the wrong way round, so each sheet's corners mirrored
      ([ADAPTING.md](ADAPTING.md#nebulaupdateboltcamera)). **Matched in `nebula_sheets_axis`**: looked
      at along its axis, a sheet keeps what the one-step look leaves, 85 at 13000 and none at 60500,
      edge-on, as predicted before the capture; picture 99.99% within 2. An exact alignment, and its
      0/0, can't be staged from a chase camera, and stay read only.
- [x] **You:** `nebula_sheets` and `nebula_sheets_edge` (`src/reference/systems.ts`): from outside a
      pitched ellipsoid with both sheets, B at about half, a far sphere's on the far list; then in the
      ellipsoid's edge. A system with no `[Object]` crashes the game, so it has a station.
- [x] **You:** `nebula_sheets_axis` (`src/reference/systems.ts`): looking along two ellipsoids' long
      axes, where only the one-step look keeps a sheet: the near one's sheet A at an alpha of 85, the
      far one's gone. An exact alignment, and its 0/0, can't be staged from a chase camera.
- [x] A nebula's exterior: `NebulaExterior`, from `NebulaRebuild` (`FUN_00506600`), `NebulaOrientBolts`
      (`FUN_00507340`) and `NebulaDrawBolts` (`FUN_00507ed0`). `[Exterior]`'s bits on `plane_slices`
      rings of latitude, `min_bits` at the ends to `max_bits` at the middle, spread by `equator_bias`,
      each ring past the middle turned half a step, and a cap at each pole; each placed on the surface
      (`GetSurfacePoint`, now on `Zone` for every shape) and pulled in `move_bit_percent` of
      `bit_radius`. Its size within `bit_radius_random_variation`, its spin and its shape are the
      game's `rand()`. Turned to the camera once a second or on a cut, sorted far to near once 1.15 s
      pass, each billboard faces the camera about its up; one on the far side is skipped, and one
      nearly edge-on or nearer than its radius fades, as does all of it over the second half of the
      camera's depth. Unlit, unculled, no depth, `ALPHAREF` 4, blended by alpha or added by the
      texture's format, fogged in the nebula's colour from its surface to twenty times as far past
      its span. Drawn by `DrawBoltsPass`: after each far node's sheets, from outside after the field's
      list, in its edge after the overlay. The `Nebula` option scales count, size and opacity
      (`ExteriorLimits`). The decomp's constructor lacks six defaults
      ([ADAPTING.md](ADAPTING.md#fnebulaeffectfnebulaeffect)). Pinned by reading. **Matched in
      `nebula_exterior` and `nebula_exterior_edge`** (`src/reference/exterior.test.ts`): both frames
      draw for draw, and every bit's place to a hundredth, size, colour, alpha and UVs in retail's
      order, the fog's start and end, and the far side left out. A bit's spin is `rand()`'s: with
      retail's spins, the pictures are 99.99% and 99.92% within 2. `move_bit_percent`'s default and
      a bit's size variation are uncaptured.
- [x] **You:** `nebula_exterior` and `nebula_exterior_edge` (`src/reference/systems.ts`): a pitched
      ellipsoid's three rings and caps from outside, a far sphere's from the far list, then from the
      ellipsoid's edge. Only each bit's spin is random.
- [x] A nebula's `[Clouds]` inside: `SpaceNebula.clouds`, the ring's `Clouds` with a nebula's
      visibility (0.1, 0.3, 0.3). Within 300 of its surface they follow the camera, as many as its depth
      allows (`FNebulaEffect::Update`, `0x5072ac`), a respawn held to its zone's immersion
      (`SpaceNebula.edgeFraction`); drawn last in a field, after its nomads (`DrawCloudsPanels`,
      `0x51fbb4`), fogged to its own start and end, unculled. A puff more than 0.9 into an exclusion
      zone counts but is hidden, on respawn and on a cut (`FUN_00550d40`, `FUN_005513b0`,
      `is_in_exclusion_zone`), asked of the zones in the order the nebula last sorted them
      (`ExclusionOrder`). Each key starts at 1e7 (`NebulaExclusionZone`), and `Update` sorts only once
      the camera was in the nebula the frame before, so what's placed on entering a system is never
      hidden. **Matched in kind in `nebula_clouds` and `nebula_clouds_hole`**
      (`src/reference/clouds.test.ts`): both frames draw for draw, the clouds' state, fog, view-space
      list, count, sizes, colours, order and sphere. The hole found the unsorted start: retail drew
      all ten, puffs deep in the zone among them, where a fresh lookup hid five. A puff hidden later
      is uncaptured. Their flashes are the clouds' own; the bolts (`lightning_shape`) aren't built.
- [x] **You:** `nebula_clouds` and `nebula_clouds_hole` (`src/reference/systems.ts`): deep in a nebula
      with the Badlands' clouds, lightning off; then in its exclusion zone.
- [x] A nebula's lightning bolts: **nothing to draw**. A `[Lightning]` section (`FUN_00552570`) sets
      its countdown once, to `(-0.8 - rand · 0.7) · gap`, and nothing else in
      `Freelancer-original.exe` writes it, its eight segments or its texture: the only callers are
      the load, the disable and `DrawFogOverlay`'s draw (`0x508cdf`). With a positive `gap` it stays
      dark; with none it would draw from a null texture and unfilled segments. No retail file has
      one. `[Clouds] lightning_shape`, `lightning_size` and `llight_*` are parsed and never read.
- [x] An asteroid field's `[AsteroidBillboards]`: `AsteroidBillboards`, from `BillboardEnsureRocks`
      (`FUN_0054de10`) and `BillboardDraw` (`FUN_0054e900`), its lighting (`FUN_0054e130`) and
      emission (`FUN_0054f9f0`). Rocks in a sphere ahead, `start_dist` on and as wide as tan 35°
      lets it, scattered afresh on a cut and back on its surface as they leave; each a triangle
      facing the camera, its base along the right or the up and its UVs flipped by `rand()`, faded
      toward the sphere's edge (narrower past its centre) and in front of the cubes' reach. Hidden
      outside the field, in a zone with `exclude_billboards`, or past a zone's `billboard_count`
      share. Lit at the camera's corners by up to four directional lights over the field's ambient
      pass, tinted by `color_shift`; retail picks each corner by rock 0's U flip. Drawn just before
      the field's cubes, opaque at `ALPHAREF` 128, then the faded blended at 5. Its options test,
      `Asteroids` above 1, is the host's. Pinned by reading. **Matched in `asteroid_billboards`**
      (`src/reference/billboards.test.ts`), in kind: draw for draw, both draws' states, in world
      space under the view. Each of retail's 376 rocks has the alpha our fade gives at its place, to
      the byte, its size within `size`, its base and point square and facing the camera, its centre's
      colour ours and its corners' one of ours, by its V flip and one U flip for the frame. Places,
      sizes and flips are `rand()`'s: we draw 368 rocks to its 376, 374 over 200 seeds.
- [x] **You:** `asteroid_billboards` (`src/reference/systems.ts`): the lab field with Cornwall's
      billboards, none about the station.
- [x] An asteroid field's `[DynamicAsteroids]`: `DynamicAsteroids` (`src/scene/dynamic.ts`), from
      `CliDynamicAsteroidUpdate` (`FUN_00525c80`), `Place` (`FUN_00525200`) and
      `CliDynamicAsteroidDraw` (`FUN_005261b0`). `count` rocks, scaled by `(1 - d) · 0.5 + d`, on a
      sphere of `placement_radius` about a point 0.7 of it ahead (75 when it's unwritten;
      `placement_offset` is never read). Each placed with a velocity squared toward `max_velocity`
      and a spin up to `max_angular_velocity` about its own axes, faded over the outer 0.35 of the
      radius squared, and placed afresh past 1.05. None placed outside the section's `zone`, in a lane
      (`SpaceScene.lane`), or in an exclusion zone with `exclude_dynamic_asteroids` within 100 of the
      camera; then those out are released. Updated every frame, near the field or not; drawn after
      the cubes, the archetype's top level whole with its first material, lit by the field's pass even
      when the cubes fade, tinted by `color_shift`, opaque at `ALPHAREF` 127 or blended at 5. A new
      rock's alpha is the heap's, taken as 0, so it shows from its second frame. Pinned by reading.
      **Matched in `asteroid_dynamic`** (`src/reference/dynamic.test.ts`), in kind: draw for draw
      to the cubes' end, then twelve rocks to retail's twelve. Each of retail's is where ours could
      be, within `sqrt(1.05) · 150` of a point 105 ahead, and its alpha is our fade at its place to
      1e-4, so its state is ours: four whole at `ALPHAREF` 127, eight blended at 5, depth written.
      Tints, the field's ambient and its light match; each frame is turned, unscaled. Retail streams
      the indices for each rock, 120 on each time. Motion is IVP's, taken as constant: damping,
      precession and collisions are unchecked, as a still can't show them. Not built: shooting one
      (loot, explosion), which is gameplay.
- [x] **You:** `asteroid_dynamic` (`src/reference/systems.ts`): the lab field with Cornwall's
      `[DynamicAsteroids]`, from inside it.
- [x] A dynamic asteroid's `particle_effect`: `DynamicAsteroids`' `effect`, the host's factory for
      the archetype's `[Effect]`. Started afresh each time its rock is placed (`0x52607e`,
      `CliCreateEffectOneShot`), at the rock's frame and intensity 0; each draw hands it the rock's
      alpha, held to [0, 1] (`0x5265c4`, `FParticleEffect::SetIntensity`), which reaches every node's
      outer time (`IFxEffect` slot 6, `SetNodeOuterTime`): the `sparam`. It matters: both retail
      effects key their emitters' frequency on it, `gf_blsmallasteroid` none at 0 and 12 a second
      from 0.2, so a faded rock trails nothing. The rocks step their own effects, at the intensity
      the last draw gave; `collectSpaceFrame` walks them after the host's, every field's newest
      first, and hands back each view's `lod`. `EFT_DEBRIS_TRAIL` is `EXIST_OFFSCREEN`, so one out of
      view runs on; one that ends is dropped. Pinned by reading. **Matched in `asteroid_badlands`**
      (`src/reference/badlands.test.ts`), in kind: draw for draw to the cubes' end, ten rocks each
      faded as ours at its place to 1e-4. Our view test at retail's ten places sees exactly the four
      whose effects retail drew, the rest running unseen. Each of those draws smoke, flare and
      lightning, additive, `ZFUNC` 4, no depth writes: the flare and lightning in their rock's turned
      frame to 1e-3, the smoke in the world, its newest puff within 10 of the rock. Retail walks
      them 9, 1, 6, 3, no slot order, so newest first. Ours draw the same triples at our seen rocks,
      their particle counts within retail's spread. Seven retail fields carry one: the Badlands' two, Gredos, and the
      lava fields of Bw03, Bw04 and Rh05 (`gf_dynamiclavaast`, in `FX/SPACE/space_ale.ini`, now
      among the loader's tables). Unchecked: where in the frame retail steps effects against the
      rocks' update.
- [x] **You:** `asteroid_badlands` (`src/reference/systems.ts`): the lab field with the Badlands'
      `[DynamicAsteroids]`, ten rocks of 200 about a point 140 ahead, each trailing
      `gf_blsmallasteroid`.
- [x] Suns: a solar's `star` from `solar\StarArch.ini`, `FStarSphere` (`star_sphere.cpp`; the name
      is the decomp's, not a sky): `starGlowDraws`, `starRadius` and `SpaceObject.star`. Reading
      settled where it falls: the fans aren't the cockpit pass's but **the solar's own draw in the
      lists** (`FClientSolarGameobj::Slot188`, `0x548220`, `DrawSimple`), which returns before
      `GameobjSubmitDrawRetail`, so neither `sun.sph`, what's attached nor a flare draws; its sphere is
      `StarSphereMaxGlowScale` (`0x512620`). `DrawBillboard` (`0x5118d0`) turns a square to the camera
      about its up, `radius × scale` from the centre, and `FUN_0050cd50` draws it as a fan of eight
      with `inner_color` at the centre and `outer_color` on the rim: `star_glow`, then `star_center` at
      alpha squared. Unlit, unculled, no depth, under the 250000 plane wherever it's listed. A texture
      with alpha blends by it, one without as `ONE, INVSRCCOLOR` (the `screen` blend mode). In a
      field, after the fog overlay, every sun draws again at the nebula's depth times
      `sun_burnthrough_intensity` and `sun_burnthrough_scaler` times its size (`0x51fad9`), which the
      host reads into `SpaceNebula.burnthrough`. A `star_glow`'s `alpha` is never read. The corner
      order was checked in `Freelancer-original.exe`: the decomp names `FUN_0050cd50`'s vectors the
      other way round from its caller (`0x5119d9`), but both come to `(P − R) + U` first, top left.
      Pinned by reading and by pixels, and matched in `sun_ahead`, `sun_occluded` and `sun_nebula`.
- [x] A sun's `lens_glow` corona: `starCorona`, `updateStar` and `Frame.afterEffects`. Not in
      the cockpit pass's place but after the effects and screen quads (`ScaleEnvironmentEffects`,
      `0x51c7d4`, from the chase camera; the cockpit's wraps its mesh and HUD around it, which is
      M8's). `FStarSphere::Draw` (`0x511ca0`): the zone occlusion eased toward whether the player is
      in a lane or any nebula's or field's zone crosses the line to the sun (`FUN_00511b90`, with
      `ZONE::Intersect`'s clips as `Zone.meets`), what showed of the corona noted for the flare,
      the sun projected in the camera's own pixels, then `FUN_0050da20`: a LOD by its pixel scale,
      less the `SunEffect` option's (`sunEffectQuality`, `sunLeastLod`), 1 to 25 samples on its
      rim and inner ring each casting a ray from the camera (`Unproject`, as far as the sun),
      eased by `glow_fade_in_seconds`, the rest filled from their neighbours. `FUN_0050e6f0` draws
      a fan, or from LOD 3 a band whose diagonals follow the alphas and a fan, at half each
      sample's alpha, added. The flare's `Intensity` follows what showed (`UpdateIntensity`). A ray
      is blocked as `FUN_0050c750` decides, from the host's `rayHits`. `Load` stores
      `zone_occlusion_fade_in` and `_out` over the intensity fades (`0x511381`, checked in
      `Freelancer-original.exe`), so retail's suns ease their flare over 1 s, and their zone
      occlusion keeps 2 s. Fully in a field it only sets its occlusion. Pinned by reading and by
      pixels, and matched in `sun_ahead` and `sun_occluded`.
- [x] The corona's rays against hitboxes: `castRay` and `SpaceObject.hitbox`, from
      `PhysicalSystem::FindRayCollisions` (`FUN_0628d1a0`): every object's shapes, nearest hit
      first, at most 6, each hull the ray enters a hit of its own. The shapes are what
      `BuildIVP_Real` (`0x6288dd0`) gives the body: the `.sur`'s root part at the object, which
      carries its fixed children's hulls, and each `!fxd` part at its own model part
      (`@treewyrm/freelancer`'s SURFACE.md). A `.sph` solar, planet or sun, is a ball of its
      `solar_radius` instead (`CSolar`, `0x62b78c5`; `BuildIVP_Sphere`), which is how a planet
      hides a sun. Down each part's ledge tree by its spheres, then the segment against each
      terminal hull's faces. A hull's id says whether it's a shield's (`Hitbox.shield`). With no
      `rayHits` the frame casts against the objects' hitboxes. A ray from inside a hull is taken
      as not hitting it: IVP's solver there isn't read. Pinned by reading; every ray toward the
      centre of `li_elite`, `space_solar_plant` and `station_small_b_lod` hits, none beside them,
      and culling by the tree changes nothing over 2000 rays at `station_large_a_lod`. Attached
      equipment, shield bubbles and asteroids aren't given shapes yet. Matched for a station in
      `sun_occluded`.
- [x] A sun's `spines` and `lens_flare`: `Star.spines`, `Star.lensFlare` and `starFlare`.
      `FUN_00510160`: each spine three quads out from the sun on screen, spread `2π / count`
      apart from the right, anticlockwise, through the inner ring's radius and the rim's to its
      tip, fading in from nothing at its base; its alpha 0.2 of `Intensity` and 0.8 of the corona's
      samples about it (`FUN_00510990`, only for 2, 4, 6 or 12 spines, as retail indexes them),
      the pixel scale held to `min_radius` and `max_radius`. They draw before the corona, and
      their longest reach decides whether the sun's on screen for them (`0x511fe5`).
      `FUN_0050f850`, at the pass's end, after every sun's corona: each bead a square of the
      whole texture along three times the line from the sun to the screen's middle, sized by the
      held pixel scale and `1 - (1 - Intensity)²`, faded as the sun nears the middle, from where
      the last draw left it. Both add by alpha. Retail sorts beads by heap address; they add, so
      file order draws the same. Pinned by reading, and matched in `sun_ahead` and `sun_occluded`.
- [x] **You:** `sun_ahead`, `sun_occluded` and `sun_nebula` (`src/reference/systems.ts`):
      `med_yellow_sun` 40000 ahead, up and to the right; then `smallstation1_old_nodock` 3000 along
      the line to it, its edge across the sun; then the ship 500 into a nebula's edge,
      `sun_burnthrough_intensity` 0.8 and `_scaler` 1.5, lightning off. **Matched**
      (`src/reference/suns.test.ts`): the scene state for state; every glow, spine and corona
      vertex's colour to the byte and place within 0.005 in the world or 0.001 on screen, after five
      seconds of frames; the flare's nine beads as a set, retail's in heap order. In
      `sun_occluded` that is the station's hitbox blocking exactly retail's samples, partial alphas
      and all; in `sun_nebula`, both glows burning through after the overlay and no corona or flare.
      The pictures (`space.gpu.test.ts`): 99.87%, 99.99% and 99.90% within 2, means 0.34, 0.29 and
      0.14. It found: a sun's draw sets no lighting or fog of its own, so its glow keeps the sky's
      white ambient (`Slot188` returns before `GameobjUpdateDrawLighting`); the alpha test every sun
      draw inherits is `GREATER 0`; and the screen draws inherit `ZWRITEENABLE` 1 under `ZENABLE` 0.
- [ ] Space dust.
- [ ] Gate tunnels.
- [ ] Projectiles and beams; the cockpit pass with its depth clear.
- [ ] Measure effects' CPU cost in a whole system. A pushed lane steps on the CPU, by choice: bring back
      transform feedback only if this shows the need. The picture doesn't depend on it ([ADAPTING.md](ADAPTING.md#alchemy-m6)).
- [x] **You:** a custom system and a save that places the ship, with screenshots and captures.
      `space_order` (`src/reference/systems.ts`, [how](VALIDATION.md#a-reference-system-for-a-space-frame))
      matches retail in `src/reference/space-order.test.ts`: state, place, far plane and lights on all
      122 scene draws, the camera read from the capture. Its picture matches too
      (`space.gpu.test.ts`): 99.96% within 2 and a mean of 0.32 outside the HUD, the effects and the
      loadout. It found four things, now built and pinned:
      - Above all, the near lists draw with `ZFUNC` 4: `DrainMeshAndAsteroids` (`0x51f956`) sets it and
        never restores it, where the menu keeps RP8's 2.
      - `skyLayers`: `star_sphere` draws complex or basic stars, never both (`StarSphereApplyDetail`).
      - `instanceExtent`: a space sky stands at its extent's centre (`StarSphereLoadLayer`), found as the
        model loads, with its parts unposed: measured on two layers to 1e-4.
      - `SpaceObject.pilot`: a ship's `pilot_mesh` at `HpPilot`, before the hull, only at tier 0
        (`AttachPilotMesh`, `Slot188`).

      An object's sphere is the host's: a body's is `get_physical_radius_r`, taken as the `.sur` root
      part's radius and mass centre, and it decided whether the station got the point light. Not
      compared: `mplatform`'s loadout (a turret drawn, a part turned by `mplatform_animate1`) and the
      effects after the objects, both since built. The shot has the chat log's icon in it, from F9; the
      key is F11 since.
- [x] Equipment on a solar or ship from its `loadout`: `SpaceObject.attached`, each model hung on its
      hardpoint by `attachJoint` (`ConnectAttachedHardpoints`, `0x62940c0`, and `HardpointConnect`): two
      revolute hardpoints make a revolute joint with the narrower range, opened to ±π past a full turn;
      otherwise the child's type decides. Drawn after the object in the same `RenderInstance`, so under
      its flags and its `envmap_material`, each part placed by the equipment's own `[LOD]` blocks.
      Retail joins it as the last child of the part holding the hardpoint (`ConnectInstanceChild`), so
      it draws after that part's subtree; here after the whole object, which only reorders within it.
      An `[InternalFX]`'s `use_animation` loops from the solar's start (`CEInternalFX`, flags 2), which
      is the host's: `sampleChannel` into `jointState`. **Matched in `space_order`**: one turret part of
      fourteen, `HpTurret_S1_03`'s `Root`, the rest past their ranges, in state, place and picture; and
      the quarters to 0.002 at one fitted angle, as the log has no clock. A revolute joint's
      orientation is the parent's times the child's, untransposed, as read; every turret's `HpConnect`
      is the identity, so that order is unchecked.
- [x] Effects in `space_order`: each nozzle's `flame_effect` and `trail_effect_player`
      (`CliEngineAttachExhaustEffects`), and `mplatform`'s `[AttachedFX]` smoke, at `sparam` 0 as an
      engine at rest gives it. Draws 123 to 129 match by order, texture, blend and depth, the rings in
      their nozzles' frames, under `FX/effect_types.ini` and `[EffectLOD]` (`effectTypeIndex`,
      `effectLodType`, `effectLodRow`: the host's names, `effect_type` case-sensitive as `strcmp`).
      Counts follow the frame rate, an emitter releasing `floor(dt × frequency)` a step: retail's
      three frames hold 18, 20 and 22 flame particles, and 96 steps a second draws nearest.
- [ ] d3d8log: a time per frame, so a capture says its own frame rate and an effect's count can be
      pinned.
- [ ] Dust against retail, here: a THN host can't show it (see M8), so `FLDustAppearance`'s kite and fade wait
      for a flying camera.

**Done when** a reference system matches in draw order and state, and the system editor runs on this
renderer.

## M8: Rooms and cutscenes

- [ ] Room frame: `room_control.cpp`, its star sphere, backdrop and shadow passes.
- [ ] A room camera's rank 2 in `ClassifySphere`, which drops a part covering under a pixel.
- [ ] A `BackdropMaterial` reference scene, with a `skydome_*` at `usr_flg` 2.
- [ ] Thorn playback: clock, attachments, THN cameras and letterbox.
- [ ] A `PSYS` steps as `Thorn_Psys` does: `advance(dt)`, then `advance(0)`. It's what makes its fields act once a
      frame with the real step's values, and its dust draw nothing (`effect_fields`, `effect_dust`).
- [x] Texture animation, moved here from M3 and built early: `playbackFrame`, `FUN_06ebe660`'s clock as a
      function of elapsed time. A material's loops from load on `Scene.time` (`TickAllPlayback`) and binds
      its frame's atlas alone, as nothing reads the rect `ResolveTextures` writes. An appearance's clamps on
      its own age (`FFxTextureWrapper::Resolve`), a beam's never moves, and a particle's frame -1 reads it
      (`GetFrame`). An animated `Dt` neither cuts nor blends (`FMaterial::Setup`). Pinned by reading and in
      pixels. **Uncaptured.** The format library defaults an absent `FPS` to 15, where retail has 24
      (`0x6ec134d`); every retail animation has one.
- [ ] Texture animation against retail: `li_sci_console`'s `boxes.avi` in a room, and an effect drawing one
      of the FX animations, whose frames all share one atlas.

`freelancer-vscode/docs/renderer/CUTSCENES.md` is a specification to check against the source.

**Done when** a retail base room and one mission cutscene match their references.

## M9: Retire the old renderer

- [ ] Every surface on this renderer, switches defaulting on for a release, then removed.
- [ ] The effect editor's particle markers and sprite frames, read from `EffectInstance`, and its gizmos' placement
      and the host's travel from `effect/game-run.ts`, so the old pool stops stepping underneath.
- [ ] Delete the game-path code from `src/webview/gl`, `alchemy` and `thn` in the extension. Editor
      overlays stay.

## M10: HUD and 2D interface

Wanted later, and not needed to replace the old renderer. Scope it when it comes up: screen quads,
fonts, `ximage` and `screen_quad_state`, in `src/freelancer/Client/`.

## Later, beyond retail

Wanted, and not part of matching the game, so none of this is on by default or in a reference path.

- [ ] **Texture colour depth as an option.** Retail narrows an opaque Targa to R5G6B5 at load (`DAOT`,
      `src/RP8/RP8.cpp`), which is where a starsphere's banding comes from. Keeping the 24 bits is a choice
      in `planUpload`, set on the renderer. It reaches only Targas: a DXT texture has no more to keep.

## Out of scope

- **RP9** and every other port-only feature of the decomp.
- **`TriMesh`**: the reverse-engineering notes found no such nodes in retail `DATA`.
- **Game logic**: flight, physics, AI, missions. The host owns anything that moves things.
- **Editor visuals**: guides, gizmos, overlays, picking. They stay in the extension.
