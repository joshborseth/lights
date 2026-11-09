import {
  Array,
  Match,
  Number,
  Option,
  Order,
  Schema,
  String,
  pipe,
} from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

export const MIN_BRIGHTNESS = 1
export const MAX_BRIGHTNESS = 254
export const DEFAULT_COLOR_TEMP = 370
export const WARM_WHITE = '#ffdfae'

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

export const clampGroupLevel = (
  level: number,
  brightnesses: Array.NonEmptyReadonlyArray<number>,
): number =>
  Number.clamp(level, {
    minimum: Array.min(brightnesses, Order.Number),
    maximum: Array.max(brightnesses, Order.Number),
  })

// HIERARCHY

export type GroupNode = Readonly<{
  group: Group
  childGroups: ReadonlyArray<GroupNode>
  lights: ReadonlyArray<Light>
}>

export type LightTree = Readonly<{
  roots: ReadonlyArray<GroupNode>
  looseLights: ReadonlyArray<Light>
  crossingGroups: ReadonlyArray<GroupNode>
}>

const memberCount = (group: Group): number => group.memberAddresses.length

const smallestFirst = Order.mapInput(Order.Number, memberCount)

const largestFirst = Order.mapInput(
  Order.Number,
  (group: Group) => -memberCount(group),
)

const isNestedIn = (inner: Group, outer: Group): boolean =>
  memberCount(inner) < memberCount(outer) &&
  Array.every(inner.memberAddresses, address =>
    Array.contains(outer.memberAddresses, address),
  )

const sharesMember = (first: Group, second: Group): boolean =>
  Array.some(first.memberAddresses, address =>
    Array.contains(second.memberAddresses, address),
  )

const crosses = (first: Group, second: Group): boolean =>
  first.name !== second.name &&
  sharesMember(first, second) &&
  !isNestedIn(first, second) &&
  !isNestedIn(second, first)

const crossingCount = (group: Group, groups: ReadonlyArray<Group>): number =>
  Array.filter(groups, other => crosses(group, other)).length

const mostCrossingGroup = (
  groups: ReadonlyArray<Group>,
): Option.Option<Group> =>
  Array.reduce(
    Array.filter(groups, group => crossingCount(group, groups) > 0),
    Option.none<Group>(),
    (maybeWorst, group) =>
      Option.match(maybeWorst, {
        onNone: () => Option.some(group),
        onSome: worst =>
          Option.some(
            crossingCount(group, groups) >= crossingCount(worst, groups)
              ? group
              : worst,
          ),
      }),
  )

const withoutCrossingGroups = (
  groups: ReadonlyArray<Group>,
): ReadonlyArray<Group> =>
  Option.match(mostCrossingGroup(groups), {
    onNone: () => groups,
    onSome: worst =>
      withoutCrossingGroups(
        Array.filter(groups, group => group.name !== worst.name),
      ),
  })

const parentOf = (
  group: Group,
  nestedGroups: ReadonlyArray<Group>,
): Option.Option<Group> =>
  Array.head(
    Array.sort(
      Array.filter(nestedGroups, other => isNestedIn(group, other)),
      smallestFirst,
    ),
  )

const toGroupNode = (
  group: Group,
  nestedGroups: ReadonlyArray<Group>,
  lights: ReadonlyArray<Light>,
): GroupNode => {
  const childGroups = Array.filter(nestedGroups, candidate =>
    Option.exists(
      parentOf(candidate, nestedGroups),
      parent => parent.name === group.name,
    ),
  )
  const addressesInChildGroups = Array.flatMap(
    childGroups,
    child => child.memberAddresses,
  )
  return {
    group,
    childGroups: Array.map(Array.sort(childGroups, largestFirst), child =>
      toGroupNode(child, nestedGroups, lights),
    ),
    lights: Array.filter(
      lights,
      light =>
        Array.contains(group.memberAddresses, light.address) &&
        !Array.contains(addressesInChildGroups, light.address),
    ),
  }
}

const knownGroupsOf = (
  lights: ReadonlyArray<Light>,
  groups: ReadonlyArray<Group>,
): ReadonlyArray<Group> =>
  pipe(
    groups,
    Array.map(group =>
      modifyFields(group, {
        memberAddresses: addresses =>
          Array.filter(addresses, address =>
            Array.some(lights, light => light.address === address),
          ),
      }),
    ),
    Array.filter(group => Array.isReadonlyArrayNonEmpty(group.memberAddresses)),
  )

// NOTE: Groups form a tree when each pair is either separate or one fully
// inside the other. A group that cuts across that shape cannot have one place
// in the tree, so it is listed on its own with all of its bulbs.
export const buildLightTree = (
  lights: ReadonlyArray<Light>,
  groups: ReadonlyArray<Group>,
): LightTree => {
  const knownGroups = knownGroupsOf(lights, groups)
  const nestedGroups = withoutCrossingGroups(knownGroups)
  const addressesInTree = Array.flatMap(
    nestedGroups,
    group => group.memberAddresses,
  )
  return {
    roots: pipe(
      nestedGroups,
      Array.filter(group => Option.isNone(parentOf(group, nestedGroups))),
      Array.sort(largestFirst),
      Array.map(group => toGroupNode(group, nestedGroups, lights)),
    ),
    looseLights: Array.filter(
      lights,
      light => !Array.contains(addressesInTree, light.address),
    ),
    crossingGroups: pipe(
      knownGroups,
      Array.filter(
        group =>
          !Array.some(nestedGroups, nested => nested.name === group.name),
      ),
      Array.map(group => ({
        group,
        childGroups: [],
        lights: Array.filter(lights, light =>
          Array.contains(group.memberAddresses, light.address),
        ),
      })),
    ),
  }
}

const wordsOf = (name: string): ReadonlyArray<string> =>
  pipe(name, String.split(' '))

export const shortLightName = (
  siblings: ReadonlyArray<Light>,
  light: Light,
): string => {
  const siblingWords = Array.map(siblings, sibling => wordsOf(sibling.name))
  const words = wordsOf(light.name)
  const sharedWords = Array.takeWhile(words, (word, index) =>
    Array.every(siblingWords, candidate => candidate[index] === word),
  )
  const canShorten =
    siblings.length > 1 &&
    Array.every(
      siblingWords,
      candidate => candidate.length > sharedWords.length,
    )
  return canShorten
    ? Array.join(Array.drop(words, sharedWords.length), ' ')
    : light.name
}

// PLACING LIGHTS

export type GroupPlace = Readonly<{ name: string; depth: number }>

export type MembershipChange = Readonly<{
  add: ReadonlyArray<string>
  remove: ReadonlyArray<string>
}>

const placesWithin = (
  node: GroupNode,
  depth: number,
): ReadonlyArray<GroupPlace> => [
  { name: node.group.name, depth },
  ...Array.flatMap(node.childGroups, child => placesWithin(child, depth + 1)),
]

// NOTE: An empty group has no bulbs to place it by, so it is offered at the
// top level. It takes its place in the tree once a bulb moves into it.
export const groupPlaces = (
  lights: ReadonlyArray<Light>,
  groups: ReadonlyArray<Group>,
): ReadonlyArray<GroupPlace> => {
  const tree = buildLightTree(lights, groups)
  const knownGroups = knownGroupsOf(lights, groups)
  return [
    ...Array.flatMap(tree.roots, root => placesWithin(root, 0)),
    ...pipe(
      groups,
      Array.filter(
        group => !Array.some(knownGroups, known => known.name === group.name),
      ),
      Array.map(group => ({ name: group.name, depth: 0 })),
    ),
  ]
}

const isMember = (group: Group, address: string): boolean =>
  Array.contains(group.memberAddresses, address)

export const currentPlace = (
  lights: ReadonlyArray<Light>,
  groups: ReadonlyArray<Group>,
  address: string,
): Option.Option<string> =>
  pipe(
    withoutCrossingGroups(knownGroupsOf(lights, groups)),
    Array.filter(group => isMember(group, address)),
    Array.sort(smallestFirst),
    Array.head,
    Option.map(group => group.name),
  )

const namesOf = (groups: ReadonlyArray<Group>): ReadonlyArray<string> =>
  Array.map(groups, group => group.name)

const containersOf = (
  group: Group,
  nestedGroups: ReadonlyArray<Group>,
): ReadonlyArray<Group> =>
  Array.filter(nestedGroups, candidate => isNestedIn(group, candidate))

const nestedInside = (
  group: Group,
  nestedGroups: ReadonlyArray<Group>,
): ReadonlyArray<Group> =>
  Array.filter(nestedGroups, candidate => isNestedIn(candidate, group))

const withoutExisting = (
  groups: ReadonlyArray<Group>,
  names: ReadonlyArray<string>,
  address: string,
): ReadonlyArray<string> =>
  Array.filter(Array.dedupe(names), name =>
    Array.some(
      groups,
      group => group.name === name && !isMember(group, address),
    ),
  )

// NOTE: Bulbs still waiting for a name are left out, so that pairing two at
// once doesn't stop All Lights from counting as the whole house.
export const wholeHouseGroupNames = (
  lights: ReadonlyArray<Light>,
  groups: ReadonlyArray<Group>,
  address: string,
): ReadonlyArray<string> => {
  const otherNamedAddresses = pipe(
    lights,
    Array.filter(light => light.address !== address && !isUnnamed(light)),
    Array.map(light => light.address),
  )
  return Array.isReadonlyArrayEmpty(otherNamedAddresses)
    ? []
    : namesOf(
        Array.filter(groups, group =>
          Array.every(otherNamedAddresses, other => isMember(group, other)),
        ),
      )
}

// NOTE: Groups nest only because of which bulbs they share, so a bulb placed in
// a room also has to be in every group around that room, and leaving a room has
// to take it out of the rest of the old branch. Otherwise the rooms stop
// nesting and the tree on the Lights tab falls apart. An empty target has no
// branch yet, so only the leaf room is left: the bulb stays in the broader
// groups that say where it is in the house.
export const moveLightChange = (
  lights: ReadonlyArray<Light>,
  groups: ReadonlyArray<Group>,
  address: string,
  target: string,
): MembershipChange => {
  const knownGroups = knownGroupsOf(lights, groups)
  const nestedGroups = withoutCrossingGroups(knownGroups)
  const maybeKnownTarget = Array.findFirst(
    knownGroups,
    group => group.name === target,
  )
  const wanted = [
    target,
    ...Option.match(maybeKnownTarget, {
      onNone: () => [],
      onSome: group => namesOf(containersOf(group, nestedGroups)),
    }),
    ...wholeHouseGroupNames(lights, groups, address),
  ]
  const isLeaf = (group: Group) =>
    Array.isReadonlyArrayEmpty(nestedInside(group, nestedGroups))
  return {
    add: withoutExisting(groups, wanted, address),
    remove: namesOf(
      Array.filter(
        nestedGroups,
        group =>
          isMember(group, address) &&
          !Array.contains(wanted, group.name) &&
          (Option.isSome(maybeKnownTarget) || isLeaf(group)),
      ),
    ),
  }
}

export const addToGroupChange = (
  lights: ReadonlyArray<Light>,
  groups: ReadonlyArray<Group>,
  address: string,
  name: string,
): MembershipChange => {
  const knownGroups = knownGroupsOf(lights, groups)
  const nestedGroups = withoutCrossingGroups(knownGroups)
  return {
    add: withoutExisting(
      groups,
      [
        name,
        ...Option.match(
          Array.findFirst(nestedGroups, group => group.name === name),
          {
            onNone: () => [],
            onSome: group => namesOf(containersOf(group, nestedGroups)),
          },
        ),
      ],
      address,
    ),
    remove: [],
  }
}

export const removeFromGroupChange = (
  lights: ReadonlyArray<Light>,
  groups: ReadonlyArray<Group>,
  address: string,
  name: string,
): MembershipChange => {
  const nestedGroups = withoutCrossingGroups(knownGroupsOf(lights, groups))
  return {
    add: [],
    remove: [
      name,
      ...Option.match(
        Array.findFirst(nestedGroups, group => group.name === name),
        {
          onNone: () => [],
          onSome: group =>
            namesOf(
              Array.filter(nestedInside(group, nestedGroups), inner =>
                isMember(inner, address),
              ),
            ),
        },
      ),
    ],
  }
}

// NAMES

export const MAX_ENTITY_NAME_LENGTH = 60
const RESERVED_ENTITY_NAMES = ['bridge', 'preset', 'coordinator']
const FORBIDDEN_NAME_CHARACTERS = ['/', '#', '+']

export const isUnnamed = (light: Light): boolean => light.name === light.address

export const entityNameProblem = (
  name: string,
  takenNames: ReadonlyArray<string>,
): Option.Option<string> => {
  const trimmed = String.trim(name)
  if (String.isEmpty(trimmed)) {
    return Option.some('Give it a name.')
  }
  if (trimmed.length > MAX_ENTITY_NAME_LENGTH) {
    return Option.some(
      `Keep the name under ${MAX_ENTITY_NAME_LENGTH} characters.`,
    )
  }
  if (
    Array.some(FORBIDDEN_NAME_CHARACTERS, character =>
      String.includes(character)(trimmed),
    )
  ) {
    return Option.some("Names can't contain /, # or +.")
  }
  if (Array.contains(RESERVED_ENTITY_NAMES, String.toLowerCase(trimmed))) {
    return Option.some('That name is reserved. Pick another one.')
  }
  return Array.contains(takenNames, trimmed)
    ? Option.some('Another light or group already has that name.')
    : Option.none()
}

// PAIRING

export const NewDeviceSetup = Schema.Literals([
  'Joining',
  'ReadyLight',
  'NotALight',
  'Failed',
])
export type NewDeviceSetup = typeof NewDeviceSetup.Type

export const NewDevice = Schema.Struct({
  address: Schema.String,
  setup: NewDeviceSetup,
  maybeDescription: Schema.Option(Schema.String),
})
export type NewDevice = typeof NewDevice.Type

export const Pairing = defineTaggedUnion({
  Closed: {},
  Open: { maybeEndsAt: Schema.Option(Schema.Number) },
})
export type Pairing = typeof Pairing.Type

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
  ReportedLights: {
    lights: Schema.Array(Light),
    newDevices: Schema.Array(NewDevice),
  },
  ReportedPairing: { pairing: Pairing },
  ReportedBridgeResponse: {
    transaction: Schema.String,
    maybeError: Schema.Option(Schema.String),
  },
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
    type: Schema.optional(Schema.String),
    interview_state: Schema.optional(Schema.String),
    definition: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          description: Schema.optional(Schema.NullOr(Schema.String)),
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

const RawBridgeInfo = Schema.Struct({
  permit_join: Schema.Boolean,
  permit_join_end: Schema.optional(Schema.NullOr(Schema.Number)),
})

const RawBridgeResponse = Schema.Struct({
  status: Schema.String,
  transaction: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.NullOr(Schema.String)),
})

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
const decodeRawBridgeInfo = Schema.decodeUnknownOption(RawBridgeInfo)
const decodeRawBridgeResponse = Schema.decodeUnknownOption(RawBridgeResponse)
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

const COORDINATOR_TYPE = 'Coordinator'
const FAILED_INTERVIEW = 'FAILED'
const SUCCESSFUL_INTERVIEW = 'SUCCESSFUL'

const newDeviceSetup = (device: RawDevice): NewDeviceSetup => {
  if (device.interview_state === FAILED_INTERVIEW) {
    return 'Failed'
  }
  if (Option.isSome(toLight(device))) {
    return 'ReadyLight'
  }
  return device.interview_state === SUCCESSFUL_INTERVIEW
    ? 'NotALight'
    : 'Joining'
}

// NOTE: Zigbee2MQTT names a device after its address until someone renames it,
// so an unnamed device is one still waiting to be set up. That survives a
// reload or a missed event, unlike the one-off join events.
const toNewDevice = (device: RawDevice): Option.Option<NewDevice> =>
  device.type !== COORDINATOR_TYPE &&
  device.friendly_name === device.ieee_address
    ? Option.some({
        address: device.ieee_address,
        setup: newDeviceSetup(device),
        maybeDescription: pipe(
          Option.fromNullishOr(device.definition),
          Option.flatMap(definition =>
            Option.fromNullishOr(definition.description),
          ),
        ),
      })
    : Option.none()

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
              newDevices: Array.getSomes(Array.map(devices, toNewDevice)),
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
      Match.when('bridge/info', () =>
        Option.some(
          readKnownFrame(topic, decodeRawBridgeInfo(payload), info =>
            IncomingFrame.ReportedPairing({
              pairing: info.permit_join
                ? Pairing.Open({
                    maybeEndsAt: Option.fromNullishOr(info.permit_join_end),
                  })
                : Pairing.Closed(),
            }),
          ),
        ),
      ),
      Match.when(String.startsWith('bridge/response/'), () =>
        pipe(
          decodeRawBridgeResponse(payload),
          Option.flatMap(({ status, transaction, error }) =>
            typeof transaction === 'string'
              ? Option.some(
                  IncomingFrame.ReportedBridgeResponse({
                    transaction,
                    maybeError:
                      status === 'ok'
                        ? Option.none()
                        : Option.some(error ?? 'Zigbee2MQTT refused that.'),
                  }),
                )
              : Option.none(),
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

export const applyLightPresetFrame = (light: string, name: string): string =>
  encodeFrame('preset/set', { name, light })

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

export const askStateFrame = (name: string): string =>
  encodeFrame(`${name}/get`, { state: '', brightness: '' })

export const BridgeRequest = defineTaggedUnion({
  OpenPairing: { seconds: Schema.Number },
  ClosePairing: {},
  RenameLight: { address: Schema.String, to: Schema.String },
  RemoveLight: { address: Schema.String, isForced: Schema.Boolean },
  CreateGroup: { name: Schema.String },
  RenameGroup: { from: Schema.String, to: Schema.String },
  RemoveGroup: { name: Schema.String, isForced: Schema.Boolean },
  AddToGroup: { address: Schema.String, group: Schema.String },
  RemoveFromGroup: { address: Schema.String, group: Schema.String },
})
export type BridgeRequest = typeof BridgeRequest.Type

type TopicAndPayload = readonly [string, Readonly<Record<string, unknown>>]

const bridgeRequestTopicAndPayload = (
  request: BridgeRequest,
): TopicAndPayload =>
  BridgeRequest.match<TopicAndPayload>(request, {
    OpenPairing: ({ seconds }) => ['permit_join', { time: seconds }],
    ClosePairing: () => ['permit_join', { time: 0 }],
    RenameLight: ({ address, to }) => ['device/rename', { from: address, to }],
    RemoveLight: ({ address, isForced }) => [
      'device/remove',
      { id: address, force: isForced },
    ],
    CreateGroup: ({ name }) => ['group/add', { friendly_name: name }],
    RenameGroup: ({ from, to }) => ['group/rename', { from, to }],
    RemoveGroup: ({ name, isForced }) => [
      'group/remove',
      { id: name, force: isForced },
    ],
    AddToGroup: ({ address, group }) => [
      'group/members/add',
      { group, device: address },
    ],
    RemoveFromGroup: ({ address, group }) => [
      'group/members/remove',
      { group, device: address },
    ],
  })

export const bridgeRequestFrame = (
  request: BridgeRequest,
  transaction: string,
): string => {
  const [topic, payload] = bridgeRequestTopicAndPayload(request)
  return encodeFrame(`bridge/request/${topic}`, { ...payload, transaction })
}

// NOTE: Additions run first, so a failure partway leaves a bulb in too many
// groups rather than in none.
export const membershipRequests = (
  address: string,
  change: MembershipChange,
): ReadonlyArray<BridgeRequest> => [
  ...Array.map(change.add, group =>
    BridgeRequest.AddToGroup({ address, group }),
  ),
  ...Array.map(change.remove, group =>
    BridgeRequest.RemoveFromGroup({ address, group }),
  ),
]

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
