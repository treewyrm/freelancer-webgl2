# Coverage

Where each material stands. Update when evidence moves. **A row only moves on evidence**: "picture
matched" means a named reference scene, not that it looks right.

- **Read**: source read, and what it computes is understood.
- **Built**: implemented, with pure and GPU tests.
- **State**: matches a retail capture in a reference scene.
- **Picture**: matches a screenshot within tolerance.

**Draws** counts mesh draws in retail by the type they're shaded as, after `[MaterialMap]`, from
`freelancer-vscode/docs/renderer/MATERIALS.md`. Not re-measured here; M3's corpus suite will confirm
it. Sphere materials aren't counted there. The nine `DcDt` rows hold 21,153 of the 22,635 draws (93%).

## Rigid models (M1, M3)

| Type | Draws | Read | Built | State | Picture |
| ---- | ----: | ---- | ----- | ----- | ------- |
| `DcDt` | 15,016 | Yes | Yes | `li_elite`, `li_elite_turned` | `li_elite`, `li_elite_turned` |
| `DcDtEc` | 3,200 | Yes | Yes | | |
| `DcDtEt` | 1,334 | | | | |
| `DcDtTwo` | 522 | Yes | Yes | `li_elite`, `li_elite_turned` | |
| `DcDtOcOt` | 484 | Yes | Yes | | |
| `DcDtEcOcOtTwo` | 318 | Yes | Yes | | |
| `DcDtEcOcOt` | 179 | Yes | Yes | | |
| `DcDtOcOtTwo` | 78 | Yes | Yes | | |
| `DcDtEcTwo` | 22 | Yes | Yes | | |
| `BtDetailMapMaterial` | 845 | | | | |
| `BtDetailMapTwoMaterial` | | | | | |
| `HUDIconMaterial` | 195 | | | | |
| `HighGlassMaterial` | 113 | Yes | Yes | `li_elite`, `li_elite_turned` | Open: [VALIDATION.md](VALIDATION.md#open-questions) |
| `GlassMaterial`, `GFGlassMaterial` | | | | | |
| `NomadMaterialNoBendy` | 30 | | | | |
| `NomadMaterial` | | | | | |
| `HUDAnimMaterial` | 26 | | | | |
| `ExclusionZoneMaterial` | 20 | | | | |
| `PlanetWaterMaterial` | 4 | | | | |
| `EcEt`, `EcEtTwo`, `LightMap` | 0 | | | | |
| `NullMaterial` | | | | | |

`DcDtBt` and `DcDtEtTwo` are authored in retail, but no DLL registers them, so they draw nothing.

## Engine overrides (M3, M7, M8)

No file names these; the engine applies them.

| Type | Milestone | Read | Built | State | Picture |
| ---- | --------- | ---- | ----- | ----- | ------- |
| `EnvMapMaterial` | M3 | | | | |
| `ColorizeMaterial` | M3 | | | | |
| `CloakMaterial` | M3 | | | | |
| `WireMaterial`, `WireMaterial2` | M3 | | | | |
| `EngineGlowMaterial` | M3 | | | | |
| `StarsphereMaterial`, `BackdropMaterial` | M4 | | | | |
| `ShadowMaterial` | M8 | | | | |
| `VisibleCounterMaterial` | M7 | | | | |

## Spheres and sky (M4)

| Type | Read | Built | State | Picture |
| ---- | ---- | ----- | ----- | ------- |
| `DetailMapMaterial` | | | | |
| `DetailMap2Dm1Msk2PassMaterial` | | | | |
| `IllumDetailMapMaterial` | | | | |
| `Masked2DetailMapMaterial` | | | | |
| `AtmosphereMaterial` | | | | |
| `Nebula`, `NebulaTwo` | | | | |

## Other (M5, M6)

| Type | Milestone | Read | Built | State | Picture |
| ---- | --------- | ---- | ----- | ----- | ------- |
| `EyeMaterial` | M5 | | | | |
| Alchemy appearances | M6 | Partly; see [ADAPTING.md](ADAPTING.md#alchemy-m6) | | | |
