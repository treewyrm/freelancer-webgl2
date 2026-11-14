# Alchemy appearances

How `alchemy.dll` turns an appearance's particles into triangles: what each kind builds, what its
properties measure, which tests drop a particle, how frames, colour and blending reach the vertex, and
in what order everything draws. Emitters, fields, the clock, the update order and the host's effect
types are the simulation, in [ALCHEMY.md](ALCHEMY.md). The file format is
[`freelancer/docs/modules/ALCHEMY.md`](https://github.com/treewyrm/freelancer/blob/main/docs/modules/ALCHEMY.md).

This library implements it in [`src/alchemy/draw.ts`](../../src/alchemy/draw.ts) (what each
appearance draws, beams and curved oriented quads on the CPU) and
[`src/alchemy/program.ts`](../../src/alchemy/program.ts) (the sprite vertex stage, blending).

Evidence: **checked** `module!0xADDR` was read in the retail binary; **decomp** names the function
that agrees, binary not read; **observed** names a retail capture (see [VALIDATION.md](../VALIDATION.md));
**unsettled** says what is unknown. Addresses are retail virtual addresses in `alchemy.dll` unless
another module is named.

## At a glance

| Type | Draws | Built in | `Size` is | Drops a particle when | Per-particle `TexFrame` | `MotionBlur` |
| ---- | ----- | -------- | --------- | --------------------- | ----------------------- | ------------ |
| `FxBasicAppearance`, quad | A view-plane quad, rolled | view space | **half** the side | `c.z > 0`; alpha `< 0.01` | yes | streaks it |
| `FxBasicAppearance`, triangle | An equilateral triangle, apex up | view space | the **inradius** | alpha `< 0.01` | yes | not read |
| `FxRectAppearance` | An axial billboard along the velocity | appearance frame | (none: `Length`, `Width` are **full** extents) | length or half-width `≤ 1e-6`; alpha `≤ 1e-4`; seen end-on | yes | lengthens it |
| `FxPerpAppearance` | A quad normal to the velocity | appearance frame | the **full** side | half-side `≤ 1e-6`; alpha `≤ 1e-6` | yes | not read |
| `FxOrientedAppearance` | A quad on a per-particle matrix | appearance frame | (none: `Width`, `Height` are **half** extents) | alpha `== 0`; `Scale × LOD < 1e-11` | yes | not read |
| `FLDustAppearance` | A kite along the motion on screen | view space | the **full** width | in front by `< 1` unit now or last frame; alpha `≤ 0.01` | **no** | (always a streak) |
| `FLBeamAppearance` | Two crossed sheets chained through the particles | appearance frame | (none: `RectApp_Width` is the full width) | see [the beam](#flbeamappearance) | **no** | not read |
| `FxParticleAppearance` | Nothing; an effect per particle | | | | | |
| `FxMeshAppearance` | Nothing that retail can show; it crashes on spawn | | | | | |

Every extent but the dust's is also multiplied by `Appearance_LODCurve` (below). Each routine's tests
come after that multiply and are on the sign, so a negative extent draws nothing in a rect, perp or
oriented node, and draws a half-turned quad in a basic one, which has no extent test.

## What every sprite shares

The "sprite set", `BasicApp_Color`, `_Alpha`, `_TexName`, `_BlendInfo`, `_TexFrame`, `_CommonTexFrame`,
`_UseCommonTexFrame`, `_FlipTexU`, `_FlipTexV`, is carried by every appearance but the particle and mesh
ones. The `BasicApp_` prefix is a naming habit, not ownership.

**Defaults the constructors fill in.** Absent from the file, colour is **0.8 grey**, alpha 1, and the
blend `SourceAlpha / One` (5, 2). **checked** `0x62155c3`, `0x62155db` (basic); the 0.8 also in the
beam's, dust's, perp's and oriented node's constructors (`0x62046e1`, `0x620efea`, `0x623240a`,
`0x622b45e`).

**Every curve is keyed by the particle's age over its life**, `t = age × (1 / lifespan)`, unclamped,
with `sparam` as the curve's outer key. **checked** `0x62166ef`. A particle past its life is gone
before it reaches a draw ([ALCHEMY.md](ALCHEMY.md)).

**Colour and alpha pack into one D3D colour, and alpha wraps.** The vertex colour is the colour
curve's packed bytes with `_ftol(alpha × 255) << 24` on top; nothing clamps alpha first, so 1.2 draws
as `306 & 0xff` = 50, about 0.2. **checked** `0x621675a`–`0x6216778` (basic), `0x6238f5d` (rect).
**observed** `effect_sprites`. The colour itself cannot leave 0…1: colour lists ease in bytes
(**decomp** `src/alchemy/alchemy_ramp.cpp`). Only the oriented node lets a negative alpha through its
test, and that wraps too: `_ftol(−0.5 × 255) << 24` keeps 129.

**`Appearance_LODCurve` is keyed by the host's LOD value, not by age**, and multiplies every extent:
`Size`, `Length`, `Width`, `Scale`, the beam's width. **checked** `0x62165c0` (basic: the curve at
`sparam` and the instance's LOD key), `0x6238c2b` (rect), `0x622c72d` (oriented). The dust never
evaluates it. **checked** `0x620fcb0` evaluates only alpha, size and colour. Where the LOD key comes
from is the host's; see [ALCHEMY.md](ALCHEMY.md). **At exactly 0 the basic quad routine returns
before any particle** (**checked** `0x62165ca`); the triangle routine has no such test
(**checked** `0x6217161`), so it draws zero-size triangles, which is the same picture.

**The draw state.** The begin-draw turns lighting off, Z writes off, culling off (`D3DCULL_NONE`) and
blending on, and sets stage 0 to `MODULATE(TEXTURE, DIFFUSE)` for both colour and alpha, with
`ADDRESSU` and `ADDRESSV` **clamped**; stage 1 is disabled. **checked** `0x623f450`, called from
`0x62019e0`. It does not set the depth function or the alpha test: around the Alchemy pass
`Freelancer.exe` sets `ZFUNC` to `LESSEQUAL` (**checked** `Freelancer-original.exe!0x4f74e8`), and the
alpha test as captured is `GREATER 0` (**observed** `effect_sprites`). Fog is the frame's. This
library: [`src/alchemy/program.ts`](../../src/alchemy/program.ts) `draw`, the clamp in
[`src/scene/render.ts`](../../src/scene/render.ts) `EFFECT_SAMPLER`.

**Each appearance is one draw**: the blend is set from the node, its texture bound once, and the
geometry written in one lock. The basic routine writes **view-space** vertices and sets an identity
model-view. **checked** `0x6217760`–`0x6217808`.

**No texture draws flat colour.** 21 retail appearances name `""`; with nothing bound the stage
passes the vertex colour. **observed** in the running game (extension's ledger). A name the texture
library doesn't hold draws the same way here; what retail does with one is **unsettled** (104 retail
nodes, e.g. 41 naming `small-flare.tga` where the entry is `small-flare`).

## Frames and texture animation

The texture is an object holding the name, a handle from the texture library, a frame record
(**a handle to bind, then `u0, v0, u1, v1`**) and the frame count. Three things pick a frame:

| | Clock | Picks | Where |
| - | ----- | ----- | ----- |
| `BasicApp_TexFrame` | The particle's `t` | **Only the UVs**, per particle | **checked** `0x62167cb`–`0x6216820` |
| `BasicApp_CommonTexFrame`, under `UseCommonTexFrame` | The appearance's own age, in seconds, once per update | The record: atlas and UVs | **checked** `0x62164a5`–`0x6216505` |
| The texture's own playback, otherwise | Advanced by the update's `dt` | The record bound | **checked** `0x6216517` (`0x6244ef0`) |

- **Both frame curves hold a position, 0…1, not an index.** The frame is
  `_ftol(position × (count − 1))`, so the last frame shows only at exactly 1, and a 0→1 ramp spends
  its last stretch on the frame before. **checked** `0x62167fe` (per particle), `0x62164e2` (common).
- **The atlas a particle draws on never depends on its own clock.** The per-particle fetch keeps the
  UVs and drops the handle; the bind is the instance's record (**checked** `0x6217789`). So a
  multi-atlas animation can only change atlas through the common frame or the playback.
- **The lookup is skipped for a one-frame texture**, and the per-particle one also under
  `UseCommonTexFrame` (**checked** `0x62165db`–`0x62165f8`).
- **An index outside the table is the last frame, except −1**, which is the texture's current
  playback frame. `GetFrame` compares unsigned, so any negative but −1 is past the end. **checked**
  `shading.dll!0x6ebe846`–`0x6ebe866`. A position at or below −1/(count − 1) therefore shows the last
  frame, and one that truncates to exactly −1 the playback's. No retail position does either:
  `TexFrame` runs 0…1.0047, and `_ftol(1.0047 × (count − 1))` stays in every retail table. A texture
  with no frames hands back handle 0 and the whole rect `0, 0, 1, 1` (**checked** `0x6ebe828`).
  This library: `pickFrame` in [`src/alchemy/draw.ts`](../../src/alchemy/draw.ts).
- **`FlipTexU` and `FlipTexV` swap `u0 ↔ u1` and `v0 ↔ v1` after every fetch.** **checked**
  `0x621664a`, `0x6216830`. The beam has no flips.
- **The dust and the beam read no per-particle frame.** The dust evaluates no frame curve (**checked**
  `0x620fcb0`); the beam loads its texture and never indexes it again, so it draws the record the
  library hands back at load (**decomp** `FLBeamAppearance::ApplyDrawState`). Retail's beams name no
  animation.

## `FxBasicAppearance`

**`BasicApp_QuadTexture` alone picks the routine**: set, the quad (`0x6216550`); clear, the triangle
(`0x6216f20`). **checked** `0x6217720`. `TriTexture` only chooses the triangle's mapping. So the 17
retail nodes setting both draw quads, and the 2 setting neither draw centred triangles.

**Built in view space.** Each particle's centre goes through `camera · world` and the corners are
added in the view plane (**checked** `0x6216618`–`0x6216629`, `0x62166c8`), so **an appearance's scale
moves its sprites and never resizes them**. View space has x right on screen, y up, and looks down −z
(**checked** `Freelancer-original.exe!0x40f390`, the camera's `+0x40`, read with its projector in the
extension's ledger).

### The quad

With `c` the centre in view space, `s = Size(t) × LOD`, `a = HToVAspect(t)`, `θ = Rotate(t)`:

```
skip if c.z > 0, or alpha < 0.01
R = (cos θ, −sin θ)        U = (sin θ, cos θ)
corners  c ± a·s·R ± s·U   at depth c.z
UVs      +R side u1, −R side u0;  +U side v0, −U side v1
```

**checked** `0x62166dc`, `0x6216740`, and the corners at `0x6216c4e`–`0x6216cd8`.

- **`BasicApp_Size` is the half side**: the quad is `2s` tall. This settles the extension's EXP-01,
  whose three readings spanned 4×.
- **`HToVAspect` scales the horizontal half only.** 1,773 of 1,822 retail basic nodes carry it.
- **`Rotate` is radians**, through `fcos` and `fsin` with no conversion (**checked** `0x623f6b0`, the
  pointer at `0x62572a0`), and **a positive angle turns clockwise on screen**: the right axis turns
  toward −up.
- A centre exactly on the camera plane (`c.z = 0`) still draws; only `> 0` is skipped.

### `MotionBlur` is a stretch, not a roll

Under `BasicApp_MotionBlur` the quad lies along the particle's motion as seen:

```
v = (camera · world) rotation · velocity
w = normalize((c × v) × c)              ; the motion across the line of sight, fast inverse root
b = c − w · (v · w) · 0.0333333         ; where it was a thirtieth of a second ago (x, y only)
P = a · s · (−w.y, w.x)
corners  b − s·w ∓ P  (tail, v0)   and   c + s·w ∓ P  (head, v1);   −P side u1, +P side u0
```

**checked** `0x62168a4`–`0x6216bd0`; the constant is `0x3d088880` at `0x624cdd8`.

- **There is no random roll.** The extension's EXP-02 saw scattered angles and read a random draw
  per particle; they were the particles' own directions of travel. A rect under `MotionBlur` looked
  unturned for the same reason: nothing rolls a rect.
- **`Rotate` is evaluated and ignored.**
- **The streak reaches `Size` past each end**, and its width is `a·s` either side.
- **A particle moving straight along the line of sight collapses to a point**: `w` is 0, so every
  corner lands on `b` or `c`. A motion-blurred spark flying at the eye is not seen.
- A flat-coloured streak reads as a trail; a round flare stretched the same way reads as a sprite at
  an angle. One mechanism, two textures. 636 retail basic nodes set it.

### The triangle

```
skip if alpha < 0.01                    ; no depth test, no LOD-zero test
apex   c + 2s·U
base   c ± √3·s·R − s·U                 ; equilateral, inradius s, centred on the particle
UVs, as fractions of the frame rect:
  TriTexture clear   apex (½, 0), base (1, 1) on +R and (0, 1) on −R
  TriTexture set     apex (0, 1), base (1, 1) on +R and (0, 0) on −R
```

No `HToVAspect`, no `MotionBlur`. **checked** `0x6216f20`–`0x62171e0`, the UV tables at `0x6255cc4`
and `0x6255cdc`, and the geometry per [DECOMP-ERRORS.md](../DECOMP-ERRORS.md#fxbasicappearancefilltrianglegeometry),
where the decomp is wrong about it. **observed** `effect_sprites`.

## `FxRectAppearance`

**An axial billboard: long along the particle's velocity in space, turned about that axis to face
the eye.** It has no `Rotate`. Seen end-on it vanishes, and it foreshortens as its travel turns toward
the view; it is not the travel projected onto the screen. **Built in the appearance's frame**, the eye
taken through the inverse of the appearance's world (**checked** `0x6238b64`–`0x6238c0e`), so the
appearance's scale reaches the rectangle.

```
k = Scale(t) · LOD;   L = Length(t) · k;   h = Width(t) · k / 2
skip if L ≤ 1e-6, h ≤ 1e-6, or alpha ≤ 1e-4
d = velocity / |velocity|, or +Y when |velocity| ≤ 1e-6       ; fast inverse root
e = p − eye
if ViewingAngleFade:
    c = |d · normalize(e)|
    skip if c > cos 10°;   if c > cos 30°:  alpha ×= ((cos 10° − c) / (cos 10° − cos 30°))²
    skip if alpha ≤ 1e-4
len = L + (MotionBlur ? |velocity| · 0.03333 : 0)
CenterOnPos set:    front = p + d·len/2,  back = p − d·len/2
CenterOnPos clear:  front = p + d·len,    back = p
side = normalize(d × e) · h;   skip if |d × e| ≤ 1e-6         ; end-on
corners front ∓ side (v0), back ∓ side (v1);  +side u0, −side u1
```

**checked** the tests `0x6238cda`–`0x6238d13`, the direction `0x6238d44`–`0x6238def`, the fade
`0x6238e33`–`0x6238f40` (constants `0.9848077`, `0.8660254`, `8.41876` at `0x624e474`, `0x624cddc`,
`0x624e470`), `CenterOnPos` and the stretch `0x6239024`–`0x6239295`, the side `0x62392a1`–`0x623932b`.

- **`Length` and `Width` are full extents**, each × `Scale` × LOD.
- **`RectApp_CenterOnPos` clear puts the particle on the trailing edge**, the rectangle reaching a
  full length ahead along the velocity. 119 retail rects set it.
- **`MotionBlur` lengthens a rect by `|v| × 0.03333`, about a thirtieth of a second of travel**, and
  does nothing else. The constant is `0x3d08850a`, not the basic streak's `0x3d088880`, and `|v|` is
  the fast-inverse-root length. 54 retail rects set it.
- `ViewingAngleFade`'s `c` is the cosine between the travel and the line of sight: full alpha beyond
  30° from end-on, the square fade from 30° to 10°, nothing within 10°. 48 retail rects set it.

## `FxPerpAppearance`

**A quad perpendicular to the particle's direction of travel**, what "perp" is short for. Sprite set,
`BasicApp_Size` and `RectApp_ViewingAngleFade`. Built in the appearance's frame, so its scale reaches
the quad.

```
h = Size(t) · LOD / 2;   skip if h ≤ 1e-6 or alpha ≤ 1e-6
n = velocity / |velocity|                                 ; fast inverse root
    or, when |velocity| ≤ 1e-6: +Y, or +X when q is within 1e-4 of +Y on every axis
ViewingAngleFade: c = 1 − |normalize(eye − p) · n|, then the rect's fade and skips
A = normalize(q × n);   B = n × A;   q ← B                    ; q: the particle's roll reference
corners p ± A·h ± B·h
```

**checked** `0x6233529`–`0x6233553` (the halving and tests), `0x62335b1`–`0x623367d` (the fallback,
squares against `1e-8`), `0x62337e9`–`0x623383b` (`1 −` the absolute cosine).

- **`BasicApp_Size` is the full side here**, where the basic sprite's is the half. The same
  property means two things, and generalizing from one type to the other is wrong by 2×.
- **The roll about the travel is carried per particle and re-derived each draw**: `q` is projected
  across the current velocity, so the quad follows a turning particle smoothly instead of spinning.
- **Where `q` starts, which the extension had not read: +X, or +Z when the birth velocity is +X
  within 1e-3 on every axis** (squared differences against `1e-6`). **checked** `0x6235e15`–`0x6235e98`.
  **observed** `effect_motion`, from both seeds.
- Its fade turns the rect's around: `c` nears 1 as the quad turns edge-on to the eye.
- A sphere emitter with equal radii shoots particles radially off one shell, and their perp quads
  tile it into a closed sphere only if the normal is right. A good test of the axis; a round texture
  hides the roll.

This library: `perpSeed` and `carryAxis` in [`src/alchemy/effect.ts`](../../src/alchemy/effect.ts), the
quad in [`src/alchemy/program.ts`](../../src/alchemy/program.ts).

## `FxOrientedAppearance`

A quad laid on a per-particle matrix: sprite set, `RectApp_Scale`, `OrientedApp_Width`,
`OrientedApp_Height`, `RectApp_ViewingAngleFade` and **`MeshApp_ParticleTransform`**, which the
oriented node dispatches itself. Built in the appearance's frame.

```
k = Scale(t) · LOD;   skip if alpha == 0 or k < 1e-11
T = ParticleTransform at (sparam, t), identity when absent
p' = p + T.translation
a = T.column0 · Width(t) · k;   b = T.column1 · Height(t) · k
ViewingAngleFade on n = a × b, as the perp's
corners p' ± a ± b
```

**checked** the tests `0x622c771`, `0x622c786` (`1e-11` at `0x624e47c`). The rest **decomp**
`FxOrientedAppearance::DrawOrEnqueue`, and **observed** `effect_oriented`.

- **`Width` and `Height` are half extents.**
- **The alpha test is exact**, so a negative alpha draws, wrapped.
- **No retail file can show one.** Retail's `dacom.ini` gives its pool 0 particles, which crashes the
  game; a mod that sets a pool size reaches it, and at 1000 it runs and matches (**observed**
  `effect_oriented`).
- A `ParticleTransform` with curves is nine Hermite curves per particle; this library builds those on
  the CPU (`orientedVertices` in [`src/alchemy/draw.ts`](../../src/alchemy/draw.ts)).

## `FLDustAppearance`

**A kite along each particle's motion across the view since the last frame, the camera's motion
included**, faded by the camera's own speed. Sprite set plus `BasicApp_Size`. Built in view space; no
`LODCurve`, no `TexFrame`. 2 retail nodes, both for space dust.

```
M = camera · world;  step = the last update's dt
travel = |camera position − last frame's|;   speed = travel / step
fade = speed < 100  ? 1 − (1 − speed/100)²
     : speed < 1200 ? 1 − ((speed − 100) / 1100)²
     : 0
j = |last frame's travel − travel|;  j > 20: fade ×= j < 35 ? 1 − (j − 20)/15 : 0
per particle:
    p = M · position;  q = its view position last frame
    skip if p.z > −1 or q.z > −1
    alpha = Alpha(t) · fade;   h = Size(t) / 2
    w = normalize((p × (p − q)) × p)
    s = 0.5 · 0.035 · ((p − q) / step) · w
    if s < 0.025: w = +Y;    C = w · (min(s, 100) + h)
    skip if alpha ≤ 0.01
    head p + 0.65·C,  tail p − C/0.65,  sides p ± h·(−w.y, w.x)
```

**checked** the constants (`100`, `1200`, `20`, `35`, `0.035`, `0.025`, `0.65`, `1/0.65`, `−1`) and their
uses in `0x620fcb0`–`0x6210314`; the alpha, size and colour as the only curves read.

- **The dust is invisible while the camera holds still**, in code: the fade is 0 at rest, full at
  100 units a second, 0 again at 1,200, and 0 on a frame whose travel jumps by 35 or more.
- **The alpha curve is an ordinary curve**; the camera term multiplies its value. Freelancer's
  reading that an easing byte carried the camera keying was wrong.
- The kite's UVs run corner to corner along the streak, so the texture lies diagonally across it
  (**decomp** `FLDustAppearance::DrawOrEnqueue`).
- **Under a THN host dust never draws**: `Thorn_Psys` follows each tick with a pass at 0 ms, so the
  step is 0 and the fade 0 (`Freelancer-original.exe!0x453ff0`; **observed** in the effect captures).
- **unsettled**: the kite itself is uncaptured. This library recovers `q` as `position − v · step`
  through last frame's view rather than storing it, which differs only for a particle born this step.

## `FLBeamAppearance`

**No sprite.** It chains its particles into **two crossed sheets** and draws them as one strip.
`dacom.ini` budgets 5 vertices and 24 indices a particle against 4 and 6 for a billboard.
**observed** `effect_beams`, every vertex, mirror parity and anchors included. This library builds it
on the CPU: `beamVertices` in [`src/alchemy/draw.ts`](../../src/alchemy/draw.ts).

**The chain is the appearance's own list, newest first**, threading every particle it holds whichever
emitter made it: births go on the front (**decomp** `FLBeamAppearance::Pad47`). Points:

- **A head point ahead of the newest particle.** If the appearance links an `FLBeamField`, the head is
  that field's position; that is all the field does, and why it needs no properties. Otherwise, unless
  `BeamApp_DisablePlaceHolder`, it is where a particle of age 0 would be, extrapolated from the two
  newest: `p0 − (p1 − p0) · a0 / (a1 − a0)`. Either is dropped when within 0.1 units of the newest.
- **`BeamApp_DupeFirstParticle`** set: the head copies the newest particle's width and colour, and the
  chain gains a point. Clear: **positions lag one point behind width and colour along the whole
  chain**, and the oldest particle's position is never drawn.
- **A point within 0.1 units of the last one drawn is skipped** (squared distance `≤ 0.01`, **checked**
  `0x6205859`, `0x6205a29`, `0x6205e9f`).
- Without an anchor, fewer than two particles draw nothing.

**Each point opens into a cross along the camera's right and up**, half the width either side; the
chain's own direction plays no part. The axes are columns 0 and 1 of `S · W`, the camera's world frame
times the appearance's (**checked** `0x620591f`–`0x620592d`; `+0x10` is the camera's frame,
`Freelancer-original.exe!0x40f380`), added to points still in the appearance's frame, which then go
through `W` again. So **a turned or scaled appearance turns and scales the sheets twice**. No retail
beam sits in a turned frame.

- **Width is `RectApp_Width × RectApp_Scale × LOD`.** `RectApp_Length` is stored and never read.
- **`BasicApp_QuadTexture` defaults to true** on the beam and fans each segment round a midpoint
  vertex with **UV (0.5, 0.5) literally**, whatever the frame, and the far end's colour (**checked**
  `0x6205cb4`). On an atlas sub-frame the centre samples outside the frame; that is retail.
- **The texture mirrors along the chain**, one whole frame per gap, every other copy flipped in V;
  across the width it never mirrors (−side `u0`, +side `u1`). V is `v0` where a point's draw index
  and a toggle the appearance flips on every birth agree, so the pattern stays on the particles as
  the chain grows instead of crawling. **The tile length is the point spacing.**
- **Seen end-on a beam vanishes**: both points of a segment project to one spot, so neither sheet has
  area. Across the screen the up sheet carries it, up the screen the right sheet.
- Property `0x1C65B7B9` switches the beam to wireframe with no texture; no retail node sets it, and
  this library doesn't draw it (**decomp** `FLBeamAppearance::ApplyDrawState`).

Librelancer builds a different beam (one ribbon about `cross(toCamera, forward)`, sized by `Width`
alone, no head, no skips, V mirrored by draw index) and is no evidence here.

## `FxParticleAppearance`: an effect per particle

**It draws nothing.** Each particle carries a life effect, started at birth and placed every frame at
the particle, in the appearance's frame.

- **No `ParticleApp_LifeName`, or a name no library defines, and no particle is born.** **checked**
  `0x622f6fc`, `0x622f742`. 8 of retail's 18 name a life effect no file defines, so they never hold a
  particle.
- **The child is created under the appearance's own parent link**, so its top nodes hang off the
  spawner, sorted by class among its children, and draw where that puts them (**checked** `0x622f73d`;
  [draw order](#draw-order)).
- **The placement `[R | p]` reaches the child's control root alone.** What hangs from the root
  follows; a node beside the root stays where it was, so its particles are left behind as a trail.
- `ParticleApp_UseDynamicRotation` turns the child's +Y onto the velocity each frame;
  `SmoothRotation` eases toward that by `min(|v| · dt, 1)` a frame.
- `ParticleApp_DeathName` starts where a particle dies, unturned.
- The child inherits the appearance's `sparam` and LOD and follows later changes.

**decomp** `FxParticleAppearance::Pad47`, `Pad5`, `ComposeNodeTransform`. Lifetimes are in
[ALCHEMY.md](ALCHEMY.md).

## `FxMeshAppearance`: crashes, so draws nothing

Meant to place a `.3db` per particle (`dacom.ini`: "need enough of these for all tradelane rings";
`TLRtube` is the ring). The mesh comes from `Freelancer.exe`'s `IFxMeshFactory`, which formats
`fx\misc\%s.3db` from an empty local rather than `MeshApp_MeshName`, fails, and still reports success.
`alchemy.dll` calls through the null mesh at once on spawn. **checked** `0x6224ed9` (no null test before
`[mesh]+0xc`); the factory's argument per the extension's reading of `Freelancer-original.exe!0x4f6810`,
**unsettled** here. So no data can draw one, and this library reports it as unsupported.

## Which appearance an emitter draws through

**An emitter has one appearance slot, and the last `Pair` naming it wins.** Each link releases the
old appearance, stores the new one and adds an emitter reference to it, but never takes back the
reference it gave the first. **checked** `0x6245b50`–`0x6245ba6`, slot `+0x98`. **observed** `lab_two`.
This settles the extension's EXP-03.

- A link from an emitter to a node that isn't an appearance empties the slot (**decomp**
  `FFxEffectObject::BindRec8Associates`).
- **The first appearance keeps that orphan reference, so it never counts as finished on its own**: its
  update marks it done only with no emitter reference and an empty list (**checked** `0x6216447`).
- Which one wins depends on **each emitter's own order of targets**, the `Pair` records' order as they
  name it (**checked** `alchemy!0x621f348`, a walk in file order). The format library keeps that order
  on write; only the interleaving between different sources changes, which nothing reads
  ([Pair ordering](https://github.com/treewyrm/freelancer/blob/main/docs/modules/ALCHEMY.md#pair-ordering-is-not-preserved)).
- **The particles live in the appearance's frame**: spawned through `inverse(appearance) · emitter`
  and drawn through the appearance's world, so an animated appearance carries the particles already
  alive. See [ALCHEMY.md](ALCHEMY.md).

## Blending

`BasicApp_BlendInfo` is `{ source, destination }`, and the format's `BlendingMode` is `D3DBLEND`
verbatim. The draw hands the two straight to `D3DRS_SRCBLEND` and `D3DRS_DESTBLEND` (render states 19
and 20). **checked** `0x6217760`–`0x621777e`.

| Pairs in retail | Count |
| --------------- | ----- |
| `SourceAlpha / One`, additive, and the default | 2,489 |
| `SourceAlpha / InverseSourceAlpha` | 161 |
| seven others | 1 or 2 each |

- **A both-mode as a source** (`BothSourceAlpha`, `BothInverseSourceAlpha`) sets both factors, as
  Direct3D defines it. **unsettled**: what a driver does with `BothInverseSourceAlpha` (13) as a
  destination, which D3D accepts only as a source; one retail node writes it
  (`gf_small_damage_smoke2.app`). This library reads it as `InverseSourceAlpha`, a guess.
- **unsettled**: a present `BlendInfo` of `None` (0, no D3D value), on 22 retail nodes. This library
  draws the default.
- Destination alpha is never kept in retail's target; this library blends alpha as `ZERO, ONE`.

## Draw order

**Nothing sorts by depth, at any level.** Each level walks a list kept in a fixed order. A renderer
that helpfully depth-sorts a cloud is wrong in a way that looks better.

| Level | Order | Evidence |
| ----- | ----- | -------- |
| Between effects | By effect type, then **newest first** within a type | **checked** `Freelancer-original.exe!0x4fc920`, `0x4f7810` |
| Between appearances in one effect | Pre-order walk of the tree, **siblings by class**: appearances, fields, emitters, folders; entry order breaks ties | **checked** `0x6201910`, `0x6201e00`, `0x6202740` |
| Within one appearance | **Oldest first**; the beam's chain newest first | **checked** `0x6216035`–`0x6216067`, `0x6217662` |

**Between effects.** `Freelancer.exe` keeps one list per effect type and pushes each new effect onto
the front (`0x4fc920`); the pass walks each list from its head (`0x4f7810`). Types 0–42 draw inside the
Alchemy batch, in index order, and 44–46 after it; this pass never walks type 43 (**checked**
`0x4f7604`–`0x4f76c6`). Before the batch the game passes render flag `0x43`, `BATCH_PARTICLES`, as
"use the material batcher"; it defaults to 0 and no retail file sets it, so every appearance draws the
moment it is walked (**checked** `0x4f7560`–`0x4f758c`, the flag tested at `0x6217699`). Effect types
are [ALCHEMY.md](ALCHEMY.md)'s.

**Between appearances.** Every class returns a constant from `+0x38`: **100 for the eight appearance
types, 200 for the seven fields, 300 for the three emitters, 400 for a folder** (**checked** the
`mov eax, imm; ret 4` at each slot the decomp attributes, e.g. basic `0x6218e80`, cone `0x621c220`,
and `0x6202740` at the folder vtable's `+0x38`, `0x624b1c8`; attribution per class **decomp**
`alchemy_genericfx.h` `GetSortKey`). Each sibling list is kept ascending by it, a new
child inserted after the last that isn't greater, so ties keep entry order (**checked** `0x6201e41`–
`0x6201e5b`). The draw walks each top-level node's subtree in pre-order: the node, its first child,
its next sibling, back up by the parent (**checked** `0x6201969`–`0x62019c7`). Two consequences:

- **An appearance beside the control root draws before everything under the root**, because the
  root is a folder.
- **Among siblings an appearance draws before the subtree of any field, emitter or folder beside
  it**, whatever the file order.

109 of retail's 1,213 effects draw differently from file order, and 7 visibly, where an alpha-blended
appearance beside the root draws before an additive one under it: `gf_ge_s_thruster_01`,
`gf_small_damage_fire03`, `gf_flakcannon01` and `rtc_gf_flakcannon01`, and the `br_`, `ku_`, `li_`
`torpedo01_drive`. In `gf_small_damage_fire03` the smoke draws over the first fire and the second fire
over the smoke. Those counts are the extension's walk of the retail files by this rule; the rule
itself is **observed** in `effect_folder`.

**Within an appearance** a billboard appends each birth at its list's tail (`+0xdc`) and draws from the
head (`+0xd8`), so a later particle draws over an earlier one even when the earlier is nearer. This
library keeps each appearance's particles in emission order for that reason.

## Open

- **A name the texture library doesn't hold**: whether retail binds nothing (flat colour, as here) or
  something else.
- **Blend values D3D doesn't define**: `None` as either factor, and a both-mode as the destination.
- **The dust's kite and fade** are uncaptured, since no THN host shows them.
- **An animated texture's own playback**, which picks the atlas when `UseCommonTexFrame` is off: built,
  uncaptured, and reached by no retail appearance (every animation one names is a single-atlas grid).

## Corrections

To the extension's `docs/renderer/ALCHEMY.md`, `ALCHEMY-DLL.md` and `ALCHEMY-LAB.md`:

| Believed | True | Evidence |
| -------- | -------- | -------- |
| The particle's frame is the **first** appearance an emitter names (ALCHEMY.md, "A particle lives in its appearance's frame") | The **last** `Pair` wins: one slot, replaced | **checked** `0x6245b50` |
| The perp's roll seed "is not read" | +X, or +Z when the birth velocity is +X within 1e-3 | **checked** `0x6235e15` |
| What the texture library does with a frame index past the table "is not read" | The last frame; −1 is the playback's current frame; any other negative is past the end | **checked** `shading.dll!0x6ebe846` |
| `MotionBlur` lengthens a rect by `|v| / 30` | By `|v| × 0.03333` (`0x3d08850a`), `|v|` by fast inverse root; the basic streak's constant is `0x3d088880` | **checked** `0x6239038`, `0x6238d44` |
| "At exactly 0 the basic routine draws nothing" (`Appearance_LODCurve`) | The quad routine only; the triangle has no LOD test, and draws zero-size triangles | **checked** `0x62165ca`, `0x6217161` |
| Types 44–46 draw after the Alchemy batch, the rest inside it | 0–42 inside, 44–46 after; type 43 is not walked by this pass | **checked** `Freelancer-original.exe!0x4f7604`–`0x4f76c6` |
| EXP-02: `MotionBlur` is a random roll per particle (the lab entry, still open there) | A stretch along the motion as seen; no roll, `Rotate` ignored | **checked** `0x62168a4` |
