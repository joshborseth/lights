import { describe, expect, test } from 'vitest'

import { hexToXy } from './automation'
import {
  DEFAULT_MUSIC_CONFIG,
  type MusicBulb,
  WARM_WHITE_COLOR_TEMP,
  bulbHex,
  musicCommands,
} from './music'

const COLOR = { supportsColor: true, supportsColorTemp: true }
const WHITE = { supportsColor: false, supportsColorTemp: true }
const PLAIN = { supportsColor: false, supportsColorTemp: false }

const bulb = (name: string, isOn = true, capabilities = COLOR): MusicBulb => ({
  name,
  isOn,
  capabilities,
})

describe('bulbHex', () => {
  test('keeps a vivid color at full strength', () => {
    expect(bulbHex('#8bce00')).toBe('#acff00')
  })

  test('pushes a pale color to a strong one with the same hue', () => {
    // IGOR's pale pink would look nearly white on a bulb.
    expect(bulbHex('#efafc3')).toBe('#ff4d84')
  })

  test('leaves pure colors alone', () => {
    expect(bulbHex('#ff0000')).toBe('#ff0000')
    expect(bulbHex('#0000ff')).toBe('#0000ff')
  })
})

describe('musicCommands', () => {
  const palette = ['#1281b6', '#8bce00', '#e03070', '#ffaa00']

  test('spreads the first three colors across lit bulbs in name order', () => {
    const commands = musicCommands(
      palette,
      [bulb('D'), bulb('B'), bulb('A'), bulb('C')],
      DEFAULT_MUSIC_CONFIG,
    )
    expect(commands.map(({ name }) => name)).toEqual(['A', 'B', 'C', 'D'])
    const hexes = commands.map(({ hex }) => hex)
    expect(hexes[0]).toBe(bulbHex('#1281b6'))
    expect(hexes[1]).toBe(bulbHex('#8bce00'))
    expect(hexes[2]).toBe(bulbHex('#e03070'))
    expect(hexes[3]).toBe(bulbHex('#1281b6'))
  })

  test('gives every bulb the main color when spreading is off', () => {
    const commands = musicCommands(palette, [bulb('A'), bulb('B')], {
      ...DEFAULT_MUSIC_CONFIG,
      spreadColors: false,
    })
    expect(new Set(commands.map(({ hex }) => hex))).toEqual(
      new Set([bulbHex('#1281b6')]),
    )
  })

  test('sends only x and y: no hex, hue, or transition', () => {
    const [command] = musicCommands(palette, [bulb('A')], DEFAULT_MUSIC_CONFIG)
    expect(command?.payload).toEqual({
      color: hexToXy(bulbHex('#1281b6')),
    })
  })

  test('leaves bulbs that are off, and bulbs with no color, alone', () => {
    const commands = musicCommands(
      palette,
      [bulb('Off', false), bulb('White', true, WHITE), bulb('On')],
      DEFAULT_MUSIC_CONFIG,
    )
    expect(commands.map(({ name }) => name)).toEqual(['On'])
  })

  test('turns lit bulbs warm white for a cover with no color', () => {
    const commands = musicCommands(
      [],
      [bulb('Color'), bulb('White', true, WHITE), bulb('Plain', true, PLAIN)],
      DEFAULT_MUSIC_CONFIG,
    )
    expect(commands.map(({ name, payload }) => [name, payload])).toEqual([
      ['Color', { color_temp: WARM_WHITE_COLOR_TEMP }],
      ['White', { color_temp: WARM_WHITE_COLOR_TEMP }],
    ])
  })
})
