# THORN: how `thorn.dll` plays a THN script

`thorn.dll` is the engine that runs a `.thn` script: the clock, every event, the parameter curves,
the spline paths. It renders nothing and loads nothing. Each entity is a proxy for an object the host
(`Freelancer.exe`) owns, reached through DACOM control interfaces the host implements. This page says
what thorn computes and in what order, and what it hands the host. What the names in a script mean
is [`freelancer/docs/refs/THORN.md`](https://github.com/treewyrm/freelancer/blob/main/docs/refs/THORN.md); what the game does
on its side of the contract (what it loads, how it lights, fogs, animates and sounds an entity, and
which scripts play together) is [THN-HOST.md](THN-HOST.md). This library's engine is
[`src/thorn/`](../../src/thorn/): the clock in [`playback.ts`](../../src/thorn/playback.ts), the events
in [`events.ts`](../../src/thorn/events.ts).

Addresses are image VAs: `thorn.dll` at `0x6f20000`, `x86math.dll` at `0x6f70000`,
`Freelancer-original.exe` at `0x400000`, `engbase.dll` at `0x6600000`. Decomp paths are under
`../freelancer-decomp/src/`. Evidence marks: **checked** (read in the retail binary), **decomp**
(agrees in the decomp, binary not read), **unsettled**.

## Conventions

**Frames are `x86math.dll`'s `[R | t]`**, a row-major 3×3 with the translation 36 bytes in, applied
as `R·v + t`. `A · B` applies `B` first. Thorn never calls the general inverse; it builds
`inverse([R | t]) = [Rᵀ | −Rᵀt]` by hand: `Rᵀv`, negate, transpose (checked `thorn.dll!0x6f47d3b`–
`0x6f47d6d`). This library's `Matrix4` is the same convention ([`frame.ts`](../../src/thorn/frame.ts)).

**An entity's `orient` triples are the columns of `R`**, its local X, Y and Z axes in scene space.
The parser stores `orient[1]` at record `+0x14, +0x20, +0x2c`, `orient[2]` at `+0x18, +0x24, +0x30`,
`orient[3]` at `+0x1c, +0x28, +0x34`: down the columns of a row-major matrix (checked
`thorn.dll!0x6f29e2b`, `0x6f29f1a`, `0x6f2a007`). That is the **transpose** of a hardpoint's nine
floats on disk. A reader that takes `orient` the way it takes a hardpoint rotates every entity
backwards.

**Quaternions are `{w, x, y, z}`** in `path_data` and `q_orient` alike, the Lua order unchanged.

**Every "slerp" in thorn is a normalised lerp** (`x86math` `+0x58`): with `a·b ≥ 0`,
`normalize(a + (b − a)t)`, else `normalize(a − (a + b)t)`, the second being `b` folded onto `a`'s
hemisphere (checked `x86math.dll!0x6f724d0`). [`nlerp`](../../src/thorn/frame.ts).

**Scene space.** Thorn keeps a scene frame `S` (the engine's own `IGeoTransformControl`). Setting an
entity's position hands the host `S·p`, its orientation `S.R·R`; reading one back undoes `S`; a frame
the host returns for a hardpoint is taken out of world by `inverse(S)`. **In the game `S` is the
identity**: the interface's name string is referenced only from the exe's two QueryInterface tables
(`0x5cca38`, `0x5dc2a8`), never from code (checked `Freelancer-original.exe`). The host keeps its own
scene frame `C` instead and each host class decides whether to apply it ([THN-HOST.md](THN-HOST.md)).
Everything below is in thorn's scene space, which is world wherever `C` is the identity.

**Time is integer milliseconds.** The parser multiplies `time` and `duration` by the double 1000.0
and truncates with `_ftol` (checked `thorn.dll!0x6f25400`–`0x6f2540e`, `0x6f2576d`–`0x6f2577b`), so
`1.9999` is 1999 ms. The product is rounded at the x87's precision, which Direct3D 8 leaves at 24
bits because `dacom.ini` has `FPU_PRESERVE` off; so `1.001 s` is 1001 ms, where a double product would
give 1000 (decomp `src/Thorn/ThornLua.cpp` `LuaMillisecondsToRetailInt`, `src/RP8/RP8.cpp`).
[`milliseconds`](../../src/thorn/events.ts) is `trunc(fround(s · 1000))`.

## The event descriptor

The parser fills one descriptor per `events` entry and the event's init copies it to `event+0x28`.
The fields that change behaviour:

| Field | What thorn does with it |
| ----- | ----------------------- |
| `flags` | Bit 1 (`USE_SCRIPT_DURATION`) is set **when `duration` is nil** (checked `0x6f25760`). A `flags` key then **overwrites the whole word** (checked `0x6f257c9`). So the bit is set when the event has neither key, or when `flags` names it |
| `duration` | ms; 0 when nil (checked `0x6f2577b`) |
| `event_flags` | copied, read by no thorn method; the host reads it on motions and IK ([THN-HOST.md](THN-HOST.md)) |
| `param_curve`, `pcurve_period` | the progress curve; the period is `_ftol` of the value, **milliseconds, no ×1000**, default −1 (checked `0x6f258b7`) |

**The end.** Most events set it at Start: `−1` (never) when flag bit 1 is set, else `start + duration`
(checked: attach `0x6f478fc`, connect `0x6f48324`, path `0x6f45160`). So an event with `flags` and no
`duration` ends at its own start: it updates once and finishes. **`START_PSYS` is the exception**: its
init sets `end = start + duration` with no flag test (checked `0x6f48740`), so a `START_PSYS` without
`duration` ends at its first update.

**Rewrites before the per-action switch** (checked `0x6f258c0`–`0x6f25942`; decomp
`src/Thorn/ThornLua.cpp`):

- A `START_PATH_ANIMATION` whose **second** target is an entity of type 1 to 8 (`COMPOUND`,
  `DEFORMABLE`, `CAMERA`, `MONITOR`, `LIGHT`, `SOUND`, `MARKER`, 8) **becomes an `ATTACH_ENTITY`** and
  is parsed by the attach case. On a `SCENE`, `MOTION_PATH` or `PSYS` it stays a path animation.
- `START` (action 23, registered, used by no retail script) becomes `START_SOUND` when its first target
  is a `SOUND`, `START_MOTION` otherwise.
- A `START_SOUND` whose `flags` has bit 2 **ORs 2 (`SPATIAL`) into its sound entity's record flags**
  through `IScriptEngine +0x94` (`UpdateEntityFromDesc`), so the sound becomes 3D. Every `START_SOUND`
  then has bits 2 and 4 cleared from its own flags. No retail script sets bit 2 on a sound.
- A `START_IK` at time 0 starts at **1 ms** (checked `0x6f25962`), after the motions at 0.

**The factory refuses** `SET_CAMERA`, a path animation, an attach, a connect and an IK without a second
target (checked: byte table `0x6f3a1e8`), and any event whose second target names no entity.

**The master list is ordered by start**: each event is inserted after those with an equal start, then
the whole list is `std::sort`ed by start once loading ends (checked `0x6f3833f`). VC6's `std::sort`
uses insertion sort for 16 elements or fewer and median-of-three partitioning above that. **In a
script with more than 16 events, events with the same start can start in an order other than script
order.** Start order decides which of two attaches on one child wins (below).
[`retailSort`](../../src/thorn/playback.ts) reproduces it.

## The clock

**The engine only moves forward by a delta** (`IScriptEngine +0x68`, the tick). It has no "evaluate at
time T". One tick by `dt` ms (checked `thorn.dll!0x6f39820`):

1. `new = now + dt`. A **negative** `dt` rewinds: every active event is finished, the clock is set to
   0, and the pending list is refilled from the master list. `new` is `max(now + dt, 0)`, and the
   steps below then replay from 0 up to it. **No entity transform is restored**: the replay starts
   from whatever the last play left.
2. If `new < now` (unsigned), stop. A tick runs only in states 5 to 7, and **5 is paused**: the pause
   slot only sets it (checked `0x6f397f0`), so a paused engine still ticks. A host pauses by not ticking.
3. **Start every pending event whose start is in `[now, new]`**, in master order (`0x6f3a960`). Before
   each one, update every active event at each pending end time before its start, then once at its own
   start instant (once per distinct instant). Then call its `Start`. A `Start` that returns true joins
   the active list and its end joins a sorted list of end times. The active list is reordered after
   every start, whether or not it succeeded.
4. **Flush end times** before `new`: an update of every active event at exactly each one
   (`0x6f399be`–`0x6f39a1d`).
5. **Update every active event at `new`** (`0x6f39a22`).
6. **Advance every host control again, by 0 ms** (`0x6f39a27`–`0x6f39a31`, skipped when the clock is
   0). For an effect, this is what hands it the frame this tick's events wrote ([PSYS](#psys)).
7. **Past the end**, `new > duration` (strict, unsigned; `0x6f39a36`): a looping script stops and
   restarts at **0**, ticking 0 ms, so **the overshoot past its duration is dropped** (stop slot
   `+0x5c` zeroes the clock, then start slot `+0x58` is called with it; checked `0x6f39a42`–`0x6f39a55`,
   `0x6f39460`). Otherwise every active event is finished, a running `START_PSYS` killed with it, and
   the state becomes 4, done (`0x6f39a63`).

**An update at instant `t`** (checked `0x6f3b400`) first advances each `COMPOUND`'s, `DEFORMABLE`'s
and `PSYS`'s host control by `t − last` (`0x6f3b330`: `ICompoundControl +0x18`, `IPSysControl +0x14`;
a sub-scene's `IScriptControl +0x10`), then calls each active event's `Update(t)` in active order. An
event whose `Update` returns false is finished (`Finish`) and removed. `Update` returns
`now < end || end < 0`.

**A forward jump is exact.** However large `dt`, every start and end inside it is visited at its own
instant, in order, so one jump from 0 to `T` reaches the state any sequence of smaller ticks reaches,
for everything thorn computes. What the host advances by `dt` sees the sub-steps too. So a scrubbable
evaluator reproduces thorn's **first play** by replaying from 0 with those breakpoints, from the
entities' `spatialprops`. A rewind does not reproduce it: step 1 restores nothing, so `rel`, `LOOK_AT`
and any entity no event drives start from leftover state. [`replay`](../../src/thorn/playback.ts)
gives the first play, as the game starts a script: start, tick 0, one jump.

**Update order within one instant** (checked `0x6f3aa00`, `0x6f3abe0`), rebuilt after every start:

- The active events are grouped by **first target** (the entity acted on). Groups are walked in
  ascending entity id (a `std::map`).
- Each group is `std::sort`ed by action number: insertion sort, stable, for 16 or fewer
  (`0x6f40290`); above 16, median-of-three partitioning (`0x6f3ff50`, chosen at `0x6f3ac0c`), which
  can reorder equal action numbers.
- Before emitting an event with a second target, the walk **emits the second target's group first**
  (`0x6f3ac86`–`0x6f3acc3`), with a visited flag against cycles.

For an attach the second target is the parent, so **every parent is updated before its children in
the same instant, however long the chain**, and chained attaches resolve with no frame of lag. On one
entity, a path animation (6) or spatial animation (7) runs before an attach (8), a motion (10) or IK
(11) after it.

## `ATTACH_ENTITY`

Keys and defaults are in [THORN.md](https://github.com/treewyrm/freelancer/blob/main/docs/refs/THORN.md#what-attach_entity-does):
`offset` (zero, also when any component is nil), `target_type` (`ROOT`), `up` (`Y_AXIS`), `front`
(`NEG_Z_AXIS`), `target_part`. Implemented in [`attach`](../../src/thorn/events.ts).

**The parent frame `P`**, computed the same way at Start and every Update (checked `0x6f47c5f`–
`0x6f47d95`):

1. `P = [parent.R | parent.t]`, the parent's current frame.
2. **Only if** `target_part` is non-null **and** `target_type` is not `ROOT` **and** the parent is a
   `COMPOUND` or `DEFORMABLE` with an `ICompoundControl`: call `ICompoundControl +0x24(target_type,
   target_part, &P)`, ignore its return, take what it wrote as world and apply `inverse(S)`. A lookup
   that writes nothing leaves `P` the parent's own frame. What the host writes is
   [below](#the-hardpoint-and-part-frame).

So a `ROOT` attach, or one whose parent is a marker, camera, light or `PSYS`, uses the parent's own
frame, and a `target_part` beside `ROOT` is ignored.

**Start** (checked `0x6f478f0`) sets the end, then records `rel = inverse(P) · child`, **whatever the
flags**: the guard `(flags & 64) | 0x80` is never zero (`0x6f47914`). It writes no transform.

**Update** (checked `0x6f47c30`–`0x6f4801a`):

```
P = the parent frame, now
if PARENT_CHILD (64):
    W = P · rel
    POSITION (2)     → child.t = W.t
    ORIENTATION (4)  → child.R = W.R
else:
    o = ENTITY_RELATIVE (32) ? P.R · offset : offset
    POSITION         → child.t = P.t + o
    ORIENTATION      → child.R = ORIENTATION_RELATIVE (128) ? P.R · rel.R : P.R
    else LOOK_AT (8) → d = (P.t + o) − child.t        ; child.t read back after the write above
                       if |d|² ≠ 0: child.R = lookAt(d, front, up)
return now < end || end < 0
```

Position is written before orientation, each through the entity's setter and on to the host.

| Flag | Bit | Effect |
| ---- | --- | ------ |
| `USE_SCRIPT_DURATION` | 1 | never ends; read only for the end |
| `POSITION` | 2 | writes the position every update |
| `ORIENTATION` | 4 | writes the orientation every update |
| `LOOK_AT` | 8 | aims the child at the parent plus `offset`, **only when `ORIENTATION` is clear** |
| — | 16 | read by no attach method |
| `ENTITY_RELATIVE` | 32 | `offset` in the parent's axes rather than scene axes; affects `POSITION` and `LOOK_AT` only |
| `PARENT_CHILD` | 64 | rigid: the child keeps the offset it had **at Start**. `offset`, `ENTITY_RELATIVE`, `ORIENTATION_RELATIVE` and `LOOK_AT` are ignored |
| `ORIENTATION_RELATIVE` | 128 | with `ORIENTATION`, without `PARENT_CHILD`: the child keeps its starting rotation relative to the parent. Inert otherwise |

**`up` and `front` are read only by `LOOK_AT`** (checked `0x6f47fe1`–`0x6f47ffe`). The near-universal
`up = Y_AXIS, front = NEG_Z_AXIS` is no extra rotation because no other combination builds a rotation
from them, not because it is an identity.

**Timing.** Before its start an attach does nothing. From its start it rewrites the child at every
update: at every event start and end instant and at the end of each tick. At its end it writes once
more, at exactly `start + duration`, then finishes; **Finish does nothing** (`xor al, al`,
`0x6f4a5b0`), so the child keeps its last transform: no snap back, no detach. **Several attaches on
one child** run in start order and each writes what its flags select, so the latest-started wins any
component two of them write.

### `LOOK_AT`

`lookAt(d, front, up)` (`thorn.dll!0x6f2e440`) returns the rotation `R` with `R·A(front) = f`,
`R·A(up) = u` and `det R = +1`, where `A(k)` is the unit axis `X, Y, Z, −X, −Y, −Z` for 0 to 5:

```
f = normalize(d)
U, F = the SCENE entity's up and front axes
if |U · f| > 0.99:   s = −σ(front)·σ(up) · normalize(W − (W·f)f),  W = U × F,  u = s × f
else:                u = normalize(U − (U·f)f)
```

The child's `front` axis points at the target and its `up` axis leans toward the scene's up. Within
about 8.1° of the pole the side reference switches to `W`. The 0.99 is a double compared to
`|U·f|` (checked `0x6f2e674`–`0x6f2e681`). A null scene-axis pointer or the value 6 means
`U = Y`, `F = Z` (checked `0x6f2e4e2`–`0x6f2e509`). Retail SCENEs all say `up = Y_AXIS,
front = Z_AXIS`, so `U = Y`, `W = X` throughout. The formula is the old reading's model, fitted under
emulation to all 24 `front`/`up` pairs; this library's [`lookAt`](../../src/thorn/frame.ts) agrees
with it to 4e-15 over 96,000 directions including the pole band (checked numerically, this pass).
`d = 0` would give NaN, which is why the attach tests `|d|²` first.

## The hardpoint and part frame

`ICompoundControl +0x24(target_type, target_part, &frame)` is the host's. Attach, spatial animation,
floor-height animation and IK call it. The incoming frame is never read; thorn ignores the return
value. [`Playback.part`](../../src/thorn/playback.ts).

**On a compound** (checked `Freelancer-original.exe!0x451b90`):

| Request | Writes |
| ------- | ------ |
| `HARDPOINT`, found | `W_part · H`: `H` the hardpoint's `[R \| t]` on the part that owns it (`HardpointSummary::get_info`), `W_part` that part's frame from `IEngine +0x90`/`+0x98`, composed as `R = W.R·H.R`, `t = W.R·H.t + W.t`. **`C` is not undone**, so this is world |
| `HARDPOINT`, not found | nothing; returns −1. `P` stays the parent's own frame |
| `ROOT`; `PART` named `root` or `""` (`stricmp`) | the root instance's frame from `IEngine +0x90`/`+0x98` |
| `PART`, null name | nothing; logs *"Petal bug: … target_name = <null>"*, returns `S_OK` |
| `PART`, any other name | nothing; logs *"Thorn requested a sub_part for which the implementation is not written"*, returns `S_OK` |

The name lookup is `HardpointSummary::find_name`, which compares with `_stricmp`, so
`HpEngine02` and `hpengine02` are one hardpoint, and the last duplicate wins (old reading,
`common.dll!0x63346c9`, `0x63346d2`; not re-read).

**On a deformable** (checked `0x452730`): `ROOT` is the root bone, `PART` the named bone
(`0x445620`), `HARDPOINT` the skeleton's hardpoint composed as on a compound. A missing name logs and
returns −1. Every branch ends in `Csys::trans_to_frame` through `C` (`0x4529e3`, `0x452a12`), so a
deformable hands back **scene space** while a compound hands back world. They agree when `C` is the
identity, which is every route but a room character's fidget ([THN-HOST.md](THN-HOST.md)).

## `CONNECT_HARDPOINTS`

**Thorn computes nothing for it.** Start sets the end as an attach does and hands the event record to
the **first target's** `ICompoundControl +0x1c`, keeping the event only on `S_OK`; Update only counts
down; Finish passes the same record to `+0x20` (checked `0x6f48320`–`0x6f483b7`). With
`USE_SCRIPT_DURATION` it is never disconnected.

The host finds the part owning `hardpoint` on the object and the part owning `parent_hardpoint` on
the target, both names ignoring case, and calls `IHardpoint +0x18`. For a fixed child hardpoint
`engbase.dll` builds the joint `J = [R_p·R_cᵀ | t_p − R_p·R_cᵀ·t_c] = H_parent · inverse(H_child)` and
links the child part under the parent part with it (`IEngine +0xbc`), so **the two hardpoints
coincide**: `childPart = parentPart · H_parent · inverse(H_child)` (decomp `src/EngBase/EngBase.cpp`
`HardpointConnect`; binary shape agrees at `engbase.dll!0x66268e1`–`0x6626963`). A revolute or
prismatic child hardpoint (info types 1, 2) carries both positions, `R_p·R_c` and the transformed axis
instead (decomp). [`connectedFrame`](../../src/thorn/playback.ts).

Against an attach at a `HARDPOINT`: an attach puts the child's **origin** (plus `offset`) at the
parent's hardpoint and thorn recomputes it every update; a connect puts the child's **hardpoint** on
the parent's, is an engine parent link that lasts until the event ends, and moves a part, the whole
object only when that part is its root.

## PSYS

**The entity** places itself from its `spatialprops` at construction and binds `IGeoTransformControl`,
`IPSysControl` and `IUserEventControl`. Its transform reaches the host as any entity's does: set
position, then set orientation, on every attach update.

**`START_PSYS`** (checked `0x6f48700`–`0x6f487d7`): Start calls `IPSysControl +0xc()` and keeps the
event only on `S_OK`; Update only counts down; Finish calls `+0x10()`. Its end is `start + duration`
whatever the flags ([above](#the-event-descriptor)). Since the host's `+0x10` kills the effect
outright, **`duration` is the effect's whole visible life**, not its emission window.

**`START_PSYS_PROP_ANIM`**: Start reads the current `sparam` back through `IPSysControl +0x1c` as
`from`. Update takes `to` from the event, or from a second target that is a `PSYS` (its current
`sparam`), and sends `from + (to − from)·u` through `+0x18`, `u` the shared
[progress](#progress-and-parameter-curves) (decomp `TickPsysPropAnim`). An event with no `sparam`
does nothing.

**The host, `Thorn_Psys`** (checked `Freelancer-original.exe`):

- Set position and set orientation **only cache** `p` and `R` (`0x453ec0`, `0x453ee0`); `C` is never
  applied.
- The advance `+0x14(ms)` (`0x453ff0`), only while an instance exists: `dt = ms × 0.001`, then effect
  `+0xc(1, [R | p])`, the transform pass `+0x1c(dt)` and the update pass `+0x20(dt)`. `which = 1` is
  the **override** placement, which reaches the effect's control root (see
  [ALCHEMY.md](ALCHEMY.md#placement)).
- Start `+0xc` (`0x453fb0` → `0x557360`) creates a **new** instance of the `[VisEffect]` named by the
  entity's template; an instance already running is abandoned, not stopped. It applies no placement
  and no `sparam`.
- Stop `+0x10` (`0x453fd0` → `0x5574a0`) kills the effect at once.
- `sparam` set `+0x18` (`0x454070`) caches the value and passes it on **only while an instance
  exists**; get `+0x1c` (`0x4540a0`) returns the cache. So an effect always starts at its default
  `sparam`, and a value set before its `START_PSYS` is lost.

Because each update advances controls **before** running events, an advance inside a tick places the
effect with the frame cached at the previous update. Step 6 of the tick then advances every control
by 0 ms, which hands the effect the frame this tick's attaches wrote and runs both passes at
`dt = 0`. **The drawn root is on the current frame**; only what the effect emitted during the step was
placed from the previous one. [`Playback`](../../src/thorn/playback.ts) passes the frame to
`EffectInstance.advance` in the same order.

## Progress and parameter curves

**Every property animation shares one progress** (checked `0x6f48b50`; byte-identical copies per
class). With `el = now − start` in ms:

```
duration == 0          → 1.0
no curve               → el / duration
pcurve_period > 0      → curve((el mod period) / period)      ; signed idiv, rounded to float (0x6f2f810)
otherwise              → curve(el / duration)
```

**Not clamped.** Each class lerps `from + (to − from)·u` itself. Because `pcurve_period` is ms with no
×1000 and defaults to −1, the values `-1000`, `-1` and `0` all mean "over the duration", and a positive
period loops the curve as a sawtooth that never reaches `t = 1`. Retail has curves whose period is at
least the event's length (some are float bit patterns written as integers, `1065353250`): those sit
near `curve(0)` throughout, so the animation **does not move in retail**.
[`progress`](../../src/thorn/curve.ts).

**The curve** is a DACOM object from `param_curve.CLSID`, fed one `(t, v, inSlope, outSlope)` per
`points` row. Every curve starts with the keys `(0, 0, 0, 0)` and `(1, 1, 0, 0)` (checked
`0x6f2ee78`–`0x6f2eea9`). A row at exactly `t = 0` or `1` replaces one; any other in `[0, 1]` is
inserted before the first key at or after its `t`; outside `[0, 1]` it is dropped (decomp
`src/Thorn/ParamCurve.cpp`).

| Class | Evaluator |
| ----- | --------- |
| `FreeFormPCurve` | Hermite with the file's slopes |
| `SmoothPCurve`, `StepPCurve`, `RampUpPCurve`, `RampDownPCurve`, `BumpInPCurve`, `BumpOutPCurve` | Hermite, slopes preset per key pair on every rebuild |
| `CatmullRomPCurve` | uniform Catmull-Rom on the values alone, ends duplicated; **0 outside its first and last keys** |
| `LinearPCurve` | **registered twice**: list linear, and Hermite with linear slopes. Which DACOM returns is unsettled; they differ only at `t ≥ 1` |
| `ThornParamCurve`, `ThornLPCurve` | Catmull-Rom / linear with every value floored at the running maximum |

The Hermite segment, with `s = (t − a.t)/dt`:
`(2s³−3s²+1)·a.v + (s³−2s²+s)·dt·a.out + (3s²−2s³)·b.v + (s³−s²)·dt·b.in`, held at the end values
outside the keys, and `a.v` when `a.out` is the step marker. Presets, `slope = (b.v − a.v)/max(dt,
1e-4)`: Step `a.out = STEP`; Linear `a.out = b.in = slope`; Smooth both 0; RampUp `(0, 2·slope)`;
RampDown `(2·slope, 0)`; BumpOut `a.v ≤ b.v ? (2·slope, 0) : (0, 2·slope)`; BumpIn
`a.v < b.v ? (0, 2·slope) : (2·slope, 0)` (decomp `ApplyHermiteTangents`, `Hermite1D`; the old reading
emulated them to 1e-6). So **retail's commonest curve, `[[0,0,0,0],[1,1,0,0]]`, is a smoothstep**:
0.028 at 0.1, 0.5 at 0.5. [`createCurve`](../../src/thorn/curve.ts).

## `MOTION_PATH` and `START_PATH_ANIMATION`

### The path

The entity parser creates the DACOM class `path_type` names (`CV_CROrientationSplinePath` in retail)
and hands it `path_data`. Format: [THORN.md](https://github.com/treewyrm/freelancer/blob/main/docs/refs/THORN.md#pathprops).

- **Closed only when the string starts `CLOSED`** (`strncmp` against `"CLOSED"`, checked
  `0x6f35778`–`0x6f357a3`). Tuples alternate `{x,y,z}`, `{w,x,y,z}`. **Fewer than two keys fails the
  load** and every animation on the path does nothing (decomp; `0x6f358fb`).
- The ends: open `P[0] = P[1]`, `P[n+1] = P[n]`; closed `P[0] = P[n]`, `P[n+1] = P[1]`, `P[n+2] = P[2]`.
  Quaternions are not wrapped, and a closed path's last one is never written (decomp
  `src/Thorn/SplinePath.cpp`). No retail path is closed.
- **The path is an ordinary entity**, placed from its `spatialprops`, and the animation re-reads its
  frame at every update, so whatever moves a path (an attach, a spatial animation, another path)
  carries everything riding it.

**Evaluation** (decomp `SplinePath.cpp`; 16 samples per segment, step 0.0625, checked
`0x6f21ff9`–`0x6f22000`; the old reading emulated it to 1e-6):

```
cr(p0,p1,p2,p3,s) = ½(2p1 + (p2−p0)s + (2p0−5p1+4p2−p3)s² + (3p1−p0−3p2+p3)s³)
c[k][j] = cr(P[k−1], P[k], P[k+1], P[k+2], j/16)              ; segment k, j = 0..16
T[k][j] = chord length from the start to c[k][j] / total chord length
position(u)    = u ≤ 0 → P[1];  u ≥ 1 → P[last];  else lerp between the two samples around u
tangent(u)     = lerp of the unit Catmull-Rom tangents at those samples; not renormalised
orientation(u) = u ≤ 0 → Q[1];  u ≥ 1 → Q[last];  else nlerp of squad at those samples
```

- **The parameter is normalised chord length over the whole path**, and travel between samples is
  linear, so an object moves at constant speed along a polyline of `16·(n − 1)` chords. A two-key path
  is a straight line.
- **The tangent points toward increasing `u`, in the path's axes**, and does not turn round when an
  animation runs `1 → 0`. Retail scripts that run a `LOOK_AT` path backwards pick `front = Z_AXIS`
  for that reason.
- The squad's log/exp intermediates get no hemisphere fold.

[`createPath`](../../src/thorn/path.ts).

### The animation

`start_percent` (default 0) and `stop_percent` (default 1) are **fractions**. Start computes
`scale = stop − start` and the end, and writes nothing (checked `0x6f45160`). Its progress is its own
(checked `0x6f454f0`):

```
scale == 0  → 1.0                         ; tests the span, not the duration
f = el / duration, or the curve exactly as in the shared progress
return start_percent + scale · f          ; unclamped; duration 0 divides by zero
```

**Update** (checked `0x6f451a0`–`0x6f454bd`), `[Rp | tp]` the path entity's frame **now**:

```
p, R = the object's current position and orientation
POSITION     → p = Rp · (position(u) + offset) + tp         ; offset in the path's axes
ORIENTATION  → R = LOOK_AT ? lookAt(Rp · tangent(u), front, up)   ; no |d| guard
                           : Rp · R(orientation(u))
set orientation R, then set position p                       ; both, always
```

`LOOK_AT` without `ORIENTATION` does nothing; `ENTITY_RELATIVE`, `PARENT_CHILD` and
`ORIENTATION_RELATIVE` are not read. Without a curve the last update lands at `u = stop`; with a
periodic curve it lands at `curve((duration mod period)/period)`, so a path animation whose period is
longer than its event never reaches its end. [`pathAnimation`](../../src/thorn/events.ts).

## The camera

**Camera and monitor are one class**, told apart by type. Thorn keeps four slots in the order
`{fovh, near, far, aspect}`, filled from `cameraprops` (defaults 60, 0.1, 100000, 1.3333). Its setter
pushes all four to `ICameraControl`. `fovh` is passed raw; the host reads it as degrees
([THN-HOST.md](THN-HOST.md)).

**`SET_CAMERA(monitor, camera)`** does everything in Start, which **returns false** (checked
`0x6f44ec0`–`0x6f44fab`): the event is never active and its `duration` means nothing. It links the
monitor to the camera (dropping the monitor's previous links), refreshes the camera's slots from its
host, and copies the slots, position and orientation onto the monitor. **The link is live**: the
camera's position, orientation and slot setters forward every later write to each linked monitor
(decomp `MonitorLinks`; old reading `0x6f414a6`, `0x6f414e6`, `0x6f415ba`). So after a cut every
attach, path, spatial or camera animation on the camera moves the monitor in the same update. A
monitor follows the camera of the last `SET_CAMERA` that named it.

**`START_CAMERA_PROP_ANIM` reads its keys by position.** The parser walks the table
`fovh, aspect, near, far` (checked `0x6f5e148`) into the event's slots 0 to 3 with mask bits 1, 2, 4, 8
(checked `0x6f26910`–`0x6f26993`). Update lerps event slot `k` into the camera's slot `k` (checked
`0x6f461c0`–`0x6f46377`), and the camera's slots are `{fovh, near, far, aspect}`. So **`aspect` writes
the near plane, `near` the far plane, `far` the aspect**; only `fovh` lands where its name says.
Retail's animations that set `aspect` use values 0.1 to 10, and the four that set all four keys carry
`near = 1000`, `far = 1.85`: authored against the shifted order. `from` is the target camera's slots
at Start. A second target that is a `CAMERA` (type 3, not a monitor) supplies `to` from its live
slots, which then line up slot for slot. [`cameraAnimation`](../../src/thorn/events.ts).

## `START_SPATIAL_PROP_ANIM`

The mask is 1 `pos`, 2 orientation (`q_orient` in `{w,x,y,z}` order, or an `orient` matrix read as
columns), 4 `axisrot` (angle in **degrees**, axis default `Y_AXIS`). Start zeroes `last` and
`applied`. **Update** (checked `0x6f46a40`–`0x6f470b7`):

```
u = progress(now)
frac = u == last ? 0
     : u ≥ 1     ? 1                                    ; last not updated
     : 1 − last == 0 ? 1                                ; last = u
     : (u − last) / (1 − last)                          ; last = u
cur = the entity's position and orientation, read now
target = the event's pos and q_orient, or a second target's live frame
if mask & 1:  set position  cur.t + (target.t − cur.t) · frac
if mask & 2:  set orientation  nlerp(cur.q, target.q, frac)
if mask & 4:  d = u·angle − applied;  applied = u·angle
              X, Y, Z:     R = Rot(d°, scene axis) · cur.R
              −X, −Y, −Z:  R = cur.R · Rot(d°, own axis)       ; same sign
              set orientation R
```

- **Absolute targets, chased by the share still left.** Each update moves the *current* value the
  fraction of the remaining way. Alone on an entity, position comes out exactly `lerp(p0, target, u)`.
  Composed nlerp steps are not one nlerp, so orientation stays on the arc and arrives at `u = 1` but
  is slightly behind a single nlerp in between, by an amount that depends on the step schedule
  (old reading: 90° is 43.2° turned at `u = 0.5`, inferred).
- **A second target replaces the numbers**: the entity chases that entity's live position and
  orientation; the mask still picks which halves are written. With `target_type` and `target_part` on
  a compound or deformable target, the target is the [hardpoint or part frame](#the-hardpoint-and-part-frame)
  instead, written over an identity frame at the origin, so **a lookup that misses chases the scene
  origin**, unlike an attach, whose miss leaves the parent's frame (checked `0x6f46c2d`–`0x6f46d51`).
- **`axisrot` is relative and incremental**: `u·angle` degrees in total, on top of whatever the
  orientation is at each update. `Rot` is the right-handed rotation (`[[1,0,0],[0,c,−s],[0,s,c]]` for
  X), radians by `0.017453292` (checked `0x6f46eed`–`0x6f46fd7`, jump table `0x6f470ec`). The positive
  axes turn about the scene's axis through the entity, the `NEG_` axes about the entity's own axis,
  **with the angle's sign unchanged**.
- **`axisrot` overrides the chase's orientation**: it starts from the orientation read before this
  update's own mask-2 write (`+0xe8`), so an event with both bits keeps only the turn.
- An axis outside 0 to 5 writes the orientation back unchanged.

[`spatialAnimation`](../../src/thorn/events.ts), [`axisTurn`](../../src/thorn/frame.ts).

## Light, fog and audio animations

**`START_LIGHT_PROP_ANIM`**: `from` is the light's state read back from its host at Start. Each masked
field lerps by the shared progress, unclamped: the three D3D colours per channel, the attenuations,
range, Theta and Phi in radians, `direction` component-wise **without renormalising**, `color`
truncated to ints (`_ftol`, checked `0x6f45cfa`–`0x6f45d4b`). **`type`, `infinite` and `on` switch
only at `u ≥ 1`** (checked `0x6f45b25`, `0x6f45d57`, `0x6f45e12`), so a `duration = 0` event flips them
at its start. A second `LIGHT` target supplies `to` from its live state (decomp `TickLightPropAnim`).
On a `SCENE` target it animates the ambient through `ILightControl`, which the game does not implement:
nothing. What a light block holds and how the host uses it is [THN-HOST.md](THN-HOST.md).
[`blendLight`](../../src/thorn/light.ts).

**`START_FOG_PROP_ANIM`**, always on the `SCENE`: `from` read back through `IFogControl +0x30` at
Start; start, end and density lerp, `fogcolor` lerps truncated to ints, and `fogon`, `fogtable`,
`fogmode` switch at `u ≥ 1` (decomp `TickFogPropAnim`). **Nothing pushes the scene's initial ambient
or inline fog**; the host reads both from the record. [`blendFog`](../../src/thorn/light.ts).

**`START_SOUND`**: `start_time` is **`_ftol` of the value with no ×1000, integer milliseconds**
(checked `0x6f2607c`–`0x6f2608a`), unlike `START_MOTION`'s float seconds. Start hands the record and
the tick's `now` to `ISoundControl +0xc`; Finish calls `+0x10`. `LOOP` is 8.
**`START_AUDIO_PROP_ANIM`**: `from` read back at Start; the masked `audioprops` fields lerp by the
shared progress (`ain`, `aout` truncated); all eight are sent every update (decomp).
[`sound.ts`](../../src/thorn/sound.ts).

## Motion, IK and floor height

Thorn computes nothing for a motion; [THN-HOST.md](THN-HOST.md) has what the game does with one.

- **`START_MOTION`**: Start hands the whole record to `ICompoundControl +0xc` and keeps the event on
  `S_OK`; Update sends nothing; Finish calls `+0x10`. `start_time` is float **seconds**. `heading` is
  parsed only when the target is not a `COMPOUND`, `trans_scale` only when it is. A `loop` key ORs 2
  into the flags word, which nothing reads (decomp `ApplyMotionDesc`). The character's animation clock
  is thorn's: each update advances it through `ICompoundControl +0x18(ms)` before the events run.
- **`START_IK`** (decomp `StartIk`/`TickIk`, old reading `0x6f44140`, `0x6f444f0`): `offset` is not
  parsed. Start and Update do the same computation and hand the host the target and an aim:
  ```
  E = ICompoundControl +0x24(PART, end_effector), then inverse(S)     ; the bone's frame
  T = the second target's position, or its hardpoint/part frame's
  R = lookAt(T.t − E.t, front, up)                                    ; the attach's builder
  IIKControl +0xc (Start) / +0x14 (Update) (record, S · T.t, S.R · R)
  ```
  A part lookup on the target writes over the target's own position, so a miss leaves it. Finish
  calls `IIKControl +0x10`.
- **`START_FLR_HEIGHT_ANIM`**: Start reads the floor through `ICompoundControl +0x28`; Update re-reads
  it and moves it the remaining fraction toward `floor_height`, or a second target's `y` (its part's,
  with `target_type` and `target_part`), exactly the spatial animation's chase, and sets it through
  `+0x14` (decomp `TickFloorHeightAnim`).

## Unused, and inert in the game

| Action | What thorn would do | In the game |
| ------ | ------------------- | ----------- |
| `USER_EVENT` (1) | made only when the host passed a string registry | `IUserEventControl` absent: nothing |
| `START_SUB_SCENE` (12) | starts the `SCENE`'s `IScriptControl` with `start_time` in seconds where the slot takes ms | `IScriptControl` absent: nothing |
| `START_REVERB_PROP_ANIM` (17) | lerps `vol`, `decay`, `damping`, steps `env` at `u ≥ 1`, sends all four to `IReverbControl` | the game implements it; no retail script uses it |
| `SUBTITLE` (19) | sends `strid` to `ISubtitleControl` at Start and Finish | absent: nothing |
| `START` (23) | rewritten to `START_SOUND` or `START_MOTION` | no retail use |

Action numbers checked from each init (`0x6f44c19`, `0x6f48509`, `0x6f49179`, `0x6f49d29`). Behaviour
from the decomp and the old reading.

**Entity flags.** The only entity flag thorn's runtime tests is `REFERENCE`: with it, every class keeps
its built-in defaults instead of the record's block. `HIDDEN`, the `LIT_` bits, `lt_grp`, `srt_grp` and
`usr_flg` mean something only to the host (decomp; old reading).

## What thorn hands the host

**Nothing at bind time.** Entities are built before the host binds them, so their constructors' setter
calls only fill caches and the bind methods only `QueryInterface`. **Thorn's first call for an entity
is the first event that writes it.** A host must take every entity's initial frame, frustum, light,
ambient and fog from the entity record (`IScriptEngine +0x24(i)`), not from thorn (decomp; old reading
`0x6f392a0`). [`Playback`](../../src/thorn/playback.ts) starts each host from the record.

**The contract**, every interface and slot thorn calls (old reading of the exe's QueryInterface table
`0x5cca20`, consistent with the routines checked above):

| Interface | Slots thorn calls | In the game |
| --------- | ----------------- | ----------- |
| `IGeoTransformControl` | `+0xc` set position, `+0x10` set orientation, `+0x14`/`+0x18` get | every host class |
| `ICompoundControl` | `+0xc`/`+0x10` motion start/stop, `+0x14` set floor, `+0x18(ms)` advance, `+0x1c`/`+0x20` connect/disconnect, `+0x24` hardpoint/part frame, `+0x28` get floor | compound, deformable |
| `IIKControl` | `+0xc` start, `+0x10` finish, `+0x14` update | deformable |
| `ICameraControl` | `+0xc` fov, `+0x14` aspect, `+0x18` near, `+0x1c` far; `+0x20`/`+0x28`/`+0x2c`/`+0x30` get | camera; aspect set and get are stubs returning −7 |
| `ID3DLightControl` | `+0xc` on, `+0x10` light, `+0x14` direction, gets | light |
| `IFogControl` | `+0xc` on, `+0x14` colour, `+0x1c` start/end/density, `+0x24` table/mode, `+0x30` get all | scene |
| `IPSysControl` | `+0xc` start, `+0x10` stop, `+0x14(ms)` advance, `+0x18`/`+0x1c` sparam | effect |
| `ISoundControl` | `+0xc` start, `+0x10` stop, `+0x24`/`+0x28` props | sound |
| `IReverbControl` | `+0xc` set, `+0x10` get | scene |
| `ILightControl`, `IUserEventControl`, `ISubtitleControl`, `IScriptControl` | ambient and legacy light, user event, subtitle, sub-scene | **absent** |

**The game's clock.** Each frame the game converts its delta to whole milliseconds, carries the
remainder, and calls the tick; a skip is one tick of `duration − now`, which the clock above turns into
an exact jump. That driver, the catch-up for early-ending voice lines, and how scripts are sequenced
and looped are [THN-HOST.md](THN-HOST.md).

## Open

- **Whether `IEngine +0x90`/`+0x98` is the part's world frame for a non-root part.** Taken as world, as
  `common.dll`'s `HardpointToWorld` composes the same way; the owner's routines behind the two
  forwarding slots were not read.
- **Whether `alchemy.dll`'s `dt = 0` transform pass re-places every node.** If it does not carry the
  override down, a drawn effect lags its attach by a step after all.
- **Which `LinearPCurve` DACOM returns.** No retail use.
- **A Hermite curve with a repeated `t`.** The evaluator guesses an index proportionally and walks, so
  the value at exactly that `t` may not be the first match.
- **A deformable bone name that misses the host's five-entry cache** (`0x44567f`).

## Corrections

To the extension's `docs/renderer/THORN-DLL.md` and `SCENES.md`:

- **Rewind.** Believed: a negative delta clamps `new` to 0. True: `new = max(now + dt, 0)`, the clock
  is reset to 0, and the tick replays from 0 up to `new` (checked `thorn.dll!0x6f3982f`–`0x6f39850`,
  then `0x6f39992`).
- **Looping.** Left open ("what the two do to the clock was not read"). True: the stop slot zeroes the
  clock and the restart ticks 0 ms, so the overshoot past the duration is dropped (checked
  `0x6f39a42`–`0x6f39a55`, `0x6f39460`, `0x6f3966f`).
- **Light animation switches.** Believed: `on` and `type` switch at `u ≥ 1`. True: `infinite` does too
  (checked `0x6f45d57`–`0x6f45d68`).
- **Spatial animation on a part.** Believed: a second target's `target_part` is resolved "as the attach
  does", which leaves the target's own frame on a miss. True: the lookup writes over an identity frame
  at the origin, so a miss chases the origin (checked `0x6f46c2d`–`0x6f46d51`).
- **Spatial animation past `u = 1`.** Believed: once `u ≥ 1` has been seen the entity stays on the
  target. True only for a fixed target: `last` is not updated at `u ≥ 1`, so a later `u < 1` chases a
  fraction again, which leaves an entity already on a fixed target there but not one following a moving
  second target (checked `0x6f46a86`–`0x6f46ae6`).
- **Event start order.** Believed: equal-start events start in the order they were loaded. True: the
  master list is `std::sort`ed once loading ends, which can reorder equal starts in a script of more
  than 16 events (checked `0x6f3833f`–`0x6f38412`).
