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

### First scenes, by milestone

Models chosen because the earlier projects already found them useful for these features.

| Milestone | Model | Exercises |
| --------- | ----- | --------- |
| M1 | `li_elite` | Lit hull |
| M3 | `li_elite` from a closer angle | Glass, environment map |
| M3 | Rheinland fighter cockpit | Batching, translucency |
| M3 | Nomad fighter | Nomad material |
| M3 | Dyson platform | Detail map |
| M4 | Earth | Planet surfaces, atmosphere |
| M4 | `ew06` starsphere | Nebula, sky order |

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
