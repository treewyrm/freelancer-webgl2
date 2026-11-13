# Animation playback

What the original computes when something moves: a rigid model's joints under a `.cmp` script, a
character's bones under an `.anm` script, and a material's UV transform. What the bytes mean is
`@treewyrm/freelancer`'s: [ANIMATION.md](../../../freelancer/docs/modules/ANIMATION.md) for scripts,
maps and channels, [COMPOUND.md](../../../freelancer/docs/modules/COMPOUND.md#joints) for joint
records, [RIGID.md](../../../freelancer/docs/modules/RIGID.md#material-uv-animation) for
`MaterialAnim`. How the engine's matrices land in WebGL2 (the mirror, the transpose) is
[RENDERER.md §2](../../../freelancer/docs/refs/RENDERER.md#2-coordinate-system-winding-and-matrices)
and [§5.2](../../../freelancer/docs/refs/RENDERER.md#52-composing-a-joint); this page does not
restate it.

Evidence tags: **checked** `module!0xADDR` was read in the retail binary; **decomp** names the
decomp's file and symbol where the binary was not read; **observed** names a reference capture.
Joint transforms live in `engbase.dll`, the character layer in `deformable2.dll`, matrix and
quaternion arithmetic in `x86math.dll`, material animation in `shading.dll`.

## Where it lives here

| Animates | Retail | Here |
| -------- | ------ | ---- |
| Rigid joints | `engbase.dll` players, then the joint builders | The host samples channels with `@treewyrm/freelancer/animation` and hands states in as `jointState`; [`partTransforms`](../../src/scene/hierarchy.ts) composes them through `getJointMatrix` |
| Character bones | `engbase.dll` players and mixer, `deformable2.dll` root and floor | [`Mixer`](../../src/deformable/mixer.ts), its players in [`player.ts`](../../src/deformable/player.ts) |
| Material UV | `shading.dll` `FImaInstance` | [`sampleUvAnimation`](../../src/scene/uv-animation.ts), drawn in [`dcdt.ts`](../../src/material/dcdt.ts) |

## Composing a joint

Each joint type has its own builder, reached through the table at `engbase!0x662aa84` (**checked**:
fixed `0x66255b0`, prismatic `0x6625730`, revolute `0x66255e0`, cylinder `0x66257f0`, sphere
`0x6625980`, translational `0x6625a80`, loose `0x6625af0`). Written in column-vector order, with
`position` the parent point and `offset` the child point of the record:

| Joint | Local transform | Evidence |
| ----- | --------------- | -------- |
| fixed | `T(position) · R(rest)` | **checked** `engbase!0x66255b0` |
| revolute | `T(position) · R(axis, θ) · R(rest) · T(−offset)` | **checked** `engbase!0x66255e0` |
| prismatic | `T(position + d·axis) · R(rest) · T(−offset)` | **checked** `engbase!0x6625730` |
| cylinder | `T(position + d·axis) · R(rest) · R(axis, θ) · T(−offset)` | **checked** `engbase!0x66257f0` |
| sphere | `T(position) · R(q) · R(rest) · T(−offset)` | **checked** `engbase!0x6625980` |
| translational | `T(position + p) · R(rest)` | **checked** `engbase!0x6625a80` |
| loose | `T(position + p) · R(q) · R(rest)` | **checked** `engbase!0x6625af0` |

**The driven rotation multiplies on the left of the rest rotation**, for revolute, sphere and
loose. Each builder calls `3DMathEngine +0x20` with the driven matrix first and the rest second.
That slot is a plain row-major `A · B` (**checked** `x86math!0x6f71670`), and `+0x2C`, which places
the offset, is `M · v` with `out.x = row0 · v` (**checked** `x86math!0x6f71830`). So the engine is
column-vector, and `R(driven) · R(rest)` turns the child about an axis given in the **parent's**
frame. The two orders agree only where the rest rotation is the identity.

**The cylinder is the exception: its rest rotation is on the left.** `0x66257f0` calls `+0x20` with
the rest matrix first and the turn second, so its rotation axis lives in the child's frame while its
slide along the same axis is in the parent's. Nothing in retail exercises this: no record is a
cylinder, and no channel can drive one (below). It matters only to a host setting a cylinder's state
itself. See [Corrections](#corrections).

**`offset` subtracts on the far right, past the rest rotation and the driven factor.** Every
builder that has the field computes the translation as `position (+ d·axis) − R · offset`, the
prismatic one included (**checked** `engbase!0x6625730`). It is a contact point, not a pivot: the
child's point lands on the parent's. All retail records leave it zero, so it shows only on authored
assets.

**A revolute axis is normalized; a prismatic or cylinder slide axis is not.** The revolute and
cylinder builders divide the axis by its length before making the quaternion, and both slide terms
multiply `d` by the axis as stored (**checked** `engbase!0x66255e0`, `0x6625730`, `0x66257f0`).

**A loose or translational channel's position adds to the rest origin; it does not replace it.**
`0x6625af0` and `0x6625a80` add the state's position to the record's origin. For these types the
origin and rest rotation are copied to the same slots a fixed joint uses
(**decomp** `src/EngBase/EngBase.cpp` `RemapJointPayload`). The `.anm` data agree: 1,955,761 loose
position keyframes sit nearer zero than their joint's rest origin, against 1,854 nearer the rest
([ANIMATION.md](../../../freelancer/docs/modules/ANIMATION.md#loose-and-sphere-channels-compose)).
**Observed** `character_reed`: a costume posed at a one-shot script's last keyframe, skinned vertices
matching retail's.

**A state quaternion need not be unit length.** `3DMathEngine +0x54` builds the matrix with
`s = 2 / |q|²` and the standard Hamilton terms (row 0 is `1 − s(y² + z²), s(xy − wz), s(xz + wy)`),
so any non-zero `q` gives a pure rotation (**checked** `x86math!0x6f723c0`).

[`getJointMatrix`](../../../freelancer/docs/modules/COMPOUND.md#joints) in `@treewyrm/freelancer`
computes these, and [`partTransforms`](../../src/scene/hierarchy.ts) multiplies them down the tree as
`W_child = W_parent · L_child`.

## The range clamp

**The engine clamps a revolute or prismatic value when it is set, and nothing else.** `IEngine +0xC8`
(**checked** `engbase!0x66226e0`, cases at `0x6622840`) tests `min > v` first and stores `min`, then
`max < v` and stores `max`, otherwise `v`. A NaN fails both tests and is stored as is. A value equal
to a limit passes unchanged. A cylinder's two floats, a sphere's quaternion, a translational
position and a loose pose are copied with no test; the sphere's three limit pairs and the
cylinder's two are loaded and never read.

What gets clamped is the value the player hands over, after the wrap and the weight below. Retail
data run past the range: 278 keyframes on 22 prismatic channels, the worst 423.25 past it, so
`br_03_warwick_cityscape.cmp`'s traffic stops at the end of its rail while its channel runs on
([ANIMATION.md](../../../freelancer/docs/modules/ANIMATION.md#channels-outside-their-joints-range)).
The keyframes are kept as stored; `getJointMatrix` clamps the same two types the same way.

## Binding a map to a joint

**A map drives a joint only when its channel's floats are exactly what the joint takes**
(**checked** `engbase!0x661ae10`–`0x661aeb5`, table at `0x661af18`). The channel's type bits are
first expanded to plain floats, so the quantized rotations count as four
(**decomp** `src/EngBase/EngBase.cpp` `ChannelDecompressFrames`):

| Target | Floats it takes |
| ------ | --------------- |
| revolute, prismatic | 1 |
| cylinder | 2 |
| translational | 3 |
| sphere | 4 |
| loose | 7 |
| object map | 7 (**checked** `engbase!0x661af0d`) |
| fixed | none, so never |

A mismatch logs *failed to map JOINT* and the map moves nothing
(**decomp** `src/EngBase/EngBase.cpp` `BindPlaybackTracks`). So a rotation-only channel on a loose
joint does nothing; that is what `ZeroPosition` and `IdentityQuaternion` exist for, padding a loose
channel to seven floats with nothing stored. No channel type expands to two floats, which is why a
cylinder cannot be animated
([ANIMATION.md](../../../freelancer/docs/modules/ANIMATION.md#why-cylinder-joints-cannot-be-animated)).
[`Mixer`](../../src/deformable/mixer.ts) refuses the same maps by shape.

## Sampling a channel

**A revolute pair always interpolates the short way round.** The float player's blend
(**checked** `engbase!0x661b8a0`) checks the type of the joint it is bound to. For a revolute joint
(type 2) it takes `Δ = b − a`; if `Δ < −π` it adds `2π` to `b`, if `Δ > π` it subtracts `2π`, then
lerps. Both tests are strict, so a pair exactly `±π` apart plays as stored. The constants are float
`π` and `2π`, and `Δ` is held in x87 precision. It looks at nothing about the channel, so storage
outside (−π, π] is wrapped all the same: a sweep authored as more than half a turn between two keys
plays backwards in game. A prismatic value is a plain lerp and never wraps. `ChannelType.Angle`
serves both, so only the joint says which:
`sampleChannel(channel, time, joint.type === 'revolute')`, which [`player.ts`](../../src/deformable/player.ts)
does through its `revolute` flag.

**Rotations interpolate by normalized lerp, not slerp.** `3DMathEngine +0x58`
(**checked** `x86math!0x6f724d0`, vtable at `0x6f73090`) negates the second quaternion when the dot
product is negative, lerps the four components, and renormalizes. It matches slerp at both keys and
at the midpoint, and differs between.

**The motion's weight is an amplitude, not a blend.** The revolute and prismatic value is
`weight · lerp` (**checked** `engbase!0x661b8e3`, `fmul [ecx+0x2c]`), and the clamp sees that
product. A rotation is `nlerp(identity, q, weight)` unless the weight is exactly `1.0`
(**decomp** `src/EngBase/EngBase.cpp` `TypedSlerpType4`). Fades and stacking between motions are
the mixer's; [ANIMATION.md](../../../freelancer/docs/modules/ANIMATION.md#scripts-mix-per-joint-and-weight-is-an-amplitude)
describes them and [`mixer.ts`](../../src/deformable/mixer.ts) implements them.

## The clock: each map loops at its own length

**Every map gets its own player and its own clock, wrapped at that map's channel duration.** A
tick (**checked** `engbase!0x661b420`) adds `dt · speed` to the player's time, reads the duration
from that player's own channel (`0x661b539`), and when the time left is `≤ 0`:

| Flags | What happens |
| ----- | ------------ |
| `0x2` loop | Time becomes the overshoot past the end, modulo the duration, and the player is rebound at the start (`0x661b5a0`–`0x661b715`) |
| `0x4` bounce | The speed flips on an even number of wraps and the player is rebound at the mirrored time (`0x661b71a`) |
| neither | Time is set to the end, the player is marked finished, and the last keyframe is held (`0x661b77d`) |

A script's duration is only its longest map (**decomp** `BindPlaybackTracks`, `LongestTyped`), and
a shorter channel cycles inside it rather than holding. `SOLAR/MISC/rift_pylon.cmp`'s
`Sc_anim active` runs channels of 2, 4, 8 and 16 seconds;
`SHIPS/RHEINLAND/RH_MINER/rh_miner.cmp`'s `sc_rotate drill` runs a 0.75 s drill against a 10 s arm.
On one clock clamped to the script, the drill would spin once and stand still for nine seconds.

**A channel's duration is its last keyframe's key, and a loop at exactly that time shows the first
frame.** The test is `≤ 0`, so landing on the end wraps. Holding, the time is pinned to the end and
the last keyframe shows. A clock that computes `t mod duration` gets the loop right and the hold
wrong; `getChannelTime(channel, time, mode)` takes the mode.

A zero-length channel never wraps and samples its one keyframe: a static pose
(**decomp** `TypedTick`, the `Duration != 0` tests).

## Object maps: root motion

**An object map moves its object from where it stood; it does not place it.** When a root player is
bound it takes a base: the pose its header supplies, or else the object's current orientation and
position from the engine (**checked** `engbase!0x661c9d3`, `0x661ca0a`). Each frame it writes
(**checked** `engbase!0x661bb10`):

```
position    = R_base · (p · trans_scale · weight) + t_base
orientation = q(R_base) ⊗ q
```

`⊗` is the plain Hamilton product: `3DMathEngine +0x18` computes `A ⊗ B` with `A × B` in the vector
part (**checked** `x86math!0x6f72740`), called with the base first and the sample second. So the
sample is expressed in the base's frame, as the position is.

**On a loop, each wrap makes the last keyframe's pose the new base.** The player applies the end
keyframe, turns it into a matrix, and rebinds with that pose as its base (**checked**
`engbase!0x661b5b3`–`0x661b6d6`). A walk cycle walks on: after `k` whole loops the object stands at
`base ∘ S(D)ᵏ ∘ S(t mod D)`. A character's loop also passes through `deformable2.dll`, which stands
the new base upright at the next cycle's height before it is used
(**decomp** `src/Deformable2/Deformable2.cpp`, the instance's `OnLoop`); `player.ts` has this as
`loopHeight`. Started part-way in, the base is solved so the object does not jump at the start's
sample (**decomp** `TypedBindType6`). Joint maps have no base.

The format library's `sampleObjectMap` returns the relative transform; compose it onto the start
pose.

### `Root height` stands a character on its floor

`engbase.dll` only stores `Root height` and hands it back through `IAnimation2 +0x64`.
**`deformable2.dll` builds a character's base from it** when a script starts
(**checked** `deformable2!0x65f4301`–`0x65f43bb`, in `0x65f41d0`):

- height: the script's `Root height` plus the floor offset (`IDeformable +0x60`); with no
  `Root height`, the root's resting height plus the floor;
- x and z: the root's own, plus an offset solved when the script starts part-way in;
- orientation: a turn about +Y only, so pitch and roll are dropped. **The heading is the caller's
  argument when it is zero or more** (`0x65f43d6`); only a negative heading keeps the root's own
  yaw, `atan2` of the rotation's third column (`0x65f436c`–`0x65f4395`).

Placing a character later discards the caller's y: the root stands at `Root height`, plus the
object map's sampled y, plus the floor (**decomp** `src/Deformable2/Deformable2.cpp`
`FDeformable::SetPosePos`). The floor is the scene's; with none, the root stands `Root height` above
y = 0. [`Mixer`](../../src/deformable/mixer.ts) keeps the floor and takes `heading` with `-1` as its
default.

## Material UV animation

**The transform is `uv · (1 + scale) + offset`, on stage 0's coordinates.** `FImaInstance`'s matrix
(**checked** `shading!0x6ec7330`) starts from identity and writes `1 + scaleU` and `1 + scaleV` on
the diagonal and the two offsets in the third column. `rp8.dll` transposes it on the way to
`D3DTS_TEXTURE0` (**checked** `rp8!0x6d0fdd2`, the store at `0x6d0fe43`), which puts the offsets
where a two-coordinate texture transform reads its translation. The material sets
`D3DTTFF_COUNT2` on stage 0 alone (**decomp** `src/Shading/Material.cpp`
`FMaterial::BindDcDtTables`). **Observed** `lair`: the captured stage-0 matrix is one moment of
`sampleUvAnimation`, offsets in the third row.

**All four stored values are displacements; neutral is zero.** That is what the `1 +` is: the scales
are added to one. Read as absolute scales, the near-zero values retail stores collapse a surface onto
one texel.

**Keys are where a segment starts; deltas are rates within it.** Segment `i` starts at
`keys[i − 1]`, or four zeros for segment 0, and adds `delta · elapsed` (**checked**
`shading!0x6ec7330`). Nothing integrates across a boundary, so where a segment's rates do not arrive
at the next key the picture jumps, in game too; the worst retail case is 0.6653, on
`ku_kyushu_equip.cmp`'s `watergreen`. At time zero the transform is the identity.

**The segment walk** (**checked** `shading!0x6ec72a0`) adds `dt` only when `dt > 0`, moves to the
next segment only while the time is **strictly** past the current one's duration, carries the
remainder, and wraps from the last segment to the first. It always wraps.
**`MAFlags` is stored at load and read by nothing** (**decomp** `src/Shading/MaterialAnimation.cpp`
`ParseMaKeys`; no reader in `src/Shading`, `src/flmaterials` or `src/freelancer`).

**The clock is the frame.** `Freelancer.exe` advances every instance once a frame by the frame's
`dt` (**checked** `Freelancer!0x41b2e0`, `IMatAnimLibrary +0x18` with index −1, walked at
`shading!0x6ec7430`). No script or scene event starts or stops one.

**An instance belongs to a material, and the animation is found by the material's name.** A
material creates its instance when it is verified, starting at zero
(**decomp** `src/Shading/Material.cpp` `FMaterial::ApplyVerifyMatAnim`). The library behind it is
one global map keyed by the name's CRC, where a later file's entry of the same name replaces the
earlier one (**decomp** `src/Shading/MaterialAnimation.cpp` `FMaterialAnimation::StoreData`), and a
model file loads its materials before its `MaterialAnim` group
(**decomp** `src/freelancer/Client/client_cliobj.cpp`). Two consequences:

- every object drawing one material shows the same phase, and materials verified at different
  moments differ in phase by their load times;
- a material in another file with the same name as an animated one is animated too, if it is
  verified while that animation is loaded.

Here the host passes the animations as `materialAnimations` and one `time`, and
[`frame.ts`](../../src/scene/frame.ts) looks them up by material name for the single-pass family,
`HUDAnimMaterial` and `PlanetWaterMaterial`. A per-model library matches retail wherever animated
names are unique among loaded files.

## Open

- **Which retail call sites pass a heading** to `IDeformable +0x1c`, and which leave it negative.
  `Freelancer.exe` was not read for this.
- **Whether any retail animated material name collides** with another loaded file's material, so
  that the global lookup shows. Not measured.
- **The start-part-way base** (`0x661c741`) and the **bounce** rebind were read in the decomp only.
- **`MAFlags`** has no reader in the decomp; the binaries were not searched for one.

## Corrections

| Believed | What the binary does | Evidence |
| -------- | -------------------- | -------- |
| A cylinder composes as `T(position + d·axis) · R(axis, θ) · R(rest) · T(−offset)`, the turn left of the rest like the others ([RENDERER.md §5.2](../../../freelancer/docs/refs/RENDERER.md#52-composing-a-joint), and `getJointMatrix`'s comment and code) | The rest is on the left: `R(rest) · R(axis, θ)`. The slide is still `d·axis` in the parent frame | `engbase!0x66257f0`: `+0x20` called with `[ebx+0x1c]` (rest) first and the quaternion's matrix second, `0x66258c2`–`0x66258d2` |
| Material animations are scoped per model, and a global map "would let one cityscape's banner drive another file's `Material #3`" as a bug (PLAYBACK.md, MATERIALS.md) | The game's map *is* global by material-name CRC, last loaded wins. Per model is this library's choice and agrees with retail only while animated names are unique | **decomp** `FMaterialAnimation::StoreData`, `FMaterial::ApplyVerifyMatAnim` |
| Starting a script, the root "keeps its heading about +Y" (PLAYBACK.md) | Only when the caller's heading is negative; otherwise the root faces the heading given | `deformable2!0x65f435f`–`0x65f436a`, then `0x65f43d6` |
