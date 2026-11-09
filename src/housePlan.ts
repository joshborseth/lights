import { Schema } from 'effect'

// NOTE: A first pass at the real home, estimated from photos, so sizes are
// approximate. North is the sliding door, x grows east, and z grows south. The
// bedroom and bathroom were not photographed, so those two are guesses.

export const HOUSE_WIDTH = 9.6
export const HOUSE_DEPTH = 13.4
export const WALL_HEIGHT = 2.2

const GREAT_ROOM_WIDTH = 5.6
const GREAT_ROOM = 'GreatRoom'

const HARDWOOD_HEX = '#6b442d'
const CARPET_HEX = '#7c7388'
const TILE_HEX = '#94a7ad'
const CABINET_HEX = '#e4e0d8'
const COUNTER_HEX = '#d9d3c4'
const STEEL_HEX = '#a3a5a7'
const DARK_STEEL_HEX = '#44464a'
const SOFA_HEX = '#5a5652'
const SOFA_BACK_HEX = '#4e4a47'
const ARMCHAIR_HEX = '#76705f'
const DARK_WOOD_HEX = '#4a3324'
const MEDIUM_WOOD_HEX = '#7a5634'
const WHITE_HEX = '#ece9e2'
const RUG_HEX = '#aaa596'
const GLASS_HEX = '#121a26'
const BLIND_HEX = '#d8d4c8'
const SHADE_HEX = '#ead9ae'
const DRUM_HEX = '#b8b3a6'
const STONE_HEX = '#8a8375'
const FAN_HEX = '#cfccc4'
const FRAME_HEX = '#2c2a28'
const SCREEN_HEX = '#1a2740'
const PORCELAIN_HEX = '#e7ecee'
const PILLOW_RED_HEX = '#94363a'
const PILLOW_TAN_HEX = '#b5a98e'
const BEDDING_HEX = '#c9c4d6'
const PILLOW_HEX = '#ece8f2'

const STOOL_SEAT_HEIGHT = 0.64
const DINING_SEAT_HEIGHT = 0.45
const TABLE_HEIGHT = 0.73
const COUNTER_HEIGHT = 0.9
const ISLAND_HEIGHT = 0.92
const UPPER_ELEVATION = 1.4
const UPPER_HEIGHT = 0.72
const LAMP_SHADE_HEIGHT = 0.26
const LAMP_SHADE_RADIUS = 0.19
const LAMP_SHADE_TAPER = 0.62
const LAMP_BASE_HEIGHT = 0.34
const DOME_HEIGHT = 0.2
const DOME_ELEVATION = 1.72
const DOME_RADIUS = 0.24
const DOME_TAPER = 0.32

// MODEL

export const RoomId = Schema.Literals([
  'LivingRoom',
  'Dining',
  'Kitchen',
  'Hallway',
  'Bedroom',
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
  shape: 'Box' | 'Round'
  taper: number
  turn: number
}>

export type LightSpot = Readonly<{ x: number; y: number; z: number }>

export type HouseRoom = Readonly<{
  id: RoomId
  label: string
  x: number
  z: number
  width: number
  depth: number
  floorHex: string
  lightSpace: string
  doors: ReadonlyArray<Door>
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
  turn = 0,
): Furniture => ({
  x,
  z,
  width,
  depth,
  height,
  hex,
  elevation,
  turn,
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

const tableLamp = (
  x: number,
  z: number,
  surface: number,
): ReadonlyArray<Furniture> => [
  round(x, z, 0.07, LAMP_BASE_HEIGHT, DARK_STEEL_HEX, surface),
  round(
    x,
    z,
    LAMP_SHADE_RADIUS,
    LAMP_SHADE_HEIGHT,
    SHADE_HEX,
    surface + LAMP_BASE_HEIGHT,
    LAMP_SHADE_TAPER,
  ),
]

const tableLampSpot = (x: number, z: number, surface: number): LightSpot => ({
  x,
  y: surface + LAMP_BASE_HEIGHT + LAMP_SHADE_HEIGHT / 2,
  z,
})

const domePendant = (x: number, z: number): ReadonlyArray<Furniture> => [
  round(x, z, DOME_RADIUS, DOME_HEIGHT, STEEL_HEX, DOME_ELEVATION, DOME_TAPER),
  round(x, z, 0.012, 0.3, STEEL_HEX, DOME_ELEVATION + DOME_HEIGHT),
]

const domePendantSpot = (x: number, z: number): LightSpot => ({
  x,
  y: DOME_ELEVATION - 0.04,
  z,
})

const barStool = (x: number, z: number): ReadonlyArray<Furniture> => [
  box(x - 0.21, z - 0.21, 0.42, 0.42, 0.04, WHITE_HEX, STOOL_SEAT_HEIGHT),
  box(x - 0.03, z - 0.03, 0.06, 0.06, STOOL_SEAT_HEIGHT, WHITE_HEX),
  box(x - 0.2, z - 0.24, 0.4, 0.04, 0.38, WHITE_HEX, STOOL_SEAT_HEIGHT),
]

const diningChair = (
  x: number,
  z: number,
  backOffsetX: number,
  backOffsetZ: number,
): ReadonlyArray<Furniture> => [
  box(x - 0.2, z - 0.2, 0.4, 0.4, 0.04, WHITE_HEX, DINING_SEAT_HEIGHT),
  box(x - 0.03, z - 0.03, 0.06, 0.06, DINING_SEAT_HEIGHT, WHITE_HEX),
  box(
    x + backOffsetX - 0.17,
    z + backOffsetZ - 0.17,
    0.34,
    0.34,
    0.42,
    WHITE_HEX,
    DINING_SEAT_HEIGHT,
  ),
]

// ROOMS

const OPEN_SOUTH: Door = { side: 'South', from: 0, width: GREAT_ROOM_WIDTH }
const OPEN_NORTH: Door = { side: 'North', from: 0, width: GREAT_ROOM_WIDTH }

const CONSOLE_LAMP = { x: 4.55, z: 5.2, surface: 0.79 }
const SIDE_TABLE_LAMP = { x: 0.55, z: 4.0, surface: 0.55 }
const FLOOR_LAMP = { x: 4.62, z: 0.36 }
const FLOOR_LAMP_HEIGHT = 1.28

const LIVING_ROOM: HouseRoom = {
  id: 'LivingRoom',
  label: 'Living Room',
  labelSpot: { x: 2.6, z: 3.2 },
  x: 0,
  z: 0,
  width: GREAT_ROOM_WIDTH,
  depth: 5.4,
  floorHex: HARDWOOD_HEX,
  lightSpace: GREAT_ROOM,
  doors: [OPEN_SOUTH],
  furniture: [
    box(0.8, 1.0, 3.6, 4.1, 0.015, RUG_HEX),
    box(0.85, 0.05, 1.5, 0.45, 0.75, MEDIUM_WOOD_HEX),
    box(0.92, 0.2, 1.36, 0.06, 0.78, SCREEN_HEX, 0.78),
    box(2.75, 0, 1.6, 0.04, 2.05, GLASS_HEX),
    box(2.15, 0, 0.6, 0.07, 2.05, BLIND_HEX),
    box(4.55, 0.27, 1.1, 0.46, 1.12, STONE_HEX, 0, -Math.PI / 4),
    box(4.5, 0.24, 1.2, 0.52, 0.06, WHITE_HEX, 1.12, -Math.PI / 4),
    round(FLOOR_LAMP.x, FLOOR_LAMP.z, 0.14, 0.03, DARK_STEEL_HEX),
    round(FLOOR_LAMP.x, FLOOR_LAMP.z, 0.016, FLOOR_LAMP_HEIGHT, DARK_STEEL_HEX),
    round(
      FLOOR_LAMP.x,
      FLOOR_LAMP.z,
      0.22,
      0.32,
      SHADE_HEX,
      FLOOR_LAMP_HEIGHT,
      LAMP_SHADE_TAPER,
    ),
    box(2.45, 4.08, 3.1, 0.95, 0.44, SOFA_HEX),
    box(2.45, 4.75, 3.1, 0.28, 0.86, SOFA_BACK_HEX),
    box(4.6, 1.3, 0.95, 2.78, 0.44, SOFA_HEX),
    box(5.27, 1.3, 0.28, 3.5, 0.86, SOFA_BACK_HEX),
    box(4.65, 1.5, 0.3, 0.46, 0.3, PILLOW_RED_HEX, 0.44),
    box(4.65, 2.2, 0.3, 0.46, 0.3, PILLOW_TAN_HEX, 0.44),
    box(0.25, 2.5, 0.95, 0.95, 0.44, ARMCHAIR_HEX),
    box(0.25, 2.5, 0.28, 0.95, 0.85, ARMCHAIR_HEX),
    box(0.15, 3.6, 0.85, 0.85, SIDE_TABLE_LAMP.surface, DARK_WOOD_HEX),
    ...tableLamp(SIDE_TABLE_LAMP.x, SIDE_TABLE_LAMP.z, SIDE_TABLE_LAMP.surface),
    box(2.95, 5.03, 2.25, 0.36, 0.05, WHITE_HEX, CONSOLE_LAMP.surface - 0.05),
    box(2.95, 5.03, 0.05, 0.36, CONSOLE_LAMP.surface - 0.05, WHITE_HEX),
    box(5.15, 5.03, 0.05, 0.36, CONSOLE_LAMP.surface - 0.05, WHITE_HEX),
    ...tableLamp(CONSOLE_LAMP.x, CONSOLE_LAMP.z, CONSOLE_LAMP.surface),
    round(2.9, 2.6, 0.13, 0.14, FAN_HEX, 2.02),
    box(2.3, 2.53, 1.2, 0.14, 0.015, FAN_HEX, 2.06, Math.PI / 4),
    box(2.3, 2.53, 1.2, 0.14, 0.015, FAN_HEX, 2.06, -Math.PI / 4),
    box(0, 0.9, 0.04, 1.2, 1.3, BLIND_HEX, 0.8),
    box(0, 2.5, 0.04, 1.2, 1.3, BLIND_HEX, 0.8),
    box(5.56, 1.7, 0.04, 0.48, 0.66, FRAME_HEX, 1.25),
    box(5.56, 2.4, 0.04, 0.48, 0.66, FRAME_HEX, 1.25),
    box(5.56, 3.1, 0.04, 0.48, 0.66, FRAME_HEX, 1.25),
  ],
  lightSpots: [
    tableLampSpot(CONSOLE_LAMP.x, CONSOLE_LAMP.z, CONSOLE_LAMP.surface),
    tableLampSpot(
      SIDE_TABLE_LAMP.x,
      SIDE_TABLE_LAMP.z,
      SIDE_TABLE_LAMP.surface,
    ),
    { x: FLOOR_LAMP.x, y: FLOOR_LAMP_HEIGHT + 0.16, z: FLOOR_LAMP.z },
  ],
}

const DINING_TABLE = { x: 1.3, z: 6.4 }

const DINING: HouseRoom = {
  id: 'Dining',
  label: 'Dining',
  labelSpot: { x: 3.8, z: 6.4 },
  x: 0,
  z: 5.4,
  width: GREAT_ROOM_WIDTH,
  depth: 2,
  floorHex: HARDWOOD_HEX,
  lightSpace: GREAT_ROOM,
  doors: [OPEN_NORTH, OPEN_SOUTH],
  furniture: [
    round(DINING_TABLE.x, DINING_TABLE.z, 0.56, 0.04, WHITE_HEX, TABLE_HEIGHT),
    round(DINING_TABLE.x, DINING_TABLE.z, 0.12, TABLE_HEIGHT, WHITE_HEX),
    ...diningChair(DINING_TABLE.x, DINING_TABLE.z - 0.78, 0, -0.18),
    ...diningChair(DINING_TABLE.x, DINING_TABLE.z + 0.78, 0, 0.18),
    ...diningChair(DINING_TABLE.x + 0.8, DINING_TABLE.z, 0.18, 0),
    round(DINING_TABLE.x, DINING_TABLE.z, 0.42, 0.26, DRUM_HEX, 1.78),
    round(DINING_TABLE.x, DINING_TABLE.z, 0.012, 0.18, DRUM_HEX, 2.04),
    box(0, 5.65, 0.04, 1.5, 1.25, GLASS_HEX, 0.85),
  ],
  lightSpots: [],
}

const STOVE = { x: 1.9, width: 0.76 }
const KITCHEN_SOUTH_RUN_END = 3.8
const KITCHEN_BACK_Z = 10.8
const PENDANT_Z = 9.25
const LEFT_PENDANT_X = 2.15
const RIGHT_PENDANT_X = 3.3

const KITCHEN: HouseRoom = {
  id: 'Kitchen',
  label: 'Kitchen',
  labelSpot: { x: 2.7, z: 10.35 },
  x: 0,
  z: 7.4,
  width: GREAT_ROOM_WIDTH,
  depth: 4,
  floorHex: HARDWOOD_HEX,
  lightSpace: GREAT_ROOM,
  doors: [OPEN_NORTH, { side: 'South', from: 4, width: 1 }],
  furniture: [
    box(
      0,
      KITCHEN_BACK_Z,
      KITCHEN_SOUTH_RUN_END,
      0.6,
      COUNTER_HEIGHT,
      CABINET_HEX,
    ),
    box(
      0,
      KITCHEN_BACK_Z - 0.02,
      KITCHEN_SOUTH_RUN_END + 0.02,
      0.62,
      0.04,
      COUNTER_HEX,
      COUNTER_HEIGHT,
    ),
    box(
      STOVE.x,
      KITCHEN_BACK_Z - 0.04,
      STOVE.width,
      0.64,
      0.96,
      DARK_STEEL_HEX,
    ),
    box(STOVE.x, 10.98, STOVE.width, 0.42, 0.12, STEEL_HEX, 1.48),
    box(
      0.4,
      11.07,
      STOVE.x - 0.4,
      0.33,
      UPPER_HEIGHT,
      CABINET_HEX,
      UPPER_ELEVATION,
    ),
    box(
      STOVE.x + STOVE.width,
      11.07,
      KITCHEN_SOUTH_RUN_END - STOVE.x - STOVE.width,
      0.33,
      UPPER_HEIGHT,
      CABINET_HEX,
      UPPER_ELEVATION,
    ),
    box(0, 8.3, 0.6, 2.5, COUNTER_HEIGHT, CABINET_HEX),
    box(0, 8.3, 0.62, 2.5, 0.04, COUNTER_HEX, COUNTER_HEIGHT),
    box(0, 8.75, 0.04, 1.3, 0.85, GLASS_HEX, 1.1),
    box(0, 10.3, 0.33, 0.77, UPPER_HEIGHT, CABINET_HEX, UPPER_ELEVATION),
    box(5, 7.8, 0.6, 1.8, 0.78, CABINET_HEX),
    box(4.98, 7.8, 0.62, 1.8, 0.04, COUNTER_HEX, 0.78),
    box(5.27, 7.8, 0.33, 1.8, UPPER_HEIGHT, CABINET_HEX, UPPER_ELEVATION),
    box(4.85, 9.65, 0.75, 0.9, 1.78, STEEL_HEX),
    box(1.6, 8.7, 2.3, 1.1, ISLAND_HEIGHT - 0.04, CABINET_HEX),
    box(1.56, 8.66, 2.38, 1.18, 0.04, COUNTER_HEX, ISLAND_HEIGHT - 0.04),
    ...barStool(2.05, 8.34),
    ...barStool(2.75, 8.34),
    ...barStool(3.45, 8.34),
    ...domePendant(LEFT_PENDANT_X, PENDANT_Z),
    ...domePendant(RIGHT_PENDANT_X, PENDANT_Z),
  ],
  lightSpots: [
    domePendantSpot(LEFT_PENDANT_X, PENDANT_Z),
    domePendantSpot(RIGHT_PENDANT_X, PENDANT_Z),
  ],
}

const HALLWAY: HouseRoom = {
  id: 'Hallway',
  label: 'Hallway',
  labelSpot: { x: 4.6, z: 12.2 },
  x: 3.6,
  z: 11.4,
  width: 2,
  depth: 1.6,
  floorHex: HARDWOOD_HEX,
  lightSpace: 'Hallway',
  doors: [
    { side: 'North', from: 4, width: 1 },
    { side: 'West', from: 11.8, width: 0.8 },
    { side: 'East', from: 11.7, width: 1 },
  ],
  furniture: [],
  lightSpots: [],
}

const BEDROOM: HouseRoom = {
  id: 'Bedroom',
  label: 'Bedroom',
  labelSpot: { x: 8.3, z: 12.55 },
  x: 5.6,
  z: 9,
  width: 4,
  depth: 4,
  floorHex: CARPET_HEX,
  lightSpace: 'Bedroom',
  doors: [{ side: 'West', from: 11.7, width: 1 }],
  furniture: [
    box(7.4, 9.9, 2.15, 1.9, 0.5, BEDDING_HEX),
    box(8.98, 10, 0.5, 1.7, 0.66, PILLOW_HEX),
    box(9.05, 9.3, 0.5, 0.5, 0.5, DARK_WOOD_HEX),
    box(9.05, 11.9, 0.5, 0.5, 0.5, DARK_WOOD_HEX),
    ...tableLamp(9.3, 9.55, 0.5),
    ...tableLamp(9.3, 12.15, 0.5),
    box(6, 9.05, 2.3, 0.55, 1.4, DARK_WOOD_HEX),
  ],
  lightSpots: [tableLampSpot(9.3, 9.55, 0.5), tableLampSpot(9.3, 12.15, 0.5)],
}

const BATHROOM: HouseRoom = {
  id: 'Bathroom',
  label: 'Bathroom',
  labelSpot: { x: 2.2, z: 12.45 },
  x: 0.8,
  z: 11.4,
  width: 2.8,
  depth: 2,
  floorHex: TILE_HEX,
  lightSpace: 'Bathroom',
  doors: [{ side: 'East', from: 11.8, width: 0.8 }],
  furniture: [
    box(0.9, 11.5, 1.75, 0.8, 0.55, PORCELAIN_HEX),
    box(2.75, 12.82, 0.75, 0.52, 0.82, CABINET_HEX),
    box(1.2, 12.75, 0.42, 0.6, 0.42, PORCELAIN_HEX),
    round(2.2, 12.4, 0.16, 0.08, PORCELAIN_HEX, 2.08),
  ],
  lightSpots: [{ x: 2.2, y: 2.02, z: 12.4 }],
}

export const ROOMS: ReadonlyArray<HouseRoom> = [
  LIVING_ROOM,
  DINING,
  KITCHEN,
  HALLWAY,
  BEDROOM,
  BATHROOM,
]
