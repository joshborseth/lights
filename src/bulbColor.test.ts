import { describe, expect, test } from 'vitest'

import { hexToXy } from './automation'
import { type ColorBulb, bulbHex, colorCommands } from './bulbColor'

const COLOR = { supportsColor: true, supportsColorTemp: true }
const WHITE = { supportsColor: false, supportsColorTemp: true }

const bulb = (name: string, isOn = true, capabilities = COLOR): ColorBulb => ({
  name,
  isOn,
  capabilities,
})

describe('bulbHex', () => {
  test('keeps a vivid color at full strength', () => {
    expect(bulbHex('#8bce00')).toBe('#acff00')
  })

  test('pushes a pale color to a strong one with the same hue', () => {
    // NOTE: A pale pink would look nearly white on a bulb.
    expect(bulbHex('#efafc3')).toBe('#ff4d84')
  })

  test('leaves pure colors alone', () => {
    expect(bulbHex('#ff0000')).toBe('#ff0000')
    expect(bulbHex('#0000ff')).toBe('#0000ff')
  })
})

describe('colorCommands', () => {
  const color = '#1281b6'

  test('gives every lit bulb the color, in name order', () => {
    const commands = colorCommands(color, [
      bulb('D'),
      bulb('B'),
      bulb('A'),
      bulb('C'),
    ])
    expect(commands.map(({ name }) => name)).toEqual(['A', 'B', 'C', 'D'])
    expect(new Set(commands.map(({ hex }) => hex))).toEqual(
      new Set([bulbHex(color)]),
    )
  })

  test('sends only x and y: no hex, hue, or transition', () => {
    const [command] = colorCommands(color, [bulb('A')])
    expect(command?.payload).toEqual({ color: hexToXy(bulbHex(color)) })
  })

  test('leaves bulbs that are off, and bulbs with no color, alone', () => {
    const commands = colorCommands(color, [
      bulb('Off', false),
      bulb('White', true, WHITE),
      bulb('On'),
    ])
    expect(commands.map(({ name }) => name)).toEqual(['On'])
  })
})
