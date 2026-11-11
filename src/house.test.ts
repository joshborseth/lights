import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { type Group, type Light, type LightState } from './domain'
import { nearestBulbName, placedBulbs, roomAreas, wallSpans } from './house'
import {
  HOUSE_DEPTH,
  HOUSE_WIDTH,
  type HouseRoom,
  ROOMS,
  WALL_HEIGHT,
} from './housePlan'

const EDGE_TOLERANCE = 1e-9

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
  id: 'Stairs',
  label: 'Test',
  x: 0,
  z: 0,
  width: 10,
  depth: 4,
  floorHex: '#000000',
  lightSpace: 'Test',
  withinRoomId: Option.none(),
  annexes: [],
  doors: [],
  furniture: [],
  lightSpots: [],
  labelSpot: { x: 0, z: 0 },
  ...overrides,
})

const roomContaining = (x: number, z: number) =>
  ROOMS.find(candidate =>
    roomAreas(candidate).some(
      area =>
        x >= area.x &&
        x <= area.x + area.width &&
        z >= area.z &&
        z <= area.z + area.depth,
    ),
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

  test('puts a bulb with no matching room on the stairs', () => {
    expect(
      placedBulbs(lights, groups, {}).find(bulb => bulb.name === 'Porch')
        ?.roomId,
    ).toBe('Stairs')
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

    expect(bulb?.roomId).toBe('Stairs')
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
    const doorsBetween = (
      roomId: string,
      side: string,
      neighborFrom: number,
      neighborTo: number,
    ) =>
      ROOMS.find(candidate => candidate.id === roomId)
        ?.doors.filter(
          door =>
            door.side === side &&
            door.from >= neighborFrom &&
            door.from + door.width <= neighborTo,
        )
        .map(({ from, width }) => [from, width])

    expect(doorsBetween('LivingRoom', 'South', 0, 8)).toEqual(
      doorsBetween('Kitchen', 'North', 0, 8),
    )
    expect(doorsBetween('Kitchen', 'South', 0, 8)).toEqual(
      doorsBetween('Stairs', 'North', 0, 8),
    )
    expect(doorsBetween('LivingRoom', 'West', 0, 3.4)).toEqual(
      doorsBetween('Bedroom', 'East', 0, 3.4),
    )
    expect(doorsBetween('Kitchen', 'West', 4.6, 6.9)).toEqual(
      doorsBetween('Bathroom', 'East', 4.6, 6.9),
    )
    expect(doorsBetween('Bedroom', 'South', 0, 2.2)).toEqual(
      doorsBetween('Closet', 'North', 0, 2.2),
    )
    expect(doorsBetween('Closet', 'North', 0, 2.2)).toHaveLength(1)
    expect(doorsBetween('Closet', 'South', 0, 2.2)).toEqual([])
    expect(doorsBetween('Bathroom', 'North', 0, 3.6)).toEqual([])
  })
})

describe('the floor plan', () => {
  test('stays inside the house and no two rooms overlap', () => {
    const areas = ROOMS.flatMap(candidate =>
      roomAreas(candidate).map(area => ({ ...area, id: candidate.id })),
    )

    areas.forEach((first, index) => {
      expect(first.x).toBeGreaterThanOrEqual(0)
      expect(first.z).toBeGreaterThanOrEqual(0)
      expect(first.x + first.width - HOUSE_WIDTH).toBeLessThan(EDGE_TOLERANCE)
      expect(first.z + first.depth - HOUSE_DEPTH).toBeLessThan(EDGE_TOLERANCE)

      areas.slice(index + 1).forEach(second => {
        const isOverlapping =
          first.x < second.x + second.width &&
          second.x < first.x + first.width &&
          first.z < second.z + second.depth &&
          second.z < first.z + first.depth

        expect([first.id, second.id, isOverlapping]).toEqual([
          first.id,
          second.id,
          false,
        ])
      })
    })
  })

  test('keeps every fixture inside its room and below the ceiling', () => {
    ROOMS.forEach(({ id, lightSpots }) => {
      lightSpots.forEach(({ x, y, z }) => {
        expect(roomContaining(x, z)?.id).toBe(id)
        expect(y).toBeLessThan(WALL_HEIGHT)
      })
    })
  })

  test('mounts each real bulb on the fixture it is named after', () => {
    const lights = [
      light('Bedroom Sphere', 'a'),
      light('Bedroom UFO', 'b'),
      light('Living Room Orb', 'c'),
      light('Living Room Shroom', 'd'),
      light('Kitchen Light Less Wobbly Chair Side', 'e'),
      light('Kitchen Light More Wobbly Chair Side', 'f'),
      light('Closet', 'g'),
    ]
    const bulbs = placedBulbs(lights, [], {})
    const named = (name: string) => bulbs.find(bulb => bulb.name === name)

    expect(named('Bedroom Sphere')?.y).toBeLessThan(
      named('Bedroom UFO')?.y ?? 0,
    )
    expect(named('Living Room Orb')?.x).toBeLessThan(
      named('Living Room Shroom')?.x ?? 0,
    )
    expect(named('Kitchen Light Less Wobbly Chair Side')?.x).toBeLessThan(
      named('Kitchen Light More Wobbly Chair Side')?.x ?? 0,
    )
    expect(named('Closet')?.roomId).toBe('Closet')
    expect(bulbs.every(({ isMounted }) => isMounted)).toBe(true)
  })

  test('puts the closet bulb in the closet while it is in the Bedroom group', () => {
    const lights = [
      light('Bedroom Sphere', 'a'),
      light('Bedroom UFO', 'b'),
      light('Closet', 'g'),
      light('Reading Lamp', 'r'),
    ]
    const bedroomGroup: ReadonlyArray<Group> = [
      { name: 'Bedroom', memberAddresses: ['a', 'b', 'g', 'r'] },
    ]
    const roomOf = (name: string) =>
      placedBulbs(lights, bedroomGroup, {}).find(bulb => bulb.name === name)
        ?.roomId

    expect(roomOf('Closet')).toBe('Closet')
    expect(roomOf('Bedroom UFO')).toBe('Bedroom')
    expect(roomOf('Reading Lamp')).toBe('Bedroom')
    expect(
      placedBulbs(lights, bedroomGroup, {}).find(
        bulb => bulb.name === 'Bedroom UFO',
      )?.isMounted,
    ).toBe(true)
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
