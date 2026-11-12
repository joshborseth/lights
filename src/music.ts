import { Array, Option, Schema, String, pipe } from 'effect'

import { hexToXy } from './automation'

/*
 * Music colors: while a song plays, the bulbs in one group take the color of
 * its album cover. The music server (`~/.t3/projects/music`) sends the song
 * and the cover's one color over a read-only WebSocket at `/now-playing`; the
 * automations service listens there and sends the bulb commands, following
 * the rules in docs/migration-plan.md.
 */

// CONFIG

export const MusicConfig = Schema.Struct({
  isEnabled: Schema.Boolean,
  group: Schema.String,
  /** Only follow music that plays on the TV, not a phone in someone's pocket. */
  onlyOnTv: Schema.Boolean,
})
export type MusicConfig = typeof MusicConfig.Type

export const DEFAULT_MUSIC_CONFIG: MusicConfig = {
  isEnabled: false,
  group: 'All Lights',
  onlyOnTv: true,
}

export const musicConfigProblem = (
  config: MusicConfig,
): Option.Option<string> =>
  String.isEmpty(String.trim(config.group))
    ? Option.some('Choose a group for the music colors.')
    : Option.none()

// WHAT THE MUSIC SERVER SENDS

const HEX = /^#[0-9a-f]{6}$/i

/** The parts of the music server's `NowPlaying` frame that the lights use. */
export const NowPlaying = Schema.Struct({
  _tag: Schema.Literal('NowPlaying'),
  track: Schema.NullOr(
    Schema.Struct({
      videoId: Schema.String,
      title: Schema.String,
      artists: Schema.String,
    }),
  ),
  playing: Schema.Boolean,
  device: Schema.NullOr(Schema.Struct({ kind: Schema.String })),
  /** The cover's color, or null for a black, white, or grey cover. */
  color: Schema.NullOr(Schema.String.check(Schema.isPattern(HEX))),
})
export type NowPlaying = typeof NowPlaying.Type

export const NowPlayingJson = Schema.fromJsonString(NowPlaying)

// STATUS

export const MusicConnection = Schema.Literals([
  'Connecting',
  'Connected',
  'Unreachable',
])
export type MusicConnection = typeof MusicConnection.Type

export const MusicSong = Schema.Struct({
  title: Schema.String,
  artists: Schema.String,
  isPlaying: Schema.Boolean,
  isOnTv: Schema.Boolean,
  maybeColor: Schema.OptionFromNullOr(Schema.String),
})
export type MusicSong = typeof MusicSong.Type

export const MusicApplied = Schema.Struct({
  at: Schema.Number,
  title: Schema.String,
  /** The color the bulbs were sent: the cover's, or warm white. */
  color: Schema.String,
  lights: Schema.Number,
})
export type MusicApplied = typeof MusicApplied.Type

export const MusicSnapshot = Schema.Struct({
  generatedAt: Schema.Number,
  config: MusicConfig,
  connection: MusicConnection,
  maybeSong: Schema.OptionFromNullOr(MusicSong),
  maybeLastApplied: Schema.OptionFromNullOr(MusicApplied),
  /** Why the latest song left the lights alone, if it did. */
  maybeLastSkip: Schema.OptionFromNullOr(Schema.String),
})
export type MusicSnapshot = typeof MusicSnapshot.Type
export const MusicSnapshotValue = Schema.toType(MusicSnapshot)

export const MUSIC_API_PATH = '/automations/music'

// COLORS

/** Warm white for covers with no color: black, white, or grey. */
export const WARM_WHITE_COLOR_TEMP = 370
/**
 * Bulbs wash out pale colors to near white, so the cover color is pushed to
 * at least this saturation. Its hue stays the same.
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

/** The cover color as a bulb should show it: full strength, never pale. */
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

export type MusicBulb = Readonly<{
  name: string
  isOn: boolean
  capabilities: BulbCapabilities
}>

export type MusicCommand = Readonly<{
  name: string
  payload: Readonly<Record<string, unknown>>
  /** The color the bulb is meant to show, for the status line. */
  hex: string
}>

const WARM_WHITE_HEX = '#ffb46b'

const byName = (x: MusicBulb, y: MusicBulb): number =>
  x.name < y.name ? -1 : x.name > y.name ? 1 : 0

/**
 * One command per bulb that is on and can show the result, all in the cover's
 * one color. Bulbs that are off stay off. The color goes as x and y with no
 * `transition`, and brightness is left alone. A cover with no color turns
 * bulbs warm white instead, where they take a color temperature.
 */
export const musicCommands = (
  maybeColor: Option.Option<string>,
  bulbs: ReadonlyArray<MusicBulb>,
): ReadonlyArray<MusicCommand> => {
  const lit = [...bulbs].filter(bulb => bulb.isOn).sort(byName)
  if (Option.isNone(maybeColor)) {
    return pipe(
      lit,
      Array.filter(bulb => bulb.capabilities.supportsColorTemp),
      Array.map(bulb => ({
        name: bulb.name,
        payload: { color_temp: WARM_WHITE_COLOR_TEMP },
        hex: WARM_WHITE_HEX,
      })),
    )
  }
  const hex = bulbHex(maybeColor.value)
  return pipe(
    lit,
    Array.filter(bulb => bulb.capabilities.supportsColor),
    Array.map(bulb => ({
      name: bulb.name,
      payload: { color: hexToXy(hex) },
      hex,
    })),
  )
}
