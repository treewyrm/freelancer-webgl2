# Architecture

**A proposal until M2 has tested it.** Revise it whenever the code teaches otherwise.

## Shape

```
host: bytes, camera, time, seed, canvas
        │  read with @treewyrm/freelancer
        ▼
scene        models, instances, lights: plain data the host can edit
        │  collect: pure, no GL
        ▼
frame        ordered list of draws and hook points: plain data
        │  execute: all the GL lives here
        ▼
canvas       the host's hooks draw at their points
```

The central decision is **the frame as data**. Collecting a frame touches no GL and produces a list
stating what is drawn, in what order, and with what state.

- **It can be checked against retail directly.** A d3d8log capture is also an ordered list of draws
  and state, so comparing them needs no pixels, and can run in Node.
- **Most logic gets tested without a GPU**: sorting, LOD, material mapping, transforms.
- **Hooks are simply entries in the list.** A hook with nothing to draw has no way to affect the frame.
- **It keeps the game's order out of the backend.** Grouping for speed can only happen where it
  provably doesn't change the picture.

## A draw

Roughly: the mesh range, world and view-projection matrices, a material program and its parameters,
textures, lights, and pipeline state in **GL terms** (blend functions, depth, cull). D3D numbers
appear only in the comparator that translates a capture, so that nothing else inherits them.

## Materials

**One small program per family, not a fixed-function emulator.** A generic combiner shader driven by
state tables would be the same transcription as `freelancer-render`, in GLSL.

- A material module turns library data into a program, parameters and state, in GL terms.
- Shared GLSL fragments cover what really is common: the fixed-function lighting model, fog, alpha test.
- **Fixed-function arithmetic is matched where it shows**: lighting computed per vertex and
  interpolated, colours clamped at each stage, and modulate-2X overflow.
- **CPU work moves to shaders where the result is exact**: Nomad's per-vertex values, UV animation.
- **`Type` is not the class.** `[MaterialMap]` runs first, and an unregistered type draws nothing.

The D3D state table in the source tells us what a family computes; it is not what we implement.

## Frames

Previews, rooms and space share draws and materials but differ in order, lights and fog, so each is
its own `collect`. Previews have no game frame to match: there the host chooses lights and background.

## Skinning and effects

Both keep the extension's GPU-heavy design ([ADAPTING.md](ADAPTING.md)). Skinned meshes are ordinary
draws with a bone table. An effect's simulation is CPU state advanced by the host's `dt`, and each appearance
adds a draw to `Frame.effects`, in the game's tree order. A particle nothing pushes is its birth record,
which the vertex stage carries to now, along with its curves. A pushed one steps on the CPU.

## Host boundary

- **Input is explicit.** The host passes time and a random seed; nothing reads a clock or
  `Math.random`. This makes frames reproducible and comparable with captures.
- **What retail hardcodes is a default, not a constant**, where a mod can patch it: `RETAIL_FRAME_LIMITS`,
  `RETAIL_SPACE_LIMITS`, `RETAIL_SPHERE_LEVELS`, `RETAIL_SWITCH_FOVX`, `RETAIL_POOLS`. A host passes its own, so an editor's settings can match the mod.
- **The host owns** canvas size, scheduling, file loading, resolution order and editor state.
- **Works in a worker**: no DOM use beyond the canvas or context handed in.
- **GPU caches are keyed on object identity**, so hosts must pass raw objects. A deep Vue proxy is a
  different object; `freelancer-vscode` already keeps its reactivity shallow for this reason.

## Editor injection

Frames contain named hook points: `begin` after the clear, `opaque` before the first blended draw, and
`end` after everything; between scene layers comes with M8. They sit between draws and move none, since
retail doesn't draw opaque and blended apart: `li_elite`'s glass blends mid-model. At a hook the host gets
the depth buffer the game path left and a view-projection that includes D3D's pixel shift. It may change
any GL state: the library sets its own again afterward, so a host's changes can't leak into the game path.

What editor passes need, per `freelancer-vscode/docs/renderer/FRAME.md`:

| Editor feature | Needs |
| -------------- | ----- |
| Hull fill, edges, wire | Mesh geometry, part transforms, depth buffer |
| Selection outline | To redraw chosen parts into its own target |
| Hardpoints, bones, markers | Part transforms, camera, depth after everything |
| Picking | Part transforms and mesh geometry; the host does the ray cast |
| Layered sequences | Hooks between layers, and insertion among a layer's objects |

Selection and highlight flags never enter a material program.

## Resources

- A renderer owns the GPU resources it creates; `dispose()` is explicit and complete.
- Instances share meshes and textures. Removing one instance frees nothing another still uses.
- **Context loss rebuilds from retained data**, so design for it from the first buffer.
- Editing an asset invalidates only what depends on it.

## Modules

Flat directories, as in the library. The planned list is in [CLAUDE.md](../CLAUDE.md#layout).
`src/capture/` and `src/harness.ts` are test-only and are never reachable from `src/index.ts`.
