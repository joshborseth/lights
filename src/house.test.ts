import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { type Group, type Light, type LightState } from './domain'
import {
  nearestBulbName,
  placedBulbs,
  roomAt,
  sharesLight,
  wallSpans,
} from './house'
import { type HouseRoom, ROOMS } from './housePlan'

const light = (name: string, address: string): Light => ({
  name,
  address,
  maybeColorTempRange: Option.none(),
  supportsColor: true,
})

const state = (overrides: Partial<LightState>): LightState => ({
  power: 'ON',
  brightness: 254,
  maybeColorTemp: Option.none(),
  maybeHueSaturation: Option.none(),
  ...overrides,
})

const groups: ReadonlyArray<Group> = [
  { name: 'Kitchen', memberAddresses: ['k1', 'k2'] },
  { name: 'bedroom', memberAddresses: ['b1'] },
  { name: 'All Lights', memberAddresses: ['k1', 'k2', 'b1', 'x1'] },
]

const room = (overrides: Partial<HouseRoom>): HouseRoom => ({
  id: 'Hallway',
  label: 'Test',
  x: 0,
  z: 0,
  width: 10,
  depth: 4,
  floorHex: '#000000',
  lightSpace: 'Test',
  doors: [],
  furniture: [],
  lightSpots: [],
  labelSpot: { x: 0, z: 0 },
  ...overrides,
})

const roomContaining = (x: number, z: number) =>
  ROOMS.find(
    candidate =>
      x >= candidate.x &&
      x <= candidate.x + candidate.width &&
      z >= candidate.z &&
      z <= candidate.z + candidate.depth,
  )

describe('placedBulbs', () => {
  const lights = [
    light('Kitchen B', 'k2'),
    light('Kitchen A', 'k1'),
    light('Bed', 'b1'),
    light('Porch', 'x1'),
  ]

  test('puts a bulb in the room whose label matches its group, ignoring case', () => {
    const roomIds = placedBulbs(lights, groups, {}).map(bulb => [
      bulb.name,
      bulb.roomId,
    ])

    expect(roomIds).toContainEqual(['Kitchen A', 'Kitchen'])
    expect(roomIds).toContainEqual(['Kitchen B', 'Kitchen'])
    expect(roomIds).toContainEqual(['Bed', 'Bedroom'])
  })

  test('puts a bulb with no matching room in the hallway', () => {
    expect(
      placedBulbs(lights, groups, {}).find(bulb => bulb.name === 'Porch')
        ?.roomId,
    ).toBe('Hallway')
  })

  test('keeps every bulb inside its room and gives each its own spot', () => {
    const manyLights = Array.from({ length: 7 }, (_, index) =>
      light(`Kitchen ${index}`, `m${index}`),
    )
    const manyGroups = [
      {
        name: 'Kitchen',
        memberAddresses: manyLights.map(({ address }) => address),
      },
    ]
    const bulbs = placedBulbs(manyLights, manyGroups, {})

    bulbs.forEach(bulb => {
      expect(roomContaining(bulb.x, bulb.z)?.id).toBe('Kitchen')
    })
    expect(new Set(bulbs.map(bulb => `${bulb.x},${bulb.z}`)).size).toBe(7)
  })

  test('uses a bulb name when its room group is empty or missing', () => {
    const named = [light('Kitchen Light Left', 'l'), light('Bathroom Orb', 'o')]
    const roomIds = placedBulbs(
      named,
      [{ name: 'Kitchen', memberAddresses: [] }],
      {},
    ).map(bulb => [bulb.name, bulb.roomId])

    expect(roomIds).toContainEqual(['Kitchen Light Left', 'Kitchen'])
    expect(roomIds).toContainEqual(['Bathroom Orb', 'Bathroom'])
  })

  test('mounts bulbs on the fixtures of their room in name order', () => {
    const bulbs = placedBulbs(
      [light('Kitchen Light B', 'b'), light('Kitchen Light A', 'a')],
      [],
      {},
    )
    const spots = ROOMS.find(({ id }) => id === 'Kitchen')?.lightSpots

    expect(bulbs.map(({ name }) => name)).toEqual([
      'Kitchen Light A',
      'Kitchen Light B',
    ])
    expect(bulbs.map(({ x, y, z }) => ({ x, y, z }))).toEqual(spots)
    expect(bulbs.every(({ isMounted }) => isMounted)).toBe(true)
  })

  test('stands a bulb on its own when its room has no fixture left', () => {
    const bulb = placedBulbs([light('Porch', 'p')], [], {})[0]

    expect(bulb?.roomId).toBe('Hallway')
    expect(bulb?.isMounted).toBe(false)
  })

  test('shows a bulb that is off or has not reported as dark', () => {
    const bulbs = placedBulbs(lights, groups, {
      'Kitchen A': state({ power: 'OFF' }),
    })

    expect(bulbs.find(bulb => bulb.name === 'Kitchen A')?.level).toBe(0)
    expect(bulbs.find(bulb => bulb.name === 'Kitchen B')?.level).toBe(0)
  })

  test('shows the reported color and brightness of a bulb that is on', () => {
    const bulb = placedBulbs(lights, groups, {
      Bed: state({
        brightness: 127,
        maybeHueSaturation: Option.some({ hue: 0, saturation: 100 }),
      }),
    }).find(({ name }) => name === 'Bed')

    expect(bulb?.hex.toLowerCase()).toBe('#ff0000')
    expect(bulb?.level).toBeCloseTo(0.5)
  })

  test('keeps a very dim bulb visible', () => {
    expect(
      placedBulbs(lights, groups, { Bed: state({ brightness: 1 }) }).find(
        ({ name }) => name === 'Bed',
      )?.level,
    ).toBe(0.3)
  })
})

describe('wallSpans', () => {
  test('returns the whole side when there is no door', () => {
    expect(wallSpans(room({}), 'North')).toEqual([{ from: 0, to: 10 }])
  })

  test('leaves a gap for each door', () => {
    expect(
      wallSpans(
        room({
          doors: [
            { side: 'North', from: 6, width: 1 },
            { side: 'North', from: 2, width: 1 },
            { side: 'East', from: 1, width: 1 },
          ],
        }),
        'North',
      ),
    ).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 6 },
      { from: 7, to: 10 },
    ])
  })

  test('drops an empty span when a door touches a corner', () => {
    expect(
      wallSpans(room({ doors: [{ side: 'West', from: 0, width: 1 }] }), 'West'),
    ).toEqual([{ from: 1, to: 4 }])
  })

  test('adjoining rooms cut matching door gaps in their shared walls', () => {
    const doorRanges = (roomId: string, side: string) =>
      ROOMS.find(candidate => candidate.id === roomId)
        ?.doors.filter(door => door.side === side)
        .map(({ from, width }) => [from, width])

    expect(doorRanges('LivingRoom', 'South')).toEqual(
      doorRanges('Dining', 'North'),
    )
    expect(doorRanges('Dining', 'South')).toEqual(
      doorRanges('Kitchen', 'North'),
    )
    expect(doorRanges('Kitchen', 'South')).toEqual(
      doorRanges('Hallway', 'North'),
    )
    expect(doorRanges('Hallway', 'West')).toEqual(
      doorRanges('Bathroom', 'East'),
    )
    expect(doorRanges('Hallway', 'East')).toEqual(doorRanges('Bedroom', 'West'))
  })
})

describe('sharesLight', () => {
  test('rooms in the open great room light each other', () => {
    expect(sharesLight('Kitchen', 'LivingRoom')).toBe(true)
    expect(sharesLight('Dining', 'Kitchen')).toBe(true)
  })

  test('light stays inside a closed room', () => {
    expect(sharesLight('Bedroom', 'Hallway')).toBe(false)
    expect(sharesLight('Kitchen', 'Bathroom')).toBe(false)
  })
})

describe('roomAt', () => {
  test('finds the room under a floor point', () => {
    expect(roomAt(1, 1)).toEqual(Option.some('LivingRoom'))
    expect(roomAt(8, 11)).toEqual(Option.some('Bedroom'))
  })

  test('finds nothing outside the house', () => {
    expect(roomAt(-1, 1)).toEqual(Option.none())
    expect(roomAt(6, 20)).toEqual(Option.none())
  })
})

describe('nearestBulbName', () => {
  const points = [
    { name: 'Far', x: 100, y: 100 },
    { name: 'Near', x: 10, y: 10 },
  ]

  test('picks the closest bulb inside the radius', () => {
    expect(nearestBulbName(points, 12, 12, 30)).toEqual(Option.some('Near'))
  })

  test('picks nothing when every bulb is outside the radius', () => {
    expect(nearestBulbName(points, 300, 300, 30)).toEqual(Option.none())
  })
})
