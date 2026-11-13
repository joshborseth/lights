import { Array, pipe } from 'effect'

import { hexToXy } from './automation'

/*
 * Painting lit bulbs one color, as Screen colors does. The color is pushed to
 * full strength, since bulbs wash out pale colors, and goes as x and y.
 */

/**
 * Bulbs wash out pale colors to near white, so a color is pushed to at least
 * this saturation. Its hue stays the same.
 */
const MIN_SATURATION = 0.7

type Hsv = Readonly<{ hue: number; saturation: number; value: number }>

const toHsv = (hex: string): Hsv => {
  const channel = (start: number) =>
    Number.parseInt(hex.slice(start, start + 2), 16) / 255
  const red = channel(1)
  const green = channel(3)
  const blue = channel(5)
  const max = Math.max(red, green, blue)
  const delta = max - Math.min(red, green, blue)
  const hue =
    delta === 0
      ? 0
      : max === red
        ? 60 * (((green - blue) / delta + 6) % 6)
        : max === green
          ? 60 * ((blue - red) / delta + 2)
          : 60 * ((red - green) / delta + 4)
  return { hue, saturation: max === 0 ? 0 : delta / max, value: max }
}

const fromHsv = ({ hue, saturation, value }: Hsv): string => {
  const chroma = value * saturation
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const base = value - chroma
  const sector = Math.floor(hue / 60) % 6
  const [red, green, blue] =
    sector === 0
      ? [chroma, second, 0]
      : sector === 1
        ? [second, chroma, 0]
        : sector === 2
          ? [0, chroma, second]
          : sector === 3
            ? [0, second, chroma]
            : sector === 4
              ? [second, 0, chroma]
              : [chroma, 0, second]
  return `#${[red, green, blue]
    .map(part =>
      Math.round((part + base) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

/** A color as a bulb should show it: full strength, never pale. */
export const bulbHex = (hex: string): string => {
  const { hue, saturation } = toHsv(hex)
  return fromHsv({
    hue,
    saturation: Math.max(saturation, MIN_SATURATION),
    value: 1,
  })
}

export type BulbCapabilities = Readonly<{
  supportsColor: boolean
  supportsColorTemp: boolean
}>

export type ColorBulb = Readonly<{
  name: string
  isOn: boolean
  capabilities: BulbCapabilities
}>

export type ColorCommand = Readonly<{
  name: string
  payload: Readonly<Record<string, unknown>>
  /** The color the bulb is meant to show, for the status line. */
  hex: string
}>

const byName = (x: ColorBulb, y: ColorBulb): number =>
  x.name < y.name ? -1 : x.name > y.name ? 1 : 0

/**
 * One command per bulb that is on and can show color, all in one color.
 * Bulbs that are off stay off. The color goes as x and y with no
 * `transition`, and brightness is left alone.
 */
export const colorCommands = (
  color: string,
  bulbs: ReadonlyArray<ColorBulb>,
): ReadonlyArray<ColorCommand> => {
  const hex = bulbHex(color)
  return pipe(
    [...bulbs].sort(byName),
    Array.filter(bulb => bulb.isOn && bulb.capabilities.supportsColor),
    Array.map(bulb => ({
      name: bulb.name,
      payload: { color: hexToXy(hex) },
      hex,
    })),
  )
}
