# Characters

How the original builds, joins, skins and draws a character: a body, a head and two hands, each a
`.dfm`, plus rigid accessories. What the bytes mean is the format library's
([DEFORMABLE.md](https://github.com/treewyrm/freelancer/blob/main/docs/modules/DEFORMABLE.md),
[COSTUME.md](https://github.com/treewyrm/freelancer/blob/main/docs/refs/COSTUME.md), `bodyparts.ini` sections in
[SECTIONS.md](https://github.com/treewyrm/freelancer/blob/main/docs/refs/SECTIONS.md#detailswitchtable)). This page is what the
engine computes from them. This library implements it in [skin.ts](../../src/deformable/skin.ts)
(`placeCostume`, `poseSkin`), [level.ts](../../src/deformable/level.ts) and the skinned stage of
[dcdt.ts](../../src/material/dcdt.ts).

Binaries: `deformable2.dll` (image base `0x65f0000`, reached only through `IDeformable`),
`common.dll` (`0x6260000`, `CostumeDescriptions`, `DetailSwitchTable`), `Freelancer-original.exe`
(`0x400000`), and `x86math.dll` for matrix products. Addresses are `deformable2.dll`'s unless a
module is named.

Evidence: **checked** read in the retail binary; **decomp** agrees in `../freelancer-decomp/src`,
binary not read; **observed** in a reference scene ([VALIDATION.md](../VALIDATION.md)); **unsettled**.

## Conventions

Matrices are `x86math.dll` frames: a 3×3 rotation stored row-major, then the translation, mapping
`v' = R·v + t`. `MulTransform` (`+0x1c`) gives `out = A·B` with `B` applied first: its translation
is `A.R·B.t + A.t` (**checked** `x86math!0x6f716f0`). Every product below is in that column-vector
order, as this library's `Matrix4` is.

## Two builders

`Freelancer.exe` makes a character in one `IDeformable` create call, with a part list and no
hardpoint names. It has two builders, and they ask for different levels.

| Builder | Where | Parts | Levels asked | Load flags | Skinned levels |
| ------- | ----- | ----- | ------------ | ---------- | -------------- |
| Base room and THN (`FCharacterObject::Load` → `BuildCharacterDeformable`) | `0x443b60` | body, head, left hand, right hand; a part with no mesh is left out | 16 | 0 | body all (`-1`), the others 2 |
| The same, `low_character_lod` on | `0x443b86` | as above | 16 | `2`: skip level 0 | body all, the others 3 |
| Comm window and character creation (`FEngineCharacterBodyDesc`) | `0x4c9f00`, `0x4ca220` | the body moved to slot 0 (`0x4ca2f0`), then head, hands | 1 | `1`: level 0 only | all |

**checked** `Freelancer-original.exe!0x443b6e`–`0x443c56` and `0x4ca2c5`, `0x4ca2d1`.

- **The body is part 0 in both**, and that is what makes it the host (below).
- **`low_character_lod` raises the limit to 3 because it skips level 0.** The skinned test counts
  the file's level index, not the loaded one, so under either setting a head's or hand's first two
  *loaded* levels skin and the rest draw rigid.
- **The comm window loads level 0 alone**, so it never draws anything else, whatever its pick.
- A base-room character whose record is a "pc" (`CharacterProperties +0x1c` = 1) shares one
  deformable built on first use (**decomp** `src/freelancer/Client/gf_character_object.cpp`
  `FCharacterObject::Load`).

## The bone table

| Fact | Evidence |
| ---- | -------- |
| The table is the `*.3db` directories in file order. `Index` and the `Cmpnd` numbering are not read | decomp `src/Deformable2/Deformable2.cpp` `LoadSkeleton` |
| **Slot 0 is the root**: the skinning inverse, the draw's world and the script's binding all use slot 0 | checked `0x65f6c00`, `0x65f41e4` |
| `Bone to root` is 48 bytes copied raw, no transpose, no inverse | checked `0x65f1255`–`0x65f128a` |
| **A bone directory without a complete 48-byte `Bone to root` is left out of the table**, so every later bone moves down one slot and `Bone_id_chain` lands on the wrong bone | checked `0x65f1266`, `0x65f1271`, `0x65f12a3`–`0x65f12cf` |
| 150 slots, and nothing checks the count | checked `0x65f3898` |
| Engine bones bind to slots by a forward-only search in table order, so the `Cmpnd` parts must be instantiated in `.3db` order or bones are skipped | checked `0x65f14f0` |
| A bone no `Cmpnd` part claims gets its own parentless engine instance | decomp `FLodHolder::AttachSkeleton` |
| `Skeleton/Name` and `Lod Bits` are never read: no binary under `EXE/` contains `Lod Bits`, and `deformable2.dll` has no `Skeleton` string of its own | checked, strings |

**The cursor.** The index after the last bone bound to a `Cmpnd` part bounds the join walk, the
destroy pass and skinning (**checked** `0x65f5a52`, `0x65f3d0a`, `0x65f6d0e`). A detached bone listed
after it is never joined, destroyed or skinned, and its slot stays the identity. A bone id at or
past the cursor in `Bone_id_chain` indexes per-bone vertex lists sized by the cursor, out of bounds
(**decomp** `BuildBoneVertexLists`). Retail has neither.

### What poses the bones

Every bone's world is the engine's: an instance of the `skel_<file>` compound built from `Cmpnd`
and `Cons`, plus whatever scripts set (**decomp** `LoadSkeleton`, `FLodHolder::AttachSkeleton`).
`Bone to root` enters only as the right-hand factor of the skinning product (**checked**
`0x65f1030`). Nothing in the game poses a bone from its bind pose.

So a character with no script running stands in its `Cons` rest. For heads and hands that is the
bind pose; for every body it is a different, non-rigid pose, displacing the skin by up to 4.6 on a
figure 1.6 tall ([DEFORMABLE.md](https://github.com/treewyrm/freelancer/blob/main/docs/modules/DEFORMABLE.md#the-chain-is-not-the-bind-pose)).
The game always has a script running. `SkinOptions.pose: 'bind'` is a viewer's choice, not a reading.

## Skinning

### The matrix

```
K(bone) = W(root)⁻¹ · W(bone) · B(bone)        drawn with W(root)
W(root)⁻¹ = [ Rᵀ | −Rᵀ·t ]
```

`B` is `Bone to root` **as stored**: it already is the inverse bind, so at bind `K` is the identity.
**checked** `0x65f1030` (`W·B`, then `W(root)⁻¹·(W·B)`), `0x65f6c07`–`0x65f6c4b` (the inverse, by
`x86math +0x38` = `Rᵀ·v`, negate, transpose). The mesh is drawn with slot 0's world as the world
matrix (**decomp** `FMeshArchetype::Draw`).

Inverting `Bone to root` once more is the classic mistake: the skeleton lands mirrored about the
origin. [RENDERER.md §8](https://github.com/treewyrm/freelancer/blob/main/docs/refs/RENDERER.md) writes the operation as
`pose · inverse(boneToRoot)` because Librelancer inverts in its reader; the file holds the inverse
already. Root-relative matters only when weights don't sum to one: the skin then scales about the
root rather than the world origin.

### Influences

Each point takes the next `Point_bone_count[p]` entries of `Bone_id_chain` and `Bone_weight_chain`,
cumulatively. `Point_bone_first` is never read, and no binary under `EXE/` contains the name
(**checked** `0x65f8310`–`0x65f832a`, strings).

| Influences | Position | Normal | Evidence |
| ---------- | -------- | ------ | -------- |
| 1 | `K₀·v`: **the weight is ignored** | `K₀·n`, not renormalised | checked `0x65f6ed9`–`0x65f6f04` |
| 2 to 4 | `(w₀K₀ + w₃K₃ + w₂K₂ + w₁K₁)·v`: one blended matrix, accumulated in that order, **weights not normalised** | the same matrix, then renormalised | checked `0x65f6f09`–`0x65f6f9d` |
| 5 or more | `w₀K₀·v`: **only the first, at its own weight** | renormalised | checked: the count falls through every case to `0x65f6fa0` |
| 0 | never re-skinned: the point is in no bone's list, so never dirtied, and keeps the stored position copied at the last level switch, relative to the root | as position | decomp `BuildBoneVertexLists`, `FMeshArchetype::Skin` |

**The renormalisation is the fast inverse square root**: `0x5f3759df − (bits >> 1)`, one Newton step
`y·(1.5 − 0.5·x·y²)` (**checked** `0x65f6fc3`–`0x65f7031`, constants 0.5 at `0x6601328` and 1.5 at
`0x6601354`). One step always undershoots, so a blended normal comes out up to about 0.18% short of
unit length. A lone influence's normal is not touched at all.

Points are skinned once each, and the result copied to every element that names the point
(**decomp** `BuildVertexRemap`, `FMeshArchetype::Skin`): a UV seam never splits a skinned normal.

Retail data never exercises the odd rows: influences never exceed four, none has zero, weights sum
to one within `1.1e-7`, and every `Point_bone_first` is the running sum
([DEFORMABLE.md](https://github.com/treewyrm/freelancer/blob/main/docs/modules/DEFORMABLE.md#corpus)). The rows matter for mods.

### When it re-skins

Only bones whose engine world was marked dirty recompute `K`, and only their points are rewritten
(**checked** `0x65f6c8f`–`0x65f6d04`). A level change forces a full copy of the stored vertices first.
`dacom.ini [Deformable] DeformRate = N` would re-skin every 1/N s; retail's `dacom.ini` has no such
section, so a character re-skins on every update (**decomp** `FDeformable::SetLod`,
`ApplyParsedRate`; `EXE/dacom.ini` read). On a GPU, re-skinning every frame is the same picture.

## Geometry

The vertex buffer is built from the element list, not the points: element `e` takes position and
normal from `Point_indices[e]` and its coordinate from `UV0_indices[e]` (**decomp**
`FillMeshStreamDesc`). `UV1` and `UV1_indices` are never read: `deformable2.dll` has no `UV1`
string (**checked**). So a character draws one coordinate set, whatever its file carries. One GPU
vertex per element reproduces this exactly, with face indices used as they are.

### Strips, parity and winding

Every face group's `Tristrip_indices` is expanded to a list at load (**checked** `0x65f7d70`):

- the window slides one entry at a time; position `i` gives `(a, b, c)` = entries `i`, `i+1`, `i+2`;
- a window with any two indices equal is skipped, **and parity still advances**: it follows the
  position in the strip, not the number of triangles written;
- even `i` writes `(a, b, c)`, odd `i` writes **`(a, c, b)`**.

The exporter stitches short runs with repeated indices, so the skip is not optional
([DEFORMABLE.md](https://github.com/treewyrm/freelancer/blob/main/docs/modules/DEFORMABLE.md#corpus)). The result is the rigid
meshes' winding: `frontFace(CCW)` under the mirrored projection, with no change for characters.
Over retail, this parity agrees with the stored normals on 542,903 triangles against 4,828, and the
opposite parity gives exactly the mirror count. `character_reed` matches retail's indices (**observed**).

A strip of exactly two entries writes nothing. A strip of one entry is not caught: its count less two
wraps unsigned and the loop reads past the strip (**checked** `0x65f7d78`–`0x65f7d8a`). Mods only.

`Face_indices` is read as a plain list only when `Tristrip_indices` is absent or empty (**decomp**
`LoadFaceGroups`). No retail group has one.

### Face groups and their materials

Groups load in `Group*` directory order, up to `Face_groups/Count`. Each `Material_name` is looked up
by CRC in the **one global material library** (`FindMaterialByCrc`), never in the `.dfm`'s own. A
group whose material isn't found keeps no indices and draws nothing (**decomp** `LoadFaceGroups`,
`DrawFaceGroup`).

**A name defined by two files resolves to the first one loaded.** When a material library loads, a
name whose CRC is already present is only reference-counted, and the file's own definition is skipped
(**checked** `shading.dll!0x6ecc9c8`–`0x6ecc9cf`, `0x6eccb6d`). 75 of the 386 material names in
retail `.dfm` files are defined by more than one model, so a second head with a colliding name draws
with the first head's material while that material is alive. The library leaves the lookup to the
host (`SceneModel.material`); a host loading several characters should resolve collisions first-wins.

`EyeMaterial` is registered by `deformable2.dll` itself as a name rule `^eye*`, which as a pattern is
`ey` then any number of `e` ([map.ts](../../src/material/map.ts)). It reaches rigid models too.

## Joining a costume

**One rule, no names.** No binary under `EXE/` contains `hp_head`, `hp_neck` or any other join name.
After loading every part, `create` walks every bone of every part below its cursor, parts in list
order and bones in table order, enumerating each bone's hardpoints. A map keyed by name CRC records
the **first** bone carrying a name; **every later bone carrying it is connected to that first one**
(**checked** `0x65f3540`: the first holder stored at `0x65f35b4`, each later one passed as the child
of `IHardpoint +0x18` at `0x65f35fb`). A failed connect logs `cannot connect parts %s<->%s`.

The connect parents the later bone under the first:

```
W(later) = W(first) · H(first) · H(later)⁻¹
```

where `H` is each bone's own hardpoint frame (**decomp** `src/EngBase/EngBase.cpp` `HardpointConnect`,
fixed hardpoint). It holds every frame, so the child follows the animated host. The engine refuses
a child that already has a parent (**decomp** `EngineCreateJoint`; the message is in
`engbase.dll`), so only two kinds of bone can be joined:

- **a part's root**: `hp_head`, `hp_left b`, `hp_right b`. This places the whole part;
- **a detached bone**: `hp_neck`, `hp_left a`, `hp_right a`, and the shoulder names. This places
  one slot of the part's table, the seam.

**The body comes first, so the body holds every shared name.** A head listed first would try to
parent the body's bones under its own and be refused.

### The seam

A seam slot is skinned like any other:

```
K(seam) = W(child root)⁻¹ · W(host bone) · H(host) · H(seam)⁻¹ · B(seam)
```

**Nothing is captured at assembly.** The child's own stored `H(seam)` and `B(seam)` are inputs, so a
head rigged against another body family opens at the neck at rest, as it does in game.
`br_darcy_body_torture.dfm` with any head is the plain case. Librelancer and MAXLancer capture the
host's frame at assembly instead, which closes every neck
([COSTUME.md](https://github.com/treewyrm/freelancer/blob/main/docs/refs/COSTUME.md#what-librelancer-and-maxlancer-do)).

### What is left unjoined

After the walk, every bone from slot 1 to the cursor that still has no parent is destroyed
(**checked** `0x65f3d1a`–`0x65f3d4c`). Its slot keeps the world it was registered with, the identity
by the format library's reading, so its vertices render at `B(seam)·v` in world space, torn towards
the world origin by their weight on it. That is read, not observed: retail's only costumes with unseated shoulder seams give them no weight
([COSTUME.md](https://github.com/treewyrm/freelancer/blob/main/docs/refs/COSTUME.md#an-unseated-seam-in-game)).

Two details of the walk matter only to mods:

- The walk runs before the destroy pass, so a detached bone with no seat **is** recorded as a first
  holder, and a later part sharing that name joins under it.
- Only part 0's root is placed by the caller: `SetPosePos` and `SetPoseOri` move slot 0 of part 0
  (**decomp** `FDeformable::SetPosePos`). A part whose root finds no holder, such as a head on
  `worm.dfm`, stays wherever its fresh engine instance is. What that is was not read.

## Detail levels

### What the loader takes

`create` loads up to `min(#Fractions, 8, levels asked)`. Without `MultiLevel` it loads one level of
fraction 1. It takes `Mesh*` directories in the order the file system finds them, not by the digit
in their names. Flag `2` skips the first found, and flag `1` stops after it. Each loaded level's
fraction is handed back by its file index (**checked** `0x65f39b4`–`0x65f3a2e`, `0x65f3a94`,
`0x65f3aa5`, `0x65f3b67`–`0x65f3b7c`).

A level is **skinned when its file index is below the part's skinned count, compared unsigned**
(**checked** `0x65f3b3a`, `setb`), so `-1` skins every level. An unskinned level writes the identity
into each bone's matrix and marks no vertex dirty (**checked** `0x65f6cc6`–`0x65f6cd8`). The buffer
keeps the stored positions: the part draws **rigid, at bind, relative to its root**. Since a head's
root rides `Body_Head`, a far head turns with the skull, while its jaw, eyes and neck seam stop
following. `character_far` shows the difference: with the rule off, 34 to 51 seam vertices a part
land elsewhere (**observed**).

### What the game picks

The deformable chooses nothing. The caller passes one level index per part on every update, and an
index out of range hides the part (**decomp** `FDeformable::SetLod`, `SelectPartLod`).

The base-room and THN caller (**checked** `Freelancer-original.exe!0x444f90`–`0x445138`):

1. At build, each level's distance is `get_switch_distance(fraction × 100)` from the part's
   `[DetailSwitchTable]`, and **the last level's is overwritten with `get_switch_distance(0)`**, the
   far cutoff (`0x443d9b`, `0x443de1`–`0x443df1`).
2. Each frame, the distance from the camera to the character's instance is scaled by
   `adjust_distance`: `d · tan(fov) / tan(fovx ÷ 2)`, with the camera's half angle in degrees and
   the table's `fovx`, stored halved, 40 by default (**checked** `common.dll!0x62fed60`; the halving
   **decomp** `DetailSwitchTable::read_from_ini`).
3. **Each part on its own** takes the first level whose distance is not less than that. None is `-1`:
   the part is not drawn.
4. Under `low_character_lod`, a part farther than its table's 100% distance takes one level coarser.
   Past the last, the body keeps its last level and a head or hand is not drawn (`0x4450b5`–`0x4450fe`).

`get_switch_distance` interpolates linearly between `switch` rows and clamps at both ends
(**checked** `common.dll!0x62fecb0`). Retail's four-level models look up `1, .8, .6, .2`
by value, so they take the same rows as the six-level models' levels of the same fraction.

**With no table, level 0 is what the game would show in the comm window**, and that is the only
place it draws a character without one. Pinning level 0 when a host has no `bodyparts.ini` is
consistent with the game, not a guess about distance. `character_far` matches all nine draws, each
part on its own level (**observed**).

## Drawing a character

Parts draw in list order, body first. Each part is culled on its own, against a sphere: Ritter's
bound of the **first loaded level's stored points**, its centre carried by the root's world, its
radius unscaled. Then the root's engine instance is rendered, which is what draws the accessories,
only if some part was in view (**decomp** `DrawInstanceParts`, `PartBoundSphere`,
`ComputeMeshBoundSphere`). A part animated out of its bind-pose sphere can be culled while visible.

### The eye

Only face groups whose material **class** is `EyeMaterial` take a UV bone, and only UV bone 0
(**checked** `0x65f7590`–`0x65f75ca`, comparing `ClassName()` against `EyeMaterial`). Only a level
carrying the UV-bone files has one: in retail, `Mesh0` of every head. Coarser levels' eyes don't move.

Each draw (**decomp** `FEyeMaterial::Bind`):

```
d  = R(parent)ᵀ · Z(bone)          Z(bone) alone when the bone has no parent
du = clamp(X_to_U · d.x · plane, Min_du, Max_du)
dv = clamp(Y_to_V · d.y · plane, Min_dv, Max_dv)
```

No transform at all when both are within `1e-4` before clamping. The offset goes into stage 0's
texture matrix, third row. The decomp writes the wrong cells there; see
[DECOMP-ERRORS.md](../DECOMP-ERRORS.md#feyematerialbind). `character_eyes` matches retail's matrix
(**observed**). The geometry never moves.

### Accessories

An accessory is a rigid model connected by the same link, `W(prop) = W(owner) · H(owner) · H(prop)⁻¹`,
with `body_hardpoint` on the character side and `hardpoint` on the prop's. The two builders search
for the character's hardpoint differently (**decomp** `FEngineCharacterAccessoryLink::Connect`,
`FCharacterObject::Load`):

| Builder | Search |
| ------- | ------ |
| Comm window | `FindHardpoint` from the root bone, pre-order over connected children: first found wins |
| Base room and THN | `HardpointSummary::find_name` over the root's summary |

Retail carries no hardpoint name twice in a costume, so the two agree on retail data. A failed comm
connect logs *Accessory - connection failed!* and leaves the prop where it was made.

## Scripts play on the whole character

A script is started on the character with no part argument (`IDeformable +0x1c`), and
`deformable2.dll` plays it on **part 0's root bone** (**checked** `0x65f41e4`–`0x65f421f`). It reaches
the head and hands because the join has made their roots engine children of body bones, so their
joints are in the hierarchy the script's maps name. Body, face and hand scripts are kept apart by
which joints they name, and several play at once.

Scripts are found by name across every `.anm` that `bodyparts.ini`'s `[Animations]` lists. A name
in two files keeps the first file's: the map insert is unique (**decomp**
`src/freelancer/Client/character_info.cpp` `FCharacterInfoDb::AddScript`). `[PetalAnimations]` is
loaded and never used: `get_petal_anims` is exported by `common.dll` and imported by no binary under
`EXE/` (**checked**, import strings).

Starting a script rebuilds its base from the root: x and z from the root, its heading about +Y alone,
and y = the script's `Root height` above the caller's floor offset (**decomp** `PlayInstanceAnim`,
`FDeformable::SetPosePos`). The motion itself is [mixer.ts](../../src/deformable/mixer.ts)'s.

## Open

- **IK.** `start_aim` (`0x65f5400`) and the multi-joint solve (`0x65fc000`) are mapped, not read in
  full. The library aims one joint.
- **Where an unjoined part's root sits.** A fresh engine instance's transform was not read.
- **Whether the 0.18% normal shortfall reaches the picture.** It depends on whether lighting
  renormalises for characters (`D3DRS_NORMALIZENORMALS`), not read here. `character_reed` matches
  every normal within capture tolerance.
- **A revolute child hardpoint.** `HardpointConnect` builds a different joint when the child's
  hardpoint is revolute (`R(A)·R(B)` and an axis, not `R(A)·R(B)ᵀ`). Retail joins use fixed
  hardpoints; what a revolute one does to a costume was not followed.

## Corrections

| Old reading (`freelancer-vscode/docs/renderer/`) | Retail | Evidence |
| ------------------------------------------------ | ------ | -------- |
| A second model defining the same material name "displaces the first head's skin, in this viewer and in the game" | In game the **first** definition loaded stays; the later file's is skipped, so the second model draws with the first's material | `shading.dll!0x6ecc9c8`, `0x6eccb6d` |
| Odd strip triangles are `(i+1, i, i+2)` | Retail writes `(i, i+2, i+1)`: the same triangle and winding, from another corner | `0x65f7dba`–`0x65f7de3` |
| Skinned levels: "`Freelancer.exe` passes −1 for a body and 2 or 3 for heads and hands"; which path passes which left open | Base room and THN pass 2, or 3 only together with skipping level 0 under `low_character_lod`, so the first two loaded levels skin either way. The comm window loads level 0 alone, all skinned | `Freelancer-original.exe!0x443b6e`–`0x443c56`, `0x4ca2c5` |
| A blended normal is "renormalised" | By the fast inverse square root with one Newton step, up to about 0.18% short | `0x65f6fc3`–`0x65f7031` |
| An unskinned level draws "with every bone the identity" | The identity is written and no vertex is re-skinned; the buffer keeps the stored positions from the level switch. Same picture, root-relative | `0x65f6cc6`–`0x65f6cd8` |
| An accessory seats by a depth-first search of the character | Only the comm window's builder does. The base room's looks the name up in a `HardpointSummary` | decomp `FCharacterObject::Load` |
| A script binds "to the whole character" | It is played on part 0's root bone, and reaches the other parts through the join's engine hierarchy | `0x65f41e4`–`0x65f421f` |
