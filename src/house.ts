import {
  Array,
  Number,
  Option,
  Order,
  Record,
  Schema,
  String,
  pipe,
} from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import {
  type Group,
  type Light,
  type LightState,
  MAX_BRIGHTNESS,
  WARM_WHITE,
  hueSaturationToHex,
} from './domain'

// NOTE: This floor plan is a stand-in until the real house is modeled. Rooms
// light up by matching a Zigbee2MQTT group to a room label, so replacing this
// data is enough to move the 3D view to a different layout.

export const HOUSE_WIDTH = 12
export const HOUSE_DEPTH = 9
export const WALL_HEIGHT = 1.5
export const BULB_HEIGHT = 1.85

const MIN_LIT_LEVEL = 0.3
const DOOR_WIDTH = 1
const ARCHWAY_WIDTH = 2

// MODEL

export const RoomId = Schema.Literals([
  'LivingRoom',
  'Kitchen',
  'Bedroom',
  'Bathroom',
  'Hallway',
])
export type RoomId = typeof RoomId.Type

export const HouseBulb = Schema.Struct({
  name: Schema.String,
  roomId: RoomId,
  x: Schema.Number,
  z: Schema.Number,
  hex: Schema.String,
  level: Schema.Number,
})
export type HouseBulb = typeof HouseBulb.Type

export const HouseSelection = defineTaggedUnion({
  Nothing: {},
  Bulb: { name: Schema.String },
  Room: { roomId: RoomId },
})
export type HouseSelection = typeof HouseSelection.Type

export type WallSide = 'North' | 'South' | 'East' | 'West'

export type Door = Readonly<{ side: WallSide; from: number; width: number }>

export type Furniture = Readonly<{
  x: number
  z: number
  width: number
  depth: number
  height: number
  hex: string
  elevation?: number
}>

export type HouseRoom = Readonly<{
  id: RoomId
  label: string
  x: number
  z: number
  width: number
  depth: number
  floorHex: string
  doors: ReadonlyArray<Door>
  furniture: ReadonlyArray<Furniture>
}>

export type WallSpan = Readonly<{ from: number; to: number }>

const LIVING_ROOM: HouseRoom = {
  id: 'LivingRoom',
  label: 'Living Room',
  x: 0,
  z: 0,
  width: 7,
  depth: 5,
  floorHex: '#9a7b58',
  doors: [
    { side: 'South', from: 4, width: DOOR_WIDTH },
    { side: 'East', from: 1.5, width: ARCHWAY_WIDTH },
  ],
  furniture: [
    { x: 1.4, z: 1.4, width: 3.4, depth: 2.2, height: 0.02, hex: '#5c6b82' },
    { x: 1.5, z: 0.15, width: 3.2, depth: 1, height: 0.45, hex: '#6e7480' },
    { x: 1.5, z: 0.15, width: 3.2, depth: 0.3, height: 0.85, hex: '#626874' },
    { x: 2.4, z: 2.1, width: 1.4, depth: 0.7, height: 0.38, hex: '#5a4230' },
    { x: 0.1, z: 1.4, width: 0.45, depth: 2.2, height: 0.5, hex: '#3b3b42' },
  ],
}

const KITCHEN: HouseRoom = {
  id: 'Kitchen',
  label: 'Kitchen',
  x: 7,
  z: 0,
  width: 5,
  depth: 5,
  floorHex: '#a3a5a8',
  doors: [
    { side: 'West', from: 1.5, width: ARCHWAY_WIDTH },
    { side: 'South', from: 9, width: DOOR_WIDTH },
  ],
  furniture: [
    { x: 7.5, z: 0.05, width: 4.45, depth: 0.65, height: 0.9, hex: '#d6d2c8' },
    { x: 11.3, z: 0.7, width: 0.65, depth: 2.6, height: 0.9, hex: '#d6d2c8' },
    { x: 8.4, z: 2.3, width: 2, depth: 1, height: 0.92, hex: '#54605c' },
  ],
}

const BEDROOM: HouseRoom = {
  id: 'Bedroom',
  label: 'Bedroom',
  x: 7,
  z: 5,
  width: 5,
  depth: 4,
  floorHex: '#7c7388',
  doors: [
    { side: 'West', from: 6.5, width: DOOR_WIDTH },
    { side: 'North', from: 9, width: DOOR_WIDTH },
  ],
  furniture: [
    { x: 9.7, z: 6, width: 2.2, depth: 1.9, height: 0.5, hex: '#c9c4d6' },
    { x: 11.3, z: 6.1, width: 0.5, depth: 1.7, height: 0.66, hex: '#ece8f2' },
    { x: 11.45, z: 5.5, width: 0.5, depth: 0.45, height: 0.5, hex: '#5a4230' },
    { x: 7.5, z: 8.4, width: 2.4, depth: 0.55, height: 1.3, hex: '#4d4238' },
  ],
}

const BATHROOM: HouseRoom = {
  id: 'Bathroom',
  label: 'Bathroom',
  x: 0,
  z: 5,
  width: 3,
  depth: 4,
  floorHex: '#94a7ad',
  doors: [{ side: 'East', from: 6.5, width: DOOR_WIDTH }],
  furniture: [
    { x: 0.1, z: 5.1, width: 0.95, depth: 1.9, height: 0.55, hex: '#e7ecee' },
    { x: 2.35, z: 8.15, width: 0.6, depth: 0.75, height: 0.8, hex: '#dfe5e8' },
    { x: 0.2, z: 8.2, width: 0.45, depth: 0.65, height: 0.42, hex: '#eef1f2' },
  ],
}

const HALLWAY: HouseRoom = {
  id: 'Hallway',
  label: 'Hallway',
  x: 3,
  z: 5,
  width: 4,
  depth: 4,
  floorHex: '#856f58',
  doors: [
    { side: 'North', from: 4, width: DOOR_WIDTH },
    { side: 'West', from: 6.5, width: DOOR_WIDTH },
    { side: 'East', from: 6.5, width: DOOR_WIDTH },
  ],
  furniture: [
    { x: 4, z: 8.55, width: 1.8, depth: 0.4, height: 0.8, hex: '#5a4230' },
  ],
}

export const ROOMS: ReadonlyArray<HouseRoom> = [
  LIVING_ROOM,
  KITCHEN,
  BEDROOM,
  BATHROOM,
  HALLWAY,
]

// DERIVED

const sideRange = (room: HouseRoom, side: WallSide): WallSpan =>
  side === 'North' || side === 'South'
    ? { from: room.x, to: room.x + room.width }
    : { from: room.z, to: room.z + room.depth }

const byDoorStart = Order.mapInput(Order.Number, (door: Door) => door.from)

export const wallSpans = (
  room: HouseRoom,
  side: WallSide,
): ReadonlyArray<WallSpan> => {
  const range = sideRange(room, side)
  const doors = pipe(
    room.doors,
    Array.filter(door => door.side === side),
    Array.sort(byDoorStart),
  )
  const { spans, start } = Array.reduce(
    doors,
    { spans: Array.empty<WallSpan>(), start: range.from },
    (progress, door) => ({
      spans: Array.append(progress.spans, {
        from: progress.start,
        to: door.from,
      }),
      start: door.from + door.width,
    }),
  )
  return Array.filter(
    Array.append(spans, { from: start, to: range.to }),
    span => span.to > span.from,
  )
}

export const roomById = (roomId: RoomId): Option.Option<HouseRoom> =>
  Array.findFirst(ROOMS, room => room.id === roomId)

export const groupOfRoom = (
  room: HouseRoom,
  groups: ReadonlyArray<Group>,
): Option.Option<Group> =>
  Array.findFirst(
    groups,
    group => String.toLowerCase(group.name) === String.toLowerCase(room.label),
  )

const roomIdOfLight = (light: Light, groups: ReadonlyArray<Group>): RoomId =>
  pipe(
    ROOMS,
    Array.findFirst(room =>
      Option.exists(groupOfRoom(room, groups), group =>
        Array.contains(group.memberAddresses, light.address),
      ),
    ),
    Option.match({
      onNone: () => 'Hallway',
      onSome: room => room.id,
    }),
  )

const lookOf = (
  maybeState: Option.Option<LightState>,
): Readonly<{ hex: string; level: number }> =>
  pipe(
    maybeState,
    Option.filter(state => state.power === 'ON'),
    Option.match({
      onNone: () => ({ hex: WARM_WHITE, level: 0 }),
      onSome: state => ({
        hex: Option.match(state.maybeHueSaturation, {
          onNone: () => WARM_WHITE,
          onSome: hueSaturationToHex,
        }),
        level: Math.max(MIN_LIT_LEVEL, state.brightness / MAX_BRIGHTNESS),
      }),
    }),
  )

const spotInRoom = (
  room: HouseRoom,
  index: number,
  count: number,
): Readonly<{ x: number; z: number }> => {
  const columns = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / columns)
  const column = index % columns
  const row = Math.floor(index / columns)
  return {
    x: room.x + (room.width * (column + 0.5)) / columns,
    z: room.z + (room.depth * (row + 0.5)) / rows,
  }
}

const byLightName = Order.mapInput(Order.String, (light: Light) => light.name)

export const placedBulbs = (
  lights: ReadonlyArray<Light>,
  groups: ReadonlyArray<Group>,
  states: Readonly<Record<string, LightState>>,
): ReadonlyArray<HouseBulb> =>
  Array.flatMap(ROOMS, room => {
    const roomLights = pipe(
      lights,
      Array.filter(light => roomIdOfLight(light, groups) === room.id),
      Array.sort(byLightName),
    )
    return Array.map(roomLights, (light, index) => ({
      name: light.name,
      roomId: room.id,
      ...spotInRoom(room, index, roomLights.length),
      ...lookOf(Record.get(states, light.name)),
    }))
  })

export const roomAt = (x: number, z: number): Option.Option<RoomId> =>
  pipe(
    ROOMS,
    Array.findFirst(
      room =>
        Number.between(x, { minimum: room.x, maximum: room.x + room.width }) &&
        Number.between(z, { minimum: room.z, maximum: room.z + room.depth }),
    ),
    Option.map(room => room.id),
  )

export type ScreenPoint = Readonly<{ name: string; x: number; y: number }>

const distanceTo = (point: ScreenPoint, x: number, y: number): number =>
  Math.hypot(point.x - x, point.y - y)

export const nearestBulbName = (
  points: ReadonlyArray<ScreenPoint>,
  x: number,
  y: number,
  radius: number,
): Option.Option<string> =>
  pipe(
    points,
    Array.filter(point => distanceTo(point, x, y) <= radius),
    Array.sort(
      Order.mapInput(Order.Number, (point: ScreenPoint) =>
        distanceTo(point, x, y),
      ),
    ),
    Array.head,
    Option.map(point => point.name),
  )
