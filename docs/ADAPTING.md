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

**Verdict: adapted, with its simulation rewritten around what the audit found**, in `src/alchemy/`. Its
readings hold up: emission, every field's arithmetic, the sprite routines' geometry and skips, curves,
blending and draw order within a tree all match the decomp, and retail where they were checked. What
fails is the structure around them. Checked against `src/alchemy/` and `alchemy.dll` (2026-11-05). The
beam's chain was read against the ledger's addresses, and matches `effect_motion` by shape. The dust's kite
was too, and stays uncaptured.

**Where the extension's ledger is wrong or open, now settled:**

| Reading | Extension | Retail | Where |
| ------- | --------- | ------ | ----- |
| A folder's clock | "Nothing reads it", unmodelled | It ticks, and past the longest life below it the folder dies **with its subtree, live particles included**: 33 retail effects, such as `gf_explosion_mine01` at 3 s | `0x6240180`, `0x6201810`, `+0x5c` |
| An appearance's `Node_LifeSpan` | "Stops drawing" | Never read: it ends only with no emitter and nothing held | `0x6216441` |
| An emitter past its life | "Open" | Its last update still emits, then the walk kills it and all that hangs from it | `0x6245c19`, `0x6201843` |
| The expired test | `time ≥ lifespan` | `>` | `0x6240160` |
| An emitter naming two appearances | Open; EXP-03 | One slot, so the last `Pair` wins, and the first's feed count never comes back | `+0x98`, `AssociateAppearance`, `BindRec8Associates` |
| A perp's roll | "Seed not read", the viewer's own | +X, or +Z when it leaves along +X, projected across the velocity each draw | `0x6235e15`, `0x6233330` |
| Update order | Fields sampled for this step | The tree's, and all 240 retail field links have the appearance first, so it **reads the field a frame late**, and not at all on the first | `0x6201810` |
| Draw and spawn frames | Sampled after the step | Composed before it, so at the time before this `dt` | `0x4f8bc7` |
| A sub-effect's place in the order | After all its parent's batches | Its top nodes hang off the spawner, sorted by class among all that spawner's children | `0x622f71a`, `0x6201e00` |
| A finished sub-effect | Inferred | No node live but the root, so a field that never expires keeps its particle for good | `0x621f6d0`, `Slot11` |
| A dust field of radius 0 | Doesn't act | Kills everything | `0x6212c90` |
| A collide under 0.001 of speed | Reflects | Lands on the plane, velocity untouched | `0x621a32f` |
| Pools | One 8,192 budget of its own | One per kind, from `dacom.ini`, a full one evicting its oldest, across effects | `0x6234ab0`, `createPools` |
| Properties absent | 0 on emitters and fields | The constructors' own: a cube's 5 and 15, a dust's 60.1, gravity's 9.8 | `0x62455b0`, and on |

**Captured.** `effect_folder`, `effect_sprites` and `effect_motion` confirm the folder cut and its tree order,
the later of two appearances, each routine's corners and UVs, the triangle, the perp's roll from both seeds,
the alpha wrap, and fast-normalize's small errors. The extension's EXP-03 is settled by `lab_two`.
`effect_beams` matches at every vertex, mirror parity and anchors included. `effect_child`, `effect_fields`
and `effect_pool` confirm sub-effect placement and turn, a death effect, a dust field's age by depth, an air
field's velocity, and eviction across appearances.

**Two more findings from the captures.** Under a THN host dust never draws: `Thorn_Psys` follows each tick with
a pass at 0 ms (`0x453ff0`), so the routine's speed is a distance over a step of 0 and its fade is 0. That same
pass is when an appearance applies its fields, reading the real step's values. And retail's
`FxOrientedAppearance.poolSize = 0` crashes the game, against the ledger's "works", and at 1000 it runs and
matches (`effect_oriented`): a mod that sets the size is what can reach the type.

**Left out on purpose.** Replay and fixed steps belong to a scrubbing host, which can make a new
`EffectInstance` and step it. The affine closed form needs a fixed step, and transform feedback paid for
17.7% of particle-steps at the extension's measure. A pushed lane steps on the CPU and uploads each frame.
Bring either back only on a measurement from a real scene, which is M7's, and the affine form not at all
unless the step is fixed: it's exact only at equal steps.

**The fixed step is settled: the host's `dt`, as retail** (`0x4f8bc7`). Emission truncates per frame and
turbulence depends on the step, so a fixed step is a different picture at any other frame rate. A capture
needs its own frame's `dt` to compare against.

**Still open:**

- **Uncaptured:** `FLDustAppearance`'s kite and fade, which a THN host can't show, so M7's; and gravity,
  radial, turbulence and collide fields. A field's frame of lag stands on the source, with `effect_fields` consistent with it.
- **The green sprites:** `effect_sprites` and `effect_child` are off by up to 5 on pure green, about one step of
  a 16-bit texture's green. That the rig filters it otherwise is a guess.
- An animated texture's own playback, which picks the atlas when `UseCommonTexFrame` is off (`0x6244ef0`). M8's.
- The beam's wireframe flag `0x1C65B7B9` isn't drawn. D3D's fill mode has no GL equivalent, but lines could do.
- A present `BlendInfo` of `None` (22 retail nodes) is no D3D value, and draws as the default here.
- Fog waits for M7. The alpha test `GREATER 0` is as captured in the menu, and the begin-draw as read doesn't
  set it, so another frame may leave it otherwise. M7 and M8 should check. The clamp is its own to set.
- A non-positive `Emitter_InitLifeSpan` births nothing here, by this library's rule, not read.
- **`FxMeshAppearance` stays out**, and is reported. The game's factory fails on every one and the DLL calls
  through the null mesh on spawn (`0x6224ed9`), so no data can draw one.

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
