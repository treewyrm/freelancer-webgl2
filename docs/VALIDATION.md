# Validation

Tests pin what the source says. Retail decides whether the source was read correctly. When they
disagree retail wins, and the disagreement gets written down.

## Levels of evidence

From cheapest and most exact, to most expensive:

| Level | Compares | Where | Exact? |
| ----- | -------- | ----- | ------ |
| Unit | Logic against values read from the source | Node | Yes |
| Frame | Our draw list against a retail capture | Node | Yes, within float epsilon |
| Picture | Our canvas against a retail screenshot | GPU | No, stated tolerance |
| Eye | A person looks at it | | Catches what the others missed; proves nothing |

**Compare state first.** The rig runs an x86 game under emulation on Windows-on-ARM through a
paravirtual GPU. d3d8log sits above that stack, so what it records is exactly what the game asked for.
A screenshot also carries that stack's filtering and rounding, and so needs a tolerance with a reason.

**Evidence levels for a material** are the columns of [COVERAGE.md](COVERAGE.md).

## Making a reference scene

1. Describe it in `src/reference/scenes.ts`: model, camera and lights.
2. `npm run reference -- mount <name>` writes the `.thn` and points the three `Intro*` rooms at it, so
   the main menu becomes the scene. It runs on the lab install, never the corpus.
3. Start the game and press F9, which also saves the screenshot.
4. `npm run reference -- collect <name>`, then `restore` when finished.
5. They land in `references/`, or `$FREELANCER_REFERENCES` if set. The directory is in `.gitignore`
   and outside `files` in `package.json`, because captures contain game assets. Suites **skip with a
   reason** when it's absent.

**Use 4:3 and a fixed camera.** Retail only knows 4:3; Hor+ is a port feature of the decomp.
For a system frame, use a custom system and a save that places the ship.

**The menu as a scene gives an almost empty frame**: one camera and what you put in it, plus button
quads that are filterable as `D3DFVF_XYZRHW`, and a software cursor to keep out of the way. See
`freelancer-vscode/docs/renderer/ALCHEMY-LAB.md`, "Mounts, ranked by what a measurement needs".

### A generated model, for what retail barely uses

A material no spawnable archetype carries can still be captured: write a small UV sphere with
`@treewyrm/freelancer`, give it the material under test, and add a lab-only archetype beside the scene.
It shows what the classes do with any data, so it says nothing about what retail's own assets look
like. A generated model is built, not game data, but the capture still goes to `references/`.

### First scenes, by milestone

Models chosen because the earlier projects already found them useful for these features.

| Milestone | Model | Exercises |
| --------- | ----- | --------- |
| M1 | `li_elite` | Lit hull |
| M3 | `li_elite` from a closer angle | Glass, environment map |
| M3 | `ku_dragon` | A batched `DcDtOcOt` on an environment-mapped ship |
| M3 | `ku_dragon_pair` | Two objects' queued glass: sort, and a room's single flush |
| M3 | `prison` | `DcDtEt`, `DcDtEc`, `BtDetailMapMaterial` on one environment-mapped solar |
| M3 | `dyson_door_shield` | A nomad surface whose ramp didn't resolve |
| M3 | `no_fighter` | A nomad surface with its ramp, preloaded on the lab install |
| M3 | `lair` | A material UV animation, on the one archetype in retail with any |
| M3 | `bands` | A generated sphere, a band per material: what retail barely uses, and mods can name |
| M3 | `bands_one_uv` | A stage asking for a second UV set on a mesh with one |
| M3, M4 | `bands_planet` | The planet classes on a generated sphere, as evidence for M4 |
| M3 | `lair_core` | A queued `DcDtOcOtTwo`, and `DcDtEt` and `BtDetailMapMaterial` with no environment map |
| M3 | Rheinland fighter cockpit | Batching, translucency |
| M3 | Nomad fighter | Nomad material |
| M3 | Dyson platform | Detail map |
| M4 | `run1-stock-menu` | Two real `.sph` planets and their shells, with no scene to set up, but no normals logged |
| M4 | `planet_earth` | `planet_earth_3000`: `Masked2DetailMapMaterial`, its shell, terminator and limb |
| M4 | `starsphere_li01` | Two layers, `DcDtEc` stars, `Nebula`, and a blended `DcDtEcOcOt` under the override |
| M4 | `starsphere_st03b` | `DcDt` alone, with no normals |
| M4 | `starsphere_ew05` | `Nebula`, two bright layers of one texture |
| M4 | `starsphere_ew06` | `Nebula`, two layers of different textures |

## The capture

`tools/d3d8log` is a proxy `d3d8.dll`; see its [README](../tools/d3d8log/README.md) for the format.
Each captured draw records its full device state, read back from the device, along with clears, scene
boundaries and render target changes. Textures are identified by content hash. The last frame's front
buffer is saved beside the log.

## The rig

| Install | Role | Notes |
| ------- | ---- | ----- |
| `~/Downloads/Freelancer` | Corpus, `$FREELANCER_DATA`. Never written | `common.dll` is build 1.0.1223.11 |
| `C:\Games\Freelancer` in the Parallels guest | The lab, `$FREELANCER_GAME`. Scenes and the proxy go here | `Common.dll` is build 1.0.1254.11; `DALib`, `Server`, `RemoteClient` also differ. The menu still says 1.0 |

The two share byte-identical `rp8`, `shading`, `flmaterials`, `rendcomp`, `alchemy`, `thorn`,
`deformable2` and `engbase`, and all 8,368 `DATA` files match in size. So captures are evidence for the
renderer. **An address looked up in the corpus's `common.dll` may not match what the lab runs.**

The game can't be started from the Mac, since `prlctl exec` needs Parallels Pro or Business.

## Reading a capture correctly

- **D3D matrices are row-major and apply to row vectors**: `p * M`, translation in the last row.
- **The captured world matrix is the whole modelview, Z flip included, and the view is identity.**
  That's `FDirectX8::SetModelview` with viewspace lights on (`PipelineStateValue(7)`), as in every
  draw of `li_elite`. Light directions arrive in that same space. With them off the flip moves to the
  view, so check which case a capture is in, and test any conversion on a known point.
- **A texture's name may not be the one the game loaded.** The index finds pixels, and identical
  pixels live in several libraries: `metal03` lists a cockpit first. Check a material's own name is
  among the matches.
- **Our projection is mirrored on purpose**; see the library's `RENDERER.md` §2. Compare what the two
  do to known points rather than comparing matrix elements directly.
- **State reaches the device late.** RP8 merges state before each draw (`FlushDrawState`), so the
  proxy sees the effective values, and that is the right thing to compare. Source tables may look
  different and still agree.
- **We need not issue the same draws.** We can merge passes in a shader. The comparator must allow an
  explicit, reviewed mapping such as "these two retail passes are this one draw".

## Measured agreement

`src/reference/picture.gpu.test.ts` compares the canvas with the screenshot on the hull: outside the
menu's art, which this renderer doesn't draw, and the canopy, below. **Tolerance: at least 99.5% of
pixels within 2 of 255 on every channel, a mean worst-channel difference of at most 0.5, and at most
0.2% of pixels lit on one side only.** Measured in `li_elite` and `li_elite_turned`: 99.9% and a mean of
about 0.2, on an Apple M4 Max under ANGLE Metal.

So the rig's stack adds little to a picture of a textured surface, and neither does gamma. The log's
gamma ramp reads a linear 0..255 where D3D's range is 0..65535. That stays unexplained, but the
screenshot shows no sign of it.

## Open questions

**Why does `starsphere_ew05`'s green read low?** Its picture is 99.95% within 2, and its state matches,
but its mean of 0.59 is over the usual 0.5, with green at -0.34, red at +0.08 and blue at +0.15 where
the other three skies stay within 0.1. Nearly every pixel has two additive layers of the same texture,
so a bias per layer would add and not cancel, and `starsphere_st03b`'s single layer has green at -0.10.
That fits, and green is the one channel with its own precision in R5G6B5, but `starsphere_ew06` also
has two R5G6B5 layers, of different textures, and no such bias. A final image can't separate layers, as both cover the same pixels. A lab copy of the
model with one layer would tell. Its limit is 0.65 until then. Apart from that, 135 pixels differ by
more than 4, up to 110, mostly on the thin bright streak, in both directions: slivers rasterized
differently, as far as can be seen, which is too few to move the mean.

**Does retail's glass reflect?** `SubmitEnvMapGeometry` binds `envmapglass` on stage 1 for the outer
pass, and the capture shows it bound and `MODULATE2X` (draw 13). The rig's screenshot shows no such
thing: solving each canopy pixel for the cube value gives 0.50 everywhere, whichever way the reflection
points, so the stage acts as nothing. On the hull the same stage works, and `envmapbasic` beats a flat
0.5 and a flipped direction. What sets glass apart is an empty stage 0. The rig's D3D8 is a translator,
so this may be its handling of that stage and not what a real D3D8 driver draws, and the rig can't tell
those apart. **It takes a screenshot from a real GPU to settle.** Until then the frame follows the
capture, the shader reflects, and the picture test masks the canopy, so our canopy differs from the
rig's screenshot by about 11 of 255 on average.

Deferred on purpose. To settle it, mount `li_elite_turned` on a Windows machine with a real GPU and
compare the canopy with the rig's screenshot:

- **It reflects:** the rig is at fault. Keep the shader, note the rig's limit here, and test the canopy
  against the new screenshot.
- **It doesn't:** an empty stage 0 turns the reflection off. Make that the rule, in
  `src/material/dcdt.ts` (`reflecting && textured`), and drop the canopy from the test's mask.

**Why does nomad's picture miss by more than the rest?** `no_fighter` reaches 97.1% within 2 and a mean
of 0.58, against 99.9% and 0.2 elsewhere, in scattered pixels up to about 20 of 255. The state matches,
every written vertex matches, the ramp's pixels hash the same as retail's, and a LOD bias of 0.25 either
way is far worse (mean 2.9 and 3.3). The suspicion is where each GPU places a nearest-mip transition,
which a surface sweeping the ramp's alpha would show most, but that isn't measured. The test holds it to
a limit of its own until a real-GPU screenshot can say.

**What does a nomad surface need in a real game?** In a menu scene its ramp binds only if `nomad_fx.txm`
was loaded before the material verified. The door shield's archetype lists it after its `.mat`, and
`no_fighter`'s materials load with the model, so neither binds it unless `FX/effect_shapes.ini` preloads
it on the lab install, and then it renders as expected. Taking the load order as the cause is
an inference: no preload, no ramp; preload, ramp. The code loading `material_library` hasn't been read.

**Nomad surfaces don't scroll.** `flmaterials.dll` has a five-second scroll in `v` (`0x6704060`), but its
clock only moves by the delta given to `ResolveTextures`, and the call sites of the library's update in
the lab's unencrypted `Freelancer.exe` pass 0 (`0x41af28`, `0x41b014`, `0x41c8b0`, `0x5b42ed`, `0x5b4954`;
`0x41acc1` passes `ebx`, which the decomp reads as 0). `no_fighter`'s capture has `v` at exactly 1 on every
vertex at frame 633. `rendcomp`, `flmaterials`, `dalib` and `engbase` have no float call through that slot.
The owner's memory of retail agrees. The corpus copy of `Freelancer.exe` is encrypted, so this reads the
lab's, a later build. A flight capture would be the last word.

**What does an empty stage do?** On the rig, a stage with no texture acts as if it were off: `ADD` with no
ramp leaves the picture as stage 0 made it (`dyson_door_shield`), and `MODULATE2X` with no `Bt` doesn't
double (`bands`, exactly half of what doubling gives). So the renderer draws it that way, as the only
measurement there is. Glass with an empty stage 0 ignoring a bound stage 1 would follow if the rig's
translator stopped at the first empty stage, which is a lead for the canopy above and not a finding. A
real D3D8 driver may read an empty stage as white, in which case all of these change together.

**What does a UV set the mesh hasn't got read?** `TEXCOORDINDEX` stays 1 on a one-set format, and the
rig's picture is of a constant (0, 0): flat, from a texture's first texel (`bands_one_uv`). So the 52 retail
draws asking for that show flat detail here, not UV0 as the extension and Librelancer read them. A real
driver may differ, as with an empty stage.

**What crashes the game?** A generated sphere with a band typed `VisibleCounterMaterial`, or one typed
`ShadowMaterial`, brings the game down, each alone beside a plain band; two plain bands on the same scene
don't. So does a sphere holding all nine override types, with or without an environment map. Why isn't
known: the decomp's counter only adds to three numbers as it draws, which doesn't explain a crash, so
creating one as a material may be what fails, and the other seven may do the same. When in the run it
fails wasn't observed.

**A nomad surface on an environment-mapped object is invisible.** Its fade and the override's cube name
share one per-object slot, so the pointer is read as a float (`bands`: vertices written `0x00ffffff`, and
none of it on screen). On the rig's install the pointer lands near 0. It stays a pointer, so a value
that reads otherwise can't be ruled out. None of the 178 environment-mapped ship, solar, asteroid, loot
crate and gun archetypes in retail has a nomad material, so this only reaches mods.

## Checking a reading in the retail binary

When the decomp and another source disagree, the binary settles it. No game needs to run, and mingw
is already required for `d3d8log`:

```sh
i686-w64-mingw32-objdump -d -M intel --start-address=0x06217230 --stop-address=0x06217420 \
  ~/Downloads/Freelancer/EXE/alchemy.dll
```

Addresses in both projects are retail virtual addresses. **Track the stack**: `[esp+N]` shifts with each
push and pop, which is how the decomp's error in
[ADAPTING.md](ADAPTING.md#known-decomp-errors) arose. Record what you find and its address in the code.

## Optional: checking the decomp itself

d3d8log works on any D3D8 executable, so it can also run against a build of the decomp. Diffing
that against a retail capture of the same scene shows directly where the decomp's rendering departs
from retail, which helps when a source reading and a capture disagree.
