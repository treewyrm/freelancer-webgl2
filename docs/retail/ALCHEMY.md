# Alchemy: the simulation

What retail `alchemy.dll` and `Freelancer.exe` compute to run a particle effect: the tree of
instances, the clock, how the game reaches and feeds an effect, every emitter and field, how a
particle lives and moves, and which key each animated property is sampled at. How particles are
drawn, and every appearance property, is in [APPEARANCES.md](APPEARANCES.md). The file format is
`@treewyrm/freelancer`'s: [ALCHEMY.md](https://github.com/treewyrm/freelancer/blob/main/docs/modules/ALCHEMY.md). This library
implements what follows in [`src/alchemy/effect.ts`](../../src/alchemy/effect.ts),
[`tree.ts`](../../src/alchemy/tree.ts) and [`transform.ts`](../../src/alchemy/transform.ts).

Evidence: **checked** `module!0xADDR` was read in the retail binary; **decomp** names the decomp's
file and symbol that agrees, binary not read; **observed** was seen in a retail capture;
**unsettled** says what is unknown. Addresses are retail virtual addresses; `Freelancer.exe` ones
were read in `Freelancer-original.exe`.

## The effect and its tree

### Nodes and instances

- **A node is a bag of properties; the effect is the tree.** A node library maps the
  case-sensitive CRC of `Node_Name` to a prototype, and an effect's entries each clone one by CRC.
  The pool is one namespace across everything loaded, so two `.ale` files defining the same name
  collide, and which wins is the host's load order (146 retail names are defined twice, 111 of them
  differently). **decomp** `src/alchemy/alchemy_effectobject.cpp`
  `FFxEffectObject::InstantiateNodesFromArchetype`.
- **An entry's `flags` makes it a folder; its CRC makes the folder the root.** `flags` 0 looks the
  CRC up (an unresolved CRC fails the whole effect). Non-zero builds a bare `FxNode` without looking
  anything up. Among folders, one whose CRC is `0xEE223B51` (`Control Root`) becomes the effect's
  **control root**; with several, each match overwrites the last, so the last in entry order wins.
  **decomp** `InstantiateNodesFromArchetype`, and `../freelancer`'s
  [two fields, two jobs](https://github.com/treewyrm/freelancer/blob/main/docs/modules/ALCHEMY.md#two-fields-two-jobs-flags-makes-a-container-control_root_id-makes-it-the-root).
  Retail sets both on every folder, has at most one per effect, and has 70 effects with none.
- **Siblings are sorted by class, not file order.** Each class answers a constant: 100 for the eight
  appearances, 200 for the seven fields, 300 for the three emitters, 400 for a folder. **checked**
  `alchemy!0x6202740` (400) and the 100/200/300 constants in every class vtable. The build puts
  top-level entries first, ascending by that key with ties in entry order, then nested entries in
  entry order; linking inserts each child after the last sibling whose key is not greater
  (`0x6201e00`). So every child list, at every depth, runs appearances, fields, emitters, folders,
  ties in entry order. **decomp** `InstantiateNodesFromArchetype`, `FAlchemy::AttachNode`. This
  order is both the update order (below) and the draw order ([APPEARANCES.md](APPEARANCES.md)).
- **A top-level entry hangs from the effect's own parent, not from the root.** Parent id `0x8000`
  means top level. **decomp** `FFxEffectObject::AttachAlchemyTree`.

### Links

Containment and the `Pair` links are separate, and neither stands in for the other: 2,234 of retail's
2,637 emitter → appearance links go to a sibling, 403 elsewhere.

- **Emitter → appearance: one slot.** A second `Pair` from the same emitter replaces the first. The
  first appearance's COM reference is released but its **feed count is not**, so it never reaches
  the "no emitter feeds me" state and never dies by it (below). **checked** `alchemy!0x6245b50`
  (`AssociateAppearance`: `+0x8` Release on the old, `+0xc4` AddEmitterRef on the new, no `+0xc8`).
  One retail emitter names two (`gf_explosion_br_battleship_damagemultiflashbang_Cone.emt#1`); the
  later `Pair` record wins. Only each source's own order of targets matters, and `../freelancer`'s
  writer keeps it; the interleaving between sources it changes is never read
  ([note](https://github.com/treewyrm/freelancer/blob/main/docs/modules/ALCHEMY.md#pair-ordering-is-not-preserved)).
- **Appearance → fields: a list in `Pair` order.** An emitter paired with anything but an appearance
  has its slot cleared (the count it gave stays given); any other combination is reported and
  ignored. **decomp** `FFxEffectObject::BindRec8Associates`.
- **A field acts only on appearances that name it.** Nothing about position in the tree applies a
  field.

### The effect header's sphere

A version 1.1 effect's four floats after its name (a centre and radius) are stored and written back
and read by nothing that runs. The game culls on the effect type's `radius` instead. **decomp**
`src/alchemy/alchemy_effectarchetype.cpp` `GetHeader16`; the game side is
`src/freelancer/Client/particle_effect.cpp` `FParticleEffect::GetWorldPos`.

## The node clock and lifetime

Every node instance has its own age, 0 when the instance is made, and a lifespan copied from
`Node_LifeSpan`.

- **`Node_LifeSpan` absent is 3 s.** **checked** `alchemy!0x623f80f`. An instance holds 100 s until
  the copy. Retail writes both `FLT_MAX` and `Infinity` for "never".
- **The tick is `age += dt`, and the node is dead once `age > lifeSpan`**, strictly.
  **checked** `alchemy!0x6240150` (`and ax,0x4100; jne` skips on `<` and `=`).
- What the lifespan does differs by role:

| Node | Ticks | Dies |
| ---- | ----- | ---- |
| Emitter | Every update, before emitting | Past its lifespan. **Its last update still emits**: the emitter never tests its own flag (`0x6245c14` ticks, nothing reads bit 0), and the walk kills it afterward. **checked** `alchemy!0x6245bf0` |
| Field | Every update, then samples its curves at the new age | Past its lifespan. **checked** `alchemy!0x62142c0` and siblings |
| Appearance | `age += dt` with **no lifespan test** | When no emitter feeds it **and** it holds no particle, tested at the start of its update with last frame's state. **checked** `alchemy!0x6216441`–`0x621645d` |
| Folder | As any node | Past its lifespan, which effect init sets to the longest `Node_LifeSpan` among its descendants, 0 with none. Only entries with `flags == 1` get this. **checked** `alchemy!0x621f526`–`0x621f5c5` |

- **Death takes the subtree, particles included.** A dead node is submitted: its children first,
  depth-first, each flagged (`| 0x80000000`) and unlinked. An emitter flagged so gives back its feed
  on its appearance. **checked** `alchemy!0x6245bb0`; **decomp** `src/alchemy/alchemy_alchemy.cpp`
  `FAlchemy::SubmitNode`, `SubmitNodeChain`.
- **So the root folder cuts an effect off** at the longest lifespan below it, live particles and
  all. An appearance's own `Node_LifeSpan` never stops that appearance, but it does count toward the
  root's. 33 retail effects are cut this way, `gf_explosion_mine01` at 3 s. **observed** `effect_folder` capture.
- A folder whose `flags` is non-zero but not 1 keeps the instance's 100 s. **unsettled**: nothing
  else was traced that writes it, and retail has none.

## One frame

### The game's order

`ParticleEffect`'s update (`Freelancer.exe 0x4f8a20`) does, after its own checks (see
[Reaching an effect](#reaching-an-effect-from-the-game)):

1. **LOD** through the effect's `+0x38`, to every node. **checked** `Freelancer!0x4f8b9d`.
2. **Placement** through `+0xc(0, world)`. **checked** `Freelancer!0x4f8bad`.
3. **Compose** through `+0x1c(0)`: every node's world matrix. **checked** `Freelancer!0x4f8bb8`.
4. **Update** through `+0x20(dt)`: the tree walk. **checked** `Freelancer!0x4f8bc7`.

The draw comes later in the same frame. `sparam` is not part of this; a host sets it when it likes.

### Compose comes before update

A node's world is `parent · override · local`, with `local` the node's `Node_Transform` evaluated at
(`sparam`, its age), any factor absent dropped. **decomp** `src/alchemy/alchemy_genericfx.cpp`
`FGenericFxObjectBase::ComposeNodeTransform`. A top-level node composes from the identity, not from
anything of the host's. **checked** `alchemy!0x62016d8`–`0x6201759`.

Because the compose runs first, **every matrix a step uses is at the age before that step's `dt`**,
while the emitter's and fields' properties are sampled after the tick. A spawn goes through the
emitter's matrix at `t − dt` and draws its shape at `t`. **checked** order above, and
`alchemy!0x621b9d0` (shape at `dt + age`).

### The update walk

The effect walks its top-level entries in array order, skipping dead ones, and from each does a
pre-order walk: update the node (`+0x14(dt)`), then read its flags; dead, submit it with its
subtree and go on to the next sibling; alive, descend into its children. The next sibling is read
before the update, the first child after it. **checked** `alchemy!0x621f730`, `0x6201810`,
`0x6201870`.

With siblings sorted 100, 200, 300, 400, this order has consequences nobody would design:

- **An appearance updates before the sibling fields it reads**, so it applies each field's values
  from the frame before, and on an effect's first frame a field does nothing (its cached state is
  the constructor's zeros). All 240 retail appearance → field links have the appearance first.
  **decomp** `src/alchemy/alchemy_fields.cpp`; **observed** `effect_fields` is consistent with it.
- **Gravity and collide use the field's own last `dt`**, not the appearance's current one, so a
  variable frame time shows.
- **An emitter updates after its sibling appearance**, so a birth is not aged or moved by its
  appearance until the next frame. It is born already aged and moved (below).

### The step

There is no fixed step. The host passes its frame time, clamped to 0.1 s
(**checked** `Freelancer!0x4f75e7`), and emission truncates per frame and turbulence redraws per
frame, so **the picture depends on the frame rate**. This library takes the host's `dt`.

## Placement

### Where a placement goes

The effect's `+0xc(which, M)` hands `M` to its control root alone. Without a root, it hands `M` to
every live top-level entry. **checked** `alchemy!0x621f610`. What hangs from them follows through the
compose.

`which` decides what `M` replaces. **checked** `alchemy!0x62400f0`, `0x62401b1`:

| `which` | Writes | Then the compose | Who uses it |
| ------- | ------ | ---------------- | ----------- |
| 0 | The node's world, outright, and flag 8 | Clears flag 8 and keeps that world: **neither parent nor the node's own `Node_Transform` is applied** | `ParticleEffect`, every in-flight effect (`Freelancer!0x4f8baa`) |
| 1 | The override, and flag 4 | `parent · M · local` | `Thorn_Psys`, cutscene effects (**decomp** `src/freelancer/Client/gf_thorn_psys.cpp` `FThornPsys::Tick`); a sub-effect's root (below) |

A root folder carries no transform, so for a rooted effect the two agree. **For a rootless effect
placed in flight, each top-level node's own `Node_Transform`, animation included, is never
applied**: it sits exactly at the placement. 26 of retail's 70 rootless effects have a top-level
node that carries a transform, among them seven `gf_explosion_br_large01_*`, the Liberty and Rheinland
battleship explosions' flashes and rings, `gf_tradelaneendsplash`, `GravityWell1020` and
`PlayerShipEngines`. The `rtc_*` ones among the 26 are placed by a cutscene, with `which` 1, and do
apply it. Not seen in game: **unsettled** whether any of these looks different for it.

### Nodes beside the root

A top-level node other than the root composes from the identity, so **it stays in the world frame**
and the placement never reaches it. An appearance there keeps its particles where they were born
while the emitter feeding it travels: that is how retail makes an engine trail (`gf_br_*_engine01`,
130 `FLBeamAppearance` and 223 `FxBasicAppearance` instances sit beside a root). Three emitters do
too (`gf_explosion_rh_battleship_bigexplosion` and the Rheinland cruiser's and gunboat's), and so
emit near the world origin plus their own transform. **checked** `alchemy!0x62016d8`; that the three
do so in game is **unsettled**.

### `Node_Transform`

`T · S · Rz(z) · Rx(x) · Ry(y)` on column vectors, angles in degrees, scale on the left of the
rotation so it stretches along the parent's axes. The three order bytes in the header are stored and
never evaluated. **checked** `alchemy!0x6243c50` (three degree conversions by `0x624d4c4`);
order **decomp** `src/alchemy/alchemy_ramp.cpp` `FFxAnimatedTransform::Evaluate`,
`BuildEulerRotation3x3`; the order was also **observed** by the extension. The header and the
nine-curve mask: [AnimatedTransform](https://github.com/treewyrm/freelancer/blob/main/docs/modules/ALCHEMY.md#animatedtransform).

### Inverting a frame

Every frame-to-frame matrix (emitter into appearance, field into appearance) is
`inverse(B) · A` through `x86math.dll`'s 3×4 inverse, which **never fails**: at `|det| ≤ 1e-8` it
scales the adjugate by 1 instead of `1/det`. A zero scale curve therefore runs, and whatever it
carries lands on that frame's origin. **checked** `x86math!0x6f71380` (threshold `0x6f73064` = 1e-8,
fallback `0x6f730f8` = 1). This library: `frameInverse`.

Two places use the **transpose** `Mᵀ(p − t)` (`x86math` `+0x3c`) instead, which is an inverse only
for an unscaled frame: the emitter's path and the dust field. **checked** `x86math!0x6f71950`.

## Inputs: `sparam` and the LOD key

Every animated property has two keys. The outer one is `sparam`, an external control value. The
inner one is decided by the code sampling the property (next section).

- **`sparam` starts at 0 and the LOD key at 1**, on every node instance. **checked**
  `alchemy!0x623fbfc`, `0x623fc02`.
- **Setting either reaches every node of the effect**, in array order, dead or alive.
  **checked** `alchemy!0x621f820` (`sparam`, each node's `+0x5c`), `0x621f850` (LOD, `+0x88`).
- **`ParticleEffect` clamps both to 0…1.** **checked** `Freelancer!0x4f8c20`, `0x4f8c80`. A
  cutscene's `Thorn_Psys` passes `sparam` unclamped and never sets the LOD, which stays 1.
  **decomp** `FThornPsys::SetSparam`, `FThornPsys::Tick`.
- **The LOD key is pushed every update** from the effect type's `[EffectLOD]` band (below).
  **checked** `Freelancer!0x4f8b94`.
- **`sparam` is pushed by a few hosts only, and an effect none feeds runs at 0.** **decomp**
  `src/freelancer/Client/client_equip_fx.cpp`, `space_dust.cpp`, `cli_asteroid_dynamic.cpp`,
  `tradelane_fx.cpp`, `gf_thorn_psys.cpp`:

| Host | Value |
| ---- | ----- |
| Engine flame and trail | `0.9 × smoothed throttle`, rising to 1 over the cruise charge; floored at 0 |
| `[AttachedFX]` with `use_throttle` | The throttle |
| Thruster | 1 on, 0 off |
| Dynamic asteroid | The rock's fade, every frame; 0 on removal |
| Space dust | A particle budget × 0.002 (the detail setting for the system layer, a zone's `spacedust_maxparticles` and immersion for a zone's) |
| Trade lane ring | A fader whose rate and start are 0, so always 0 |
| Cutscene | `START_PSYS_PROP_ANIM`, a linear ramp, unclamped |

Nothing feeds it from speed. A gun flash, a hit, a cloak, debris, jump and lane effects run at 0.
The shield-hit feed exists but never fires: its out handle is never written (**decomp**
`FCliShieldEquipFx::OnCollisionHit`).

## Sampling

### Which key each property takes

| Property | Outer | Inner |
| -------- | ----- | ----- |
| `Node_Transform` | `sparam` | node age, before this step's `dt` |
| Every `Emitter_*` but two, every shape property | `sparam` | emitter age, after the tick |
| `Emitter_LODCurve` | `sparam` | **the LOD key** |
| `Emitter_EmitCount` | first list only | not evaluated: its keys are walked as events |
| Every field property but one | `sparam` | field age, after the tick |
| `RadialField_Attenuation` | `sparam` | **distance over radius, clamped to 1** |
| Appearance properties | | see [APPEARANCES.md](APPEARANCES.md) |

**checked** `alchemy!0x6245c59`–`0x6245cb9` (emitter at `+0x8c`, `+0x84`), `0x6245dd4` (LOD curve at
`+0x8c`, `+0x90`), `0x6236696` (attenuation at `+0x8c` and the distance).

### How a value is evaluated

`../freelancer`'s `curveAt`, `floatAt` and `colorAt` are ports of the DLL's three evaluators, and
its [Evaluation](https://github.com/treewyrm/freelancer/blob/main/docs/modules/ALCHEMY.md#evaluation) section is the reference.
What a maintainer would otherwise get wrong:

- **Emitters, shapes and fields are looped Hermite lists**; `Emitter_LODCurve` and
  `RadialField_Attenuation` are eased lists, which run once and hold.
- **A key on or past an eased list's last key returns the last value**, before any easing, so a
  `Step` list reaches its last value exactly there. **decomp** `src/alchemy/alchemy_ramp.cpp`
  `FRampSingle::Eval`.
- **The `sparam` level eases with its own inline code**: `Step` takes the lower list, any byte
  outside 2–6 is linear, and `Auto` and `AutoInverse` are swapped against the inner table. Retail's
  outer lists never use either. **decomp** `TNestedSingleRamp::Eval`.
- **A looped list's wrap word is two four-bit modes**, before and after: hold, cycle, cycle with
  offset, oscillate, linear. Not independent bits.
- **Hermite tangents are per unit of key**, scaled by the span; the loader never recomputes them.
- **An empty eased list is read unguarded** in the DLL. **decomp** `FRampSingle::Eval`.

## Emitters

### Properties and defaults

All three shapes share the `Emitter_*` block. Absent properties take the constructors' values,
which matter for edited files; retail omits only `Emitter_MaxParticles` (on 535 emitters).
**checked** `alchemy!0x62455b0`, `0x621cdd0`, `0x621b490`, `0x623bb80`.

| Property | Default | Meaning |
| -------- | ------- | ------- |
| `Emitter_Frequency` | 100 | Particles per second, truncated per frame |
| `Emitter_EmitCount` | 0 | Bursts: each key of the first list is a time, its value a count |
| `Emitter_InitialParticles` | 0 | An integer added on the first update, signed |
| `Emitter_MaxParticles` | 10,000 | Cap on what **the appearance** holds |
| `Emitter_InitLifeSpan` | 2 | Each birth's lifespan, s |
| `Emitter_Pressure` | 10 | Speed along the heading |
| `Emitter_VelocityApproach` | 0 | Share of the emitter's own motion lent to each birth |
| `Emitter_LODCurve` | 1 | Scales the count at the LOD key |
| `CubeEmitter_Width`, `_Height`, `_Depth` | 5, 5, 5 | **Half**-extents along x, y, z |
| `CubeEmitter_MinSpread`, `_MaxSpread` | 0, 15 | Polar angle off +Y, degrees |
| `ConeEmitter_MinRadius`, `_MaxRadius` | 0, 1 | Shell between two radii |
| `ConeEmitter_MinSpread`, `_MaxSpread` | 0, 0 | Polar angle off +Y, degrees |
| `SphereEmitter_MinRadius`, `_MaxRadius` | 0, 1 | Shell between two radii |

### The update

Each shape's update samples its shape at the new age, then runs the shared body. Here `t` is the
emitter's age after the tick, `last` the age of its last emission, and `M` its world matrix (at
`t − dt`, above). **checked** `alchemy!0x6245bf0`–`0x62460c9`:

```
tick; no appearance: return
appearance dead, or this emitter flagged dead: drop the link, return
F = inverse(appearance world) · M                    ; 0x623ffb0, the spawn frame
P, L, f = Pressure, InitLifeSpan, Frequency at (sparam, t)
Δ = t − last                                          ; stored as a float
n = _ftol(Δ · f)
first update, or first after a link: n += InitialParticles; prev = M.translation
for each key k of EmitCount's first list, in order:
    k.time < last: skip;  k.time > t: stop
    n = _ftol(n + k.value)                            ; last ≤ k.time ≤ t, both ends inclusive
s = LODCurve(sparam, lod) · n + carry
N = _ftol(s); carry = s − N                           ; carry is kept before the test below
N == 0: if f == 0, last = t; return
D = Mᵀ · (prev − M.translation); prev = M.translation ; 0x6245e74, x86math +0x3c
bias = Δ > 0 ? −VelocityApproach(sparam, t) · D / Δ : 0
offset = D; step = D / N
appearance shares this emitter's parent: offset = step = 0       ; the bias stays
room = MaxParticles(sparam, t) − appearance's live count
room < N: N' = _ftol(room), else N' = N
for i in 1 … N': age = Δ · (1 − i/N); offset −= step; spawn(age, offset, bias)
last += Δ
```

What follows from it:

- **The count is frame-rate bound.** The fraction of `Δ · f` is dropped whenever anything is
  emitted: 100/s is 60/s at 60 Hz and 90/s at 30 Hz.
- **And float-bound.** `Δ` is a difference of float ages, so a rate meant to land on a whole count
  per frame often truncates one short: with a step of exactly `1/60` s, 60/s comes out near 43/s.
- **A slow emitter accumulates.** While `N` is 0 and `f` is not, `last` stays put, so `Δ` grows
  until it yields a particle.
- **The same rule blunts the LOD.** When the LOD factor leaves `N` at 0, `carry` keeps its share
  *and* `last` stays put, so the next frame counts that interval again. 100/s at 60 Hz emits 60/s at
  a factor of 1 and still 60/s at 0.5 (30/s at 0.25); 50/s gives 30, 24 and 18. Burst keys in a
  re-counted interval count again too. Simulated from the checked arithmetic, **unsettled** in game.
- **A burst key exactly on a frame boundary fires twice**, since both ends are inclusive and the
  next frame's `last` is this frame's `t`.
- **`EmitCount` is not inert.** Its keys are times and its values counts, truncated: retail's
  `0.180 → 5.866` on 41 gun projectiles is five particles 0.18 s in.
- **`InitialParticles` is added as stored**, so `0xCDCDCDCD` on one retail cone emitter is
  −842,150,451 and that emitter's first frame emits nothing.
- **The cap is the appearance's**, counted across every emitter feeding it. The births dropped are
  the last of the loop, the youngest.
- **Velocity approach lends the whole path**, `VA = 1` being the emitter's full velocity however
  many are born. The `1/N` only spaces births along it.
- **The path goes through the transpose**, so on an emitter scaled by `s` the path is `s` times too
  long in its local frame and `s²` times once mapped back: a scaled emitter lends `s²` of its motion
  and spaces births `s²` apart. Read from the arithmetic, **unsettled** in game.
- **The parent test zeroes only the spacing.** It compares the appearance's parent link with the
  emitter's (`0x6245fa0`, node `+0x8`), the one arrangement where the appearance's own frame already
  carries the path.
- **An emitter past its lifespan emits once more**, for the time up to `t`, then dies.

### The spawn

Each shape draws in this order, every draw from the random source below; `r` is one draw.
**checked** `alchemy!0x621ba90` (cone), **decomp** `src/alchemy/alchemy_emitters.cpp`
`FxCubeEmitter::EmitParticle`, `FxSphereEmitter::EmitParticle`:

| Shape | Heading, local | Point, local |
| ----- | -------------- | ------------ |
| Cone | `φ = r · 2π`, then `θ = min + r · (max − min)` in degrees, signed: `(cos φ sin θ, cos θ, −sin φ sin θ)` | heading × `(minR + r · (maxR − minR))` |
| Cube | As the cone's, from its own spread pair | `y = 2(r − ½) · Height`, then `x` by `Width`, then `z` by `Depth`: independent of the heading |
| Sphere | `(2(r − ½), 2(r − ½), 2(r − ½))` drawn **y, x, z**, normalized by the fast inverse square root with one Newton step | heading × `(minR + r · (maxR − minR))` |

- **An emitter fires along local +Y**, not −Z: `θ = 0` gives `(0, 1, 0)`. Retail aims directional
  emitters with ±90° about X.
- **The cone is a sphere shell carved by the spread**, the point on the heading; a cone with both
  spreads at 0 spawns along the +Y axis between the radii. Both spreads at 90 make a ring.
- **The sphere's heading is not uniform**: a normalized point of the cube leans toward its diagonals.
- **The cube's spread defaults to a 15° cone.**

Then every shape: `v = heading · Pressure`, `p = point + v · age + offset`, `v += bias`, `p` through
`F` and `v` through `F`'s rotation **with its scale**, and `(p, v, age, L)` go to the appearance.
**checked** `alchemy!0x621bb1b`–`0x621bbcc`. So **a particle is born already aged and already moved**,
by its own velocity before the bias; the bias is not part of that head start, and no field acts on
it.

### The random source

One generator for the whole DLL: a 16-bit shift register with a call counter, both 0 at load,
returning one of 256 values `byte / 255`, 0 and 1 included. **checked** `alchemy!0x623f1f0`
(state `0x6257bac`, counter `0x6257bb0`). Every effect running, every spawn and every turbulence
draw take from it in turn, so no particle's draws are reproducible across scenes; the distribution
is what matters. This library ports it per `EffectPools`.

### Pools

Each appearance kind draws its particles from one pool for the whole game, sized by
`dacom.ini`'s `[Alchemy]` (`FxBasicAppearance` 1000, rect 400, perp 250, beam 680, dust 250, mesh 500,
particle 100, oriented 0). **A birth into a full pool evicts the oldest particle of that kind,
from whichever effect holds it.** **decomp** `src/alchemy/alchemy_genericfx.cpp`
`FGenericFxObjectBase::SpawnListParticle`; **checked** for the particle kind at `alchemy!0x622f6ae`;
**observed** `effect_pool`. `MaxParticles` is a second, per-appearance cap on top. Retail's oriented
pool of 0 crashes the game; at 1000 it runs and matches (**observed** `effect_oriented`).

## A particle's life

A particle record holds position and velocity in **its appearance's frame**, age, lifespan,
`1/lifespan` (no zero check) and links. Because it is stored relative to the appearance, an animated
appearance transform carries every particle already alive, while an emitter's transform reaches
only new births. **decomp** `SpawnListParticle`.

An appearance's update, every list kind alike. **checked** `alchemy!0x6216420`, `0x62188c0`:

```
age(appearance) += dt; no feed and no particle: flag dead
drop fields that are dead; each live field: prepare against this appearance
every particle: every field, in link order, may change v (and the dust field, age)
every particle: age += dt
    age > lifespan: removed
    else:           p += v · dt                       ; with the velocity the fields just set
```

- **Integration is semi-implicit Euler**: fields first, then the position with the new velocity.
- **Fields run over every particle before any is aged.**
- **A lifespan of 0 or less** gives a particle that is drawn in its birth frame and removed at its
  first update. This library births none, by its own rule.
- Within an appearance, births append at the tail and the draw walks from the head, so particles are
  kept oldest first. `FLBeamAppearance` pushes on the front; see [APPEARANCES.md](APPEARANCES.md).

## Fields

### The interface

Each field has an update, a prepare and an apply. **decomp** `src/alchemy/alchemy_fields.cpp`:

- **update(dt)** ticks and samples the curves at the new age, then caches what apply needs.
- **prepare(appearance)** computes `F = inverse(appearance world) · field world`, rotation **with
  scale**, and moves its cached target into the appearance's frame.
- **apply(particle)** is handed position, velocity and a pointer to the particle's **age**.

`k = min(4 · Approach · dt, 1)`, clamped at the top only, wherever an approach appears.
**checked** `alchemy!0x6214317`–`0x621433c` (air), `0x62364eb` (radial); constant `0x624ca50` = 4.
A negative approach is kept: `k` goes negative and drives the velocity away from the target, so a
positive magnitude attracts and amplifies. Retail never does it; authored effects do.

### Arithmetic and defaults

| Field | Per particle | Defaults | Evidence |
| ----- | ------------ | -------- | -------- |
| `FxGravityField` | `v += F · (0, −Gravity · dt, 0)`, with the field's own `dt`. Accumulates: there is no approach | `Gravity` 9.8 | **checked** `alchemy!0x62235c0`, `0x6223600`, `0x62236e0`, `0x6223408` |
| `FxAirField` | `v += (F · (0, Magnitude, 0) − v) · k`. Overrides at a high approach | `Approach` 1, `Magnitude` 1 | **checked** `alchemy!0x62142c0`, `0x6214430`, `0x62140c2` |
| `FxTurbulenceField` | Four fresh draws per particle per frame: `u` = normalized `(2(r−½), 2(r−½), 2(r−½))` drawn **y, x, z**, `s = r`; `v += (u · s · Magnitude − v) · k`. No noise field: white noise smoothed by the approach | `Approach` 1, `Magnitude` 10 | **decomp** `FxTurbulenceField::ApplyFieldToVel`; defaults **checked** `alchemy!0x623d562` |
| `FxRadialField` | `D = p − origin`, `x = min(|D| / max(Radius, 0.001), 1)` with a true square root; `v += (D · Magnitude · Attenuation(sparam, x) − v) · k` | `Magnitude` 10, `Approach` 0.3, `Radius` 50 | **checked** `alchemy!0x6236450`, `0x6236610`, `0x6235fe1` |
| `FxCollideField` | An unbounded plane through `F · (1, 0, 1)` with normal `F · (0, 1, 0)` normalized; below | `Reflectivity` 0.7, `Width` and `Height` 10, never read | **decomp** `FxCollideField::ApplyFieldToVel`; defaults **checked** `alchemy!0x6219aec` |
| `FLDustField` | Writes the age; below | `SphereEmitter_MaxRadius` 60.1 | **decomp** `FLDustField::ApplyFieldToVel`; default **checked** `alchemy!0x62128c3` |
| `FLBeamField` | Nothing. Its prepare and apply return at once; a beam reads its transform | | **decomp** |

Things each of these would tempt someone to fix:

- **Radial:** the displacement is not normalized, so the target speed grows with distance and
  `Magnitude` is a rate. **Nothing is cut off at `Radius`**: `x` clamps at 1 and a particle beyond
  is pushed at the attenuation's last key. The attenuation is a curve over normalized distance, and a
  negative key turns the push into a pull. Positive magnitude pushes outward.
- **Turbulence** takes four draws from the global stream per particle per frame, so it is
  frame-rate dependent and moves every later spawn's draws.
- **Collide**, with `s = v · dt` (the field's `dt`) and `n` the unit normal:

  ```
  start = (p + 5n − point) · n;  end = (p + s − point) · n
  start < 0, or s · n < 0, or end > 0: nothing
  t = start / (start − end);  p = (p + 5n) + t · (s − 5n)
  |v| ≤ 0.001: stop, the position already moved
  v = Reflectivity · (v − 2(v·n)n);  p −= (1 − t) · dt · v
  ```

  So it acts only on particles within five units **behind** the plane, moving toward it, that this
  step would not carry through; one fast enough to cross in a step goes through, and anything in
  front is untouched. A slow one is put on the plane with its velocity unchanged. `Width` and
  `Height` are never even sampled. **decomp**; the 5 and 0.001 **checked** `alchemy!0x624d160`,
  `0x624d168`.
- **Dust** holds a population rather than pushing one. With the field's **world** matrix `W` and
  radius `R`:

  ```
  q = Wᵀ · (p − W.translation)
  |q|² > R²: age = FLT_MAX                       ; the ageing that follows removes it
  fade = 1, or for q.z < 0 and |q|² > 0.8R²: 1 − (|q|² − 0.8R²) / 0.2R²
  age = 10 · (1 − (R − q.z) / 2R) · fade
  ```

  A dust particle lives exactly as long as it stays inside the sphere, and its curves are keyed on
  where it sits along local +Z, faded at the back rim. It uses the world matrix where every other
  field uses `F`, which agrees only while the appearance's frame is the world's, and the transpose,
  which agrees only while the field is unscaled. A radius of 0 kills everything. A flag that would
  subtract `dt` from the written age has no writer. The node's `0xE63AA248` and
  `ParticleApp_UseDynamicRotation` are never read. Constants **checked** `alchemy!0x624c6fc` (0.8),
  `0x624c6f8` (10).

## Sub-effects: `FxParticleAppearance`

This appearance draws nothing; each particle is an effect. **checked** `alchemy!0x622f6a0` (birth);
**decomp** `src/alchemy/alchemy_appearances.cpp` `FxParticleAppearance::Pad5`,
`ComposeNodeTransform`, and `IntegrateRecord` for the rest.

- **Birth.** The particle pool's oldest is evicted first if the pool is full. No `LifeName`, or a
  name no loaded library defines: no particle. Otherwise the life effect is made **with this
  appearance as its parent**, so its top-level nodes join this appearance's children, sorted by class
  among them, and are updated by the parent effect's walk, not by a clock of their own. The child
  takes this appearance's `sparam` only if it is not 0, and its LOD key only if it is not 1, which
  are the child's defaults anyway. **checked** `alchemy!0x622f71a`–`0x622f84e`.
- **Setting `sparam` or the LOD** on this appearance forwards the value to every particle's life
  and death effect, so children follow the parent from then on. **decomp**.
- **Each update**, for a particle still alive: `age += dt`; if still alive, `p += v · dt` by its own
  integration and the life effect is placed. On the frame it dies, the life effect is stopped
  (`+0x34(1)`: every emitter killed) unless it has already finished (`+0x2c(7)`).
- **A dead particle is kept** until its life effect has finished and its death effect, if any, has
  too, so it still counts against `MaxParticles` and the pool meanwhile. Fields act only on
  particles whose age is below their lifespan.
- **Placement** is `which` 1 with `[R | p]` in this appearance's frame, so the child's root sits at
  `appearance world · [R | p] · local`. Nodes beside the child's root stay in the spawner's frame and
  leave a trail. `R` is identity unless `UseDynamicRotation`: the turn taking +Y onto `v̂` (about
  `Y × v̂` by `acos v̂.y`; when `|v̂.y| ≥ 0.99`, +X onto `v̂` after −90° about Z). With
  `SmoothRotation` too, `R` slerps toward that by `min(|v| · dt, 1)`, or toward identity by
  `dt + 0.01` when `|v| < 0.5`.
- **The death effect** starts at the compose after the particle dies, at its position, unturned,
  with the same `sparam` and LOD forwarding.
- **Finished** for a child means `+0x2c(7)`: no live node but its root. A field that never expires
  therefore keeps its particle, and the spawner, for good. **checked** `alchemy!0x621fa80` (7 returns
  "not finished" at the first live node other than the root).

`FxMeshAppearance` hands each particle to a mesh factory that fails on every request in retail; see
[APPEARANCES.md](APPEARANCES.md).

## Reaching an effect from the game

From an `[Effect]` to an `.ale`: `[Effect] vis_effect` names a `[VisEffect]`, whose `alchemy` is the
file and whose `effect_crc`, the case-sensitive CRC read **signed**, is the whole link into it; no
name is matched. `effect_type` names an `[EffectType]`. The INI side is the host's.

### Each frame

`Freelancer.exe`'s effect pass walks each type's list. For each `ParticleEffect`
(**checked** `Freelancer!0x4f7880`–`0x4f78fc`, `0x4f8a20`–`0x4f8bc7`):

1. **Visibility test.** If it fails and the type is not `EXIST_OFFSCREEN`, the effect is **killed
   now**, particles and all. **checked** `Freelancer!0x4f78a2`.
2. **Run time.** A positive time left counts down by `dt`, and at ≤ 0 the effect is killed. Zero or
   negative never counts. **checked** `Freelancer!0x4f8a57`.
3. **Finished.** `+0x2c(4)`: the effect is killed once **no live appearance** remains besides the
   root. Emitters, fields and folders still alive do not keep it. **checked** `Freelancer!0x4f8a88`,
   `alchemy!0x621fa80` (bit 4 asks `+0x90`, "is an appearance", set only by the appearance
   constructor at `0x624439f`).
4. **Offscreen.** Not visible and the type is not `UPDATE_OFFSCREEN`: stop here. **The Alchemy
   clock freezes and the unseen time is lost.** **checked** `Freelancer!0x4f8ae9`.
5. **Instance.** The Alchemy instance is built on the first update that gets this far, so **an effect
   born unseen with `CULL_UPDATE` starts at t = 0 when first seen.** **checked** `Freelancer!0x4f8b04`.
6. LOD, placement, compose, update, as in [One frame](#one-frame).

### The LOD key

From the type's `lod_type` band, each frame (**checked** `Freelancer!0x42dcd0`, `0x42da00`):

```
band not 1…6:        LOD = 1                      ; EFT_LOD_NONE, never reduced
depth < 1e-5:        LOD = 1
s = camera(+0x2c) · camera(+0x20) · type.radius / depth   ; the type's radius in screen pixels
s ≤ min_screen_size: LOD = 0, and not visible
LOD = clamp((s − min_lod_screen_size) / (max_lod_screen_size − min_lod_screen_size), 0, 1)
```

The bands' three sizes are `[EffectLOD]` in `FX/effects.ini`. `s` uses the type's `radius`, never
the `.ale`'s sphere, and depends on the viewport's width and the field of view. What a band does
to an effect is therefore its own `LODCurve`s evaluated at this value; retail's run from ×2–3 of the
size and a fraction of the rate at 0 to within 2% of ×1 at 1 (measured by the extension).

### When the owner lets go

When the owning object releases a `ParticleEffect` that has an Alchemy instance
(**checked** `Freelancer!0x4f8680`–`0x4f86b0`):

- it is frozen into the world and inherits the parent's velocity;
- **its time left is set to 1 s if it was negative or above 1**, and kept if it was within 0…1;
- `+0x34(1)` kills every emitter, with whatever hangs from each, and leaves what they made to live
  out.

Retail writes `run_time = -1` for every open-ended type, so released particles get **at most one
more second**. A type written with `run_time = 0` gets no limit: it ends only when its last
appearance dies.

## Open

- Whether the 26 rootless effects placed in flight, and the three emitters beside a root, look in
  game as the code says.
- The blunted LOD, the float-bound count and the scaled emitter's `s²` path are read from the
  arithmetic, not observed.
- A folder whose `flags` is neither 0 nor 1, and a nested folder, whose lifespan is read when its
  parent's turn comes: neither occurs in retail, and what the nested one holds at that moment was
  not traced.
- `RadialField_Attenuation`'s default when absent: the constructor builds an eased list from 1.0 and
  0.001 (`alchemy!0x623613c`–`0x623618f`) whose shape was not read. Retail always carries it.

## Corrections

What the extension's `docs/renderer/ALCHEMY.md`, `ALCHEMY-DLL.md` and `docs/system/EFFECT-TYPES.md`
held, against what the code does:

| Believed | True | Evidence |
| -------- | ---- | -------- |
| An appearance's `Node_LifeSpan` stops it drawing | Never read for the appearance itself; it dies with no feed and no particle. Its lifespan counts only toward the root folder's | `alchemy!0x6216441` |
| A container's lifespan: "nothing reads it" | The folder ticks and, past the longest lifespan below it, dies with its subtree, particles included | `alchemy!0x6240150`, `0x6201843` |
| A node expires at `time ≥ lifespan` | At `>` | `alchemy!0x6240160` |
| Whether emission stops at `Node_LifeSpan` in the DLL or the host: open | The DLL's walk kills the emitter after the update in which it expires, and that update still emits | `alchemy!0x6245c14`, `0x6201843` |
| A field's `+0x1c` "finished": open | It is the node's dead flag; a dead field is dropped from the appearance's list | `alchemy!0x6245c2f` (same query on an appearance) |
| The appearance applies fields sampled for this step | It applies last frame's, since it updates before its sibling fields; nothing on the first frame | `alchemy!0x6201810`, class keys |
| `D` is a world displacement | It is the world displacement through the transpose of the emitter's matrix; on a scaled emitter the path and bias come out `s²` times | `x86math!0x6f71950` |
| Spawns and draws use matrices sampled after the step | Composed before the update, at the age before this `dt` | `Freelancer!0x4f8bb8`, `0x4f8bc7` |
| The game places with `0` "which reaches the root the same way" | `0` sets the world outright and skips the node's own transform and parent; same for a root folder, different for every rootless effect's top-level nodes | `alchemy!0x62400f0`, `0x62401b1` |
| A child effect has no clock of its own and "the runtime updates it" | Its top-level nodes hang under the spawner and the parent's walk updates them | `alchemy!0x622f73d`; **decomp** |
| Which of two appearances an emitter draws through: unsettled | The last `Pair`; the first keeps a feed count forever | `alchemy!0x6245b50` |
| `dacom.ini`'s pool sizes are a vertex budget not worth adopting | A full pool evicts its oldest particle across all effects of the game | **decomp** `SpawnListParticle`; **observed** `effect_pool` |
| A collide field reflects whatever it catches | Under 0.001 of speed it puts the particle on the plane and leaves the velocity alone | **decomp** `FxCollideField::ApplyFieldToVel`, `0x624d168` |
| `ParticleEffect` ends when "Alchemy reports every node finished (`+0x2c(4)`)" | `+0x2c(4)` asks only whether any appearance is alive | `alchemy!0x621fa80`, `0x624439f` |
| On release, time left is clamped to (0, 1] | Negative or above 1 becomes 1; 0…1 is kept, and an exact 0 never expires | `Freelancer!0x4f8680` |
