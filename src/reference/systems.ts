/**
 * Reference systems: a lab-only star system and a save that places the player's ship in it, for a
 * space frame as the game draws one. Mounted beside the menu, never in place of it.
 */

type Vector = readonly [number, number, number]

export interface ReferenceSystem {
  /** The scene's name, which `collect` files the capture under. */
  name: string
  /** `[Ambient] color`, 0 to 255. */
  ambient: Vector
  /** `[Background]`, three `.cmp` paths under `DATA`. */
  background: { basic: string; complex: string; nebulae: string }
  /** `[LightSource]`s, in file order. */
  lights: {
    nickname: string
    position: Vector
    color: Vector
    range: number
    type: 'DIRECTIONAL' | 'POINT'
    attenuation?: Vector
    curve?: string
  }[]
  /**
   * `[Object]`s, with no `rotate` or `spin`, so that nothing moves between frames. Nothing dockable:
   * one with no `base` logs an error (`CSolar`), and the first try crashed loading three of them. At
   * least one: a system with none warns that it found no solars (`load_solars`) and crashes.
   */
  objects: {
    nickname: string
    archetype: string
    position: Vector
    /** `ring =`: its `RING` zone and ring file, under `DATA`. */
    ring?: { zone: string; file: string }
  }[]
  /** `[zone]`s, turned about X alone so `EulerMatrix`'s order can't matter. */
  zones?: {
    nickname: string
    position: Vector
    /** Degrees about X. */
    pitch: number
    shape: 'RING' | 'SPHERE' | 'ELLIPSOID'
    /** `size`: a ring's outer radius, inner radius and height; a sphere's radius; an ellipsoid's. */
    size: readonly number[]
    /** `property_flags`, as retail's field and nebula zones carry them. */
    propertyFlags?: number
    /** `edge_fraction`: a nebula's exclusion zone without one logs an error (`0x62bc720`). */
    edgeFraction?: number
  }[]
  /** `[Asteroids]`: a field file under `DATA`, and its zone. */
  asteroids?: { file: string; zone: string }[]
  /** `[Nebula]`: a nebula file under `DATA`, and its zone. */
  nebulae?: { file: string; zone: string }[]
  /** Files the mount writes under `DATA`, by path as the system names them, and their text. */
  files?: { path: string; text: string }[]
  player: {
    ship: string
    /** Internal, so nothing but the hull is drawn. An engine adds its flame effect. */
    equipment: string[]
    position: Vector
    /** Euler degrees, as a save writes them. */
    rotate: Vector
  }
}

/** `[system]` nickname in `universe.ini`. */
export const systemNickname = (name: string): string => `Lab_${name}`
/** Under `DATA`, as `universe.ini` names it. */
export const systemFile = (name: string): string => `systems\\lab\\${name}.ini`
/** In `Accts/SinglePlayer`, where every `*.fl` is a character. */
export const saveFile = (name: string): string => `lab_${name}.fl`

const list = (v: Vector): string => v.join(', ')

export const systemIni = ({
  ambient,
  background,
  lights,
  objects,
  zones = [],
  asteroids = [],
  nebulae = [],
}: ReferenceSystem): string => {
  const lines = [
    '[SystemInfo]',
    'space_color = 0, 0, 0',
    'local_faction = li_p_grp',
    '[TexturePanels]',
    'file = universe\\heavens\\shapes.ini',
    // No `[Dust]`: dust follows the camera and isn't built yet.
    '[Music]',
    'space = music_li_space',
    'danger = music_li_danger',
    'battle = music_li_battle',
    '[Ambient]',
    `color = ${list(ambient)}`,
    '[Background]',
    `basic_stars = ${background.basic}`,
    `complex_stars = ${background.complex}`,
    `nebulae = ${background.nebulae}`,
    ...lights.flatMap(({ nickname, position, color, range, type, attenuation, curve }) => [
      '[LightSource]',
      `nickname = ${nickname}`,
      `pos = ${list(position)}`,
      `color = ${list(color)}`,
      `range = ${range}`,
      `type = ${type}`,
      ...(attenuation ? [`attenuation = ${list(attenuation)}`] : []),
      ...(curve ? [`atten_curve = ${curve}`] : []),
    ]),
    ...objects.flatMap(({ nickname, archetype, position, ring }) => [
      '[Object]',
      `nickname = ${nickname}`,
      'ids_name = 1',
      `pos = ${list(position)}`,
      `archetype = ${archetype}`,
      'ids_info = 1',
      ...(ring ? [`ring = ${ring.zone}, ${ring.file}`] : []),
    ]),
    ...asteroids.flatMap(({ file, zone }) => ['[Asteroids]', `file = ${file}`, `zone = ${zone}`]),
    ...nebulae.flatMap(({ file, zone }) => ['[Nebula]', `file = ${file}`, `zone = ${zone}`]),
    ...zones.flatMap(({ nickname, position, pitch, shape, size, propertyFlags, edgeFraction }) => [
      '[zone]',
      `nickname = ${nickname}`,
      `pos = ${list(position)}`,
      `rotate = ${pitch}, 0, 0`,
      `shape = ${shape}`,
      `size = ${size.join(', ')}`,
      ...(propertyFlags === undefined ? [] : [`property_flags = ${propertyFlags}`]),
      ...(edgeFraction === undefined ? [] : [`edge_fraction = ${edgeFraction}`]),
      'sort = 99.5',
    ]),
  ]
  return `${lines.join('\r\n')}\r\n`
}

/** Li01's name and voice prefix, so that nothing the game says about it is missing. */
export const universeSection = (name: string): string =>
  [
    '[system]',
    `nickname = ${systemNickname(name)}`,
    `file = ${systemFile(name)}`,
    'pos = 1, 15',
    'msg_id_prefix = gcs_refer_system_Li01',
    'visit = 1',
    'strid_name = 196609',
    'ids_info = 66106',
  ].join('\r\n')

/**
 * Plain text, which the game reads as readily as `FLS1` (`server_savegame.cpp`). No `base`, so it
 * loads in space, and `No_Mission`, so no story runs (`FStory::OnLoad`). Then the initial world, as
 * `PlayerDB::create_restart_file` appends it, for the groups' feelings.
 */
export const saveText = ({ name, player }: ReferenceSystem, initialWorld: string): string => {
  const lines = [
    '[Player]',
    'name = Lab',
    `description = ${name}`,
    'rank = 0',
    'money = 500',
    'voice = trent_voice',
    'costume = trent',
    'com_costume = trent',
    `system = ${systemNickname(name)}`,
    `pos = ${list(player.position)}`,
    `rotate = ${list(player.rotate)}`,
    `ship_archetype = ${player.ship}`,
    ...player.equipment.map((nickname) => `equip = ${nickname}`),
    '',
    '[StoryInfo]',
    'Mission = No_Mission',
    'delta_worth = -1',
    '',
  ]
  return `${lines.join('\r\n')}\r\n${initialWorld}`
}

const LI01_SKY = {
  basic: 'solar\\starsphere\\starsphere_stars_basic.cmp',
  complex: 'solar\\starsphere\\starsphere_li01_stars.cmp',
  nebulae: 'solar\\starsphere\\starsphere_li01.cmp',
}

/**
 * M7: a planet's ring. A ringed planet ahead, its band tilted toward the camera, all of it nearer
 * than the draw range less 5000, so every piece is on the main list; and one far off, whose pieces
 * straddle that and the far plane. `ew05_ring` has a detail shape and a colour, `ice` neither, so
 * its opacity halves.
 */
const RINGS: Omit<ReferenceSystem, 'name' | 'player'> = {
  ambient: [40, 40, 50],
  background: LI01_SKY,
  lights: [
    {
      nickname: 'Lab_sun_light',
      position: [20000, 15000, 30000],
      color: [255, 255, 255],
      range: 120000,
      type: 'DIRECTIONAL',
      curve: 'DYNAMIC_DIRECTION',
    },
  ],
  objects: [
    {
      nickname: 'Lab_ringed_planet',
      archetype: 'planet_gasblucld_1000',
      position: [0, -300, -5000],
      ring: { zone: 'Lab_ring', file: 'solar\\rings\\ew05_ring.ini' },
    },
    {
      nickname: 'Lab_far_ringed_planet',
      archetype: 'planet_gasicecld_2000',
      position: [8000, 1500, -15000],
      ring: { zone: 'Lab_far_ring', file: 'solar\\rings\\ice.ini' },
    },
  ],
  zones: [
    {
      nickname: 'Lab_ring',
      position: [0, -300, -5000],
      pitch: 20,
      shape: 'RING',
      size: [3000, 1800, 200],
    },
    {
      nickname: 'Lab_far_ring',
      position: [8000, 1500, -15000],
      pitch: -30,
      shape: 'RING',
      size: [4000, 2600, 200],
    },
  ],
}

const RING_PLAYER: Omit<ReferenceSystem['player'], 'position'> = {
  ship: 'li_elite',
  equipment: ['ge_le_engine_01', 'ge_fighter_power01', 'ge_s_scanner_01', 'ge_s_tractor_01'],
  rotate: [0, 0, 0],
}

/** Files written for the asteroid lab, under `DATA`, as its system names them. */
const ASTEROID_FIELD_FILE = 'solar\\asteroids\\lab\\lab_field.ini'
const ASTEROID_NEBULA_FILE = 'solar\\nebula\\lab\\lab_nebula.ini'
const ASTEROID_EXBAND_FILE = 'solar\\asteroids\\lab\\lab_field_exband.ini'

/**
 * Br01's Cornwall field, with no `[DynamicAsteroids]` or `[AsteroidBillboards]`, whose `rand()`
 * would make no two runs alike, and its exclusions the lab's own: the station's, and the hole in the
 * nebula.
 */
const LAB_FIELD = [
  '[TexturePanels]',
  'file = solar\\asteroids\\rock_shapes.ini',
  '[Field]',
  'cube_size = 400',
  'fill_dist = 1650',
  'diffuse_color = 220, 220, 180',
  'ambient_color = 120, 120, 120',
  'ambient_increase = 70, 40, 30',
  'empty_cube_frequency = 0.5',
  '[Exclusion Zones]',
  'exclusion = Lab_station_exclusion',
  'exclusion = Lab_nebula_hole',
  '[properties]',
  'flag = rock_objects',
  'flag = Object_density_med',
  '[Cube]',
  'asteroid = minedout_asteroid30, 0.6, 0.2, -0.2, 45, 10, 20',
  'asteroid = minedout_asteroid30, 0.2, 0.8, 0.3, 45, 30, 0',
  'asteroid = minedout_asteroid10, -0.3, -0.3, 0.8, 85, 0, 185',
  'asteroid = minedout_asteroid60, -0.2, -0.1, -0.1, 115, 160, 25',
  'asteroid = minedout_asteroid30, -0.7, 0.4, -0.6, 75, 30, 80',
  '[Band]',
  'render_parts = 6',
  'shape = asteroid_belt_04',
  'height = 5000',
  'offset_dist = 3000',
  'fade = 1.0, 1.35, 15, 17',
  'texture_aspect = 1.0',
  'color_shift = 1.0, 1.0, 1.0',
  'ambient_intensity = 1.0',
  'vert_increase = 2',
].join('\r\n')

/**
 * The lab field with an `[ExclusionBand]` about the station's exclusion zone: 500 out from it, 1000
 * high, so seen from the field its points fade in between 1000 and 1500. Its points are counted by
 * the zone's girth, not the ring's: 10, so the 12 parts it asks for are held to 5. Its own file, so the field's earlier captures still stand.
 */
const LAB_FIELD_EXBAND = [
  LAB_FIELD,
  '[ExclusionBand]',
  'zone = Lab_station_exclusion',
  'render_parts = 12',
  'shape = asteroid_belt_04',
  'height = 1000',
  'offset_dist = -500',
  'fade = 1, 1.5, 15, 18',
  'texture_aspect = 0.5',
  'color_shift = 0.5, 0.5, 0.5',
  'ambient_intensity = 1.5',
  'cull_mode = 0',
  'vert_increase = 2',
].join('\r\n')

/**
 * The Badlands' fog and light, with no `[Clouds]` and both lightnings off, all `rand()`'s. An
 * `[Exterior]` it must have: with none, `plane_slices` stays 1 and its bits pick from no shapes, which
 * crashes. No slices and no `fill_shape` builds nothing. An exclusion zone opens a hole, with a shell.
 */
const LAB_NEBULA = [
  '[TexturePanels]',
  'file = solar\\nebula\\generic_shapes.ini',
  '[Exterior]',
  'plane_slices = 0',
  'color = 15, 10, 40',
  '[NebulaLight]',
  'ambient = 20, 15, 60',
  '[Fog]',
  'fog_enabled = 1',
  'near = 125',
  'distance = 1500',
  'color = 10, 7, 30',
  '[Exclusion Zones]',
  'exclusion = Lab_nebula_hole',
  'fog_far = 2000',
  'zone_shell = solar\\nebula\\generic_exclusion.3db',
  'shell_scalar = 1.0',
  'max_alpha = 0.8',
  'exclusion_tint = 70, 100, 200',
  '[BackgroundLightning]',
  'duration = 0',
  '[DynamicLightning]',
  'duration = 0',
].join('\r\n')

/**
 * M7: an asteroid field, a nebula over part of it, and what they hold. The field is a sphere of 5000
 * centred 4000 ahead, so the ship starts in it; a station sits in an exclusion zone in it. The
 * nebula, to the left, holds part of the field and a hole of its own around a power plant.
 */
const ASTEROIDS: Omit<ReferenceSystem, 'name' | 'player'> = {
  ambient: [40, 40, 50],
  background: LI01_SKY,
  lights: [
    {
      nickname: 'Lab_sun_light',
      position: [20000, 15000, 30000],
      color: [255, 255, 255],
      range: 120000,
      type: 'DIRECTIONAL',
      curve: 'DYNAMIC_DIRECTION',
    },
  ],
  objects: [
    {
      nickname: 'Lab_field_station',
      archetype: 'smallstation1_old_nodock',
      position: [600, -100, -1500],
    },
    { nickname: 'Lab_hole_plant', archetype: 'space_solar_plant', position: [-3500, 0, -3200] },
  ],
  zones: [
    {
      nickname: 'Lab_field',
      position: [0, 0, -4000],
      pitch: 0,
      shape: 'SPHERE',
      size: [5000],
      propertyFlags: 66,
    },
    {
      nickname: 'Lab_station_exclusion',
      position: [600, -100, -1500],
      pitch: 0,
      shape: 'SPHERE',
      size: [500],
    },
    {
      nickname: 'Lab_nebula',
      position: [-3500, 0, -3000],
      pitch: 0,
      shape: 'SPHERE',
      size: [2500],
      propertyFlags: 32768,
    },
    {
      nickname: 'Lab_nebula_hole',
      position: [-3500, 0, -3200],
      pitch: 0,
      shape: 'SPHERE',
      size: [600],
      propertyFlags: 65536,
      edgeFraction: 0.2,
    },
  ],
  asteroids: [{ file: ASTEROID_FIELD_FILE, zone: 'Lab_field' }],
  nebulae: [{ file: ASTEROID_NEBULA_FILE, zone: 'Lab_nebula' }],
  files: [
    { path: ASTEROID_FIELD_FILE, text: LAB_FIELD },
    { path: ASTEROID_NEBULA_FILE, text: LAB_NEBULA },
  ],
}

const SHEETS_NEBULA_FILE = 'solar\\nebula\\lab\\lab_sheets.ini'

/**
 * The Badlands' `[Exterior]` reduced to its `fill_shape`: no slices, so no bits, and both lightnings
 * off. No exclusion zones.
 */
const LAB_SHEETS_NEBULA = [
  '[TexturePanels]',
  'file = solar\\nebula\\generic_shapes.ini',
  '[Exterior]',
  'fill_shape = nebula_circle2',
  'plane_slices = 0',
  'color = 40, 30, 90',
  '[NebulaLight]',
  'ambient = 15, 10, 45',
  '[Fog]',
  'fog_enabled = 1',
  'near = 125',
  'distance = 1500',
  'color = 10, 7, 30',
  '[BackgroundLightning]',
  'duration = 0',
  '[DynamicLightning]',
  'duration = 0',
].join('\r\n')

/**
 * M7: a nebula's fill sheets (`DrawFogShell`). An ellipsoid ahead and to the left, longest along x
 * and pitched 40, which the camera answers to: from the start, sheet A along its x at full and sheet B
 * along its turned y at about half. A sphere written with one value, far past the draw range, on the
 * far list: its sheet A alone, as its sheet B has no height and faces away.
 */
const SHEETS: Omit<ReferenceSystem, 'name' | 'player'> = {
  ambient: [40, 40, 50],
  background: LI01_SKY,
  lights: [
    {
      nickname: 'Lab_sun_light',
      position: [20000, 15000, 30000],
      color: [255, 255, 255],
      range: 120000,
      type: 'DIRECTIONAL',
      curve: 'DYNAMIC_DIRECTION',
    },
  ],
  // Ahead and to the right, outside both nebulae: a system needs one.
  objects: [
    {
      nickname: 'Lab_sheets_station',
      archetype: 'smallstation1_old_nodock',
      position: [1500, -300, -2000],
    },
  ],
  zones: [
    {
      nickname: 'Lab_sheets_near',
      position: [-4000, 0, -9000],
      pitch: 40,
      shape: 'ELLIPSOID',
      size: [4000, 1500, 2500],
      propertyFlags: 32768,
    },
    {
      nickname: 'Lab_sheets_far',
      position: [15000, 3000, -60000],
      pitch: 0,
      shape: 'SPHERE',
      size: [6000],
      propertyFlags: 32768,
    },
  ],
  nebulae: [
    { file: SHEETS_NEBULA_FILE, zone: 'Lab_sheets_near' },
    { file: SHEETS_NEBULA_FILE, zone: 'Lab_sheets_far' },
  ],
  files: [{ path: SHEETS_NEBULA_FILE, text: LAB_SHEETS_NEBULA }],
}

/**
 * M7: a sheet looked at along its own axis. Two ellipsoids straight ahead, longest along z, so sheet A
 * stands along the look, edge-on. Retail's one Newton step leaves the look up to 0.17% short, and how
 * short by its length: from the chase camera, the near one's sheet A keeps an alpha of 85 at 13000,
 * and the far one's, at 60500 and on the far list, fades out. Sheet B faces the camera in both. The
 * look is never exactly along the axis, so its 0/0 isn't reached.
 */
const SHEETS_AXIS: Omit<ReferenceSystem, 'name' | 'player'> = {
  ...SHEETS,
  zones: [
    {
      nickname: 'Lab_sheets_axis_near',
      position: [0, 0, -13000],
      pitch: 0,
      shape: 'ELLIPSOID',
      size: [2000, 2000, 4000],
      propertyFlags: 32768,
    },
    {
      nickname: 'Lab_sheets_axis_far',
      position: [0, 0, -60500],
      pitch: 0,
      shape: 'ELLIPSOID',
      size: [2000, 2000, 4000],
      propertyFlags: 32768,
    },
  ],
  nebulae: [
    { file: SHEETS_NEBULA_FILE, zone: 'Lab_sheets_axis_near' },
    { file: SHEETS_NEBULA_FILE, zone: 'Lab_sheets_axis_far' },
  ],
}

const EXTERIOR_NEBULA_FILE = 'solar\\nebula\\lab\\lab_exterior.ini'

/**
 * The Badlands' `[Exterior]`, its bits made the same size and shape: one `shape` and no
 * `bit_radius_random_variation`, so only each bit's spin is the game's `rand()`. Its fill sheets too,
 * and both lightnings off.
 */
const LAB_EXTERIOR_NEBULA = [
  '[TexturePanels]',
  'file = solar\\nebula\\generic_shapes.ini',
  '[Exterior]',
  'shape = generic_exterior2',
  'fill_shape = nebula_circle2',
  'plane_slices = 3',
  'bit_radius = 1500',
  'min_bits = 4',
  'max_bits = 7',
  'move_bit_percent = 0.5',
  'equator_bias = 0.5',
  'color = 40, 30, 90',
  '[NebulaLight]',
  'ambient = 15, 10, 45',
  '[Fog]',
  'fog_enabled = 1',
  'near = 125',
  'distance = 1500',
  'color = 10, 7, 30',
  '[BackgroundLightning]',
  'duration = 0',
  '[DynamicLightning]',
  'duration = 0',
].join('\r\n')

/**
 * M7: a nebula's exterior (`NebulaDrawBolts`). An ellipsoid ahead and to the left, pitched 20, which
 * the camera answers to: three rings of 4, 7 and 4 bits and its two caps, the near half drawn after
 * its list. A sphere far past the draw range, its bits from the far list after its sheets.
 */
const EXTERIOR: Omit<ReferenceSystem, 'name' | 'player'> = {
  ...SHEETS,
  zones: [
    {
      nickname: 'Lab_exterior_near',
      position: [-3000, 0, -14000],
      pitch: 20,
      shape: 'ELLIPSOID',
      size: [5000, 2500, 3000],
      propertyFlags: 32768,
    },
    {
      nickname: 'Lab_exterior_far',
      position: [12000, 2000, -55000],
      pitch: 0,
      shape: 'SPHERE',
      size: [6000],
      propertyFlags: 32768,
    },
  ],
  nebulae: [
    { file: EXTERIOR_NEBULA_FILE, zone: 'Lab_exterior_near' },
    { file: EXTERIOR_NEBULA_FILE, zone: 'Lab_exterior_far' },
  ],
  files: [{ path: EXTERIOR_NEBULA_FILE, text: LAB_EXTERIOR_NEBULA }],
}

const CLOUDS_NEBULA_FILE = 'solar\\nebula\\lab\\lab_clouds.ini'

/**
 * The Badlands' fog and `[Clouds]`, its lightning off: no `lightning_duration`, and both background
 * lightnings off. No bits or sheets. An exclusion zone with no shell.
 */
const LAB_CLOUDS_NEBULA = [
  '[TexturePanels]',
  'file = solar\\nebula\\generic_shapes.ini',
  '[Exterior]',
  'plane_slices = 0',
  'color = 40, 30, 90',
  '[NebulaLight]',
  'ambient = 15, 10, 45',
  '[Fog]',
  'fog_enabled = 1',
  'near = 0',
  'distance = 1000',
  'color = 10, 7, 30',
  '[Exclusion Zones]',
  'exclusion = Lab_clouds_hole',
  'fog_far = 2000',
  '[Clouds]',
  'max_distance = 300',
  'puff_count = 10',
  'puff_radius = 100',
  'puff_colora = 45, 40, 160',
  'puff_colorb = 55, 10, 20',
  'puff_max_alpha = 0.5',
  'puff_shape = generic_cloud1',
  'puff_shape = generic_cloud2',
  'puff_shape = generic_cloud3',
  'puff_shape = generic_cloud4',
  'puff_weights = 1, 1, 1, 1',
  'puff_drift = 1',
  'near_fade_distance = 125, 200',
  '[BackgroundLightning]',
  'duration = 0',
  '[DynamicLightning]',
  'duration = 0',
].join('\r\n')

/**
 * M7: a nebula's `[Clouds]` from inside (`DrawCloudsPanels`). A sphere of 8000 about the ship, so the
 * camera is deep in its core, with a hole of 600 well to the side, its last fifth an edge.
 */
const CLOUDS: Omit<ReferenceSystem, 'name' | 'player'> = {
  ...SHEETS,
  zones: [
    {
      nickname: 'Lab_clouds',
      position: [0, 0, -2000],
      pitch: 0,
      shape: 'SPHERE',
      size: [8000],
      propertyFlags: 32768,
    },
    {
      nickname: 'Lab_clouds_hole',
      position: [3000, 0, 0],
      pitch: 0,
      shape: 'SPHERE',
      size: [600],
      propertyFlags: 65536,
      edgeFraction: 0.2,
    },
  ],
  nebulae: [{ file: CLOUDS_NEBULA_FILE, zone: 'Lab_clouds' }],
  files: [{ path: CLOUDS_NEBULA_FILE, text: LAB_CLOUDS_NEBULA }],
}

const ASTEROIDS_EXBAND: Omit<ReferenceSystem, 'name' | 'player'> = {
  ...ASTEROIDS,
  asteroids: [{ file: ASTEROID_EXBAND_FILE, zone: 'Lab_field' }],
  files: [
    { path: ASTEROID_EXBAND_FILE, text: LAB_FIELD_EXBAND },
    { path: ASTEROID_NEBULA_FILE, text: LAB_NEBULA },
  ],
}

export const systems: ReadonlyMap<string, ReferenceSystem> = new Map(
  [
    {
      // In the field, 900 from the station's exclusion; the nebula's part of the field off to the left.
      name: 'asteroid_inside',
      ...ASTEROIDS,
      player: { ...RING_PLAYER, position: [0, 0, 0] },
    } satisfies ReferenceSystem,
    {
      // In the nebula and the field, 1200 short of the hole and its plant.
      name: 'asteroid_nebula',
      ...ASTEROIDS,
      player: { ...RING_PLAYER, position: [-3500, 0, -2000] },
    } satisfies ReferenceSystem,
    {
      // Outside the field, 13000 from its centre: no cubes near enough to fill, its band and exterior.
      name: 'asteroid_outside',
      ...ASTEROIDS,
      player: { ...RING_PLAYER, position: [0, 0, 9000] },
    } satisfies ReferenceSystem,
    {
      // In the nebula's hole, the camera 427 from its centre: past the edge's ramp, so the shell
      // (`DrawExclusionShell`) is at its full `max_alpha`, the plant 400 ahead.
      name: 'asteroid_hole',
      ...ASTEROIDS,
      player: { ...RING_PLAYER, position: [-3500, 0, -2800] },
    } satisfies ReferenceSystem,
    {
      // In the hole's edge: the camera about 527 out of 600, an immersion near 0.6 of an
      // `edge_fraction` of 0.2, so the shell at about half.
      name: 'asteroid_hole_edge',
      ...ASTEROIDS,
      player: { ...RING_PLAYER, position: [-3500, 0, -2700] },
    } satisfies ReferenceSystem,
    {
      // In the field, 1500 from the station: the exclusion band about it, partly faded, at full.
      name: 'asteroid_exband',
      ...ASTEROIDS_EXBAND,
      player: { ...RING_PLAYER, position: [0, 0, 0] },
    } satisfies ReferenceSystem,
    {
      // 500 past the field's surface: the exclusion band at half its alpha, the field's own beside.
      name: 'asteroid_exband_edge',
      ...ASTEROIDS_EXBAND,
      player: { ...RING_PLAYER, position: [0, 0, 1500] },
    } satisfies ReferenceSystem,
    {
      // Outside both nebulae: the near one's sheets before its list, the far one's on the far list.
      name: 'nebula_sheets',
      ...SHEETS,
      player: { ...RING_PLAYER, position: [0, 0, 0] },
    } satisfies ReferenceSystem,
    {
      // In the near one's edge, about 500 in from its surface along x, off its axis so neither sheet's
      // edge is 0/0: its sheets after the main lists, before the fog overlay.
      name: 'nebula_sheets_edge',
      ...SHEETS,
      player: { ...RING_PLAYER, position: [-600, 200, -8700] },
    } satisfies ReferenceSystem,
    {
      // Looking along both ellipsoids' long axes, from where `nebula_sheets` had its camera.
      name: 'nebula_sheets_axis',
      ...SHEETS_AXIS,
      player: { ...RING_PLAYER, position: [0, 0, 0] },
    } satisfies ReferenceSystem,
    {
      // Outside both: the far sphere's sheets and bits, then the ellipsoid's sheets and its bits.
      name: 'nebula_exterior',
      ...EXTERIOR,
      player: { ...RING_PLAYER, position: [0, 0, 0] },
    } satisfies ReferenceSystem,
    {
      // In the ellipsoid's edge, about 500 in along its x: its bits after the fog overlay.
      name: 'nebula_exterior_edge',
      ...EXTERIOR,
      player: { ...RING_PLAYER, position: [1500, 0, -13800] },
    } satisfies ReferenceSystem,
    {
      // Deep in the nebula, far from its hole: its clouds ahead, all ten when none fades.
      name: 'nebula_clouds',
      ...CLOUDS,
      player: { ...RING_PLAYER, position: [0, 0, 0] },
    } satisfies ReferenceSystem,
    {
      // In the hole, toward its edge ahead: the puffs deep in it hidden, those past it shown.
      name: 'nebula_clouds_hole',
      ...CLOUDS,
      player: { ...RING_PLAYER, position: [3000, 0, -150] },
    } satisfies ReferenceSystem,
    {
      name: 'ring_outside',
      ...RINGS,
      player: { ...RING_PLAYER, position: [0, 0, 0] },
    } satisfies ReferenceSystem,
    {
      // Inside the near ring's band: 2400 from its centre along its own +Z, which its pitch of 20
      // turns to (0, -2400 sin 20, 2400 cos 20). Where its `[Clouds]` draw, which aren't built.
      name: 'ring_inside',
      ...RINGS,
      player: { ...RING_PLAYER, position: [0, -1121, -2745] },
    } satisfies ReferenceSystem,
    {
      // M7: the frame's order. A planet past the draw range on the far list, one inside it sorted by
      // its surface, three solars at different distances, two kinds of light and an ambient. Ahead
      // of a ship facing -Z, with its chase camera behind it.
      name: 'space_order',
      ambient: [30, 50, 80],
      background: LI01_SKY,
      lights: [
        {
          nickname: 'Lab_sun_light',
          position: [20000, 15000, 30000],
          color: [255, 255, 255],
          range: 120000,
          type: 'DIRECTIONAL',
          curve: 'DYNAMIC_DIRECTION',
        },
        {
          nickname: 'Lab_platform_light',
          position: [-1500, 600, -1000],
          color: [255, 180, 120],
          range: 3000,
          type: 'POINT',
          attenuation: [1, 0, 1e-6],
        },
      ],
      objects: [
        {
          nickname: 'Lab_far_planet',
          archetype: 'planet_gasblucld_5000',
          position: [-12000, 4000, -60000],
        },
        {
          nickname: 'Lab_near_planet',
          archetype: 'planet_earthgrncld_4000',
          position: [9000, -2500, -14000],
        },
        { nickname: 'Lab_plant', archetype: 'space_solar_plant', position: [250, 400, -5500] },
        {
          nickname: 'Lab_station',
          archetype: 'smallstation1_old_nodock',
          position: [900, -200, -3500],
        },
        { nickname: 'Lab_platform', archetype: 'mplatform', position: [-700, 150, -1800] },
      ],
      player: {
        ship: 'li_elite',
        equipment: ['ge_le_engine_01', 'ge_fighter_power01', 'ge_s_scanner_01', 'ge_s_tractor_01'],
        position: [0, 0, 0],
        rotate: [0, 0, 0],
      },
    } satisfies ReferenceSystem,
  ].map((system) => [system.name, system]),
)
