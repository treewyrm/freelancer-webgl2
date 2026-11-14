# CLAUDE.md

**WebGL2 renderer for Freelancer** (Digital Anvil, 2003), published as
`@treewyrm/freelancer-webgl2`. Its first consumer is [freelancer-vscode](../freelancer-vscode),
whose webviews draw with it.

**Status:** rigid models, planets, starspheres, characters, effects, whole systems, base rooms and cutscenes render and match retail, and every picture in the extension is drawn with it: its own renderer is down to the camera, the pick and the overlays. What retail evidence hasn't settled is in [VALIDATION.md](docs/VALIDATION.md#open-questions); what's uncaptured, per material, in [COVERAGE.md](docs/COVERAGE.md).

| Doc | Covers |
| --- | ------ |
| [docs/API.md](docs/API.md) | The public surface by area, conventions, recipes; update it when an export changes |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The frame as data, materials, host boundary, injection, resources |
| [docs/VALIDATION.md](docs/VALIDATION.md) | Checking against retail: reference scenes, captures, comparison |
| [docs/COVERAGE.md](docs/COVERAGE.md) | Each material's status, by evidence |
| [docs/DECOMP-ERRORS.md](docs/DECOMP-ERRORS.md) | Where the decomp disagrees with the retail binary |
| [docs/retail/](docs/retail/README.md) | How retail renders, where it isn't obvious: materials, characters, animation, Alchemy, THN; each claim checked or marked |

## Commands

```sh
npm test            # pure tests: src/**/*.test.ts, except GPU suites
npm run test:gpu    # src/**/*.gpu.test.ts in headless Chromium, on the hardware GPU
npm run test:all    # both
npm run typecheck   # tsdown and tsx do not typecheck; this does
npm run build       # tsdown → dist/, platform: 'neutral'
npm run format      # Prettier, code only, never .md
npm run reference -- mount li_elite   # put a scene on the lab install's menu; also collect, restore
npm run capture -- references/li_elite   # read a capture; add --draw n for one draw in full
npm run bench       # effects' CPU cost in retail systems; BENCH_THROTTLE=4 for a slower CPU
npm run view -- UNIVERSE/SYSTEMS/LI01/li01.ini -28022,0,51486 0,0,0   # a retail system from eye to target
npm run frames -- room s002xe --video --at 20   # stills and mp4 clips of a cutscene; see frames.ts
npm run frames -- system UNIVERSE/SYSTEMS/LI01/li01.ini --path flyby.json --video   # or --eye/--target, --thn
```

Single file: `node --import tsx --test src/gl/program.gpu.test.ts`

## Sources, in order of authority

1. **[../freelancer-decomp](../freelancer-decomp) `src/`** decides behavior. Start from
   `docs/re/render.md` and `docs/re/shading.md`; `docs/re/deviations.md` lists where the code
   departs from retail. **RP9 is out of scope**: `src/RP9/`, `DATA_EXTRA/` and the volumetric
   nebulae are the port's additions. So are `render_ex.*`, `nebula_volume.*`, `#ifdef FREELANCER_RP9`
   blocks and the switches in `src/Freelancer.Diagnostics.props`, including widescreen.
2. **[../freelancer](https://github.com/treewyrm/freelancer) `docs/`** says what the data means, and
   `docs/refs/RENDERER.md` maps it onto WebGL2: the mirrored projection, winding, matrix upload.
3. **[../freelancer-vscode](../freelancer-vscode)** shows what the consumer needs. Its
   `docs/renderer/` readings are leads, **not a specification**; where they were wrong, the
   Corrections table of each [docs/retail/](docs/retail/README.md) page says so.

**Retail binaries outrank all of these.** The decomp is the fast way in, not the final word: it has
been found wrong, even where its comments say traced. When sources disagree, read the DLL in
`$FREELANCER_DATA/../EXE` ([how](docs/VALIDATION.md#checking-a-reading-in-the-retail-binary)).

Where a reading is uncertain, say so in a comment. Do not turn a guess into a default.

## Fidelity

The target is the **same picture**, not the same steps. The original is a DX8 fixed-function
pipeline, and nothing obliges this library to imitate how it got there.

- **Do not transcribe.** Read the source for what it computes, then write the simplest WebGL2 that
  computes the same thing. Device state caches, COM slots, render-state tables and retail's object
  layouts are how the original got there, and have no place here.
- **Prefer a shader wherever it can give the exact output.** `NomadMaterial`
  (`src/flmaterials/MaterialImpl.cpp`) computes per-vertex values on the CPU and writes them to
  locked vertex memory each frame; here that belongs in the vertex shader.
- **Exact output includes the arithmetic.** Fixed-function clamps per stage, interpolates per
  vertex, and combines in 8-bit fixed point. A shader that drops any of those is a different picture.
- **A correct-looking render is not evidence.** Tests pin behavior read from the source; say which
  function a non-obvious constant or ordering comes from, using the decomp's path and symbol.

## Boundaries

1. **No filesystem, no fetching, no framework.** The host supplies bytes, time, camera and a canvas
   or context. `dist/` must run in a browser, a worker and a bundler with no plugins, which is why
   GLSL lives in `.ts` strings rather than `.glsl` files.
2. **Format knowledge belongs in `@treewyrm/freelancer`.** If this needs to know what a byte means,
   the change goes there. Never parse a game format here. Reuse its `./math`.
3. **Depend on the published library**, never `file:../freelancer`; use `npm link` to iterate on
   both. The same goes for how `freelancer-vscode` will depend on this package.
4. **No game data** in git or the package. Captures go to the ignored `references/`, other output to
   the ignored `artifacts/`. The exception is the README's screenshots in `docs/images/`: frames this
   library drew, in git, never in the package.
5. **Editor visuals stay in `freelancer-vscode`**: guides, overlays, gizmos, picking. This library
   gives them a way in; see below.

## Editor injection

The host must be able to draw its own visuals into a frame without the library knowing what they are.
A frame with a hook that draws nothing must match a frame with no hook, pixel for pixel. The game path
never reads editor state. Details are in [ARCHITECTURE.md](docs/ARCHITECTURE.md#editor-injection).

## Layout

Flat, one directory per subsystem, added when there is code for it. A subsystem gets a subpath in
`exports` and `tsdown.config.ts` once it has a public surface; `#/gl` is internal for now.

| Directory       | Holds                                 | Decomp source                         |
| --------------- | ------------------------------------- | ------------------------------------- |
| `gl/`           | Context, programs, GL resources       | `src/RP8/`                            |
| `texture/`      | Upload plans, GL textures, samplers   | `src/Shading/TextureLibrary.cpp`      |
| `mesh/`         | VMesh buffers and index plans         | `src/RendComp/`                       |
| `scene/`        | Camera, frames, lights, space, rooms  | `src/freelancer/`, `src/Shading/MaterialBatcher.cpp` |
| `material/`     | One program per material type         | `src/Shading/`, `src/flmaterials/`    |
| `deformable/`   | Skinned meshes and bone tables        | `src/Deformable2/`                    |
| `alchemy/`      | Particle effects: run, draws, programs | `src/alchemy/`                       |
| `thorn/`        | THN playback: clock, placement, paths | `src/Thorn/`, `gf_thorn_*`, `gf_script_object.cpp` |
| `harness.ts`    | GPU test runner, never shipped        |                                       |
| `capture/`      | Capture reader and texture names, never shipped |                             |
| `reference/`    | Reference scenes and their install, never shipped |                           |
| `/tools/d3d8log` | Proxy `d3d8.dll` capturing retail frames, C++, never shipped |                |

## Tests

- `x.test.ts` runs in Node, colocated, using `node:test` and `node:assert/strict`.
- `x.gpu.test.ts` runs in Node and drives `x.fixture.ts`, whose default export runs in the page with
  a fresh context. `runFixture` returns its value, the renderer string and a PNG.
- **GPU tests never fall back to software.** Full headless Chromium with ANGLE on the platform's
  native backend; `runFixture` throws on SwiftShader or similar, rather than skipping, because a
  software pass says nothing about what a real driver draws.
- Read pixels back and assert on them. A compiled shader or a mocked context proves nothing.
- Suites reading retail assets use `$FREELANCER_DATA`, falling back to `~/Downloads/Freelancer/DATA`,
  and **skip with a reason when absent**. The rest must not depend on retail data.

## Validating against retail

Tests pin what the source says; retail decides whether the source was read correctly. **Compare state
first, pixels second.** Workflow and pitfalls are in [VALIDATION.md](docs/VALIDATION.md). Never mark a
material as matched in [COVERAGE.md](docs/COVERAGE.md) without a named reference scene.

## Code style

As [@treewyrm/freelancer](https://github.com/treewyrm/freelancer/blob/main/docs/refs/ARCHITECTURE.md), including its naming rules
C1–C14, **with shorter comments**: one line per function where the name does not already say it, and
a comment in the body only for what the code cannot say, such as a retail quirk or a source reference.

- Prettier: single quotes, no semicolons, 100 columns. Never run over Markdown.
- `import type` for types, `.js` on relative imports, `noUncheckedIndexedAccess`.
- `./` for siblings and children, `#/` for everything else. `../` never appears in an import.
- Absence is `undefined`, except where a GL call itself takes or returns `null`.
