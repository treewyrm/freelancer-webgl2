# Validation

Tests pin what the source says. Retail decides whether the source was read correctly. When they
disagree retail wins, and the disagreement gets written down.

## Levels of evidence

| Level | Compares | Where | Exact? |
| ----- | -------- | ----- | ------ |
| Unit | Logic against values read from the source | Node | Yes |
| Frame | Our draw list against a retail capture | Node | Yes, within float epsilon |
| Picture | Our canvas against a retail screenshot | GPU | No, stated tolerance |
| Eye | A person looks at it | | Catches what the others missed; proves nothing |

**Compare state first.** The rig runs an x86 game under emulation on Windows-on-ARM through a
paravirtual GPU. d3d8log sits above that stack, so what it records is exactly what the game asked for.
A screenshot also carries that stack's filtering and rounding, and so needs a tolerance with a reason.
A material's evidence levels are the columns of [COVERAGE.md](COVERAGE.md).

## Making a reference scene

Scenes are described in `src/reference/scenes.ts`, `systems.ts` and `thorn.ts`, each with a comment
saying what it exercises.

1. `npm run reference -- mount <name>` writes the `.thn` and points the three `Intro*` rooms at it, so
   the main menu becomes the scene. It runs on the lab install, never the corpus.
2. Start the game and press F11, the proxy's `key`, which also saves the screenshot.
3. `npm run reference -- collect <name>`, then `restore` when finished.
4. They land in `references/`, or `$FREELANCER_REFERENCES` if set: ignored by git and outside the
   package, because captures contain game assets. Suites **skip with a reason** when it's absent.

**Use 4:3 and a fixed camera.** Retail only knows 4:3; Hor+ is a port feature of the decomp. The menu
as a scene gives an almost empty frame: the camera and what you put in it, plus button quads
(filterable as `D3DFVF_XYZRHW`) and a software cursor to keep out of the way.

### A reference system

For a space frame, `mount` leaves the menu alone and writes `UNIVERSE/SYSTEMS/LAB/<name>.ini`, listed
in `universe.ini` as `Lab_<name>`, and a plain-text save `lab_<name>.fl` with no `base`, so it loads in
space, and `Mission = No_Mission`. Load the save, let the chase camera settle without touching the
controls, then press F11 (F9 opens the chat log in space). `restore` removes the systems and saves too.
The scene's draws end at a depth clear, after which the HUD draws.

The comparison reads the camera from the capture: a known solar's translation in the far list gives
its position, the sky's rotation its orientation, the projection its field of view and planes. The ship's
position comes from its hull's first draw, since the game moves it a little as it loads.

A system leaves out, unless the scene is about it: anything dockable (one with no `base` logs an error,
and three crashed the first load), `[Dust]`, suns, `rotate` and `spin`, and the player's lights, guns
and contrails. The engine stays, and its flame is in the frame.

**Every mounted lab system loads, so a zone's nickname is the universe's.** A later zone with the same
nickname is dropped silently, from its system's list too (`InsertZone`). `systems.test.ts` holds scenes
to sharing a zone only if it is the same zone.

### A generated model

A material no spawnable archetype carries can still be captured: write a small UV sphere with
`@treewyrm/freelancer`, give it the material under test, and add a lab-only archetype beside the scene.
It shows what the classes do with any data, not what retail's own assets look like.

## The capture

`tools/d3d8log` is a proxy `d3d8.dll`; its [README](../tools/d3d8log/README.md) has the format. Each
captured draw records its full device state, read back from the device, along with clears, scene
boundaries and render target changes. Textures are identified by content hash. The last frame's front
buffer is saved beside the log. `npm run capture` reads one.

## The rig

| Install | Role | Notes |
| ------- | ---- | ----- |
| `~/Downloads/Freelancer` | Corpus, `$FREELANCER_DATA`. Never written | Patched to 1.1 on 2026-11-14: `common.dll` is build 1.0.1254.11, as in the lab |
| `C:\Games\Freelancer` in the Parallels guest | The lab, `$FREELANCER_GAME`. Scenes and the proxy go here | 1.1: `Common.dll` is build 1.0.1254.11 |

The two are one 1.1 install: every binary and all of `DATA` match byte for byte, so captures are
evidence for the renderer, and an address looked up in the corpus is what the lab runs. Two
differences remain. The lab's `Freelancer.exe` is the unpacked exe the corpus keeps as
`Freelancer-original.exe`, and the lab's `freelancer.ini` skips the intro movies. The game can't be
started from the Mac.

## Reading a capture correctly

- **D3D matrices are row-major and apply to row vectors**: `p * M`, translation in the last row.
- **The captured world matrix is the whole modelview, Z flip included, and the view is identity**, with
  viewspace lights on (`FDirectX8::SetModelview`, `PipelineStateValue(7)`). Light directions arrive in
  that space. With them off the flip moves to the view, so check which case a capture is in.
- **A texture's name may not be the one the game loaded.** Identical pixels live in several libraries:
  `metal03` lists a cockpit first. Check a material's own name is among the matches.
- **Our projection is mirrored on purpose** (the format library's `RENDERER.md` §2). Compare what the
  two do to known points, not matrix elements.
- **State reaches the device late.** RP8 merges state before each draw (`FlushDrawState`), so the proxy
  sees the effective values, which is what to compare.
- **We need not issue the same draws.** The comparator allows an explicit, reviewed mapping such as
  "these two retail passes are this one draw".

## Measured agreement

`picture.gpu.test.ts` and `space.gpu.test.ts` in `src/reference/` hold the canvas to the screenshot,
outside the menu's art, the HUD, effects' random particles and the canopy (below). **Tolerance: at least
99.5% of pixels within 2 of 255 on every channel, a mean worst-channel difference of at most 0.5, and at
most 0.2% of pixels lit on one side only.** Typical: 99.9% and a mean of 0.2 to 0.35, on an Apple M4 Max
under ANGLE Metal. So the rig's stack adds little to a textured surface, and neither does gamma.

## Open questions

Most need a screenshot from a real GPU; the rig's D3D8 is a translator and can't tell its own handling
from a driver's.

**`starsphere_ew05`'s green reads low**: mean 0.59, green -0.34, where the other skies stay within 0.1.
Its two additive layers share one R5G6B5 texture, so a per-layer bias would add; but `starsphere_ew06`'s
two R5G6B5 layers show none. A lab copy with one layer would tell. Its limit is 0.65 until then.

**Does retail's glass reflect?** The capture binds `envmapglass` on stage 1 with `MODULATE2X`, but the
rig's canopy solves to a cube value of 0.50 everywhere: the stage does nothing. Glass differs from the
hull, where the stage works, by its empty stage 0 (see below). The frame follows the capture and the
picture test masks the canopy. To settle it, mount `li_elite_turned` on a real GPU: if it reflects, unmask
the canopy; if not, make an empty stage 0 turn reflection off in `src/material/dcdt.ts`
(`reflecting && textured`).

**What does an empty stage do?** On the rig, it acts as off: `ADD` with no ramp leaves stage 0's picture
(`dyson_door_shield`), and `MODULATE2X` with no `Bt` doesn't double (`bands`). The renderer follows
that. A real driver may read it as white, and then all of these change together.

**What does a UV set the mesh hasn't got read?** The rig gives a constant (0, 0) (`bands_one_uv`), so
the 52 retail draws asking for one show flat detail here. A real driver may differ.

**Nomad's picture misses by more than the rest**: `no_fighter` is 97.1% within 2, mean 0.58, with state
and every vertex matching. The suspicion is where each GPU places a nearest-mip transition; it has its
own limit until a real GPU can say.

**What does a nomad surface need in a real game?** In a menu scene its ramp binds only if `nomad_fx.txm`
loaded before the material verified, which on the lab install takes a preload in
`FX/effect_shapes.ini`. Load order as the cause is an inference; the code loading `material_library`
hasn't been read.

**Nomad surfaces don't scroll.** `flmaterials.dll` has a five-second scroll in `v` (`0x6704060`), but
every caller of the library's update in the lab's `Freelancer.exe` passes 0 (`0x41af28`, `0x41b014`,
`0x41c8b0`, `0x5b42ed`, `0x5b4954`), and `no_fighter`'s capture has `v` at exactly 1. The corpus's
executable is encrypted, so this reads the lab's later build. A flight capture would be the last word.

**What crashes the game?** A band typed `VisibleCounterMaterial` or `ShadowMaterial` does, each alone
beside a plain band, as does a sphere holding all nine override types. The decomp's counter doesn't
explain it, so creating one as a material may be what fails, and the other seven may too.

**A nomad surface on an environment-mapped object is invisible.** Its fade and the override's cube name
share one per-object slot, so the pointer is read as a float (`bands`: vertices written `0x00ffffff`).
No environment-mapped archetype in retail has a nomad material, so this only reaches mods.

## Checking a reading in the retail binary

When the decomp and another source disagree, the binary settles it. No game needs to run, and mingw is
already required for `d3d8log`:

```sh
i686-w64-mingw32-objdump -d -M intel --start-address=0x06217230 --stop-address=0x06217420 \
  ~/Downloads/Freelancer/EXE/alchemy.dll
```

Addresses are retail virtual addresses. **Track the stack**: `[esp+N]` shifts with each push and pop,
which is how several of [DECOMP-ERRORS.md](DECOMP-ERRORS.md) arose. Record what you find and its address
in the code.

d3d8log also runs against a build of the decomp, and a diff against a retail capture of the same scene
shows where the decomp's rendering departs.
