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
import {
  type Door,
  type HouseRoom,
  ROOMS,
  RoomId,
  type WallSide,
} from './housePlan'

const FREE_STANDING_HEIGHT = 1.85
const MIN_LIT_LEVEL = 0.3

// MODEL

export const HouseBulb = Schema.Struct({
  name: Schema.String,
  roomId: RoomId,
  x: Schema.Number,
  y: Schema.Number,
  z: Schema.Number,
  isMounted: Schema.Boolean,
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

export type WallSpan = Readonly<{ from: number; to: number }>

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

const isNamedAfterRoom = (name: string, room: HouseRoom): boolean =>
  String.toLowerCase(name) === String.toLowerCase(room.label)

export const groupOfRoom = (
  room: HouseRoom,
  groups: ReadonlyArray<Group>,
): Option.Option<Group> =>
  Array.findFirst(
    groups,
    group =>
      isNamedAfterRoom(group.name, room) &&
      Array.isReadonlyArrayNonEmpty(group.memberAddresses),
  )

const isMemberOfRoomGroup = (
  light: Light,
  room: HouseRoom,
  groups: ReadonlyArray<Group>,
): boolean =>
  Option.exists(groupOfRoom(room, groups), group =>
    Array.contains(group.memberAddresses, light.address),
  )

const startsWithRoomName = (light: Light, room: HouseRoom): boolean =>
  String.startsWith(String.toLowerCase(room.label))(
    String.toLowerCase(light.name),
  )

const DEFAULT_ROOM_ID: RoomId = 'Hallway'

const roomIdOfLight = (light: Light, groups: ReadonlyArray<Group>): RoomId =>
  pipe(
    Array.findFirst(ROOMS, room => isMemberOfRoomGroup(light, room, groups)),
    Option.orElse(() =>
      Array.findFirst(ROOMS, room => startsWithRoomName(light, room)),
    ),
    Option.match({
      onNone: () => DEFAULT_ROOM_ID,
      onSome: room => room.id,
    }),
  )

export const sharesLight = (first: RoomId, second: RoomId): boolean =>
  Option.exists(
    Option.all([roomById(first), roomById(second)]),
    ([firstRoom, secondRoom]) => firstRoom.lightSpace === secondRoom.lightSpace,
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

const freeStandingSpot = (
  room: HouseRoom,
  index: number,
  count: number,
): Readonly<{ x: number; y: number; z: number; isMounted: boolean }> => {
  const columns = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / columns)
  const column = index % columns
  const row = Math.floor(index / columns)
  return {
    x: room.x + (room.width * (column + 0.5)) / columns,
    y: FREE_STANDING_HEIGHT,
    z: room.z + (room.depth * (row + 0.5)) / rows,
    isMounted: false,
  }
}

const spotInRoom = (room: HouseRoom, index: number, count: number) =>
  Option.match(Array.get(room.lightSpots, index), {
    onNone: () => freeStandingSpot(room, index, count),
    onSome: spot => ({ ...spot, isMounted: true }),
  })

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
