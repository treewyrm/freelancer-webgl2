# Adapting from freelancer-vscode

`freelancer-vscode`'s effect system and GPU skinning were read from the retail DLLs and move work onto
the GPU, unlike its early material path. They are worth adapting rather than rewriting, provided each
piece is audited first. This page records what has been checked, and what hasn't.

**Audit before adapting**: compare the piece with `freelancer-decomp`, and where they disagree, read
the retail binary ([VALIDATION.md](VALIDATION.md#checking-a-reading-in-the-retail-binary)). Then
rewrite it to this project's style: shorter comments, and no viewer or editor state.

## GPU skinning (M5)

**Verdict: adapt.** `src/webview/gl/skin.ts` and `skinVertexSource` in `gl/shaders/mesh.ts` match retail
for all retail data. Checked against `FMeshArchetype::Skin` in `Deformable2.cpp` (2026-11-04).

| Checked | Result |
| ------- | ------ |
| 1 influence: weight ignored | Matches |
| 2 to 4: unnormalized weighted sum | Matches |
| 5 or more: first influence alone, at its own weight | Matches |
| Normal as a direction; renormalized when blended | Matches; the shader always renormalizes, harmless for rigid bones |
| One skinned normal per point, shared by its elements | Matches |
| Influence slices cumulative from `Point_bone_count` | Matches the library's `DEFORMABLE.md` |

**Adapted** into `src/deformable/skin.ts`, with the two changes below, and matched against
`character_reed`. The strips expand at load as `ExpandTristrip` writes them, where the extension's odd
triangles start from another corner: the same triangle, and retail's indices here.

**Change when adapting:**

- **Make the bone table root-relative.** Retail computes `K = W(root)⁻¹ · W(bone) · B` and draws with
  `W(root)`; the extension bakes `W(bone) · B` and draws with identity. The two agree when weights sum
  to one, which holds for retail. Otherwise the extension scales about the world origin, where retail
  scales about the root, which affects modded files. Root-relative tables also keep precision for
  characters far from the origin.
- **Size the table from the model.** `MAX_BONES = 86` is the retail maximum, and a modded model could
  exceed it. A 16 KB uniform block holds 256 `mat4`.

**Missing, confirmed in the decomp:**

- The eye UV bone, and `EyeMaterial`, which the extension has as `DcDt` and so shows the `Et` retail drops.
- A detail level per part, from `[DetailSwitchTable]`. The extension shares one across a character.
- Levels past a part's skinned count draw rigid at bind (`Flag70`). The extension skins every level.

## Alchemy (M6)

**Verdict: adapt, and finish the audit in M6.** Spot checks agree with the decomp and retail. This is
a sample of a large system, not proof of the whole. Its own ledger, `docs/renderer/ALCHEMY.md`, marks
readings as disassembled, with addresses that can be checked one by one.

| Part | Size | Plan |
| ---- | ---- | ---- |
| `src/webview/alchemy/` | About 4,500 lines; imports only the library and itself | Adapt |
| `gl/shaders/{sprites,curves,fields,motion}.ts` | About 900 lines | Adapt |
| `gl/arena.ts`, `gl/integrate.ts`, `gl/sprite.ts` | GPU store, transform feedback, templates | Adapt |
| `gl/effects.ts`, `render/passes/effects.ts` | About 2,600 lines; gizmos and old renderer plumbing mixed in | Rewrite against the frame list |

| Checked | Result |
| ------- | ------ |
| Emission: truncated count, bursts, LOD carry (`alchemy_emitters.cpp`) | Matches |
| Pass state: lighting off, no Z writes, no culling, blend on (`alchemy_alchemy.cpp`) | Matches |
| Blend taken per node from `BlendInfo` | Matches |
| Skip at alpha under 0.01 | Matches |
| Triangle sprite, equilateral with circumradius `2·Size` | Matches retail; **the decomp is wrong** ([below](#known-decomp-errors)) |
| Sort keys: appearance 100, emitter 300, folder 400 | Matches the extension's draw order notes |
| Curves handed to the shader whole, not baked | Good: the extension measured baking to lose 10% of alpha at the 99th percentile |
| Fog applied across the effects pass | Per-pixel, which matches table fog; the rig's capture will show which mode it uses |

**To settle in M6:**

- **Fixed step.** The pool steps at 1/60 s; retail uses the frame's own `dt`. Emission and turbulence
  depend on step size, so captures need a known frame rate, or comparison by measurement.
- **The rest of the ledger**: the other appearances, fields, sub-effects and beams, by the same method.
- **Defaults**, such as what a node with no `BlendInfo` gets. Retail seeds `{5, 2}`; not yet compared.
- **`FxMeshAppearance`** isn't implemented. The extension's notes count 4 nodes and say the game
  crashes when one spawns a particle, so it can probably stay out. Confirm first.

## Known decomp errors

Places where the decomp disagrees with the retail binary. Keep these, and report them upstream if you
want them fixed there.

### `FEyeMaterial::Bind`

`src/Deformable2/EyeMaterial.cpp`, retail `0x65fff20`. Found 2026-11-05.

It writes the eye offset to `m[0][2]` and `m[1][2]` of the stage's matrix, where a 2D coordinate never
reads it. `character_eyes` captures `[1,0,0,0, 0,1,0,0, U,V,1,0, 0,0,0,1]`, the third row, and the eye
moves. **Reading the stack offsets by hand reproduced the decomp's error**: the two stores sit between
pushes that are easy to miscount. A capture of the matrix is what settled it.

### `FxBasicAppearance::FillTriangleGeometry`

`src/alchemy/alchemy_appearances.cpp`, retail `0x6216f20`. Found 2026-11-04.

| | Base half-width | Apex distance |
| - | --------------- | ------------- |
| Decomp | `2·S` | The particle's **alpha** |
| Retail | `√3·S` | `2·S` |

Retail stores `2S` at `[esp+0x50]` and `2S × 0.866025` at `[esp+0x54]`. It multiplies the rotation by
the second at `0x6217280`, and only afterward overwrites that slot. The apex at `0x621755b` reads the
first. The decomp's comment takes the overwrite to come first, and takes `[esp+0x50]` for alpha.
Only 14 of the 1,822 `FxBasicAppearance` nodes draw triangles, by the extension's count, so it rarely
shows. It matters as proof that the decomp can be wrong even in a function its comments call traced.
