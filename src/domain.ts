import { Array, Match, Number, Option, Schema, String, pipe } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

export const MIN_BRIGHTNESS = 1
export const MAX_BRIGHTNESS = 254
export const DEFAULT_COLOR_TEMP = 370

export const PRESET_GROUPS: ReadonlyArray<string> = [
  'All Lights',
  'Rest of the House',
]

// LIGHTS

export const ColorTempRange = Schema.Struct({
  min: Schema.Number,
  max: Schema.Number,
})
export type ColorTempRange = typeof ColorTempRange.Type

export const Light = Schema.Struct({
  name: Schema.String,
  address: Schema.String,
  maybeColorTempRange: Schema.Option(ColorTempRange),
  supportsColor: Schema.Boolean,
})
export type Light = typeof Light.Type

export const Group = Schema.Struct({
  name: Schema.String,
  memberAddresses: Schema.Array(Schema.String),
})
export type Group = typeof Group.Type

export const Power = Schema.Literals(['ON', 'OFF'])
export type Power = typeof Power.Type

export const HueSaturation = Schema.Struct({
  hue: Schema.Number,
  saturation: Schema.Number,
})
export type HueSaturation = typeof HueSaturation.Type

export const LightState = Schema.Struct({
  power: Power,
  brightness: Schema.Number,
  maybeColorTemp: Schema.Option(Schema.Number),
  maybeHueSaturation: Schema.Option(HueSaturation),
})
export type LightState = typeof LightState.Type

// PRESETS

export const PresetLook = defineTaggedUnion({
  Color: { hex: Schema.String },
  White: { colorTemp: Schema.Number },
  Rainbow: {},
})
export type PresetLook = typeof PresetLook.Type

export const Preset = Schema.Struct({
  name: Schema.String,
  brightness: Schema.Number,
  look: PresetLook,
})
export type Preset = typeof Preset.Type

// INCOMING FRAMES

export const IncomingFrame = defineTaggedUnion({
  ReportedLights: { lights: Schema.Array(Light) },
  ReportedGroups: { groups: Schema.Array(Group) },
  ReportedLightState: { name: Schema.String, state: LightState },
  ReportedBridge: { isOnline: Schema.Boolean },
  ReportedPresets: { presets: Schema.Array(Preset) },
  Unreadable: { topic: Schema.String },
})
export type IncomingFrame = typeof IncomingFrame.Type

const RawFrame = Schema.fromJsonString(
  Schema.Struct({ topic: Schema.String, payload: Schema.Unknown }),
)

const RawFeature = Schema.Struct({
  name: Schema.optional(Schema.String),
  value_min: Schema.optional(Schema.Number),
  value_max: Schema.optional(Schema.Number),
})
type RawFeature = typeof RawFeature.Type

const RawDevices = Schema.Array(
  Schema.Struct({
    friendly_name: Schema.String,
    ieee_address: Schema.String,
    definition: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          exposes: Schema.Array(
            Schema.Struct({
              type: Schema.String,
              features: Schema.optional(Schema.Array(RawFeature)),
            }),
          ),
        }),
      ),
    ),
  }),
)
type RawDevice = (typeof RawDevices.Type)[number]

const RawGroups = Schema.Array(
  Schema.Struct({
    friendly_name: Schema.String,
    members: Schema.Array(Schema.Struct({ ieee_address: Schema.String })),
  }),
)

const RawBridgeState = Schema.Struct({ state: Schema.String })

const RawLightState = Schema.Struct({
  state: Power,
  brightness: Schema.Number,
  color_temp: Schema.optional(Schema.NullOr(Schema.Number)),
  color: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        hue: Schema.optional(Schema.Number),
        saturation: Schema.optional(Schema.Number),
      }),
    ),
  ),
})
type RawLightState = typeof RawLightState.Type

const RawPresets = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    brightness: Schema.Number,
    color: Schema.optional(Schema.Struct({ hex: Schema.String })),
    color_temp: Schema.optional(Schema.Number),
    loop: Schema.optional(Schema.Unknown),
  }),
)
type RawPreset = (typeof RawPresets.Type)[number]

const decodeRawFrame = Schema.decodeUnknownOption(RawFrame)
const decodeRawDevices = Schema.decodeUnknownOption(RawDevices)
const decodeRawGroups = Schema.decodeUnknownOption(RawGroups)
const decodeRawBridgeState = Schema.decodeUnknownOption(RawBridgeState)
const decodeRawLightState = Schema.decodeUnknownOption(RawLightState)
const decodeRawPresets = Schema.decodeUnknownOption(RawPresets)

const toLight = (device: RawDevice): Option.Option<Light> =>
  pipe(
    Option.fromNullishOr(device.definition),
    Option.flatMap(definition =>
      Array.findFirst(definition.exposes, expose => expose.type === 'light'),
    ),
    Option.map(expose => {
      const features = expose.features ?? []
      const maybeColorTemp = Array.findFirst(
        features,
        feature => feature.name === 'color_temp',
      )
      return {
        name: device.friendly_name,
        address: device.ieee_address,
        maybeColorTempRange: Option.flatMap(maybeColorTemp, toColorTempRange),
        supportsColor: Array.some(
          features,
          feature => feature.name === 'color_xy' || feature.name === 'color_hs',
        ),
      }
    }),
  )

const toColorTempRange = (feature: RawFeature): Option.Option<ColorTempRange> =>
  Option.all({
    min: Option.fromNullishOr(feature.value_min),
    max: Option.fromNullishOr(feature.value_max),
  })

const toLightState = (raw: RawLightState): LightState => ({
  power: raw.state,
  brightness: raw.brightness,
  maybeColorTemp: Option.fromNullishOr(raw.color_temp),
  maybeHueSaturation: pipe(
    Option.fromNullishOr(raw.color),
    Option.flatMap(color =>
      Option.all({
        hue: Option.fromNullishOr(color.hue),
        saturation: Option.fromNullishOr(color.saturation),
      }),
    ),
  ),
})

const toPresetLook = (raw: RawPreset): PresetLook => {
  if (raw.loop !== undefined) {
    return PresetLook.Rainbow()
  }
  if (raw.color !== undefined) {
    return PresetLook.Color({ hex: raw.color.hex })
  }
  return PresetLook.White({ colorTemp: raw.color_temp ?? DEFAULT_COLOR_TEMP })
}

const readKnownFrame = <Decoded>(
  topic: string,
  maybeDecoded: Option.Option<Decoded>,
  toFrame: (decoded: Decoded) => IncomingFrame,
): IncomingFrame =>
  Option.match(maybeDecoded, {
    onNone: () => IncomingFrame.Unreadable({ topic }),
    onSome: toFrame,
  })

export const decodeFrame = (text: string): Option.Option<IncomingFrame> =>
  Option.flatMap(decodeRawFrame(text), ({ topic, payload }) =>
    Match.value(topic).pipe(
      Match.withReturnType<Option.Option<IncomingFrame>>(),
      Match.when('bridge/devices', () =>
        Option.some(
          readKnownFrame(topic, decodeRawDevices(payload), devices =>
            IncomingFrame.ReportedLights({
              lights: Array.getSomes(Array.map(devices, toLight)),
            }),
          ),
        ),
      ),
      Match.when('bridge/groups', () =>
        Option.some(
          readKnownFrame(topic, decodeRawGroups(payload), groups =>
            IncomingFrame.ReportedGroups({
              groups: Array.map(groups, group => ({
                name: group.friendly_name,
                memberAddresses: Array.map(
                  group.members,
                  member => member.ieee_address,
                ),
              })),
            }),
          ),
        ),
      ),
      Match.when('bridge/state', () =>
        Option.some(
          readKnownFrame(topic, decodeRawBridgeState(payload), ({ state }) =>
            IncomingFrame.ReportedBridge({ isOnline: state === 'online' }),
          ),
        ),
      ),
      Match.when('preset/list', () =>
        Option.some(
          readKnownFrame(topic, decodeRawPresets(payload), presets =>
            IncomingFrame.ReportedPresets({
              presets: Array.map(presets, preset => ({
                name: preset.name,
                brightness: preset.brightness,
                look: toPresetLook(preset),
              })),
            }),
          ),
        ),
      ),
      Match.when(String.startsWith('bridge/'), () => Option.none()),
      Match.orElse(() =>
        Option.map(decodeRawLightState(payload), raw =>
          IncomingFrame.ReportedLightState({
            name: topic,
            state: toLightState(raw),
          }),
        ),
      ),
    ),
  )

// OUTGOING FRAMES

export const Setting = defineTaggedUnion({
  Brightness: { value: Schema.Number },
  ColorTemp: { value: Schema.Number },
  Color: { hex: Schema.String },
})
export type Setting = typeof Setting.Type

export const encodeFrame = (topic: string, payload: unknown): string =>
  JSON.stringify({ topic, payload })

export const powerFrame = (name: string, power: Power): string =>
  encodeFrame(`${name}/set`, { state: power })

export const settingFrame = (name: string, setting: Setting): string =>
  encodeFrame(
    `${name}/set`,
    Setting.match(setting, {
      Brightness: ({ value }) => ({ brightness: value }),
      ColorTemp: ({ value }) => ({ color_temp: value }),
      Color: ({ hex }) => ({ color: { hex } }),
    }),
  )

export const applyPresetFrame = (group: string, name: string): string =>
  encodeFrame('preset/set', { name, group })

export const SavablePresetLook = defineTaggedUnion({
  Color: { hex: Schema.String },
  White: { colorTemp: Schema.Number },
})
export type SavablePresetLook = typeof SavablePresetLook.Type

export const savePresetFrame = (
  maybePreviousName: Option.Option<string>,
  name: string,
  brightness: number,
  look: SavablePresetLook,
): string =>
  encodeFrame('preset/save', {
    name,
    brightness,
    ...Option.match(maybePreviousName, {
      onNone: () => ({}),
      onSome: previous_name => ({ previous_name }),
    }),
    ...SavablePresetLook.match(look, {
      Color: ({ hex }) => ({ color: { hex } }),
      White: ({ colorTemp }) => ({ color_temp: colorTemp }),
    }),
  })

export const deletePresetFrame = (name: string): string =>
  encodeFrame('preset/delete', { name })

// COLOR

const toHexByte = (channel: number): string =>
  Math.round(channel * 255)
    .toString(16)
    .padStart(2, '0')

export const hueSaturationToHex = ({
  hue,
  saturation,
}: HueSaturation): string => {
  const scaled = Number.remainder(hue, 360) / 60
  const chroma = saturation / 100
  const floor = 1 - chroma
  const secondary = chroma * (1 - Math.abs((scaled % 2) - 1))
  const channels = Match.value(Math.floor(scaled)).pipe(
    Match.withReturnType<readonly [number, number, number]>(),
    Match.when(0, () => [chroma, secondary, 0]),
    Match.when(1, () => [secondary, chroma, 0]),
    Match.when(2, () => [0, chroma, secondary]),
    Match.when(3, () => [0, secondary, chroma]),
    Match.when(4, () => [secondary, 0, chroma]),
    Match.orElse(() => [chroma, 0, secondary]),
  )
  return `#${Array.join(
    Array.map(channels, channel => toHexByte(channel + floor)),
    '',
  )}`
}
