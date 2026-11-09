import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  type GroupNode,
  IncomingFrame,
  Setting,
  type Setting as SettingType,
  buildLightTree,
  decodeFrame,
  hueSaturationToHex,
  powerFrame,
  settingFrame,
  shortLightName,
} from './domain'

const frame = (topic: string, payload: unknown) =>
  decodeFrame(JSON.stringify({ topic, payload }))

describe('decodeFrame', () => {
  test('keeps only devices that expose a light', () => {
    const decoded = frame('bridge/devices', [
      {
        friendly_name: 'Coordinator',
        ieee_address: '0x0',
        type: 'Coordinator',
        definition: null,
      },
      {
        friendly_name: 'Orb',
        ieee_address: '0x1',
        type: 'Router',
        definition: {
          exposes: [
            {
              type: 'light',
              features: [
                { name: 'state' },
                { name: 'color_temp', value_min: 153, value_max: 555 },
                { name: 'color_xy' },
              ],
            },
          ],
        },
      },
    ])
    expect(decoded).toEqual(
      Option.some(
        IncomingFrame.ReportedLights({
          lights: [
            {
              name: 'Orb',
              address: '0x1',
              maybeColorTempRange: Option.some({ min: 153, max: 555 }),
              supportsColor: true,
            },
          ],
          newDevices: [],
        }),
      ),
    )
  })

  test('reads light state', () => {
    expect(
      frame('Orb', {
        state: 'OFF',
        brightness: 254,
        color_temp: 370,
        color: { hue: 32, saturation: 82, x: 0.4, y: 0.4 },
        linkquality: 112,
      }),
    ).toEqual(
      Option.some(
        IncomingFrame.ReportedLightState({
          name: 'Orb',
          state: {
            power: 'OFF',
            brightness: 254,
            maybeColorTemp: Option.some(370),
            maybeHueSaturation: Option.some({ hue: 32, saturation: 82 }),
          },
        }),
      ),
    )
  })

  test('marks the Rainbow preset as a loop', () => {
    expect(
      frame('preset/list', [
        { name: 'Rainbow', brightness: 254, loop: { type: 'rainbow' } },
        { name: 'Red', brightness: 254, color: { hex: '#FF0000' } },
        { name: 'Warm', brightness: 100, color_temp: 370 },
      ]),
    ).toEqual(
      Option.some(
        IncomingFrame.ReportedPresets({
          presets: [
            {
              name: 'Rainbow',
              brightness: 254,
              look: { _tag: 'Rainbow' },
            },
            {
              name: 'Red',
              brightness: 254,
              look: { _tag: 'Color', hex: '#FF0000' },
            },
            {
              name: 'Warm',
              brightness: 100,
              look: { _tag: 'White', colorTemp: 370 },
            },
          ],
        }),
      ),
    )
  })

  test('flags a known topic with the wrong shape', () => {
    expect(frame('bridge/devices', { nope: true })).toEqual(
      Option.some(IncomingFrame.Unreadable({ topic: 'bridge/devices' })),
    )
  })

  test.each([
    ['bridge/health', { response_time: 1 }],
    ['Some Sensor', { temperature: 20 }],
  ])('ignores %s', (topic, payload) => {
    expect(frame(topic, payload)).toEqual(Option.none())
  })

  test('ignores text that is not a frame', () => {
    expect(decodeFrame('not json')).toEqual(Option.none())
  })
})

describe('commands to the bulbs', () => {
  const payloadOf = (encoded: string) => JSON.parse(encoded).payload

  test('off is exactly state OFF', () => {
    expect(payloadOf(powerFrame('Orb', 'OFF'))).toStrictEqual({ state: 'OFF' })
  })

  test.each<[string, SettingType]>([
    ['brightness', Setting.Brightness({ value: 40 })],
    ['color temperature', Setting.ColorTemp({ value: 300 })],
    ['color', Setting.Color({ hue: 210 })],
  ])('%s never carries a transition', (_label, setting) => {
    expect(payloadOf(settingFrame('Orb', setting))).not.toHaveProperty(
      'transition',
    )
  })
})

describe('hueSaturationToHex', () => {
  test.each([
    [0, 100, '#ff0000'],
    [120, 100, '#00ff00'],
    [240, 100, '#0000ff'],
    [360, 100, '#ff0000'],
    [32, 0, '#ffffff'],
  ])('%i/%i is %s', (hue, saturation, hex) => {
    expect(hueSaturationToHex({ hue, saturation })).toBe(hex)
  })
})

describe('buildLightTree', () => {
  const light = (name: string, address: string) => ({
    name,
    address,
    maybeColorTempRange: Option.none(),
    supportsColor: true,
  })
  const group = (name: string, memberAddresses: ReadonlyArray<string>) => ({
    name,
    memberAddresses,
  })
  const shape = (node: GroupNode): unknown => ({
    [node.group.name]: [
      ...node.childGroups.map(shape),
      ...node.lights.map(({ name }) => name),
    ],
  })

  const lights = [
    light('Living Room Orb', 'lr1'),
    light('Living Room Shroom', 'lr2'),
    light('Bedroom UFO', 'b1'),
    light('Bedroom Sphere', 'b2'),
    light('Bathroom Orb', 'ba1'),
    light('Kitchen Light Less Wobbly Chair Side', 'k1'),
    light('Kitchen Light More Wobbly Chair Side', 'k2'),
  ]
  const allAddresses = ['lr1', 'lr2', 'b1', 'b2', 'ba1', 'k1', 'k2']
  const house = [
    group('All Lights', allAddresses),
    group('Bedroom', ['b1', 'b2']),
    group('Rest of the House', ['lr1', 'lr2', 'ba1', 'k1', 'k2']),
    group('Living Room', ['lr1', 'lr2']),
    group('Kitchen', ['k1', 'k2']),
  ]

  test('nests the real house by bulb membership', () => {
    const tree = buildLightTree(lights, house)
    expect(tree.roots.map(shape)).toEqual([
      {
        'All Lights': [
          {
            'Rest of the House': [
              { 'Living Room': ['Living Room Orb', 'Living Room Shroom'] },
              {
                Kitchen: [
                  'Kitchen Light Less Wobbly Chair Side',
                  'Kitchen Light More Wobbly Chair Side',
                ],
              },
              'Bathroom Orb',
            ],
          },
          { Bedroom: ['Bedroom UFO', 'Bedroom Sphere'] },
        ],
      },
    ])
    expect(tree.looseLights).toEqual([])
    expect(tree.crossingGroups).toEqual([])
  })

  test('without room groups, bulbs sit directly under their parent', () => {
    const tree = buildLightTree(lights, house.slice(0, 3))
    expect(tree.roots.map(shape)).toEqual([
      {
        'All Lights': [
          {
            'Rest of the House': [
              'Living Room Orb',
              'Living Room Shroom',
              'Bathroom Orb',
              'Kitchen Light Less Wobbly Chair Side',
              'Kitchen Light More Wobbly Chair Side',
            ],
          },
          { Bedroom: ['Bedroom UFO', 'Bedroom Sphere'] },
        ],
      },
    ])
  })

  test('a group spanning rooms is listed apart and leaves the tree whole', () => {
    const tree = buildLightTree(lights, [
      ...house,
      group('Reading Lamps', ['lr1', 'b1']),
    ])
    expect(tree.crossingGroups.map(shape)).toEqual([
      { 'Reading Lamps': ['Living Room Orb', 'Bedroom UFO'] },
    ])
    expect(tree.roots.map(node => node.group.name)).toEqual(['All Lights'])
    expect(tree.roots[0]?.childGroups.map(node => node.group.name)).toEqual([
      'Rest of the House',
      'Bedroom',
    ])
  })

  test('of two groups with the same bulbs, only the first nests', () => {
    const tree = buildLightTree(lights, [
      group('Bedroom', ['b1', 'b2']),
      group('Sleep', ['b1', 'b2']),
    ])
    expect(tree.roots.map(node => node.group.name)).toEqual(['Bedroom'])
    expect(tree.crossingGroups.map(node => node.group.name)).toEqual(['Sleep'])
  })

  test('bulbs in no group are loose, and empty groups disappear', () => {
    const tree = buildLightTree(lights.slice(0, 2), [
      group('Living Room', ['lr1']),
      group('Gone', ['missing']),
    ])
    expect(tree.roots.map(shape)).toEqual([
      { 'Living Room': ['Living Room Orb'] },
    ])
    expect(tree.looseLights.map(({ name }) => name)).toEqual([
      'Living Room Shroom',
    ])
  })
})

describe('shortLightName', () => {
  const named = (name: string, address: string) => ({
    name,
    address,
    maybeColorTempRange: Option.none(),
    supportsColor: false,
  })

  test('drops the words every sibling shares', () => {
    const less = named('Kitchen Light Less Wobbly', 'a')
    const more = named('Kitchen Light More Wobbly', 'b')
    expect(shortLightName([less, more], less)).toBe('Less Wobbly')
  })

  test('keeps the name of an only child', () => {
    const orb = named('Bathroom Orb', 'a')
    expect(shortLightName([orb], orb)).toBe('Bathroom Orb')
  })

  test('keeps full names when shortening would leave one blank', () => {
    const lamp = named('Lamp', 'a')
    const lampTwo = named('Lamp Two', 'b')
    expect(shortLightName([lamp, lampTwo], lamp)).toBe('Lamp')
    expect(shortLightName([lamp, lampTwo], lampTwo)).toBe('Lamp Two')
  })
})
