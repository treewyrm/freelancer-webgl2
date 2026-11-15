# INTERFACE: Win3D's 3D interface

Freelancer's interface is drawn in 3D: every button, frame and tab is a model, placed in an interface
space and drawn through a camera of its own after the scene. This page is what that drawing computes,
read for the base-side button bar (`NavBar`), whose models are the first a host asks this library to
draw. This library's side is [`src/scene/interface.ts`](../../src/scene/interface.ts). What the bar
lays out where, and why, is the extension's
[ROOMS.md](../../../freelancer-vscode/docs/bases/ROOMS.md#the-button-bar).

## Conventions

As [THN-HOST.md](THN-HOST.md#conventions): a bare address is in `Freelancer-original.exe` (base
`0x400000`; the shipped `Freelancer.exe` is packed). Decomp paths are under `../freelancer-decomp/src/`,
most in `freelancer/Client/`. Evidence: **checked**, **decomp**, **observed**, **unsettled**. Colours are
written `R G B A`, the order their bytes sit in memory.

## The camera

Win3D's camera (`DAT_0067dbf8`) is built once with **identity orientation at the origin**
(`SpaceCameraConstruct`, `0x40f150`) and never moved; only its viewport follows the surface
(`Win3DSetViewportSize`, `0x59dcc0`). Its view is the inverse of that world, so identity
(`FSpaceCamera::GetViewTransform`). `Win3DStartupManager` (`0x59d5a0`) sets near 0.1, far 1000 and
**half the horizontal field 27.216°**, the float bits `0x41d9ba5e` (decomp, `win3d.cpp`).

- RP8 takes that as a half angle: x scale `1 / tan 27.216° = 1.94445`, y scale that times the aspect,
  the aspect the surface's width over height. The horizontal field is fixed, so a wider screen sees
  less of the interface's height (decomp).
- It looks down −Z: every element stands at negative z, and the cursor's ray unprojects to
  `z = -near` (`0x55b660`; unsettled: RP8's handedness flip was not traced).
- `Win3DBeginDraw` (`0x59e500`) applies it each frame (checked).

`INTERFACE_CAMERA` is that camera as this library's `Camera`, whose `fovh` is already the half
horizontal angle in degrees.

## Placing a control

An instance stands at `Position + Offset` (`wincontrol_base.cpp`; decomp). A child's `Position` is its
parent's plus its attach point, which with no hardpoint is the parent's `Offset`; a button
(`NnButtonControl::SetPosition`, `0x55b4a0`) always attaches, a static control only with a hardpoint.
So a nav bar button stands at `[BaseFrame] offset` plus its own, and the frame and tab, static
controls, stand where their `Offset` says, absolutely. Orientation is identity but for a spin, and
scale is 1 throughout: `force_radius` 0, every submit's scale 1 (decomp).

## Meshes

**No interface model carries its meshes.** A `.3db` or `.cmp` under `INTERFACE/` holds its materials,
textures and `VMeshRef`s, and every `VMeshRef` names mesh `0x1351B6D4`, the id of
`interface.generic-102.vms`, in `INTERFACE/interface.generic.vms` (FVF `0x102`: position and one UV
set, no normals, no colours). `Win3DStartupManager` loads that file once into the global caches
(`ResolveMaterialEntryFromFs`, `0x41ade0`, its entry held at `0x67dbc8`), and every interface model
resolves against it (decomp; the id computed from the name). A host hands this library each model with
that library's meshes behind `mesh(id)`.

## Shading

`Win3DBeginDraw` (checked `0x59e500`):

- lighting, texture and fog off in the GL shim, culling **none**, **`ZENABLE` 0**;
- `AMBIENT` white, `DITHER` 0, every light switched off;
- the batcher's bin 1 off (`SetBinOrder(1, -1)`), so every part draws where it is submitted.

With `ZENABLE` 0 nothing tests or writes depth, whatever a submit sets: `FUN_0059efa0` writes
`ZFUNC` and `ZWRITEENABLE` (checked `0x59efb7`–`0x59efea`; the decomp's header calls them cull and
lighting, its `.cpp` constants are right).

**A tint** is the control's colour, written by `SetHolderTint` into the instance's user data: red,
green and blue over 255 into `Ac`, alpha over 255 into `Oc` (decomp). Only one material reads it:

- **`^ui_.*` is `HUDIconMaterial`** in retail's `[MaterialMap]`, and every nav bar button's material is
  `UI_CITY_*` or `UI_INV_*`. Under white ambient and no lights it draws **`Dt × tint`**, alpha
  `Dt.a × tint.a`, blending when the tint's alpha is under 1 or `Dt` has more than one alpha bit
  (`BindHudIcon`, decomp; [MATERIALS.md](MATERIALS.md)).
- **Anything else ignores it.** The frame and tab meshes' `HUD_NN_tray`, `HUD_frame` and
  `Material #NN` are plain `DcDt`/`DcDtOcOt`: `Dc × Dt` at `Oc` (decomp).
- **`^anim_hud.*` is `HUDAnimMaterial`**, the frame's scan line and edge pulse, which draws only when
  the material library's global record 4 is set: the `HUDAnimConfig` performance option above 0.999
  (`ApplyMaterialRecordOption`, `perf_options.cpp`; `BindHudAnim` and `SubmitHudAnimatedGeometry`,
  `flmaterials/MaterialImpl.cpp`), and the submit's flag `0x100`, which Win3D's sets (decomp). This
  library draws it always: the option on.

A control's **glow** is not a glow: a `WireMaterial` pass over the model's `VWireData` as lines, only
with game option `0xb` (`FUN_00434630` → `FUN_00434310`; decomp). Nothing on the nav bar draws one.

## Colours

Hard-coded, not read from an INI (checked, the static initialisers `0x561be0`–`0x561c7c`):

| Colour | `R G B A` | Where |
| ------ | --------- | ----- |
| The interface's cyan | `87 C3 E0 FF` | an idle button; every static control's tint |
| Amber | `F5 EA 52 FF` | the pulse's far end |
| Grey | `B9 B9 B9 FF` | the pulse's middle |
| Selected | `FF FF 00 FF` | a selected button, or one lit while pressed |
| Inactive | `80 80 80 FF` | an inactive button, which draws only with a flag no bar button sets |

`NnButtonControl::Draw` (`0x55af90`; decomp) picks a button's: inactive, else selected, else **the
pulse** when focused or hovered (every button pulses on hover: its constructor sets the flag), else
cyan; `no_color_change` makes it white. A static control is always tinted cyan
(`NnStaticControl::Draw`, `0x588770`; decomp), which its own materials ignore.

**The pulse** (`nn_ui_pulse.cpp`; decomp) is one clock for the whole interface, advanced every frame:
a phase that wraps at 0.3 s and flips a direction on each wrap, the sum compared before it is rounded
to a float. Entering a button resets it to half the cycle, direction 0. Its colour blends each byte as
`to + trunc((from − to) · t)`, with `n` the phase over 0.3:

| Direction | `n < 0.5` | `n ≥ 0.5` |
| --------- | --------- | --------- |
| 0 | grey to cyan, `t = 2n` | amber to grey, `t = 2(n − 0.5)` |
| 1 | grey to amber, `t = 2n` | cyan to grey, `t = 2(n − 0.5)` |

So from a reset: grey, amber at 0.15 s, grey, cyan at 0.45 s, and round again every 0.6 s.

## Order and depth

The base frame (`UpdateGameflowBaseFrame`, `0x558c10`; decomp): clear colour and depth, draw the room,
**clear depth**, then `Win3DDrawAll` (`0x59e300`), the fade, and the scene's end, which flushes the
batcher. The interface draws over the room whole, and nothing in it tests depth, so **the order of
submission is the picture's**. Controls draw in their parent's list, appended as created, a parent's
children before itself; `z_order` above 0 would sort by layer then z, and the nav bar has none. Its
order: the frame, the tab, then `[BaseFrame]`'s children in file order (decomp).

`collectInterfaceFrame` draws in the order it is given, and `render`'s `over` keeps what the target
holds and clears depth alone.

## Motion

- **Spin**: a tab spins (property `0x36`), a room button does not. While hovered its angle runs on at
  180°/s (`SpinSpeed`, the constructor's `0x43340000`); otherwise it goes home the short way at twice
  that, snapping to 0 past 359° or under 1° (`0x55b02e`; decomp). It is applied as a turn about +Y,
  `RotateMatrix({0, angle, 0})`: rows `[c 0 s; 0 1 0; −s 0 c]`, none within 0.01° (decomp
  `common_csys.cpp`). `spinAngle` and `interfaceWorld` are those.
- **Slide**: a tab moves to its place linearly over 0.3 s, after a 0.25 s delay, and snaps there once
  the time is up (`button_mover.cpp`, `NavBar::Update`; decomp). The host moves its controls.

## Open

- RP8's handedness for an identity view was not traced; −Z ahead is inferred from the cursor ray.
- `Dt_flags` `0x40` and `0x4A`, the interface textures' addressing and filtering, were not traced.
- `HUDAnimConfig`'s default, so whether a fresh install draws the frame's scan line.
- Nothing here is **observed**: no retail capture of the base-side interface has been compared.

## Corrections

- The extension's ROOMS.md called FrontDesk and Repair "hidden": they are disabled, and a disabled
  button is not drawn, which comes to the same picture.
- `win3d_engine_submit.h` names the two states `FUN_0059efa0` sets cull and lighting; they are
  `ZFUNC` and `ZWRITEENABLE` (checked), which `ZENABLE` 0 makes moot.
