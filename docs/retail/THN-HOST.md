# THN-HOST: what the game does with a THN script

`thorn.dll` runs a script's clock and events and moves proxies; it draws, loads and plays nothing
([THORN.md](THORN.md)). This page is the other side of that contract, in `Freelancer.exe`: what the
game loads for each entity, the scene frame it places them in, which camera the screen shows and how
it projects and letterboxes it, how it lights, fogs, orders and clears a scene, what it does with a
character's motions and IK, and which scripts it plays together and when. What a script's names mean
is [`../freelancer/docs/refs/THORN.md`](../../../freelancer/docs/refs/THORN.md). This library's side is
[`src/thorn/`](../../src/thorn/) and the room frame in [`src/scene/room.ts`](../../src/scene/room.ts).

## Conventions

Addresses are image VAs. A bare address is in `Freelancer-original.exe` (base `0x400000`; the shipped
`Freelancer.exe` is packed). Others name their module: `common.dll` `0x6260000`, `deformable2.dll`
`0x65f0000`, `engbase.dll` `0x6610000`, `content.dll` `0x6f90000`, `thorn.dll` `0x6f20000`. Decomp
paths are under `../freelancer-decomp/src/`, most in `freelancer/Client/`. Evidence: **checked** (read
in the retail binary), **decomp** (agrees in the decomp, binary not read), **observed** (matched in a
retail capture), **unsettled**. Frames are THORN.md's `[R | t]`, `A · B` applying `B` first.

The decomp's `common.dll` addresses are not retail's: they sit `0x350`–`0x360` below the DLL's own
exports (`RtcSlider::is_enabled(char const*)` is `common.dll!0x627a920`, the decomp says `0x627a5c0`).
Its `content.dll` addresses are not a fixed offset at all. Use the export table.

## A cutscene is a playlist

The game never plays a `.thn` on its own. It plays **sequences**, and several run at once:

```
the sequence manager (0x66d2d0), one per process
 └─ sequences, updated in creation order, each with the same milliseconds every frame
     └─ entries { path, kind, C }, one live at a time
          └─ FGfScript (0x44eab0): the host objects, the sounds, the clock driver
               └─ thorn's IScriptEngine: one per entry, its own clock
```

**No two entries share an engine or a clock** (checked `0x558b06`, `0x454eb0`). They share only what
the host owns: the view table and the room camera, the letterbox and fade, the room's light list and
fog, and the entities an exporting sequence makes visible to other scripts' `REFERENCE`s. An entry
started again (a decision repeating, traffic) reuses its engine and spawns new host objects (decomp
`gf_script_object.cpp` `FGfScriptSequence::StartEntry`).
[`Sequence`, `SequenceManager`](../../src/thorn/sequence.ts).

| What plays | Its sequences | `C` |
| ---------- | ------------- | --- |
| A base room at rest | each `scene` line, looping; every room character's fidget, looping | `I`; a fidget's is its setpoint's ([The scene frame](#the-scene-frame-c)) |
| Landing, launch, the goods cart, a walk-in | that script, cinematic, over the room | `I` |
| A mission cutscene in a base | the encounter's scripts as one sequence, over the room | `I` |
| A clicked conversation (`SCRIPTS/GCS`) | that script, over the room | `I`; its `special/` markers and `camera/` cameras are re-placed on the NPC's seat ([below](#markers-cameras-effects)) |
| A mission cutscene in space | only its camera, over the live system | the anchored object's ([below](#in-space)) |
| The intro | one room whose only ambient scene has its own monitor | `I` |

The set script of a room is read as data and never played ([Rooms](#rooms)).

## The clock

**The frame's milliseconds** (checked `0x558ac7`–`0x558afa`): `sum = float(carry + dt)`,
`ms = ftol(floor(sum · 1000))`, `carry = float(sum − ms · 0.001)`. Every sequence ticks its live
script with the same `ms`. [`frameMilliseconds`](../../src/thorn/script.ts).

**`FGfScript::Start`** (checked `0x44f720`) spawns the entities, preloads the sounds, sets the
engine's loop flag, starts it at 0 and **ticks it by 0**, so everything at `t = 0` (every retail
monitor's first `SET_CAMERA`) happens before the first frame draws.

**`FGfScript::Tick`** (checked `0x44f7f0`):

```
if skipping:   engine.tick(length − now); done                   ; an exact jump        0x44f8d0
else:          engine.tick(ms + catchup)                         ; catchup: 0x44f500
               if !loop and now ≥ length (unsigned): done                               0x44f817
               end fade (below)
if done:       engine.tick(100)                                  ; same call            0x44f905
```

The extra 100 ms puts the clock past the end so thorn finishes every active event; the sequence tears
the script down right after, so it happens once. A skipped script therefore ticks twice in that
call. **A loop restarts at exactly 0**: past its length (strictly) a looping engine finishes its
events, refills its pending list, starts again at 0 and ticks by 0; the overshoot is dropped and no
transform is restored (checked `thorn.dll!0x6f39a36`–`0x6f39a68`; [THORN.md](THORN.md#the-clock)).
[`ScriptRun`](../../src/thorn/script.ts).

**The end fade** (checked `0x44f849`–`0x44f8ce`): when the sequence asks for one, once the time left
is within the global fade duration (`0x61650c`, 1 s after any immediate fade), the game fades to black
at `1 / remaining` a second, or cuts at once when nothing remains. Launch asks for it, as does the
last entry of a sequence that relocates the player.

## Sequences

### What plays next

Each entry has a kind; when its script is done, the sequence starts the next in the same update
(checked `0x455fc0`, `0x455f50`):

| Kind | Written for | Next |
| ---- | ----------- | ---- |
| 0 | everything plain | the next entry |
| 1 | a mission offer's decision | **itself until the offer is answered**; then the first later entry of kind 0, 2 or 4 if accepted, 0 or 3 if declined |
| 2 | accept | the first later entry of kind 0, 2 or 4 |
| 3 | decline, reject | the first later entry of kind 0 or 3 |
| 4 | an info box | itself until it is closed, then the first later 0, 2 or 4 |
| 5 | a room's `traffic` line | itself, forever |
| 6 | a group offer's other branch | the first later 0 or 6 |

No match steps past the end, and the sequence stops. **A decision does not loop in its engine**: it
plays to its end and the sequence starts it again. Answering pauses it, so the next update jumps it
to its end and starts the branch (decomp `OnOfferAnswered`). In multiplayer a group offer waits for
the server, then the acceptor takes {0, 2, 4} and everyone else {0, 6} (checked `0x455fc0`).

### Flags

The constructor's defaults (checked `0x454a19`–`0x454a6e`), and who changes them:

| Flag | Default | Effect |
| ---- | ------- | ------ |
| loop | off | the live entry's engine loops |
| cinematic | on | letterbox, interface hidden |
| skippable | on | the skip key reaches it; separate from cinematic |
| fade | off | the end fade above |
| apply spatial | on | the spawn writes each entity's initial pose ([The walker](#the-walker)) |
| restore camera | on | the room camera saved at start is restored at the end |
| duck ambience, music | off | lowers the room's ambience and music while it plays |
| priority | 0 | its monitors' claim on the view |
| props to room | off | compounds it makes are handed to the room, not kept by the sequence |
| skip latch | off | skips at entry start while a global latch is set (the latch's setter is unsettled) |

Whether a sequence's entities **export** to other scripts' references is an argument of its creation,
not a flag.

| Sequence | Settings | Evidence |
| -------- | -------- | -------- |
| a room's `scene` line | loop, exported, not cinematic, no camera restore, priority 0 | checked `0x44a800`–`0x44a85f` |
| landing | cinematic, skippable, restores camera, **priority 1**, props to room | checked `0x447c8b` |
| launch | cinematic, skippable, **fade**, no camera restore, **priority 1**, skip latch | checked `0x447d16` |
| nav-bar transition | **priority 1**, cinematic and fade as the caller asks | checked `0x441bf3` |
| goods cart | cinematic, skippable, priority 0, props to room, skip latch | checked `0x44aa18` |
| a walk-in (`start_script`) | cinematic, skippable, cast on the character standing there | checked `0x44aafe` |
| a fidget | loop, not cinematic, not exported, no camera restore, priority 0, **apply spatial off** | checked `0x445340`; spatial decomp |
| a mission cutscene | cinematic, ducked, **not skippable**, priority 0, named cast | checked `0x435e21`–`0x435fb8`, `content.dll!0x6f99724` |

### Skip

The skip input (event `0xf`, checked `0x456840`) marks every playing sequence that is cinematic and
skippable. Each entry is then run out (jumped to its end and updated by 0) and the next started, until
the next is a **decision or an info box: that one starts and plays**, and skipping clears. Running
past the last entry stops the sequence. The frame's normal update then runs on the new entry
(checked `0x456170`–`0x456231`). [`Sequence.skip`](../../src/thorn/sequence.ts).

## Rooms

### Entering one

On entering a room (checked `0x44a7e2`–`0x44ab40`):

1. **The set script is data**, never played (`RoomData::read_set_script`, `common.dll!0x6274ea0`;
   decomp `common/common_roomdata.cpp`): each `COMPOUND` with a `category` becomes a room prop
   (template, frame, `LIT_` flags, fog unless `nofog`, `lt_grp`, `srt_grp`, render type, `loadout`,
   `priority`, `running_lights`); a `Room` category or a `hardpoint` userprop marks the main prop. A
   compound without a `category` is reported and skipped. Each `CAMERA` becomes a room camera **and**
   a setpoint of the same name, each `MARKER` a setpoint. `LtShadowSource` and `LtGlareSource` become
   the shadow and glare sources; any other `LIGHT` joins the room's lights only when `on`. The
   `SCENE`'s `ambient` over 255 is the room's ambient. The engine is then destroyed.
   [`readSetScript`](../../src/thorn/sequence.ts).
2. **`scene` lines**, in groups: every `ambient` line, then `traffic`, then `once`, each group in
   file order. Ambient lines are looping exporting sequences at `C = I`; `traffic` is a kind-5 entry,
   `once` a plain one, neither exported. A leading `all` is read and discarded.
3. **A mission encounter due here** plays and the rest of this step is skipped
   ([Mission cutscenes](#in-a-base)). Otherwise: the landing script when arriving from space, the
   goods cart, then each character placement's `start_script` by character slot.
4. **Every room character** loops its fidget ([below](#fidgets)).

The view is the set script's camera named by the room's `[Camera]` until a script with a monitor
takes it ([The view](#which-camera-the-screen-shows)).

### Fidgets

Each room character loops its fidget script with `C = setpoint · G⁻¹`
([The scene frame](#the-scene-frame-c)), apply spatial off, so the spawn writes no initial pose and
the character stays where it stands until an event moves it. **It starts at a random point**: the
sequence is advanced by its whole length (which wraps it to 0), then by `rand()/32768` of it,
`floor(D · r + 0.5)` ms; nothing when `rand()` is 0 (checked `0x445340`–`0x445470`, `0x4448b9`,
`0x44f9e0`). Which fidget, and which conversations a click plays, the server decides.

## References

A `REFERENCE` binds to another script's live entity of the same type and name, found by walking the
**exporting** sequences in creation order, current entry only, first match (checked `0x456790`). In
retail that is an ambient scene of the room started earlier. Failing that:

| Type | Fallback |
| ---- | -------- |
| `MARKER` | the set script's setpoint of that name, **expressed in `C`** (`trans_to_frame`), so it lands on the setpoint; else its own record (checked `0x44d810`) |
| `CAMERA` | the set script's camera of that name, its **pose only and not through `C`**; fov and clip planes stay the referencing entity's own (checked `0x44dc20`–`0x44dd43`) |
| `LIGHT`, `SOUND` | none: warned, no target (decomp `gf_thorn_light.cpp`, `gf_thorn_sound.cpp`) |
| `COMPOUND` | the room prop of that name (decomp `ResolveCompoundTarget`) |
| `DEFORMABLE`, `PSYS`, `MONITOR` | no host at all |

Reads and writes through a reference go to its target. [`SequenceManager.find`](../../src/thorn/sequence.ts).

## Mission cutscenes

### In a base

An encounter (`Act_AddRTC` naming a `[CharacterEncounter]`) becomes one sequence of its scripts:
walkup, greet, action and offer as kind 0, decision 1, accept 2, decline or reject 3 (checked
`content.dll!0x6f99718`–`0x6f998b4`). It is cinematic, ducked, **not skippable**, `C = I`, priority
0, its characters cast by their `actor` names (checked `0x435e21`–`0x435fb8`). When the decision
starts the offer dialog opens and the letterbox goes out; answering tells the server, letterboxes back
in (decomp `OnOfferAnswered`; every letterbox call passes 3) and ends the decision, so the branch starts
next update. The room's ambient scenes keep running underneath; the cutscene's monitor wins because
they have none. The sequence hangs on the encounter's first character: with `autoplay` it starts on
room entry, the last such character in the room winning (checked `0x449fb0`–`0x44a01f`); otherwise
when that character is clicked. A relocation moves the player when it stops (decomp `StopPlayback`).

### In space

`Act_CallThorn` makes a separate script camera with its own engine that binds **only the `MONITOR`
and the entity with a `main_object` userprop** (the last such) (checked `0x51e596`–`0x51e5f2`). It
starts at 0 with no tick by 0. **Nothing in the script is drawn**: the live system is, and keeps
simulating. The `main_object` entity's setters do nothing, so the script cannot move it; reading it
gives the live object relative to the setup frame. The camera is that setup frame times the monitor.
Its clock is `ftol(dt · 1000)` a frame with **no carry** (checked `0x51e758`–`0x51e7f3`). **When the
engine finishes, the view returns to the player's camera by itself** (checked `0x51e810`,
`0x54b1b8`–`0x54b1fa`).

## The intro

At startup the game rolls `rand() · 3 >> 15` (checked `0x564e9c`); the main menu later enters
`Intro2_Base`, `Intro3_Base` or `Intro1_Base` for 0, 1, 2 (checked `0x573912`–`0x573933`), an ordinary
room whose ambient scene carries its own monitor.

## Which INI key starts what

The routes above, by the key that names the script (the format is
[`../freelancer`](../../../freelancer/docs/refs/SECTIONS.md)'s; the route is the game's):

| Key | Section | Route |
| --- | ------- | ----- |
| `set_script` | room `[Room_Info]` | read as data |
| `scene` | room `[Room_Info]` | ambient, traffic or once sequences |
| `start_script` | `[CharacterPlacement]` | the walk-in |
| `landing_script`, `launching_script` | `[PlayerShipPlacement]` | priority-1 cinematics |
| `goodscart_script` | room | the cart |
| `fixture` | `mbases.ini` `[MRoom]` | a vendor's fidget |
| `script` | `SCRIPTS/GCS/genericscripts.ini`, `gcsexcl.ini` | bar conversations, generic fidgets |
| `fidget` | `[Char]` | a mission character's idle |
| `offer`, `decision`, `accept`, `decline`, `reject`, `action` | `[CharacterEncounter]` | a mission cutscene |
| `Act_CallThorn` | mission scripts | a space camera |
| `Act_AddAmbient` | mission scripts | an extra ambient scene (unsettled: not read) |

## What a script loads

### The walker

`FGfScript::Spawn` (the first pass checked `0x44ede3`–`0x44f06c`; the second pass decomp, its pose and floor writes checked `0x44f198`–`0x44f1d2`):

```
for each entity e, in file order:
    fog     = !has(userprops, "nofog")              ; presence; any value             0x44ee06
    running =  has(userprops, "running_lights")     ; presence                        0x44ee35
    p = userprops.priority
    if p and !RtcSlider::is_enabled(p): no host at all                               0x44ee72
    host = factory[e.type]                          ; MOTION_PATH and types 8, 10–12: none
    host.SetFlags(LIT_AMBIENT, LIT_DYNAMIC, fog, running)                            0x44f05c
every host learns the script's last SCENE and the spawn table; then engine.bind(i, host)
second pass, skipping REFERENCEs and the game's background sounds:
    CAMERA:  fov, near, far from the record — never hvaspect
    SOUND:   every audioprop
    if the sequence applies spatial:
        COMPOUND, DEFORMABLE, CAMERA, SOUND, PSYS: position, then orientation, from spatialprops
        DEFORMABLE: then its floor_height                                           0x44f1d2
    MARKER "special/…", CAMERA "camera/…": re-placed (below)
```

**This is how an entity's initial state reaches the game.** Thorn pushes nothing at bind
([THORN.md](THORN.md#what-thorn-hands-the-host)); the second pass writes it through the same
interfaces an event uses. The walker reads only bits 0–2 of an entity's flags (`REFERENCE`,
`LIT_AMBIENT`, `LIT_DYNAMIC`; checked `0x44edf8`–`0x44ee13`): **`HIDDEN` does nothing** in the game,
and thorn's runtime does not read it either. `userprops` keys match ignoring case (thorn's map
compares with `_memicmp`, decomp `Thorn/ThornScene.cpp`), so `NoFog` and `Priority` count.

**A `SCENE`'s own `priority` does two things**: it gates the scene like any entity, and `atoi` of it
becomes the script's camera priority from that point of the walk on, so a monitor spawned before the
`SCENE` keeps the sequence's (checked `0x44eee5`–`0x44ef06`). No retail scene has one. A `SCENE` with
both `TextStart` and `TextString` shows the base-arrival caption `TextStart` seconds in, an interface
element (checked `0x44eedd`).

[`spawns`, `roomEntities`](../../src/thorn/room.ts).

### The detail gate

`userprops.priority` names a setting in `DATA/SCRIPTS/rtcslider.ini`. `RtcSlider::is_enabled(name)`
(`common.dll!0x627a920`): a `set = name, t` line is on when the cutscene-detail slider is at least
`t`, a `set_less = name, t` line when the slider is below `t`; the name is a `CreateID`, so case does
not matter; the first line for a name wins; **a name the file lacks is on**, with a warning (decomp
`common/common_rtcslider.cpp`). So at full detail every `set` entry is on and every `set_less` entry
off, which is how a story script with both a moving and a static monitor gets exactly one.

- A `PSYS` with no `priority` is gated by `script_particles` instead (checked `0x44efd3`).
- `fog` gates the scene's fog, `ship_loadouts` a ship's loadout, `shadow_glare` the room's shadows
  and glare (checked `0x454450`, `0x446751`; decomp `RoomControlDrawShadow`).
- A set-script prop is gated by its own `priority`, and a `scene` line by its optional setting
  (decomp `room_control.cpp`).

The slider is the `rtc_performance` option (decomp `perf_options.cpp`); its default was not read.
[`rtcEnabled`](../../src/thorn/room.ts).

### `COMPOUND`

```
REFERENCE                            → the room prop of that name; ambient is the room's
category Spaceship, template PlayerShip → the player's ship, offset by its HpMount hardpoint;
                                         no player ship: no host                       0x44dda1
otherwise                            → a new ObjectProp(template, category, record pose, loadout)
```

`category` is matched **exactly, case included** (`PetalInterfaceDatabase::get_category`,
`common.dll!0x631c5e0`, `repz cmpsb`): `Room` 0, `Spaceship` 1, `Solar` 2, `Asteroid` 3, `Equipment`
4, `Equipment Cart` 5, `Prop` 6, else −1. **`template_name` ignores case** (`CreateID`), except a
leading `$`, which indirects through the current base's `[Base]` slots: `$ship_sml_01`…`$ship_lrg_03`,
`$terrain_tiny`, `_sml`, `_mdm`, `_lrg`, `$terrain_dyna_01`, `_02` (checked `0x44628c`; decomp
`object_prop.cpp` `ResolveTemplate`).

| `category` | Looked up in | Loads |
| ---------- | ------------ | ----- |
| `Spaceship`, `Solar`, `Asteroid`, `Equipment` | that archetype table | its `DA_archetype` with its material libraries |
| `Room`, `Equipment Cart`, `Prop` | `petaldb.ini`, the record of that category | its mesh and extra materials |
| anything else | nothing | a host with no model |

(decomp `FObjectProp::Load`). A miss logs and leaves no model. The instance is placed at the raw
record pose before anything moves it. **A loadout** loads only on a `Spaceship` with a `loadout`
userprop while `ship_loadouts` is on (checked `0x446744`–`0x446772`); its attachable equipment
connects to the named hardpoints, and its `always_on` lights draw only with `running_lights` (decomp
`FObjectProp::LoadLoadout`, `Update`; [`flashlight.ts`](../../src/scene/flashlight.ts)). A prop is
shown only while the detail options allow its type: a `Room` with the background group, a ship with
objects and ships, the rest with objects (decomp `IsPropTypeShown`).

### `DEFORMABLE`

`template_name` is a `costumes.ini` `[Costume]`, ignoring case, used **only** when a new character
has to be made ([CHARACTERS.md](CHARACTERS.md#joining-a-costume)). A `REFERENCE` gets no host. The
`Actor` userprop, lowercased, picks the character (checked `0x44e870`, `0x44df03`):

| `actor` | Character |
| ------- | --------- |
| `player` | the room's player character (the first slot whose placement type is 1, `0x449cd0`); none: no host |
| `bartender`, `trader`, `shipdealer`, `equipment` | the placed character whose setpoint name has that role segment, compared ignoring case (`0x449d50`); none: no host |
| any other, or none | by the sequence's binding mode: 0 its cast by name; 1 its mirror's **first** character, name ignored; 2 the mirror's of that name. A miss falls to the cast, then to **a new character** from the costume at the record pose, added to the cast |

A walk-in uses mode 1 on the character standing there, a mission cutscene mode 2.

### Markers, cameras, effects

- **Generic setpoints.** A `MARKER` named `special/<x>` and a `CAMERA` named `camera/<x>` are
  re-placed, through `C`, at the room setpoint or camera that the script's own setpoint name maps to
  with segment `<x>`; a camera also takes its record's fov and clip planes (decomp
  `ApplySpecialMarker`, `ApplySpecialCamera`, from the walker's second pass). This is how one bar
  conversation sits on whichever seat and conversation cameras the NPC has.
- **`PSYS`** is a `[VisEffect]`, ignoring case; `PlayerShipEngines` is the player ship's engines, and
  `PlayerShipHover` is made only while a player ship exists (checked `0x44efed`–`0x44f033`).
  [THORN.md](THORN.md#psys) has how it steps.

## The scene frame `C`

`C` is the entry's frame, copied into its script and every host. Compounds, characters, cameras,
monitors and markers are placed at `C · T`; **lights, sounds and effects at `T`**, `C` not applied
(decomp `gf_thorn_*`; observed in `thorn_lights` and `thorn_psys`). [`Playback.world`](../../src/thorn/playback.ts).

**Every route passes `C = I` except a fidget** (checked `0x445340`, `0x435c90`; a clicked
conversation or encounter goes through `0x435dd0` with `I`):

```
G = ThornScriptGetCsys(engine, null)   ; the first DEFORMABLE with no actor or an actor ≠ "player"
                                       ;   (stricmp): [R_e | (x, floor_height, z)]; none → I
C = setpoint · G⁻¹
```

(checked `common.dll!0x627bd80`–`0x627bf70`.) `R_e` is the entity's whole orientation; only the height
is replaced, by its `floor_height`. So the script's own actor lands exactly on the character's
setpoint. [`anchoredFrame`](../../src/thorn/sequence.ts).

## The view

### Which camera the screen shows

The view table (`FGfCameraPool`, `0x668b00`) has 256 slots.

- **A `CAMERA` never shows.** It registers as not selectable and only holds values (checked
  `0x44dbf4`).
- **A `MONITOR` is a candidate** with its script's priority (checked `0x44da11`). A `REFERENCE`
  monitor gets no host.
- **A new slot takes the view only over a strictly lower priority**; freeing the shown slot re-elects
  the highest selectable one, **ties to the lowest slot** (checked `0x450580`–`0x45066a`,
  `0x450680`–`0x450750`). A fresh slot holds fov 35, near 0.25, far 1,000,000.
- **The shown slot writes straight into the room's one camera**: every fov, near, far, position or
  orientation write to a slot reaches the camera only when that slot is shown (checked `0x450b40`).
  `SET_CAMERA` copies a camera into a monitor and keeps it following
  ([THORN.md](THORN.md#the-camera)), so the screen shows the camera most recently cut to by the
  highest-priority script with a monitor.

Priorities are 1 for landing, launch and nav-bar transitions and 0 otherwise
([Flags](#flags)). Ambient scenes normally have no monitor, so a room at rest shows its own camera.
[`ViewTable`](../../src/thorn/view.ts).

### The projection

`ICameraControl` (vtable `0x5ccb18`): `+0xc` fov, `+0x18` near, `+0x1c` far, `+0x20`, `+0x2c`, `+0x30`
their getters. **`+0x10`, `+0x14`, `+0x24` and `+0x28` all return −7** (checked `0x454190`), so a
camera's `hvaspect`, and a camera animation key that lands on the aspect slot, do nothing.

```
Camera::set_fov(f), f in degrees (checked 0x556ce0):
    tanH   = tan(2f · π/360)                  ; f is the HALF horizontal angle
    aspect = (right − left + 1) / (bottom − top + 1)   ; the viewport, inclusive edges
    tanV   = tanH / aspect
```

**`fovh` is half the horizontal field of view**: 25 is a 50° lens. The horizontal is held and the
vertical follows the viewport. Near and far are world units.
[`cameraOf`](../../src/thorn/view.ts), [`camera.ts`](../../src/scene/camera.ts).

### The letterbox

`SetLetterboxTarget(target, rate)` (checked `0x41a0f0`): under an opaque fade the amount jumps to the
target; otherwise it moves there at `rate` a second. Every caller passes 3 (checked: the calls at
`0x449864`, `0x4551a5`, `0x455492` and others), so a third of a second in or out. Each frame, with `s`
the amount and `w × h` the back buffer (checked `0x41a140`–`0x41a2ad`):

```
a'  = w/h + (1.85 − w/h) · s                         ; 1.85 at 0x5c9020
bar = floor((h − w/a') · 0.5 + 0.5)
viewport = (0, bar, w, h − 2·bar); the camera re-derives tanV from the new aspect
```

**At full letterbox the picture is 1.85:1 with the horizontal angle unchanged**, the `hvaspect = 1.85`
retail's cameras carry and the game never reads. A cinematic sequence aims the letterbox at 1; a
decision aims it at 0 while the offer is up. [`Letterbox`](../../src/thorn/view.ts).

## Lights

### A THN light becomes a game light

`Thorn_Light` (`0x452fa0`) hands `0x556fd0` the record's position, its `D3DLIGHT8`, its `direction`
and its `lt_grp` (checked `0x556fd0`–`0x557120`):

```
a point light gets Theta = Phi = π                                  0x55704e
set_d3d (0x411120):
    the type is stored only if the light is not yet registered      0x411130
    not directional: Phi > π → π, with a warning                     0x411213
                     Att0, Att1, Att2 all ≤ 0 → Att0 = 0.1           0x41124f–0x4112a4
position  = the record's pos, C not applied
direction = R_entity · direction, through LookMatrixYup              0x5570bb–0x5570f1
then registered; the group byte kept beside it
```

The light registers in its constructor, so **a later change of `type` is ignored**. `on` only decides
whether it is in the list. A script's lights take the first free of 64 registry slots (decomp
`GfLightRegistryAdd`). What a light block holds, and how `START_LIGHT_PROP_ANIM` changes it, is
[THORN.md](THORN.md#light-fog-and-audio-animations). [`roomLightOf`](../../src/thorn/light.ts).

### Which lights light what

Each room frame the list is the room's own lights (none in retail) and then every script light that
is on, at most 128 (decomp `CollectRoomLights`). Then, per object (checked `0x44ae80`–`0x44af57`):

```
FOGENABLE = room fog active and the object's fog flag
ambient   = !IsVisible ? 0 : (the object's SCENE ? its ambient/255 : the room's ambient)
if the object is not lit (LIT_DYNAMIC): no lights
else, at the object's instance position c (0x5572b0), of the lights whose group byte EQUALS the
object's lt_grp (0x5571e1), keep the 4 highest scores (0x5586f0):
    directional           3
    Range = 0             rejected
    point                 2 − |c − p|²/Range²
    spot                  b − |c − p|²/Range²,  b = 2 when cos α > cos(Phi/2), else cos α;
                          b = 2 also when |c − p|² < 1e-5
```

(α is the angle from the spot's direction to `c`.) A light is inserted before the first one it scores
**at least** as high as, so among equals the later light ranks first; the list is cut to four only at
the end (checked `0x55721f`–`0x55729d`). **`lt_grp` is a strict partition**: a light reaches only
objects of its own group, four at most, chosen once per object at its centre.
[`pickRoomLights`, `lightRoomObject`](../../src/scene/room.ts).

**Ambient.** `IsVisible` is the `LIT_AMBIENT` flag for a prop or character, so an object without it
has black ambient. The ambient comes from **the last `SCENE` in the script that made the object**;
a set-script prop, a referenced prop, or an object whose script has no `SCENE` takes the room's
(decomp `SetScene`, `ResolveCompoundTarget`). **The player's ship always has black ambient**: its
`IsVisible` is `xor al,al` whatever its flags (checked vtable `0x5cbdf4` → `0x44fd00`), and so is a
dealer's ship.

Shading is D3D8's fixed-function model, which the material pages carry; every light's own `Ambient`
colour counts, and specular is never enabled (observed in `thorn_lights`).

## Fog

One global state (`0x66d2a8`) behind the `SCENE`'s `IFogControl` (checked `0x454450`–`0x4546f5`):

| Slot | Writes |
| ---- | ------ |
| `+0xc` on | on = the value **and** `RtcSlider::is_enabled("fog")`, asked at the time of the write |
| `+0x14` colour | the low byte of each int, packed `0x00RRGGBB` |
| `+0x1c` | start, end, density |
| `+0x24 (b, mode)` | **`b ≠ 0`: `FOGTABLEMODE = mode`, `FOGVERTEXMODE = 0`; `b = 0`: the reverse** (`0x4545d0`) |

Thorn passes its `fogtable` byte as `b` (decomp `Thorn/ThornScene.cpp`, `Fun06f43140`), so **`fogtable
= Y` is table fog and `N` is vertex fog**, the key reading as it says. Retail scripts write `N`:
D3D computes their fog per vertex on eye depth and interpolates it.

The state is zeroed at room setup (`0x4546d0`), so a scene without a fog animation has none; nothing
pushes a scene's inline fog block ([THORN.md](THORN.md#light-fog-and-audio-animations)). Once per room
render (`0x454250`) it applies when on, the effects and nebula options are on, and, for table fog,
the device reports the ability; then `FOGENABLE`, `FOGCOLOR`, `FOGSTART`, `FOGEND`, `FOGDENSITY`,
`FOGTABLEMODE`, `FOGVERTEXMODE`. Otherwise fog is disabled. Per object, `FOGENABLE` is then that and
the object's fog flag. [`roomFogOf`](../../src/thorn/light.ts).

## Draw flags, order and background

**What reaches a draw object.** A compound's or character's room object takes `LIT_AMBIENT`
(ambient), `LIT_DYNAMIC` (lights), fog, `running_lights`, `lt_grp`, `srt_grp`, and for a compound the
render type from `usr_flg` (checked `0x44f05c`; decomp `FThornCompound::SetFlags`, `SpawnCompound`).
A character's render type is always 0. Effects, lights, sounds and markers have no draw object, so
their `lt_grp`, `srt_grp`, `usr_flg` and `LIT_` bits are read by nothing.

**`usr_flg` is a render type** (`ThornGetRenderType`, `common.dll!0x627c0b0`, checked): bit 0 gives 1,
bit 1 gives 2, bit 1 winning. 0 is a normal draw, 1 a starsphere through the appearance's starsphere
path, 2 a backdrop through its backdrop path (checked dispatch `0x44b106`–`0x44b292`). Both sky types
draw without depth; their materials are [MATERIALS.md](MATERIALS.md)'s (observed in
`backdrop_skydome`). A scene's sky is its own compounds of these types at negative `srt_grp`.

**The order** (`RoomControlDraw`, checked `0x44b570`–`0x44b8db`): the distinct `srt_grp` values, as
**signed** bytes (`SETL`, checked `0x44c54b`), ascending, then **three passes, each walking every
group** in that order, objects in creation order within a group:

1. opaque: every object's model, lit as above, the batcher relighting each queued record as it
   flushes once after all of them;
2. translucent: each object's running lights; then the room's own flashlights;
3. under white ambient and no lights, each object's effects, then every script's `PSYS`.

Negative groups draw first, so with depth off on the sky types that order is the whole sky.
[`collectRoomFrame`](../../src/scene/room.ts).

**The background is black.** The base state clears colour to `(0, 0, 0)` and depth to 1 before the
room render (checked `0x558c9a`–`0x558caf`); no system starsphere is drawn. **There is no
post-processing**: the game's fade covers room entry, launch and relocation, and a script's fades are
Alchemy effects hung before its camera.

## Characters

The motion mixer itself is [ANIMATION.md](ANIMATION.md) and [`mixer.ts`](../../src/deformable/mixer.ts);
this is what the host hands it.

### Where the animation comes from

A character's `animation` is looked up in **one global table**, built at startup from every file an
`[Animations] anim =` line names, keyed by `CreateID` (so **ignoring case**); a name in two files is
taken from the first (checked `0x435100`, `0x4360e0`, `0x452240`, `0x434d10`). The script is opened on
first use (its count at 0), or earlier for a `preload =` name. **A missing name does nothing**: it
logs, returns success, and the event plays nothing. It also leaves one of the character's 32 motion
slots marked in use (checked `0x452280`–`0x452294`). A compound's motion comes from its own model's
scripts (checked `0x4513b0`).

### `START_MOTION`

The host hands `IDeformable +0x1c` (`deformable2.dll!0x65f41d0`) the name, `start_time`, `trans_time`,
`time_scale`, `weight`, `event_flags` and `heading`; **not `trans_scale` or `duration`** (checked
`0x4522b2`). For a body script it rebuilds the root **upright** at its current world `x`, `z`, facing
its current yaw, or `heading` radians of **world** yaw when that is not negative (retail sends −1),
and at height `Root height + floor` from the script's object map; a script with no `Root height`
keeps the root's height above the floor it had (checked `deformable2.dll!0x65f431e`, `0x65f4358`).

| Field | Effect |
| ----- | ------ |
| `time_scale` | speed `|time_scale|`, reversed by `event_flags & 1` (checked `engbase.dll!0x66126e0`) |
| `start_time` | seconds into each channel; the root is lifted so it does not jump (checked `deformable2.dll!0x65f424b`) |
| `weight` | **an amplitude**: root motion is `p · weight · 1.0`, a character's translation scale fixed at 1 (checked `deformable2.dll!0x65f44ad`); channels likewise (decomp `EngBaseMixer.cpp`) |
| `trans_scale` | compounds only: scales the object map's translation (checked `0x4513b0`) |
| `trans_time` | the blend-in; **0 replaces** every script on the joint (decomp mixer) |
| `event_flags` | 1 backwards, 2 loop, 4 bounce, 128 keep what is beneath (decomp mixer) |
| `locked_bone` | locked after the play whatever it returned, if the animation and part exist; unlocked at Finish (checked `0x45230a`) |
| `duration` | Finish **destroys the motion at once, no blend-out** (checked host side `0x4523a0` → `deformable2.dll!0x65f4d30`) |

### Root and floor against thorn

A character's `IGeoTransformControl` (checked `0x452ab0`–`0x452c20`, `deformable2.dll!0x65f4f00`,
`0x65f5050`):

- **Set position keeps thorn's `x` and `z` and discards its `y`.** Each running motion is rebased so
  the root stands at `Root height + the object map's sampled y + floor`. With nothing playing the root
  keeps its current height.
- **Set orientation** turns every motion's overlay, then the root bone.
- **Get position and orientation read the root bone as it is**, so thorn reads the walk back.

A character's height is therefore never thorn's. **The floor**: the spawn writes `floor_height` after
the position ([The walker](#the-walker)), and `START_FLR_HEIGHT_ANIM` sets it later. The host passes
**the world `y` of `(0, h, 0)` through the script's frame**, not `h` (checked `0x452d00`). The setter
(`deformable2.dll!0x65f50b0`) stores the floor and adds the height change to each running motion's root
overlay; **the root moves at that motion's next evaluation, not at once**, and with nothing playing it
does not move until the next motion or position write.

### Who advances what

A character in a script is advanced by thorn's tick (`ICompoundControl +0x18`, `0x452210`) and taken
off the room's own update while a script holds it (`TakeOverForScript`, `0x4454e0`). **A compound's
`+0x18` does nothing** (`0x451370`); its own model's animation, a script's `START_MOTION` on it, and a
room's `animation = Sc_loop`, advance in the base frame's walk over room objects after the sequences
update (`FObjectProp::Update`, checked `0x558b26`, `0x446a60`).

### IK

`START_IK` (host `0x452460`, checked; aim `deformable2.dll!0x65f5400`, solve `0x65fb540`):

- The chain runs from `end_effector` up `count_to_root` parents, **excluding the root found**, so it
  has `count_to_root` joints. `count_to_root ≤ 0` gives an empty chain and nothing happens. More than
  four joints fails (checked `deformable2.dll!0x65fb041`), as does any joint already locked; every
  joint is locked for the aim's life.
- The aim enters the same mixer, `transition_duration` its blend, `event_flags & 128` keep-beneath.
  Thorn re-sends the target every update ([THORN.md](THORN.md#motion-ik-and-floor-height)).
- **One joint with `point_at`**: the joint's world rotation becomes thorn's look-at, the parent's world
  rotation transposed times the target orientation (checked `deformable2.dll!0x65fb5e9`, `0x65fb618`).
  **Joint limits are skipped** when `count_to_root` is 1 with `point_at`, and also whenever
  `event_flags & 128`, since the event flags are ORed into the aim's (checked `0x452460`,
  `deformable2.dll!0x65fb69c`).
- Longer chains solve damped least squares (decomp `Deformable2.cpp` `IkSolveDls`; unread here).

## Open

- **The cutscene-detail slider's default**, `rtc_performance` in the options.
- **The global skip latch**: what sets it (`LAB_004548f0` not read).
- **Multi-joint IK**: the damped least-squares iteration and its stopping rule.
- **The player ship's `HpMount` offset** (`0x4478c0`): taken as the inverse of the hardpoint relative
  to the root.
- **`Act_AddAmbient`** and the generic conversation lists' routes, not read in the binary.

## Corrections

To `freelancer-vscode/docs/renderer/THN-HOST.md` and `CUTSCENES.md`:

- **`fogtable`.** Believed: `b ≠ 0` selects vertex fog, so `fogtable` reads backwards and retail's `N`
  is table fog. True: `b ≠ 0` writes `FOGTABLEMODE`, `b = 0` `FOGVERTEXMODE`; `Y` is table fog, `N`
  vertex fog. Checked `0x4545d0` and the render states at `0x45434a`, `0x454360`.
- **Draw order.** Believed: each `srt_grp` group drawn in three passes. True: three passes, each over
  every group ascending. Checked `0x44b66c`–`0x44b8db`.
- **Ambient.** Believed: `LIT_AMBIENT ? SCENE.ambient/255 : 0`. True: the scene is the object's own
  script's last `SCENE`, else the room's; the player's and dealers' ships are always black. Checked
  `0x44aeb4`, `0x5cbdf4`.
- **Floor.** Believed: setting it shifts the root at once, by `floor_height`. True: it is applied at
  each motion's next evaluation, and the value is the world `y` of `(0, h, 0)` through the script's
  frame. Checked `0x452d00`, `deformable2.dll!0x65f50b0`.
- **IK limits.** Believed: skipped for every single-joint aim. True: for `point_at` with
  `count_to_root` 1, and whenever `event_flags & 128`. Checked `0x452460`.
- **Compound motion.** Believed: who advances it was not found. True: `FObjectProp::Update` in the
  base frame's room-object walk. Checked `0x558b26`, `0x446a60`.
- **Actors.** Believed: any other name is the cast, a script's earlier one, or a new character. True:
  the sequence's binding mode decides, and mode 1 takes the mirror's first character whatever the
  name. Roles come from `0x449d50`, not `0x444324`. Checked `0x44e870`.
- **Apply spatial.** Believed: the sequence flag is always on. True: fidgets on placed characters
  clear it, and `0x435f57`, `0x44545e` write it. Checked.
- **Skip.** Believed: it stops before a decision. True: it stops **at** a decision or an info box,
  which starts and plays. Checked `0x456170`–`0x456231`.
- **Entry kinds.** Kinds 4 (info box) and 6 (a group offer's other branch) were missing, and a
  decision is restarted by its sequence, not looped by its engine. Checked `0x455fc0`.
- **Skippable** is its own flag, on by default; a mission cutscene is unskippable through
  `content.dll`'s encounter, not by being cinematic. Checked `0x454a19`.
- **Camera reference fallback.** Believed: takes the set script's camera's fov and clip planes. True:
  its pose only, not through `C`; fov and clip planes stay the referencing entity's. Checked
  `0x44dc20`–`0x44dd43`.
- **Conversations.** Believed: anchored like fidgets, `C = setpoint · G⁻¹`. True: `C = I`; only
  fidgets are anchored, and a conversation sits on the seat through its `special/` and `camera/`
  names. Checked `0x435e37`–`0x435e6c`.
- **Space cutscenes.** Believed: the camera holds its last frame until `Act_RevertCam`. True: when the
  engine finishes, the view returns to the player's camera. Checked `0x54b1b8`–`0x54b1fa`.
- **End fade.** Believed: over the script's last `fade_level` seconds. True: over the global fade
  duration, normally 1 s, at `1 / remaining`. Checked `0x44f849`–`0x44f8ce`.
- **The intro roll** is at startup (`0x564e9c`), not at `0x573860`, which only reads it.
- **`ICameraControl` stubs.** `+0x10` and `+0x24` return −7 as well as `+0x14` and `+0x28`. Checked
  `0x5ccb18`.
