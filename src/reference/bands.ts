/** The bands of the generated sphere: types retail barely uses, or a mod could name. */
import type { Material, TextureReference } from '@treewyrm/freelancer/material'
import type { MaterialAnim } from '@treewyrm/freelancer/rigid'

// Retail textures from `SOLAR/nomad_lair.mat`: one-bit alpha, and DXT3 for what blends by texture.
const slot = (name: string, flags = 64): TextureReference => ({ name, flags })
const OPAQUE = slot('lair_rock01.tga')
const ALPHA = slot('lair_rock_membrane.tga')
const GLOW = slot('lair_rock_dtl01.tga')
const DETAIL = slot('lair_dtl01.tga', 80)
const TINT = { x: 0.8, y: 0.6, z: 0.4 }
const EMIT = { x: 0.1, y: 0.2, z: 0.3 }

const band = (name: string, type: string, fields: Partial<Material> = {}): Material => ({
  name: `bands_${name}`,
  type,
  diffuse: TINT,
  diffuseTexture: OPAQUE,
  ...fields,
})

// Their names have to meet `[MaterialMap]`, and so don't take the prefix.
const named = (name: string, type: string, fields: Partial<Material> = {}): Material => ({
  ...band(name, type, fields),
  name,
})

export const BANDS: readonly Material[] = [
  band('dcdtec_two', 'DcDtEcTwo', { emission: EMIT }),
  band('ec_ocot', 'DcDtEcOcOt', { emission: EMIT }),
  band('ec_ocot_half', 'DcDtEcOcOt', { emission: EMIT, opacity: 0.5 }),
  band('ec_ocot_two', 'DcDtEcOcOtTwo', { emission: EMIT }),
  band('ocot_two', 'DcDtOcOtTwo', { diffuseTexture: ALPHA }),
  band('ecet', 'EcEt', { emission: EMIT, emissionTexture: GLOW }),
  band('ecet_two', 'EcEtTwo', { emission: EMIT, emissionTexture: GLOW }),
  band('lightmap', 'LightMap'),
  band('engine_glow', 'EngineGlowMaterial'),
  band('nebula', 'Nebula', { diffuseTexture: ALPHA }),
  band('nebula_two', 'NebulaTwo', { diffuseTexture: ALPHA }),
  band('bt_two', 'BtDetailMapTwoMaterial', { detailTexture: DETAIL }),
  named('detailmap_bands_nobt', 'DcDt'),
  named('ui_bands', 'DcDt'),
  named('anim_hud_bands', 'DcDtOcOt'),
  named('exclusion_bands', 'DcDt'),
  named('sea_anim_bands', 'DcDtOcOt'),
  named('planet_bands_glass', 'DcDtOcOt', { opacity: 0.5 }),
  band('glass_class', 'GlassMaterial', { opacity: 0.5 }),
  named('nomad_bands', 'DcDt'),
  named('null', 'DcDt'),
  band('unregistered', 'DcDtBt'),
]

const scroll = (name: string): MaterialAnim =>
  ({
    name,
    flags: 0,
    segments: [
      {
        duration: 4,
        start: { uOffset: 0, vOffset: 0, uScale: 0, vScale: 0 },
        velocity: { uOffset: 0.25, vOffset: 0, uScale: 0, vScale: 0 },
      },
    ],
  }) as unknown as MaterialAnim

export const BAND_ANIMATIONS: readonly MaterialAnim[] = [
  scroll('anim_hud_bands'),
  scroll('sea_anim_bands'),
]

/** Archetype lines: textures first, as a material resolves when its own library loads. */
export const BAND_LIBRARIES = [
  'SOLAR/nomad_lair.mat',
  'SHIPS/NOMAD/nomad_fx.txm',
  'FX/envmapbasic.mat',
  'FX/envmapglass.txm',
]
