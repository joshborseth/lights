import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  IncomingFrame,
  Setting,
  type Setting as SettingType,
  decodeFrame,
  hueSaturationToHex,
  powerFrame,
  settingFrame,
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
    ['color', Setting.Color({ hex: '#123456' })],
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
