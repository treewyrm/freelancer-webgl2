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
   * one with no `base` logs an error (`CSolar`), and the first try crashed loading three of them.
   */
  objects: {
    nickname: string
    archetype: string
    position: Vector
    /** `ring =`: its `RING` zone and ring file, under `DATA`. */
    ring?: { zone: string; file: string }
  }[]
  /** `[zone]`s: here only a ring's, turned about X alone so `EulerMatrix`'s order can't matter. */
  zones?: {
    nickname: string
    position: Vector
    /** Degrees about X. */
    pitch: number
    /** `size`: outer radius, inner radius, height. */
    size: Vector
  }[]
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
    ...zones.flatMap(({ nickname, position, pitch, size }) => [
      '[zone]',
      `nickname = ${nickname}`,
      `pos = ${list(position)}`,
      `rotate = ${pitch}, 0, 0`,
      'shape = RING',
      `size = ${list(size)}`,
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
    { nickname: 'Lab_ring', position: [0, -300, -5000], pitch: 20, size: [3000, 1800, 200] },
    {
      nickname: 'Lab_far_ring',
      position: [8000, 1500, -15000],
      pitch: -30,
      size: [4000, 2600, 200],
    },
  ],
}

const RING_PLAYER: Omit<ReferenceSystem['player'], 'position'> = {
  ship: 'li_elite',
  equipment: ['ge_le_engine_01', 'ge_fighter_power01', 'ge_s_scanner_01', 'ge_s_tractor_01'],
  rotate: [0, 0, 0],
}

export const systems: ReadonlyMap<string, ReferenceSystem> = new Map(
  [
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
