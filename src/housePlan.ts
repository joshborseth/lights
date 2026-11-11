import { Array, Option, Schema } from 'effect'

// NOTE: Estimated from photos of each room, so sizes are approximate. North is
// the living room window wall, x grows east, and z grows south. The bedroom door
// opens straight off the great room. The walk-in closet fills the bedroom's
// southwest corner, between the bed and the bathroom, and opens into the bedroom
// through double doors. The nook east of it, which holds the hamper and the UFO
// light, is an annex of the bedroom. The bathroom door is on the kitchen wall, and its position along that
// wall is inferred. The bathroom keeps its modeled outline, so its walkway and
// tub are drawn shorter than they really are.

export const HOUSE_WIDTH = 7.8
export const HOUSE_DEPTH = 7.9
export const WALL_HEIGHT = 2.3

const GREAT_ROOM = 'GreatRoom'
const GREAT_ROOM_WEST = 3.6
const GREAT_ROOM_WIDTH = 4.2
const LIVING_ROOM_DEPTH = 3.3
const KITCHEN_SOUTH = 6.9
const BEDROOM_DEPTH = 4.6
const CLOSET_NORTH = 3.5
const CLOSET_EAST = 2.2
const STAIRS_WEST = 2.3
const STAIRS_FOOT_X = 5.7
const STAIRS_OPENING_WIDTH = 1.38

const FLOOR_HEX = '#6a4c37'
const CABINET_HEX = '#e8e5de'
const QUARTZ_HEX = '#e6e3dd'
const STEEL_HEX = '#a3a5a7'
const BRONZE_HEX = '#7b6c5c'
const SOFA_HEX = '#8d8a82'
const SOFA_BACK_HEX = '#7d7a73'
const OAK_HEX = '#8a5a2e'
const WHITE_HEX = '#f0ede6'
const GLASS_HEX = '#121a26'
const TABLE_GLASS_HEX = '#a9bcc3'
const SCREEN_HEX = '#14161c'
const SHADE_HEX = '#f0d9a8'
const FRAME_HEX = '#2c2a28'
const GOLD_HEX = '#b08d3f'
const PORCELAIN_HEX = '#e7ecee'
const CURTAIN_HEX = '#c98a9c'
const RUG_HEX = '#d9775a'
const BEDDING_HEX = '#b9c4ae'
const BED_FRAME_HEX = '#b4bdc0'
const PILLOW_HEX = '#ece8e0'
const WICKER_HEX = '#d8cdb4'
const LANTERN_HEX = '#f2efe8'
const CHERRY_HEX = '#b8302c'
const CLOTHES_HEX = '#4a5266'
const BOOK_RED_HEX = '#a8433f'
const BOOK_TEAL_HEX = '#3f7f83'
const BIN_HEX = '#c7c4bd'
const CARDBOARD_HEX = '#a98a62'
const COOKTOP_HEX = '#2e2e30'
const PARTITION_HEX = '#a09c97'
const TILE_HEX = '#55585e'
const VACUUM_HEX = '#2f4fa3'
const LAVENDER_HEX = '#6f6aa8'
const BAG_TAN_HEX = '#9a6a3c'
const COAT_BROWN_HEX = '#5b3f2c'
const COAT_NAVY_HEX = '#2c3550'
const ARGYLE_HEX = '#bdb8b0'
const HOODIE_PINK_HEX = '#c26a7e'

const COUNTER_HEIGHT = 0.88
const COUNTER_THICKNESS = 0.04
const STOOL_SEAT_HEIGHT = 0.64
const UPPER_ELEVATION = 1.45
const UPPER_HEIGHT = 0.75
const SILL_ELEVATION = 1.15
const WINDOW_HEIGHT = 0.8
const LANTERN_ELEVATION = 1.55
const LANTERN_HEIGHT = 0.38
const LANTERN_RADIUS = 0.13
const LANTERN_RING_HEIGHT = 0.03
const LANTERN_RING_LIP = 0.005
const TREAD_COUNT = 9
const TREAD_RUN = 0.25
const TREAD_RISE = 0.25
const NOSING_HEIGHT = 0.03
const NOSING_OVERHANG = 0.02

// MODEL

export const RoomId = Schema.Literals([
  'LivingRoom',
  'Kitchen',
  'Stairs',
  'Bedroom',
  'Closet',
  'Bathroom',
])
export type RoomId = typeof RoomId.Type

export type WallSide = 'North' | 'South' | 'East' | 'West'

export type Door = Readonly<{ side: WallSide; from: number; width: number }>

export type Furniture = Readonly<{
  x: number
  z: number
  width: number
  depth: number
  height: number
  hex: string
  elevation: number
  shape: 'Box' | 'Round' | 'Ball'
  taper: number
  turn: number
}>

export type LightSpot = Readonly<{ x: number; y: number; z: number }>

export type RoomArea = Readonly<{
  x: number
  z: number
  width: number
  depth: number
  doors: ReadonlyArray<Door>
}>

export type HouseRoom = RoomArea &
  Readonly<{
    id: RoomId
    label: string
    floorHex: string
    lightSpace: string
    withinRoomId: Option.Option<RoomId>
    annexes: ReadonlyArray<RoomArea>
    furniture: ReadonlyArray<Furniture>
    lightSpots: ReadonlyArray<LightSpot>
    labelSpot: Readonly<{ x: number; z: number }>
  }>

// FURNITURE

const box = (
  x: number,
  z: number,
  width: number,
  depth: number,
  height: number,
  hex: string,
  elevation = 0,
): Furniture => ({
  x,
  z,
  width,
  depth,
  height,
  hex,
  elevation,
  turn: 0,
  shape: 'Box',
  taper: 1,
})

const round = (
  centerX: number,
  centerZ: number,
  radius: number,
  height: number,
  hex: string,
  elevation = 0,
  taper = 1,
): Furniture => ({
  x: centerX - radius,
  z: centerZ - radius,
  width: radius * 2,
  depth: radius * 2,
  height,
  hex,
  elevation,
  taper,
  shape: 'Round',
  turn: 0,
})

const ball = (
  centerX: number,
  centerY: number,
  centerZ: number,
  radius: number,
  hex: string,
): Furniture => ({
  x: centerX - radius,
  z: centerZ - radius,
  width: radius * 2,
  depth: radius * 2,
  height: radius * 2,
  hex,
  elevation: centerY - radius,
  taper: 1,
  shape: 'Ball',
  turn: 0,
})

const counter = (
  x: number,
  z: number,
  width: number,
  depth: number,
): ReadonlyArray<Furniture> => [
  box(x, z, width, depth, COUNTER_HEIGHT, CABINET_HEX),
  box(
    x - 0.02,
    z - 0.02,
    width + 0.04,
    depth + 0.04,
    COUNTER_THICKNESS,
    QUARTZ_HEX,
    COUNTER_HEIGHT,
  ),
]

const northWindow = (x: number, width: number): ReadonlyArray<Furniture> => [
  box(
    x - 0.1,
    0,
    width + 0.2,
    0.03,
    WINDOW_HEIGHT + 0.2,
    WHITE_HEX,
    SILL_ELEVATION - 0.1,
  ),
  box(x, 0.01, width, 0.04, WINDOW_HEIGHT, GLASS_HEX, SILL_ELEVATION),
  box(x - 0.04, 0, width + 0.08, 0.2, 0.03, WHITE_HEX, SILL_ELEVATION - 0.03),
]

const wallArt = (
  x: number,
  z: number,
  width: number,
  depth: number,
  height: number,
  elevation: number,
  hex = FRAME_HEX,
): Furniture => box(x, z, width, depth, height, hex, elevation)

const lanternPendant = (x: number, z: number): ReadonlyArray<Furniture> => [
  round(x, z, LANTERN_RADIUS, LANTERN_HEIGHT, SHADE_HEX, LANTERN_ELEVATION),
  round(
    x,
    z,
    LANTERN_RADIUS + 0.015,
    LANTERN_RING_HEIGHT,
    STEEL_HEX,
    LANTERN_ELEVATION - LANTERN_RING_LIP,
  ),
  round(
    x,
    z,
    LANTERN_RADIUS + 0.015,
    LANTERN_RING_HEIGHT,
    STEEL_HEX,
    LANTERN_ELEVATION + LANTERN_HEIGHT + LANTERN_RING_LIP - LANTERN_RING_HEIGHT,
  ),
  round(
    x,
    z,
    0.012,
    WALL_HEIGHT - LANTERN_ELEVATION - LANTERN_HEIGHT,
    STEEL_HEX,
    LANTERN_ELEVATION + LANTERN_HEIGHT,
  ),
]

const lanternSpot = (x: number, z: number): LightSpot => ({
  x,
  y: LANTERN_ELEVATION + LANTERN_HEIGHT / 2,
  z,
})

const barStool = (x: number, z: number): ReadonlyArray<Furniture> => [
  box(x - 0.2, z - 0.2, 0.4, 0.4, 0.04, BRONZE_HEX, STOOL_SEAT_HEIGHT),
  box(x - 0.18, z - 0.18, 0.04, 0.04, STOOL_SEAT_HEIGHT, BRONZE_HEX),
  box(x + 0.14, z - 0.18, 0.04, 0.04, STOOL_SEAT_HEIGHT, BRONZE_HEX),
  box(x - 0.18, z + 0.14, 0.04, 0.04, STOOL_SEAT_HEIGHT, BRONZE_HEX),
  box(x + 0.14, z + 0.14, 0.04, 0.04, STOOL_SEAT_HEIGHT, BRONZE_HEX),
  box(x - 0.2, z - 0.22, 0.4, 0.03, 0.42, BRONZE_HEX, STOOL_SEAT_HEIGHT),
]

const stairTread = (index: number): ReadonlyArray<Furniture> => {
  const x = STAIRS_FOOT_X - (index + 1) * TREAD_RUN
  const height = (index + 1) * TREAD_RISE
  return [
    box(x, KITCHEN_SOUTH + 0.04, TREAD_RUN, 0.92, height, WHITE_HEX),
    box(
      x,
      KITCHEN_SOUTH + 0.04,
      TREAD_RUN + NOSING_OVERHANG,
      0.92,
      NOSING_HEIGHT,
      BRONZE_HEX,
      height,
    ),
  ]
}

// ROOMS

const OPEN_LIVING_TO_KITCHEN_NORTH: Door = {
  side: 'North',
  from: GREAT_ROOM_WEST,
  width: GREAT_ROOM_WIDTH,
}
const OPEN_LIVING_TO_KITCHEN_SOUTH: Door = {
  ...OPEN_LIVING_TO_KITCHEN_NORTH,
  side: 'South',
}
const BATHROOM_DOOR_FROM = 5.4
const BEDROOM_DOOR_FROM = 2.5
const DOOR_WIDTH = 0.8

const ORB_LAMP = { x: 4.97, z: 0.12, radius: 0.13 }
const SHROOM_LAMP = { x: 6.62, z: 0.12 }
const SHROOM_STEM_HEIGHT = 0.14

const LIVING_ROOM: HouseRoom = {
  id: 'LivingRoom',
  label: 'Living Room',
  labelSpot: { x: 5.7, z: 2.75 },
  x: GREAT_ROOM_WEST,
  z: 0,
  width: GREAT_ROOM_WIDTH,
  depth: LIVING_ROOM_DEPTH,
  floorHex: FLOOR_HEX,
  lightSpace: GREAT_ROOM,
  withinRoomId: Option.none(),
  annexes: [],
  doors: [
    OPEN_LIVING_TO_KITCHEN_SOUTH,
    { side: 'West', from: BEDROOM_DOOR_FROM, width: DOOR_WIDTH },
  ],
  furniture: [
    ...northWindow(4.06, 1.1),
    ...northWindow(6.41, 1.09),
    ball(
      ORB_LAMP.x,
      SILL_ELEVATION + ORB_LAMP.radius,
      ORB_LAMP.z,
      ORB_LAMP.radius,
      LANTERN_HEX,
    ),
    round(
      SHROOM_LAMP.x,
      SHROOM_LAMP.z,
      0.06,
      SHROOM_STEM_HEIGHT,
      LANTERN_HEX,
      SILL_ELEVATION,
    ),
    round(
      SHROOM_LAMP.x,
      SHROOM_LAMP.z,
      0.15,
      0.11,
      LANTERN_HEX,
      SILL_ELEVATION + SHROOM_STEM_HEIGHT,
      0.5,
    ),
    box(4.2, 0.05, 0.42, 0.15, 0.12, BOOK_RED_HEX, SILL_ELEVATION),
    box(6.98, 0.05, 0.46, 0.15, 0.2, BOOK_TEAL_HEX, SILL_ELEVATION),
    wallArt(5.42, 0, 0.8, 0.04, 1.15, 0.92),
    box(4.97, 0.27, 2.53, 0.88, 0.42, SOFA_HEX),
    box(4.85, 0.05, 2.9, 0.22, 0.8, SOFA_BACK_HEX),
    box(6.85, 1.15, 0.65, 1.2, 0.42, SOFA_HEX),
    box(7.5, 0.27, 0.25, 2.08, 0.8, SOFA_BACK_HEX),
    box(4.85, 0.27, 0.12, 0.9, 0.58, SOFA_BACK_HEX),
    box(5.1, 0.3, 0.42, 0.26, 0.26, SOFA_BACK_HEX, 0.42),
    box(6.0, 0.3, 0.42, 0.26, 0.26, SOFA_BACK_HEX, 0.42),
    box(7.2, 1.4, 0.26, 0.42, 0.26, SOFA_BACK_HEX, 0.42),
    box(5.7, 1.4, 0.82, 0.8, 0.03, TABLE_GLASS_HEX, 0.4),
    box(5.76, 1.46, 0.7, 0.68, 0.3, WICKER_HEX),
    box(3.62, 0.9, 0.48, 1.5, 0.82, OAK_HEX),
    box(3.8, 1.1, 0.06, 1.1, 0.62, SCREEN_HEX, 0.82),
    wallArt(3.6, 0.35, 0.04, 0.72, 1.25, 0.9),
    box(4.2, 0.05, 0.56, 0.45, 0.62, BIN_HEX),
    box(4.26, 0.6, 0.44, 0.36, 0.36, CARDBOARD_HEX),
    wallArt(7.76, 0.75, 0.04, 0.42, 0.55, 1.35),
    wallArt(7.76, 1.65, 0.04, 0.42, 0.55, 1.2),
  ],
  lightSpots: [
    {
      x: ORB_LAMP.x,
      y: SILL_ELEVATION + ORB_LAMP.radius,
      z: ORB_LAMP.z,
    },
    {
      x: SHROOM_LAMP.x,
      y: SILL_ELEVATION + SHROOM_STEM_HEIGHT + 0.06,
      z: SHROOM_LAMP.z,
    },
  ],
}

const PENDANT_Z = 4.2
const LESS_WOBBLY_PENDANT_X = 6.2
const MORE_WOBBLY_PENDANT_X = 7.0
const STOOL_Z = 3.5
const STOVE = { z: 5, depth: 0.76 }
const SINK_RUN_DEPTH = 0.58
const SINK_RUN_Z = KITCHEN_SOUTH - SINK_RUN_DEPTH - 0.02

const KITCHEN: HouseRoom = {
  id: 'Kitchen',
  label: 'Kitchen',
  labelSpot: { x: 5.5, z: 5.5 },
  x: GREAT_ROOM_WEST,
  z: LIVING_ROOM_DEPTH,
  width: GREAT_ROOM_WIDTH,
  depth: KITCHEN_SOUTH - LIVING_ROOM_DEPTH,
  floorHex: FLOOR_HEX,
  lightSpace: GREAT_ROOM,
  withinRoomId: Option.none(),
  annexes: [],
  doors: [
    OPEN_LIVING_TO_KITCHEN_NORTH,
    { side: 'West', from: BATHROOM_DOOR_FROM, width: DOOR_WIDTH },
    {
      side: 'South',
      from: STAIRS_FOOT_X,
      width: STAIRS_OPENING_WIDTH,
    },
  ],
  furniture: [
    box(5.5, 3.9, 2.3, 0.8, COUNTER_HEIGHT, CABINET_HEX),
    box(5.45, 3.66, 2.35, 1.06, COUNTER_THICKNESS, QUARTZ_HEX, COUNTER_HEIGHT),
    box(
      7.3,
      3.95,
      0.48,
      0.4,
      0.3,
      WHITE_HEX,
      COUNTER_HEIGHT + COUNTER_THICKNESS,
    ),
    ...barStool(LESS_WOBBLY_PENDANT_X, STOOL_Z),
    ...barStool(MORE_WOBBLY_PENDANT_X, STOOL_Z),
    ...lanternPendant(LESS_WOBBLY_PENDANT_X, PENDANT_Z),
    ...lanternPendant(MORE_WOBBLY_PENDANT_X, PENDANT_Z),
    ...counter(7.18, 4.72, 0.62, STOVE.z - 4.72),
    ...counter(7.18, STOVE.z + STOVE.depth, 0.62, 0.36),
    box(7.04, STOVE.z, 0.76, STOVE.depth, 0.94, WHITE_HEX),
    box(7.04, STOVE.z, 0.72, STOVE.depth, 0.02, COOKTOP_HEX, 0.94),
    box(7.36, STOVE.z, 0.44, STOVE.depth, 0.14, WHITE_HEX, 1.55),
    box(7.47, 3.75, 0.33, 1.2, UPPER_HEIGHT, CABINET_HEX, UPPER_ELEVATION),
    box(7.06, 6.12, 0.74, 0.76, 1.72, WHITE_HEX),
    ...counter(GREAT_ROOM_WEST, SINK_RUN_Z, 2.05, SINK_RUN_DEPTH),
    box(GREAT_ROOM_WEST + 0.02, SINK_RUN_Z - 0.03, 0.6, 0.03, 0.84, WHITE_HEX),
    box(4.6, SINK_RUN_Z + 0.1, 0.62, 0.36, 0.01, STEEL_HEX, 0.925),
    box(
      GREAT_ROOM_WEST + 0.1,
      KITCHEN_SOUTH - 0.33,
      0.8,
      0.33,
      UPPER_HEIGHT,
      CABINET_HEX,
      UPPER_ELEVATION,
    ),
  ],
  lightSpots: [
    lanternSpot(LESS_WOBBLY_PENDANT_X, PENDANT_Z),
    lanternSpot(MORE_WOBBLY_PENDANT_X, PENDANT_Z),
  ],
}

const STAIRS: HouseRoom = {
  id: 'Stairs',
  label: 'Stairs',
  labelSpot: { x: 6.75, z: 7.4 },
  x: STAIRS_WEST,
  z: KITCHEN_SOUTH,
  width: HOUSE_WIDTH - STAIRS_WEST,
  depth: HOUSE_DEPTH - KITCHEN_SOUTH,
  floorHex: FLOOR_HEX,
  lightSpace: GREAT_ROOM,
  withinRoomId: Option.none(),
  annexes: [],
  doors: [
    {
      side: 'North',
      from: STAIRS_FOOT_X,
      width: STAIRS_OPENING_WIDTH,
    },
  ],
  furniture: [
    ...Array.flatten(Array.makeBy(TREAD_COUNT, stairTread)),
    box(
      STAIRS_WEST,
      KITCHEN_SOUTH + 0.04,
      STAIRS_FOOT_X - TREAD_COUNT * TREAD_RUN - STAIRS_WEST,
      0.92,
      TREAD_COUNT * TREAD_RISE,
      WHITE_HEX,
    ),
    wallArt(5.95, HOUSE_DEPTH - 0.04, 0.55, 0.04, 0.7, 1.15, GOLD_HEX),
    box(6.7, HOUSE_DEPTH - 0.34, 0.7, 0.32, 1.15, STEEL_HEX),
  ],
  lightSpots: [],
}

const SPHERE_LANTERN = { x: 0.8, y: 1.85, z: 1.75, radius: 0.42 }
const CEILING_LIGHT = { x: 2, z: 1.7 }
const UFO_LIGHT = { x: 3.25, z: 4.25, elevation: 1.96, height: 0.09 }
const BED = { x: 0.02, z: 1.35, length: 2.03, width: 1.55 }
const FAN = { x: 2.45, z: 0.3 }
const CLOSET_DOOR = { from: 0.55, width: 1.2 }
const SIDE_TABLE = { x: 0.05, z: 3.0, size: 0.4, height: 0.55 }

const BEDROOM_NOOK: RoomArea = {
  x: CLOSET_EAST,
  z: CLOSET_NORTH,
  width: GREAT_ROOM_WEST - CLOSET_EAST,
  depth: BEDROOM_DEPTH - CLOSET_NORTH,
  doors: [
    { side: 'North', from: CLOSET_EAST, width: GREAT_ROOM_WEST - CLOSET_EAST },
  ],
}

// CLOSET

const CLOSET_DEPTH = BEDROOM_DEPTH - CLOSET_NORTH
const CLOSET_LEAF_WIDTH = CLOSET_DOOR.width / 2
const CLOSET_LEAF_THICKNESS = 0.035
const CLOSET_LEAF_HEIGHT = 2.0
const CLOSET_LEAF_OPEN = (75 * Math.PI) / 180
const BAG_DEPTH = 0.12
const BAG_WIDTH = 0.22
const BAG_HEIGHT = 0.34
const SHELF_ELEVATION = 1.9
const SHELF_DEPTH = 0.36
const RAIL_ELEVATION = 1.84
const LOWER_RAIL_ELEVATION = 1.02
const CLOTHES_DEPTH = 0.46
const CLOTHES_GAP = 0.01
const CLOSET_LIGHT = { x: 1.1, z: 4.0, radius: 0.15, height: 0.08 }
const WEST_SHELF_END = BEDROOM_DEPTH - SHELF_DEPTH - 0.02
const WEST_RAIL = { x: 0.3, from: CLOSET_NORTH + 0.06, to: 4.04 }

// NOTE: Each leaf turns on its hinge into the bedroom. A leaf's direction from
// its hinge is (cos turn, -sin turn), and its bags hang on the side facing the
// doorway, the way Josh hangs them on the real doors.
const closetLeaf = (
  hingeX: number,
  opensToward: 1 | -1,
  bagHexes: ReadonlyArray<string>,
): ReadonlyArray<Furniture> => {
  const turn = opensToward === 1 ? CLOSET_LEAF_OPEN : Math.PI - CLOSET_LEAF_OPEN
  const alongX = Math.cos(turn)
  const alongZ = -Math.sin(turn)
  const normalX = Math.sin(turn) * opensToward
  const normalZ = Math.cos(turn) * opensToward
  const turned = (
    along: number,
    out: number,
    width: number,
    depth: number,
    height: number,
    hex: string,
    elevation: number,
  ): Furniture => ({
    ...box(
      hingeX + alongX * along + normalX * out - width / 2,
      CLOSET_NORTH + alongZ * along + normalZ * out - depth / 2,
      width,
      depth,
      height,
      hex,
      elevation,
    ),
    turn,
  })
  return [
    turned(
      CLOSET_LEAF_WIDTH / 2,
      0,
      CLOSET_LEAF_WIDTH,
      CLOSET_LEAF_THICKNESS,
      CLOSET_LEAF_HEIGHT,
      WHITE_HEX,
      0,
    ),
    ...Array.map(bagHexes, (hex, index) =>
      turned(
        0.17 + index * 0.25,
        (CLOSET_LEAF_THICKNESS + BAG_DEPTH) / 2 + 0.005,
        BAG_WIDTH,
        BAG_DEPTH,
        BAG_HEIGHT + index * 0.06,
        hex,
        1.3 - index * 0.12,
      ),
    ),
  ]
}

// NOTE: Lays clothes side by side along a rail, starting at the rail's west or
// north end. Pieces are separated by a hair so their tops never share a face.
// Clothes stay a few centimetres off the walls: a focused neighbor cuts this
// room away 3 cm inside its walls, and a face on that line would shimmer.
const clothesRun = (
  start: Readonly<{ x: number; z: number }>,
  runsAlong: 'X' | 'Z',
  elevation: number,
  height: number,
  pieces: ReadonlyArray<Readonly<{ width: number; hex: string }>>,
): ReadonlyArray<Furniture> =>
  Array.map(pieces, (piece, index) => {
    const offset = Array.reduce(
      Array.take(pieces, index),
      0,
      (sum, { width }) => sum + width + CLOTHES_GAP,
    )
    return runsAlong === 'X'
      ? box(
          start.x + offset,
          start.z,
          piece.width,
          CLOTHES_DEPTH,
          height,
          piece.hex,
          elevation,
        )
      : box(
          start.x,
          start.z + offset,
          CLOTHES_DEPTH,
          piece.width,
          height,
          piece.hex,
          elevation,
        )
  })

const BACK_RAIL_Z = BEDROOM_DEPTH - CLOTHES_DEPTH / 2 - 0.06
const BACK_CLOTHES_Z = BACK_RAIL_Z - CLOTHES_DEPTH / 2
const DOUBLE_HANG_X = 1.12

const CLOSET: HouseRoom = {
  id: 'Closet',
  label: 'Closet',
  labelSpot: { x: 1.1, z: 3.85 },
  x: 0,
  z: CLOSET_NORTH,
  width: CLOSET_EAST,
  depth: CLOSET_DEPTH,
  floorHex: FLOOR_HEX,
  lightSpace: 'Closet',
  withinRoomId: Option.some('Bedroom'),
  annexes: [],
  doors: [{ side: 'North', ...CLOSET_DOOR }],
  furniture: [
    box(
      0.02,
      BEDROOM_DEPTH - SHELF_DEPTH - 0.02,
      CLOSET_EAST - 0.04,
      SHELF_DEPTH,
      0.02,
      WHITE_HEX,
      SHELF_ELEVATION,
    ),
    box(
      0.02,
      CLOSET_NORTH + 0.06,
      SHELF_DEPTH,
      WEST_SHELF_END - CLOSET_NORTH - 0.06,
      0.02,
      WHITE_HEX,
      SHELF_ELEVATION,
    ),
    box(
      0.03,
      BACK_RAIL_Z,
      CLOSET_EAST - 0.06,
      0.02,
      0.02,
      STEEL_HEX,
      RAIL_ELEVATION,
    ),
    box(
      DOUBLE_HANG_X,
      BACK_RAIL_Z,
      CLOSET_EAST - DOUBLE_HANG_X - 0.03,
      0.02,
      0.02,
      STEEL_HEX,
      LOWER_RAIL_ELEVATION,
    ),
    box(
      WEST_RAIL.x - 0.01,
      WEST_RAIL.from,
      0.02,
      WEST_RAIL.to - WEST_RAIL.from,
      0.02,
      STEEL_HEX,
      RAIL_ELEVATION,
    ),
    ...clothesRun({ x: 0.08, z: BACK_CLOTHES_Z }, 'X', 0.36, 1.46, [
      { width: 0.2, hex: COAT_BROWN_HEX },
      { width: 0.2, hex: FRAME_HEX },
      { width: 0.26, hex: COAT_NAVY_HEX },
      { width: 0.18, hex: CHERRY_HEX },
      { width: 0.14, hex: FRAME_HEX },
    ]),
    ...clothesRun({ x: DOUBLE_HANG_X, z: BACK_CLOTHES_Z }, 'X', 1.08, 0.74, [
      { width: 0.16, hex: FRAME_HEX },
      { width: 0.2, hex: PILLOW_HEX },
      { width: 0.16, hex: COAT_BROWN_HEX },
      { width: 0.2, hex: ARGYLE_HEX },
      { width: 0.15, hex: COAT_NAVY_HEX },
      { width: 0.12, hex: FRAME_HEX },
    ]),
    ...clothesRun({ x: DOUBLE_HANG_X, z: BACK_CLOTHES_Z }, 'X', 0.14, 0.86, [
      { width: 0.14, hex: CHERRY_HEX },
      { width: 0.16, hex: CARDBOARD_HEX },
      { width: 0.22, hex: HOODIE_PINK_HEX },
      { width: 0.16, hex: BEDDING_HEX },
      { width: 0.14, hex: BOOK_TEAL_HEX },
      { width: 0.15, hex: FRAME_HEX },
    ]),
    ...clothesRun(
      { x: WEST_RAIL.x - CLOTHES_DEPTH / 2, z: WEST_RAIL.from + 0.02 },
      'Z',
      0.5,
      1.32,
      [
        { width: 0.16, hex: COAT_NAVY_HEX },
        { width: 0.16, hex: CLOTHES_HEX },
        { width: 0.13, hex: COAT_BROWN_HEX },
      ],
    ),
    round(
      CLOSET_LIGHT.x,
      CLOSET_LIGHT.z,
      CLOSET_LIGHT.radius,
      CLOSET_LIGHT.height,
      LANTERN_HEX,
      WALL_HEIGHT - CLOSET_LIGHT.height,
      0.75,
    ),
  ],
  lightSpots: [
    {
      x: CLOSET_LIGHT.x,
      y: WALL_HEIGHT - CLOSET_LIGHT.height - 0.04,
      z: CLOSET_LIGHT.z,
    },
  ],
}

const BEDROOM: HouseRoom = {
  id: 'Bedroom',
  label: 'Bedroom',
  labelSpot: { x: 3.0, z: 1.7 },
  x: 0,
  z: 0,
  width: GREAT_ROOM_WEST,
  depth: CLOSET_NORTH,
  floorHex: FLOOR_HEX,
  lightSpace: 'Bedroom',
  withinRoomId: Option.none(),
  annexes: [BEDROOM_NOOK],
  doors: [
    { side: 'East', from: BEDROOM_DOOR_FROM, width: DOOR_WIDTH },
    { side: 'South', ...CLOSET_DOOR },
    { side: 'South', from: CLOSET_EAST, width: GREAT_ROOM_WEST - CLOSET_EAST },
  ],
  furniture: [
    box(BED.x, BED.z - 0.05, 0.1, BED.width + 0.1, 0.85, BED_FRAME_HEX),
    box(BED.x + 0.1, BED.z, BED.length - 0.1, BED.width, 0.3, BED_FRAME_HEX),
    box(
      BED.x + 0.1,
      BED.z,
      BED.length - 0.1,
      BED.width,
      0.26,
      BEDDING_HEX,
      0.3,
    ),
    box(BED.x + 0.15, BED.z + 0.1, 0.42, 0.6, 0.14, PILLOW_HEX, 0.56),
    box(BED.x + 0.15, BED.z + 0.85, 0.42, 0.6, 0.14, PILLOW_HEX, 0.56),
    round(BED.x + 0.75, BED.z + 0.75, 0.19, 0.05, PILLOW_HEX, 0.56),
    box(0.03, 0.2, 0.6, 1.1, 0.04, OAK_HEX, 0.72),
    box(0.08, 0.25, 0.05, 1.0, 0.72, WHITE_HEX),
    box(0.12, 0.5, 0.06, 0.6, 0.36, SCREEN_HEX, 0.76),
    box(0.75, 0.5, 0.48, 0.5, 0.5, BIN_HEX),
    box(0.75, 0.46, 0.48, 0.08, 0.55, BIN_HEX, 0.5),
    ...northWindow(0.85, 0.8),
    box(0.85, 0.05, 0.8, 0.02, 0.72, PILLOW_HEX, SILL_ELEVATION + 0.06),
    box(1.45, 0.02, 1.1, 0.08, 0.2, WHITE_HEX, 0.08),
    box(1.85, 0, 0.28, 0.14, 0.22, BOOK_TEAL_HEX, 1.4),
    wallArt(2.3, 0, 0.32, 0.05, 0.3, 1.45, CLOTHES_HEX),
    round(FAN.x, FAN.z, 0.16, 0.03, FRAME_HEX),
    round(FAN.x, FAN.z, 0.02, 1.1, FRAME_HEX),
    ball(FAN.x, 1.22, FAN.z, 0.2, FRAME_HEX),
    box(2.7, 0.05, 0.85, 0.46, 1.25, OAK_HEX),
    box(2.95, 4.1, 0.55, 0.45, 0.42, WICKER_HEX),
    box(2.85, 0, 0.55, 0.03, 0.62, PORCELAIN_HEX, 1.42),
    round(3.25, 0.32, 0.01, 0.42, CHERRY_HEX, 1.88),
    ball(3.25, 1.76, 0.32, 0.13, CHERRY_HEX),
    wallArt(0, 2.05, 0.03, 0.62, 0.55, 1.1, WICKER_HEX),
    box(
      SIDE_TABLE.x,
      SIDE_TABLE.z,
      SIDE_TABLE.size,
      SIDE_TABLE.size,
      SIDE_TABLE.height,
      GOLD_HEX,
    ),
    box(
      SIDE_TABLE.x + 0.02,
      SIDE_TABLE.z + 0.02,
      SIDE_TABLE.size - 0.04,
      SIDE_TABLE.size - 0.04,
      0.01,
      GLASS_HEX,
      SIDE_TABLE.height,
    ),
    round(
      SIDE_TABLE.x + 0.25,
      SIDE_TABLE.z + 0.15,
      0.08,
      0.22,
      LAVENDER_HEX,
      SIDE_TABLE.height + 0.01,
      0.85,
    ),
    wallArt(0, 3.0, 0.03, 0.3, 0.38, 1.5, GOLD_HEX),
    wallArt(0, 3.02, 0.03, 0.3, 0.3, 1.05, GOLD_HEX),
    ...closetLeaf(CLOSET_DOOR.from, 1, [BAG_TAN_HEX, FRAME_HEX]),
    ...closetLeaf(CLOSET_DOOR.from + CLOSET_DOOR.width, -1, [
      FRAME_HEX,
      BAG_TAN_HEX,
    ]),
    round(SPHERE_LANTERN.x, SPHERE_LANTERN.z, 0.008, 0.05, FRAME_HEX, 2.25),
    ball(
      SPHERE_LANTERN.x,
      SPHERE_LANTERN.y,
      SPHERE_LANTERN.z,
      SPHERE_LANTERN.radius,
      LANTERN_HEX,
    ),
    round(
      CEILING_LIGHT.x,
      CEILING_LIGHT.z,
      0.2,
      0.09,
      STEEL_HEX,
      WALL_HEIGHT - 0.09,
      0.9,
    ),
    round(
      UFO_LIGHT.x,
      UFO_LIGHT.z,
      0.008,
      WALL_HEIGHT - UFO_LIGHT.elevation - UFO_LIGHT.height,
      FRAME_HEX,
      UFO_LIGHT.elevation + UFO_LIGHT.height,
    ),
    round(
      UFO_LIGHT.x,
      UFO_LIGHT.z,
      0.2,
      UFO_LIGHT.height,
      STEEL_HEX,
      UFO_LIGHT.elevation,
      0.9,
    ),
  ],
  lightSpots: [
    {
      x: SPHERE_LANTERN.x,
      y: SPHERE_LANTERN.y,
      z: SPHERE_LANTERN.z,
    },
    { x: UFO_LIGHT.x, y: UFO_LIGHT.elevation - 0.05, z: UFO_LIGHT.z },
  ],
}

const VANITY = { x: 1.5, depth: 0.55, width: 1.35 }
const VANITY_TOP = 0.86
const BATHROOM_ORB = { x: 1.65, z: 4.92, radius: 0.13 }
const LAUNDRY_DEPTH = 0.62
const APPLIANCE_WIDTH = 0.72
const APPLIANCE_HEIGHT = 0.92
const PARTITION = { z: 5.7, depth: 0.06, end: 0.9 }
const TUB_NORTH = PARTITION.z + PARTITION.depth
const TUB = { x: 0.05, width: 0.8, depth: KITCHEN_SOUTH - 0.02 - TUB_NORTH }
const CURTAIN_X = TUB.x + TUB.width + 0.02
const CURTAIN_ELEVATION = 0.15
const CURTAIN_HEIGHT = 1.85
const TOILET_X = 1.31
const FAR_WALL_ART_Z = KITCHEN_SOUTH - 0.03

const washerOrDryer = (x: number): ReadonlyArray<Furniture> => [
  box(
    x,
    BEDROOM_DEPTH + 0.02,
    APPLIANCE_WIDTH,
    LAUNDRY_DEPTH,
    APPLIANCE_HEIGHT,
    WHITE_HEX,
  ),
  box(x, BEDROOM_DEPTH + 0.02, APPLIANCE_WIDTH, 0.08, 0.14, WHITE_HEX, 0.92),
]

const BATHROOM: HouseRoom = {
  id: 'Bathroom',
  label: 'Bathroom',
  labelSpot: { x: 2.75, z: 5.9 },
  x: 0,
  z: BEDROOM_DEPTH,
  width: GREAT_ROOM_WEST,
  depth: KITCHEN_SOUTH - BEDROOM_DEPTH,
  floorHex: FLOOR_HEX,
  lightSpace: 'Bathroom',
  withinRoomId: Option.none(),
  annexes: [],
  doors: [{ side: 'East', from: BATHROOM_DOOR_FROM, width: DOOR_WIDTH }],
  furniture: [
    ...washerOrDryer(0.05),
    ...washerOrDryer(0.77),
    box(
      VANITY.x,
      BEDROOM_DEPTH + 0.02,
      VANITY.width,
      VANITY.depth,
      0.82,
      CABINET_HEX,
    ),
    box(
      VANITY.x,
      BEDROOM_DEPTH,
      VANITY.width + 0.02,
      VANITY.depth + 0.02,
      COUNTER_THICKNESS,
      QUARTZ_HEX,
      VANITY_TOP - COUNTER_THICKNESS,
    ),
    box(2.05, 4.72, 0.5, 0.3, 0.01, PORCELAIN_HEX, VANITY_TOP),
    ball(
      BATHROOM_ORB.x,
      VANITY_TOP + BATHROOM_ORB.radius,
      BATHROOM_ORB.z,
      BATHROOM_ORB.radius,
      LANTERN_HEX,
    ),
    box(VANITY.x, BEDROOM_DEPTH, VANITY.width, 0.02, 0.3, TILE_HEX, VANITY_TOP),
    box(0.5, BEDROOM_DEPTH, 1.1, 0.33, 0.62, CABINET_HEX, 1.55),
    box(1.62, BEDROOM_DEPTH, 1.23, 0.03, 0.78, GOLD_HEX, 1.18),
    box(1.6, 5.2, 0.85, 0.5, 0.015, RUG_HEX),
    box(2.92, BEDROOM_DEPTH + 0.05, 0.4, 0.46, 0.6, FRAME_HEX),
    box(3.36, BEDROOM_DEPTH + 0.05, 0.22, 0.4, 0.85, WHITE_HEX),

    box(0, 5.02, 0.03, 0.66, 1, WHITE_HEX, 1.05),
    box(0.01, 5.1, 0.04, 0.5, 0.8, GLASS_HEX, 1.15),
    box(0.05, 5.26, 0.36, 0.42, 0.68, FRAME_HEX),

    box(
      0,
      PARTITION.z,
      PARTITION.end,
      PARTITION.depth,
      WALL_HEIGHT,
      PARTITION_HEX,
    ),
    box(
      PARTITION.end,
      PARTITION.z + 0.02,
      0.62,
      0.02,
      WALL_HEIGHT - 0.3,
      TABLE_GLASS_HEX,
    ),
    box(PARTITION.end + 0.02, PARTITION.z - 0.2, 0.26, 0.1, 0.08, VACUUM_HEX),
    round(PARTITION.end + 0.08, PARTITION.z - 0.12, 0.015, 1.05, VACUUM_HEX),
    box(
      PARTITION.end + 0.02,
      PARTITION.z - 0.16,
      0.14,
      0.14,
      0.2,
      FRAME_HEX,
      1.05,
    ),

    box(TUB.x, TUB_NORTH, TUB.width, TUB.depth, 0.52, PORCELAIN_HEX),
    box(
      TUB.x + 0.07,
      TUB_NORTH + 0.08,
      TUB.width - 0.14,
      TUB.depth - 0.16,
      0.01,
      BIN_HEX,
      0.52,
    ),
    box(
      CURTAIN_X,
      TUB_NORTH,
      0.03,
      TUB.depth,
      CURTAIN_HEIGHT,
      CURTAIN_HEX,
      CURTAIN_ELEVATION,
    ),
    box(
      CURTAIN_X,
      TUB_NORTH,
      0.03,
      TUB.depth,
      0.02,
      STEEL_HEX,
      CURTAIN_ELEVATION + CURTAIN_HEIGHT,
    ),

    box(TOILET_X - 0.21, 6.66, 0.42, 0.22, 0.75, PORCELAIN_HEX),
    round(TOILET_X, 6.42, 0.19, 0.42, PORCELAIN_HEX),
    box(TOILET_X - 0.21, 6.18, 0.42, 0.2, 0.18, OAK_HEX),
    box(1.57, 6.62, 0.16, 0.16, 0.3, WHITE_HEX),
    box(1.78, 6.4, 0.45, 0.48, 0.2, WICKER_HEX),
    box(1.82, 6.46, 0.37, 0.36, 0.01, FRAME_HEX, 0.2),
    box(1.8, 6.05, 0.4, 0.3, 0.015, WICKER_HEX),
    wallArt(1.8, FAR_WALL_ART_Z, 0.32, 0.03, 0.42, 1.25, GOLD_HEX),
    wallArt(2.32, FAR_WALL_ART_Z, 0.3, 0.03, 0.38, 1.55, STEEL_HEX),
    box(3.54, 6.35, 0.03, 0.5, 0.02, STEEL_HEX, 1.15),
    box(3.52, 6.38, 0.06, 0.44, 0.69, PILLOW_HEX, 0.47),
  ],
  lightSpots: [
    {
      x: BATHROOM_ORB.x,
      y: VANITY_TOP + BATHROOM_ORB.radius,
      z: BATHROOM_ORB.z,
    },
  ],
}

export const ROOMS: ReadonlyArray<HouseRoom> = [
  LIVING_ROOM,
  KITCHEN,
  STAIRS,
  BEDROOM,
  CLOSET,
  BATHROOM,
]
