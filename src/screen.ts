import { Option, Schema, String } from 'effect'

/*
 * Screen colors: while a film or show plays in Joshflix on the TV, the bulbs
 * in one group take the color on screen. The TV sends a tiny copy of the
 * picture to the Joshflix relay on this machine (`~/.t3/projects/joshflix`),
 * which finds the one color it reads as and sends it over a read-only
 * WebSocket at `/api/v1/screen/feed`. The relay already smooths it: a new
 * color comes only after the picture's color clearly changed and held for
 * 1.5 seconds. The automations service listens there, only while Screen
 * colors is on (the TV reads the picture only while someone listens), and
 * sends the bulb commands with Music colors' code, following the rules in
 * docs/migration-plan.md.
 */

// CONFIG

export const ScreenConfig = Schema.Struct({
  isEnabled: Schema.Boolean,
  group: Schema.String,
})
export type ScreenConfig = typeof ScreenConfig.Type

export const DEFAULT_SCREEN_CONFIG: ScreenConfig = {
  isEnabled: false,
  group: 'All Lights',
}

export const screenConfigProblem = (
  config: ScreenConfig,
): Option.Option<string> =>
  String.isEmpty(String.trim(config.group))
    ? Option.some('Choose a group for the screen colors.')
    : Option.none()

// WHAT THE RELAY SENDS

const HEX = /^#[0-9a-f]{6}$/i

/** A frame of the Joshflix relay's screen colors feed. */
export const ScreenColors = Schema.Struct({
  _tag: Schema.Literal('ScreenColors'),
  /** Video is playing on the TV: not paused, stopped, or gone quiet. */
  playing: Schema.Boolean,
  /** What plays, such as "The Office · S2E4", or null. */
  title: Schema.NullOr(Schema.String),
  /** The color the picture reads as, or null for a dark or grey picture. */
  color: Schema.NullOr(Schema.String.check(Schema.isPattern(HEX))),
})
export type ScreenColors = typeof ScreenColors.Type

export const ScreenColorsJson = Schema.fromJsonString(ScreenColors)

// STATUS

/** `Off` while Screen colors is off: the service doesn't listen then. */
export const ScreenConnection = Schema.Literals([
  'Off',
  'Connecting',
  'Connected',
  'Unreachable',
])
export type ScreenConnection = typeof ScreenConnection.Type

export const ScreenShow = Schema.Struct({
  title: Schema.String,
  isPlaying: Schema.Boolean,
  maybeColor: Schema.OptionFromNullOr(Schema.String),
})
export type ScreenShow = typeof ScreenShow.Type

export const ScreenApplied = Schema.Struct({
  at: Schema.Number,
  title: Schema.String,
  /** The color the bulbs were sent. */
  color: Schema.String,
  lights: Schema.Number,
})
export type ScreenApplied = typeof ScreenApplied.Type

export const ScreenSnapshot = Schema.Struct({
  generatedAt: Schema.Number,
  config: ScreenConfig,
  connection: ScreenConnection,
  maybeShow: Schema.OptionFromNullOr(ScreenShow),
  maybeLastApplied: Schema.OptionFromNullOr(ScreenApplied),
  /** Why the latest color left the lights alone, if it did. */
  maybeLastSkip: Schema.OptionFromNullOr(Schema.String),
})
export type ScreenSnapshot = typeof ScreenSnapshot.Type
export const ScreenSnapshotValue = Schema.toType(ScreenSnapshot)

export const SCREEN_API_PATH = '/automations/screen'
