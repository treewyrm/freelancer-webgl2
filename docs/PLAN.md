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
| [M1](#m1-first-picture) | One static ship, matched against retail | **Next** |
| [M2](#m2-in-the-model-viewer) | That ship in the real model viewer, with editor overlays | |
| [M3](#m3-every-rigid-model) | All materials on rigid models, with animation and LOD | |
| [M4](#m4-spheres-and-the-sky) | Planets, atmospheres, starspheres | |
| [M5](#m5-characters) | Skinned characters | |
| [M6](#m6-effects) | Alchemy effects | |
| [M7](#m7-the-space-frame) | A whole system, as the game frames it | |
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
      reference. They and the logged vertices match `li_elite` exactly; all 9,322 retail references
      stay in range. **Not captured:** normals, which `d3d8log` doesn't log. Add them for lighting.
- [ ] Camera: THN `cameraprops` to matrices, with the mirrored projection and `CCW` (`RENDERER.md` §2).
- [ ] Static `Cmpnd` hierarchy to world transforms (§5).
- [ ] Frame as data: a pure function from scene to ordered draw list ([ARCHITECTURE.md](ARCHITECTURE.md)).
- [ ] Fixed-function vertex lighting, from `SetLight` and `SetMaterial` semantics, in a vertex shader.
- [ ] `DcDt` as the first material program. **Not plain `DcDt`:** the captured hull draws add the
      `envmapbasic` cube on the next stage, `MODULATE2X` with camera space reflection
      (`FMaterialImpl::BindEnvMap`). It comes from the archetype's `envmap_material`, not the model
      (library `RENDERER.md` §6), and `use_environment_maps` must be above 0, so the scene must carry
      it from the host. In a room any non-empty value means `envmapbasic`, whatever it names
      (`src/freelancer/Client/room_control.cpp`).
- [ ] The second passes in `li_elite`: `L_glass` draws back faces, then blended front faces with
      `envmapglass`; `DcDtTwo` draws front, then back. So 19 mesh groups make 22 draws.
- [ ] Comparator: draw list against capture, then canvas against screenshot.

**Done when** the reference scene matches in draw count, order, state and matrices, and the picture
matches within a stated tolerance.

## M2: In the model viewer

Early on purpose: it tests the API and the injection design while they are cheap to change.

- [ ] Renderer API, first version, shaped by what `src/webview/model/` calls.
- [ ] Hook points in the frame, with the empty-hook pixel test.
- [ ] Resource ownership: explicit disposal, sharing between instances, context-loss recovery.
- [ ] Unsupported materials are reported to the host; none disappears silently.
- [ ] In `freelancer-vscode`, as its own change: a setting that switches the model viewer to this
      renderer, with at least hardpoints and wireframe drawn through hooks.

**Done when** `li_elite` opens in the extension behind the switch, overlays included, and resizing,
closing and losing the context all work. Then revise the API with what was learned.

## M3: Every rigid model

- [ ] `[MaterialMap]` and the name rewrites; unregistered types draw nothing, as in retail.
- [ ] All `DcDt` classes, blending by value, the alpha test, two-sided variants.
- [ ] Transparency order and `MaterialBatcher`.
- [ ] `DcDtEt`, `BtDetailMapMaterial`, glass, environment maps.
- [ ] **`NomadMaterial` in shaders**, as the worked example of not transcribing.
- [ ] Engine overrides: colorize, cloak, wire, engine glow.
- [ ] LOD selection, joint animation, material UV animation, texture animation.
- [ ] Corpus suite: every retail model plans a frame without an unexplained material.
- [ ] **You:** reference scenes for each new family.
- [ ] Move the extension's material and texture previews across.

**Done when** every rigid-model row in [COVERAGE.md](COVERAGE.md) has reached "state matched", and
the model viewer's switch can default to on. **From here on, stop adding shading features to the old
renderer**, so the two don't diverge.

## M4: Spheres and the sky

- [ ] Sphere patch tessellation and the `M0..M5` face order.
- [ ] The four planet surface types and `AtmosphereMaterial`.
- [ ] `Nebula` materials; starsphere and backdrop overrides, with the game's draw order for the layers.
- [ ] **You:** reference scenes for a planet and a starsphere.

**Done when** the sphere rows are state matched. The tessellation density is a budget in the game, so
compare its density-independent results only.

## M5: Characters

Adapted from `freelancer-vscode`'s GPU skinning; see [ADAPTING.md](ADAPTING.md#gpu-skinning-m5).

- [ ] Adapt skinned geometry and the skinned vertex stage, with a root-relative bone table.
- [ ] Add what's missing: `EyeMaterial` and the eye UV bone, a detail level per part, levels drawn
      rigid past the skinned count.
- [ ] Costumes joined from four `.dfm` files.
- [ ] **You:** a reference scene with a character.

**Done when** the character editor runs on this renderer behind its switch and the eye and skin rows
are state matched.

## M6: Effects

Adapted from `freelancer-vscode`'s Alchemy; see [ADAPTING.md](ADAPTING.md#alchemy-m6).

- [ ] Audit the rest of its ledger against the decomp and, where they differ, retail.
- [ ] Adapt the simulation and effect shaders, driven by host-supplied time and a seed.
- [ ] Rewrite the draw side against the frame list; gizmos stay in the extension, behind hooks.
- [ ] Settle the fixed step against retail's per-frame `dt`.
- [ ] Effects mounted on model hardpoints.
- [ ] **You:** reference scenes, reusing the one-particle lab assets where they still serve.

**Done when** captured particle quads match by measurement, and the effect editor runs on this
renderer. Random streams need not match retail; each appearance's sizes, colours and blends must.

## M7: The space frame

- [ ] The game's frame order: lists sorted back to front, far list, main lists, effects.
- [ ] Light selection, ambient, fog and nebula state.
- [ ] Planet rings, asteroid field exteriors and billboards, space dust, gate tunnels.
- [ ] Projectiles and beams; the cockpit pass with its depth clear.
- [ ] **You:** a custom system and a save that places the ship, with screenshots and captures.

**Done when** a reference system matches in draw order and state, and the system editor runs on this
renderer.

## M8: Rooms and cutscenes

- [ ] Room frame: `room_control.cpp`, its star sphere, backdrop and shadow passes.
- [ ] Thorn playback: clock, attachments, THN cameras and letterbox.

`freelancer-vscode/docs/renderer/CUTSCENES.md` is a specification to check against the source.

**Done when** a retail base room and one mission cutscene match their references.

## M9: Retire the old renderer

- [ ] Every surface on this renderer, switches defaulting on for a release, then removed.
- [ ] Delete the game-path code from `src/webview/gl`, `alchemy` and `thn` in the extension. Editor
      overlays stay.

## M10: HUD and 2D interface

Wanted later, and not needed to replace the old renderer. Scope it when it comes up: screen quads,
fonts, `ximage` and `screen_quad_state`, in `src/freelancer/Client/`.

## Out of scope

- **RP9** and every other port-only feature of the decomp.
- **`TriMesh`**: the reverse-engineering notes found no such nodes in retail `DATA`.
- **Game logic**: flight, physics, AI, missions. The host owns anything that moves things.
- **Editor visuals**: guides, gizmos, overlays, picking. They stay in the extension.
