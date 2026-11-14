# Known decomp errors

Places where `freelancer-decomp` disagrees with the retail binary, and what settled each:
a capture or a reading of the DLL. Report them upstream to have them fixed there.

## `FNebulaEffect::FNebulaEffect`

`src/freelancer/Client/cli_nebula.cpp`, retail `FUN_00504970`, at `0x504a77` to `0x504aa7`. Found
2026-11-07.

The decomp's constructor leaves out six of retail's stores, the `[Exterior]` defaults: `min_bits` 4
(`+0xc0`), `max_bits` 8 (`+0xc4`), both radius bounds 1.0 (`+0xc8`, `+0xcc`, from `ebp`, set to
`0x3f800000` at `0x504a4b`), `move_bit_percent` 0.75 (`+0xd4`), and 1 at `+0xd8`. Nothing else writes
`+0xd8`, so `NebulaDrawBolts` always takes its second facing branch: a bit on the far side is skipped,
and the edge fade beside it never runs. `nebula_exterior` and `nebula_exterior_edge` capture it: only
the near half draws, and with no `bit_radius_random_variation` every bit is `bit_radius` exactly.

## `NebulaUpdateBoltCamera`

`src/freelancer/Client/cli_nebula.cpp`, retail `FUN_005074e0`, at `0x507644`. Found 2026-11-07.

The decomp takes the fill sheets' look as the camera less the zone's position. `FUN_00423b60(out, a, b)`
is `a - b`, and its `a` is `[esp+0x68]` after the first push, the zone's position stored at `[esp+0x6c]`
by `0x507510`: the look runs from the camera to the zone. The facings take its absolute value, so only
each sheet's edge, the look across its axis, turns over. `nebula_sheets` and `nebula_sheets_edge`
capture every corner where the zone-to-camera look puts its mirror image about the centre.

## `BandBakeLighting`

`src/freelancer/Client/cli_asteroid.cpp`, retail `0x54cfb0`. Found 2026-11-06.

The decomp lights each point of an asteroid band by `Particles + P * 15 + 5`, the floats at `+0x14` to
`+0x1c`: the normal's last two and the front colour's red. Retail sets `ebx` to `+0x14` at `0x54d169`
and reads `[ebx - 4]`, `[ebx]` and `[ebx + 4]`, the normal at `+0x10`, where `BandUpdateSpokeFade` reads
it too. Baked from the real normal, every band vertex of `asteroid_inside`, `asteroid_nebula` and
`asteroid_outside` matches retail to the byte.

## `Win3DSetTextureFilterLinear` and `Win3DSetTextureFilterPoint`

`src/freelancer/Client/win3d_immediate.cpp`, retail `0x4223d0` and `0x422410`. Found 2026-11-06.

The decomp reads both as stage 0's `MAGFILTER` and `MINFILTER`, to 3 and to 1. They write texture
stage states 13 and 14, which in D3D8 are `D3DTSS_ADDRESSU` and `ADDRESSV`: the first clamps (3), the
second wraps (1). The filter states are 16 to 18, and `D3DTEXF_LINEAR` is 2, not 3. `ScreenQuadFlush`
writes the same two states as 3, and `space_order`'s draw 130 captures `ADDRESSU` 3. A planet ring's
`DrawPiece` calls both, so its shape wraps.

## `FEyeMaterial::Bind`

`src/Deformable2/EyeMaterial.cpp`, retail `0x65fff20`. Found 2026-11-05.

It writes the eye offset to `m[0][2]` and `m[1][2]` of the stage's matrix, where a 2D coordinate never
reads it. `character_eyes` captures `[1,0,0,0, 0,1,0,0, U,V,1,0, 0,0,0,1]`, the third row, and the eye
moves. **Reading the stack offsets by hand reproduced the decomp's error**: the two stores sit between
pushes that are easy to miscount. A capture of the matrix is what settled it.

## `FxBasicAppearance::FillTriangleGeometry`

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

## `START_SOUND`'s spatial flag

`src/Thorn/ThornLua.cpp`, the event parser's `START_SOUND` branch (lines 2113–2122), retail
`thorn.dll!0x6f25904` to `0x6f2593c`. Found 2026-11-13.

With flags bit 2 set, retail ORs 2 (`SPATIAL`) into the target entity record's flags (`+0x04`) and
pushes the record through `IScriptEngine +0x94` (`UpdateEntityFromDesc`): `mov eax,[esp+0xe4]`,
`push ecx`, `or eax,2`, `mov [esp+0xe8],eax`, where after the push `[esp+0xe8]` is still `+0x04`. The
decomp writes `Flags | 2` into `SpatialSnap.Pos[0]` (`+0x08`) instead, leaving the flags as they were
and corrupting `pos.x`. No retail script sets the bit. See [THORN.md](retail/THORN.md).

## Names and addresses that aren't retail's

Not errors in what the code computes, but labels that mislead a reader of the binary:

- `src/alchemy/alchemy_appearances.cpp`, `FxBasicAppearance::FillQuadGeometry`: the curve fields are
  misnamed. Alpha is read through `SizeRamp`, `Rotate` through `TexFrameRamp`, `HToVAspect` through
  `CommonTexFrameRamp` and the frame through `AxisOverrideRamp`; the values are right.
- **Withdrawn 2026-11-14:** a table of `common.dll` addresses in `common_costume.cpp`,
  `common_rtcslider.cpp` and `common_roomdata.cpp` said to sit 0x350 to 0x360 off retail's, and
  `content.dll`'s said to follow no offset at all. They are not errors. The decomp is built from the
  1.1 patch, whose `common.dll`, `server.dll` and `content.dll` are build 1254, and each address it
  gives is that build's. The table compared them with 1.0's (build 1223). These docs now cite 1.1.
