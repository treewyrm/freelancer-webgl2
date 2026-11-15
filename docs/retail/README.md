# How retail renders

What the original game computes, written down where it isn't obvious: an ordering, a clamp, a default
the engine fills in, a precision quirk, a place where the decomp, a modding tool or common belief is
wrong. Read the page for a subject before deciding what retail "probably" does.

These pages began as the extension's `docs/renderer/`, written against its own renderer, and were
carried here and checked against the decomp and the retail binaries (2026-11-13). Each claim says how
it is known:

- **checked** `module!0xADDR`: read in the retail binary;
- **decomp** `path` `Symbol`: agrees in the decomp, the binary not read;
- **observed**: seen in a retail capture or screenshot;
- **unsettled**: what is unknown, said plainly.

Each page ends with what is still **Open**, and the **Corrections** it made to the readings it was
carried from. Formats belong to `@treewyrm/freelancer` ([its docs](https://github.com/treewyrm/freelancer/tree/main/docs)); a
decomp error found on the way is in [DECOMP-ERRORS.md](../DECOMP-ERRORS.md).

| Page | Covers |
| ---- | ------ |
| [MATERIALS.md](MATERIALS.md) | Which class a material becomes, the colour record, texture slots, translucency and the alpha test, each class's state, environment maps, batching, UV animation, the 8-bit arithmetic |
| [CHARACTERS.md](CHARACTERS.md) | The two character builders, the bone table, skinning, strips, joining a costume, detail levels, scripts on the whole character |
| [ANIMATION.md](ANIMATION.md) | Composing each joint type, the range clamp, binding a map, sampling a channel, each map's own clock, root motion, material UV animation |
| [ALCHEMY.md](ALCHEMY.md) | An effect's tree and clock, one frame's order, placement, `sparam` and the LOD key, emitters, a particle's life, fields, sub-effects, the game's host |
| [APPEARANCES.md](APPEARANCES.md) | How particles are drawn: every appearance kind, sizes, frames, which appearance an emitter draws through, blending, draw order |
| [THORN.md](THORN.md) | THN playback as `thorn.dll` runs it: the clock, each event as a matrix composition, curves, paths, the camera, property animations, the host contract |
| [THN-HOST.md](THN-HOST.md) | The game's side of THN: cutscenes as playlists, sequences, rooms, what a script loads, the scene frame, the view, lights, fog, draw order, characters |
| [INTERFACE.md](INTERFACE.md) | Win3D's 3D interface: its camera, placing a control, the shared interface meshes, tints and the materials that read them, the palette and the hover pulse, order and depth, spin and slide |

Not carried: sound in cutscenes (`audioprops`, volume and pan, `START_SOUND` timing), since the
library plays none. The extension keeps it, unchecked, in its
[CUTSCENE-SOUND.md](../../../freelancer-vscode/docs/bases/CUTSCENE-SOUND.md).
