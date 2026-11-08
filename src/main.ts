import {
  Array,
  Duration,
  Effect,
  Match,
  Option,
  Queue,
  Record,
  Schema,
  Stream,
  String,
  pipe,
} from 'effect'
import {
  Command,
  ManagedResource,
  Runtime,
  Subscription,
  Update,
} from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import * as Slider from '@/components/ui/slider'

import {
  type ColorTempRange,
  DEFAULT_COLOR_TEMP,
  Group,
  IncomingFrame,
  Light,
  LightState,
  MAX_BRIGHTNESS,
  MIN_BRIGHTNESS,
  Power,
  Preset,
  PresetLook,
  SavablePresetLook,
  Setting,
  applyLightPresetFrame,
  applyPresetFrame,
  clampGroupLevel,
  decodeFrame,
  deletePresetFrame,
  hueSaturationToHex,
  powerFrame,
  savePresetFrame,
  settingFrame,
} from './domain'

const CONNECTION_TIMEOUT_MS = 5000
const MAX_RECONNECT_DELAY_MS = 30_000
const BASE_RECONNECT_DELAY_MS = 500
const SETTING_THROTTLE_MS = 400
const REPEAT_GROUP_POWER_DELAY_MS = 400
const MAX_PRESET_NAME_LENGTH = 40
const SLIDER_STEP = 1
const DRAFT_SETTLE_TIMEOUT_MS = 1500
const POWER_CONFIRM_TIMEOUT_MS = 5000
const PRESET_APPLY_TIMEOUT_MS = 5000
const PRESET_SAVE_TIMEOUT_MS = 5000
const NO_RESPONSE_NOTICE_MS = 4000
const STARTUP_FRAMES_TIMEOUT_MS = 3000
const STRUGGLING_CONNECTION_ATTEMPTS = 3
export const PRESET_COLOR_TEMP_RANGE: ColorTempRange = { min: 153, max: 555 }

// MODEL

const Z2mSocket = ManagedResource.tag<WebSocket>()('Z2mSocket')
type Z2mSocketService = ManagedResource.ServiceOf<typeof Z2mSocket>

export const Connection = defineTaggedUnion({
  Connecting: { attempt: Schema.Number },
  Connected: {},
  WaitingToReconnect: { attempt: Schema.Number },
})
export type Connection = typeof Connection.Type

export const Target = defineTaggedUnion({
  Light: { name: Schema.String },
  Group: { name: Schema.String },
})
export type Target = typeof Target.Type

export const SettingKind = Schema.Literals(['Brightness', 'ColorTemp', 'Color'])
export type SettingKind = typeof SettingKind.Type

export const DraftPhase = defineTaggedUnion({
  Throttling: { isDirty: Schema.Boolean },
  Settling: { requestId: Schema.Number },
})
export type DraftPhase = typeof DraftPhase.Type

const Draft = Schema.Struct({
  target: Target,
  setting: Setting,
  phase: DraftPhase,
  awaitingReports: Schema.Array(Schema.String),
})
type Draft = typeof Draft.Type

export const Activity = defineTaggedUnion({
  SettingPower: { power: Power },
  ApplyingPreset: { preset: Schema.String },
  NoResponse: {},
})
export type Activity = typeof Activity.Type

const TargetActivity = Schema.Struct({
  requestId: Schema.Number,
  target: Target,
  activity: Activity,
})
type TargetActivity = typeof TargetActivity.Type

export const InitialFrame = Schema.Literals(['Lights', 'Groups', 'Presets'])
export type InitialFrame = typeof InitialFrame.Type

export const Startup = defineTaggedUnion({
  Loading: { missing: Schema.Array(InitialFrame) },
  Ready: {},
})
export type Startup = typeof Startup.Type

export const SliderId = defineTaggedUnion({
  TargetBrightness: { target: Target },
  TargetColorTemp: { target: Target },
  EditorBrightness: {},
  EditorColorTemp: {},
})
export type SliderId = typeof SliderId.Type

const ActiveSlider = Schema.Struct({
  sliderId: SliderId,
  slider: Slider.Model,
})

export const EditingPreset = Schema.Struct({
  maybeOriginalName: Schema.Option(Schema.String),
  name: Schema.String,
  brightness: Schema.Number,
  look: SavablePresetLook,
})
export type EditingPreset = typeof EditingPreset.Type

export const PresetEditor = defineTaggedUnion({
  Closed: {},
  Open: { editing: EditingPreset, maybeFailure: Schema.Option(Schema.String) },
  Saving: { editing: EditingPreset, requestId: Schema.Number },
  Deleting: { editing: EditingPreset, requestId: Schema.Number },
})
export type PresetEditor = typeof PresetEditor.Type

export const Model = Schema.Struct({
  connection: Connection,
  startup: Startup,
  isBridgeOnline: Schema.Boolean,
  lights: Schema.Array(Light),
  groups: Schema.Array(Group),
  states: Schema.Record(Schema.String, LightState),
  groupLevels: Schema.Record(Schema.String, Schema.Number),
  presets: Schema.Array(Preset),
  drafts: Schema.Array(Draft),
  activities: Schema.Array(TargetActivity),
  nextRequestId: Schema.Number,
  maybeExpanded: Schema.Option(Target),
  maybeActiveSlider: Schema.Option(ActiveSlider),
  presetEditor: PresetEditor,
  maybeProblem: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  AcquiredSocket: {},
  ReleasedSocket: {},
  FailedAcquireSocket: { error: Schema.String },
  ClosedSocket: {},
  CompletedWaitToReconnect: {},
  ReceivedFrame: { frame: IncomingFrame },
  ClickedPower: { target: Target },
  ClickedExpand: { target: Target },
  UpdatedSetting: { target: Target, setting: Setting },
  CompletedThrottleWait: { target: Target, kind: SettingKind },
  CompletedWaitForConfirmation: { requestId: Schema.Number },
  CompletedWaitForStartupFrames: {},
  GotSliderMessage: { sliderId: SliderId, message: Slider.Message },
  GotActiveSliderMessage: { message: Slider.Message },
  ClickedPreset: { target: Target, preset: Schema.String },
  ClickedNewPreset: {},
  ClickedEditPreset: { preset: Schema.String },
  UpdatedEditorName: { value: Schema.String },
  UpdatedEditorLook: { look: SavablePresetLook },
  ClickedCancelEditor: {},
  SubmittedEditor: {},
  ClickedDeletePreset: {},
  SucceededSendFrame: {},
  FailedSendFrame: { error: Schema.String },
})
export type Message = typeof Message.Type

// DERIVED

export type TargetStatus = Readonly<{
  hasReported: boolean
  isOn: boolean
  brightness: number
  maybeColorTemp: Option.Option<number>
  maybeHex: Option.Option<string>
  maybeColorTempRange: Option.Option<ColorTempRange>
  supportsColor: boolean
}>

const groupMembers = (model: Model, group: Group): ReadonlyArray<Light> =>
  Array.filter(model.lights, light =>
    Array.contains(group.memberAddresses, light.address),
  )

const statusOf = (
  lights: ReadonlyArray<Light>,
  states: ReadonlyArray<LightState>,
): TargetStatus => {
  const onStates = Array.filter(states, state => state.power === 'ON')
  const shownStates = Array.isArrayNonEmpty(onStates) ? onStates : states
  const ranges = Array.getSomes(
    Array.map(lights, light => light.maybeColorTempRange),
  )
  return {
    hasReported: Array.isReadonlyArrayNonEmpty(states),
    isOn: Array.isArrayNonEmpty(onStates),
    brightness: Array.reduce(shownStates, 1, (highest, state) =>
      Math.max(highest, state.brightness),
    ),
    maybeColorTemp: Array.findFirst(shownStates, state => state.maybeColorTemp),
    maybeHex: Option.map(
      Array.findFirst(shownStates, state => state.maybeHueSaturation),
      hueSaturationToHex,
    ),
    maybeColorTempRange: Array.match(ranges, {
      onEmpty: () => Option.none(),
      onNonEmpty: nonEmptyRanges =>
        Option.some({
          min: Array.reduce(nonEmptyRanges, 0, (highest, range) =>
            Math.max(highest, range.min),
          ),
          max: Array.reduce(
            nonEmptyRanges,
            Number.POSITIVE_INFINITY,
            (lowest, range) => Math.min(lowest, range.max),
          ),
        }),
    }),
    supportsColor: Array.some(lights, light => light.supportsColor),
  }
}

const statesOf = (
  model: Model,
  lights: ReadonlyArray<Light>,
): ReadonlyArray<LightState> =>
  Array.getSomes(
    Array.map(lights, light => Record.get(model.states, light.name)),
  )

export const lightsOfTarget = (
  model: Model,
  target: Target,
): ReadonlyArray<Light> =>
  Target.match(target, {
    Light: ({ name }) =>
      Array.filter(model.lights, light => light.name === name),
    Group: ({ name }) =>
      pipe(
        Array.findFirst(model.groups, group => group.name === name),
        Option.match({
          onNone: () => [],
          onSome: group => groupMembers(model, group),
        }),
      ),
  })

export const targetStatus = (model: Model, target: Target): TargetStatus => {
  const lights = lightsOfTarget(model, target)
  const status = statusOf(lights, statesOf(model, lights))
  return Target.match(target, {
    Light: () => status,
    Group: ({ name }) =>
      Option.match(Record.get(model.groupLevels, name), {
        onNone: () => status,
        onSome: level => modifyFields(status, { brightness: () => level }),
      }),
  })
}

const settingKindOf = (setting: Setting): SettingKind => setting._tag

const isSameTarget = (first: Target, second: Target): boolean =>
  first._tag === second._tag && first.name === second.name

const isActivityFor = (target: Target) => (entry: TargetActivity) =>
  isSameTarget(entry.target, target)

const isDraftFor = (target: Target, kind: SettingKind) => (draft: Draft) =>
  isSameTarget(draft.target, target) && draft.setting._tag === kind

export const draftSetting = (
  model: Model,
  target: Target,
  kind: SettingKind,
): Option.Option<Setting> =>
  Option.map(
    Array.findFirst(model.drafts, isDraftFor(target, kind)),
    draft => draft.setting,
  )

export const canControl = (model: Model): boolean =>
  model.connection._tag === 'Connected' && model.isBridgeOnline

export const isStrugglingToConnect = (connection: Connection): boolean =>
  Connection.match(connection, {
    Connecting: ({ attempt }) => attempt >= STRUGGLING_CONNECTION_ATTEMPTS,
    WaitingToReconnect: ({ attempt }) =>
      attempt >= STRUGGLING_CONNECTION_ATTEMPTS,
    Connected: () => false,
  })

export const activityOf = (
  model: Model,
  target: Target,
): Option.Option<Activity> =>
  Option.map(
    Array.findFirst(model.activities, isActivityFor(target)),
    entry => entry.activity,
  )

export const isExpanded = (model: Model, target: Target): boolean =>
  Option.exists(model.maybeExpanded, expanded => isSameTarget(expanded, target))

export const presetEditorProblem = (
  model: Model,
  editing: EditingPreset,
): Option.Option<string> => {
  const name = String.trim(editing.name)
  if (String.isEmpty(name)) {
    return Option.some('Give the preset a name.')
  }
  if (name.length > MAX_PRESET_NAME_LENGTH) {
    return Option.some(
      `Keep the name under ${MAX_PRESET_NAME_LENGTH} characters.`,
    )
  }
  const isTaken = Array.some(
    model.presets,
    preset =>
      preset.name === name &&
      !Option.contains(editing.maybeOriginalName, preset.name),
  )
  return isTaken
    ? Option.some('Another preset already has that name.')
    : Option.none()
}

const domSafeName = (name: string): string =>
  pipe(name, String.toLowerCase, String.replaceAll(' ', '-'))

export const targetId = (target: Target): string =>
  `${String.toLowerCase(target._tag)}-${domSafeName(target.name)}`

export const sliderDomId = (sliderId: SliderId): string =>
  SliderId.match(sliderId, {
    TargetBrightness: ({ target }) => `${targetId(target)}-brightness`,
    TargetColorTemp: ({ target }) => `${targetId(target)}-temperature`,
    EditorBrightness: () => 'preset-brightness',
    EditorColorTemp: () => 'preset-temperature',
  })

const sliderRange = (model: Model, sliderId: SliderId): ColorTempRange => {
  const brightnessRange = { min: MIN_BRIGHTNESS, max: MAX_BRIGHTNESS }
  return SliderId.match(sliderId, {
    TargetBrightness: () => brightnessRange,
    TargetColorTemp: ({ target }) =>
      Option.getOrElse(
        targetStatus(model, target).maybeColorTempRange,
        () => PRESET_COLOR_TEMP_RANGE,
      ),
    EditorBrightness: () => brightnessRange,
    EditorColorTemp: () => PRESET_COLOR_TEMP_RANGE,
  })
}

// NOTE: Only a dragged slider has state worth keeping, so every other slider
// is rebuilt idle from the Model instead of being stored per bulb.
export const sliderModelOf = (model: Model, sliderId: SliderId): Slider.Model =>
  pipe(
    model.maybeActiveSlider,
    Option.filter(active => active.slider.id === sliderDomId(sliderId)),
    Option.match({
      onNone: () =>
        Slider.init({
          id: sliderDomId(sliderId),
          ...sliderRange(model, sliderId),
          step: SLIDER_STEP,
        }),
      onSome: active => active.slider,
    }),
  )

const reconnectDelayMs = (attempt: number): number =>
  Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** attempt)

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Z2mSocketService>

const nextAttempt = (connection: Connection): number =>
  Connection.match(connection, {
    Connecting: ({ attempt }) => attempt + 1,
    Connected: () => 0,
    WaitingToReconnect: ({ attempt }) => attempt,
  })

const startReconnectWait = (model: Model): UpdateReturn => {
  const attempt = nextAttempt(model.connection)
  return {
    model: modifyFields(model, {
      connection: () => Connection.WaitingToReconnect({ attempt }),
      drafts: () => [],
      activities: () => [],
      presetEditor: editor => failedEditor(editor, CONNECTION_LOST_FAILURE),
    }),
    commands: [WaitToReconnect({ delayMs: reconnectDelayMs(attempt) })],
  }
}

// NOTE: A group has no brightness of its own once its bulbs differ, so it keeps
// the last level until every bulb is above it or below it. A draft pins the
// level so frames still in flight from earlier in a drag can't pull it back.
const settledGroupLevel = (
  model: Model,
  group: Group,
): Option.Option<number> => {
  const maybeLevel = Record.get(model.groupLevels, group.name)
  const target = Target.Group({ name: group.name })
  if (Option.isSome(draftSetting(model, target, 'Brightness'))) {
    return maybeLevel
  }
  const lights = groupMembers(model, group)
  const states = statesOf(model, lights)
  return Array.match(states, {
    onEmpty: () => maybeLevel,
    onNonEmpty: reportedStates =>
      Option.match(maybeLevel, {
        onNone: () =>
          states.length === lights.length
            ? Option.some(statusOf(lights, states).brightness)
            : Option.none(),
        onSome: level =>
          Option.some(
            clampGroupLevel(
              level,
              Array.map(reportedStates, state => state.brightness),
            ),
          ),
      }),
  })
}

const withSettledGroupLevels = (model: Model): Model =>
  modifyFields(model, {
    groupLevels: () =>
      Record.fromEntries(
        Array.getSomes(
          Array.map(model.groups, group =>
            Option.map(
              settledGroupLevel(model, group),
              (level): [string, number] => [group.name, level],
            ),
          ),
        ),
      ),
  })

const CONNECTION_LOST_FAILURE =
  'Lost the connection before that finished. Try again.'
const NO_CONFIRMATION_FAILURE = "Didn't hear back from Zigbee2MQTT. Try again."

const failedEditor = (editor: PresetEditor, failure: string): PresetEditor =>
  PresetEditor.match(editor, {
    Closed: () => editor,
    Open: () => editor,
    Saving: ({ editing }) =>
      PresetEditor.Open({ editing, maybeFailure: Option.some(failure) }),
    Deleting: ({ editing }) =>
      PresetEditor.Open({ editing, maybeFailure: Option.some(failure) }),
  })

const isReportFrom = (model: Model, target: Target, name: string): boolean =>
  target.name === name ||
  Array.some(lightsOfTarget(model, target), light => light.name === name)

const isActivityConfirmed =
  (model: Model, name: string) =>
  (entry: TargetActivity): boolean =>
    Activity.match(entry.activity, {
      SettingPower: ({ power }) =>
        isReportFrom(model, entry.target, name) &&
        targetStatus(model, entry.target).isOn === (power === 'ON'),
      ApplyingPreset: () => isReportFrom(model, entry.target, name),
      NoResponse: () => isReportFrom(model, entry.target, name),
    })

const withoutConfirmedActivities = (model: Model, name: string): Model =>
  modifyFields(model, {
    activities: activities =>
      Array.filter(
        activities,
        entry => !isActivityConfirmed(model, name)(entry),
      ),
  })

const isSettled = (draft: Draft): boolean =>
  draft.phase._tag === 'Settling' &&
  Array.isReadonlyArrayEmpty(draft.awaitingReports)

const reportMatchesSetting = (state: LightState, setting: Setting): boolean =>
  Setting.match(setting, {
    Brightness: ({ value }) => state.brightness === value,
    ColorTemp: ({ value }) => Option.contains(state.maybeColorTemp, value),
    Color: () => true,
  })

// NOTE: A draft holds until every bulb it was sent to reports the value it was
// last sent, so neither the value from before the drag nor a late report of an
// earlier position can pull the slider backward. Color has no exact match,
// because bulbs report it back as hue and saturation. The settle timeout caps
// the wait, after which whatever the bulb last reported wins.
const withReportCounted = (
  model: Model,
  name: string,
  state: LightState,
): Model =>
  modifyFields(model, {
    drafts: drafts =>
      Array.filter(
        Array.map(drafts, draft =>
          reportMatchesSetting(state, draft.setting)
            ? modifyFields(draft, {
                awaitingReports: names =>
                  Array.filter(names, candidate => candidate !== name),
              })
            : draft,
        ),
        draft => !isSettled(draft),
      ),
  })

const withLightState = (model: Model, name: string, state: LightState): Model =>
  pipe(
    modifyFields(model, {
      states: states => Record.set(states, name, state),
    }),
    next => withoutConfirmedActivities(next, name),
    next => withReportCounted(next, name, state),
  )

const isConfirmedByPresets = (
  editor: PresetEditor,
  presets: ReadonlyArray<Preset>,
): boolean => {
  const isNamed = (name: string) =>
    Array.some(presets, preset => preset.name === name)
  return PresetEditor.match(editor, {
    Closed: () => false,
    Open: () => false,
    Saving: ({ editing }) => isNamed(String.trim(editing.name)),
    Deleting: ({ editing }) =>
      Option.exists(editing.maybeOriginalName, name => !isNamed(name)),
  })
}

const withReceived = (model: Model, received: InitialFrame): Model =>
  modifyFields(model, {
    startup: startup =>
      Startup.match(startup, {
        Loading: ({ missing }) =>
          Startup.Loading({
            missing: Array.filter(missing, frame => frame !== received),
          }),
        Ready: () => startup,
      }),
  })

const applyFrame = (model: Model, frame: IncomingFrame): Model =>
  IncomingFrame.match(frame, {
    ReportedLights: ({ lights }) =>
      withReceived(
        withSettledGroupLevels(modifyFields(model, { lights: () => lights })),
        'Lights',
      ),
    ReportedGroups: ({ groups }) =>
      withReceived(
        withSettledGroupLevels(modifyFields(model, { groups: () => groups })),
        'Groups',
      ),
    ReportedLightState: ({ name, state }) =>
      withSettledGroupLevels(withLightState(model, name, state)),
    ReportedBridge: ({ isOnline }) =>
      modifyFields(model, { isBridgeOnline: () => isOnline }),
    ReportedPresets: ({ presets }) =>
      withReceived(
        modifyFields(model, {
          presets: () => presets,
          presetEditor: editor =>
            isConfirmedByPresets(editor, presets)
              ? PresetEditor.Closed()
              : editor,
        }),
        'Presets',
      ),
    Unreadable: ({ topic }) =>
      modifyFields(model, {
        maybeProblem: () =>
          Option.some(
            `Zigbee2MQTT sent a ${topic} update this app can't read.`,
          ),
      }),
  })

const hasEveryInitialFrame = (
  model: Model,
  missing: ReadonlyArray<InitialFrame>,
) =>
  Array.isReadonlyArrayEmpty(missing) &&
  Array.every(model.lights, light => Record.has(model.states, light.name))

// NOTE: Zigbee2MQTT sends everything in one burst on connect. Holding the
// first paint until the burst lands stops the page assembling itself piece by
// piece, with every bulb briefly shown as off.
const withStartupSettled = (model: Model): Model =>
  Startup.match(model.startup, {
    Loading: ({ missing }) =>
      hasEveryInitialFrame(model, missing)
        ? modifyFields(model, { startup: () => Startup.Ready() })
        : model,
    Ready: () => model,
  })

const expiredDrafts = (model: Model, requestId: number): Model =>
  modifyFields(model, {
    drafts: drafts =>
      Array.filter(
        drafts,
        draft =>
          !(
            draft.phase._tag === 'Settling' &&
            draft.phase.requestId === requestId
          ),
      ),
  })

const expiredEditor = (model: Model, requestId: number): Model => {
  const expireIfRequested = (candidateId: number): PresetEditor =>
    candidateId === requestId
      ? failedEditor(model.presetEditor, NO_CONFIRMATION_FAILURE)
      : model.presetEditor
  return modifyFields(model, {
    presetEditor: editor =>
      PresetEditor.match(editor, {
        Closed: () => editor,
        Open: () => editor,
        Saving: ({ requestId: candidateId }) => expireIfRequested(candidateId),
        Deleting: ({ requestId: candidateId }) =>
          expireIfRequested(candidateId),
      }),
  })
}

const withoutActivity = (model: Model, requestId: number): Model =>
  modifyFields(model, {
    activities: activities =>
      Array.filter(activities, entry => entry.requestId !== requestId),
  })

const expiredConfirmation = (model: Model, requestId: number): UpdateReturn => {
  const expired = expiredEditor(expiredDrafts(model, requestId), requestId)
  return Option.match(
    Array.findFirst(expired.activities, entry => entry.requestId === requestId),
    {
      onNone: () => ({ model: expired }),
      onSome: entry =>
        Activity.match<UpdateReturn>(entry.activity, {
          SettingPower: () =>
            startActivity(
              expired,
              entry.target,
              Activity.NoResponse(),
              NO_RESPONSE_NOTICE_MS,
              [],
            ),
          ApplyingPreset: () => ({
            model: withoutActivity(expired, requestId),
          }),
          NoResponse: () => ({ model: withoutActivity(expired, requestId) }),
        }),
    },
  )
}

const startActivity = (
  model: Model,
  target: Target,
  activity: Activity,
  timeoutMs: number,
  sendCommands: UpdateReturn['commands'],
): UpdateReturn => ({
  model: modifyFields(model, {
    activities: activities => [
      ...Array.filter(activities, entry => !isActivityFor(target)(entry)),
      { requestId: model.nextRequestId, target, activity },
    ],
    nextRequestId: id => id + 1,
  }),
  commands: [
    ...(sendCommands ?? []),
    WaitForConfirmation({
      requestId: model.nextRequestId,
      delayMs: timeoutMs,
    }),
  ],
})

const settingCommands = (target: Target, setting: Setting) => [
  SendFrame({ frame: settingFrame(target.name, setting) }),
  WaitForThrottle({ target, kind: settingKindOf(setting) }),
]

const editorFromPreset = (preset: Preset): Option.Option<EditingPreset> =>
  PresetLook.match(preset.look, {
    Rainbow: () => Option.none(),
    Color: ({ hex }) =>
      Option.some({
        maybeOriginalName: Option.some(preset.name),
        name: preset.name,
        brightness: preset.brightness,
        look: SavablePresetLook.Color({ hex }),
      }),
    White: ({ colorTemp }) =>
      Option.some({
        maybeOriginalName: Option.some(preset.name),
        name: preset.name,
        brightness: preset.brightness,
        look: SavablePresetLook.White({ colorTemp }),
      }),
  })

const modifyEditing = (
  model: Model,
  modify: (editing: EditingPreset) => EditingPreset,
): UpdateReturn => ({
  model: modifyFields(model, {
    presetEditor: editor =>
      PresetEditor.match(editor, {
        Closed: () => editor,
        Open: ({ editing, maybeFailure }) =>
          PresetEditor.Open({ editing: modify(editing), maybeFailure }),
        Saving: () => editor,
        Deleting: () => editor,
      }),
  }),
})

const closedEditor = (model: Model) =>
  modifyFields(model, { presetEditor: () => PresetEditor.Closed() })

const withEditedGroupLevel = (
  levels: Model['groupLevels'],
  target: Target,
  setting: Setting,
): Model['groupLevels'] =>
  target._tag === 'Group' && setting._tag === 'Brightness'
    ? Record.set(levels, target.name, setting.value)
    : levels

export const isEditorBusy = (editor: PresetEditor): boolean =>
  editor._tag === 'Saving' || editor._tag === 'Deleting'

const startEditorRequest = (
  model: Model,
  editor: PresetEditor,
  frame: string,
): UpdateReturn => ({
  model: modifyFields(model, {
    presetEditor: () => editor,
    nextRequestId: id => id + 1,
  }),
  commands: [
    SendFrame({ frame }),
    WaitForConfirmation({
      requestId: model.nextRequestId,
      delayMs: PRESET_SAVE_TIMEOUT_MS,
    }),
  ],
})

const awaitingReportsFor = (
  model: Model,
  target: Target,
): ReadonlyArray<string> =>
  Array.map(lightsOfTarget(model, target), light => light.name)

const throttlingDraft = (
  model: Model,
  target: Target,
  setting: Setting,
): Draft => ({
  target,
  setting,
  phase: DraftPhase.Throttling({ isDirty: false }),
  awaitingReports: awaitingReportsFor(model, target),
})

const updatedSetting = (
  model: Model,
  target: Target,
  setting: Setting,
): UpdateReturn => {
  if (model.connection._tag !== 'Connected') {
    return { model }
  }
  const isThisDraft = isDraftFor(target, settingKindOf(setting))
  const groupLevels = () =>
    withEditedGroupLevel(model.groupLevels, target, setting)
  const replacedDrafts = (draft: Draft) =>
    Array.map(model.drafts, candidate =>
      isThisDraft(candidate) ? draft : candidate,
    )
  const sentImmediately = (drafts: ReadonlyArray<Draft>): UpdateReturn => ({
    model: modifyFields(model, { drafts: () => drafts, groupLevels }),
    commands: settingCommands(target, setting),
  })
  return Option.match(Array.findFirst(model.drafts, isThisDraft), {
    onNone: () =>
      sentImmediately([
        ...model.drafts,
        throttlingDraft(model, target, setting),
      ]),
    onSome: draft =>
      DraftPhase.match<UpdateReturn>(draft.phase, {
        Throttling: () => ({
          model: modifyFields(model, {
            drafts: () =>
              replacedDrafts(
                modifyFields(draft, {
                  setting: () => setting,
                  phase: () => DraftPhase.Throttling({ isDirty: true }),
                }),
              ),
            groupLevels,
          }),
        }),
        Settling: () =>
          sentImmediately(
            replacedDrafts(throttlingDraft(model, target, setting)),
          ),
      }),
  })
}

const appliedSliderValue = (
  model: Model,
  sliderId: SliderId,
  value: number,
): UpdateReturn =>
  SliderId.match<UpdateReturn>(sliderId, {
    TargetBrightness: ({ target }) =>
      updatedSetting(model, target, Setting.Brightness({ value })),
    TargetColorTemp: ({ target }) =>
      updatedSetting(model, target, Setting.ColorTemp({ value })),
    EditorBrightness: () =>
      modifyEditing(model, editing =>
        modifyFields(editing, { brightness: () => value }),
      ),
    EditorColorTemp: () =>
      modifyEditing(model, editing =>
        modifyFields(editing, {
          look: () => SavablePresetLook.White({ colorTemp: value }),
        }),
      ),
  })

const foldSliderMessage = (sliderId: SliderId) =>
  Update.foldChild({
    update: Slider.update,
    read: (model: Model) => Option.some(sliderModelOf(model, sliderId)),
    write: (model: Model, nextSlider: Slider.Model) =>
      modifyFields(model, {
        maybeActiveSlider: () =>
          nextSlider.dragState._tag === 'Dragging'
            ? Option.some({ sliderId, slider: nextSlider })
            : Option.none(),
      }),
    toParentMessage: (message: Slider.Message): Message =>
      Message.GotSliderMessage({ sliderId, message }),
    foldOutMessage: outMessage =>
      Slider.OutMessage.match(outMessage, {
        ChangedValue:
          ({ value }) =>
          (stepModel: Model) =>
            appliedSliderValue(stepModel, sliderId, value),
      }),
  })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    AcquiredSocket: () => ({
      model: modifyFields(model, {
        connection: () => Connection.Connected(),
        maybeProblem: () => Option.none(),
      }),
      commands: Startup.match(model.startup, {
        Loading: () => [WaitForStartupFrames()],
        Ready: () => [],
      }),
    }),

    ReleasedSocket: () => ({ model }),

    FailedAcquireSocket: () => startReconnectWait(model),

    ClosedSocket: () =>
      Match.value(model.connection).pipe(
        Match.withReturnType<UpdateReturn>(),
        Match.tag('Connected', () => startReconnectWait(model)),
        Match.orElse(() => ({ model })),
      ),

    CompletedWaitToReconnect: () =>
      Match.value(model.connection).pipe(
        Match.withReturnType<UpdateReturn>(),
        Match.tag('WaitingToReconnect', ({ attempt }) => ({
          model: modifyFields(model, {
            connection: () => Connection.Connecting({ attempt }),
          }),
        })),
        Match.orElse(() => ({ model })),
      ),

    ReceivedFrame: ({ frame }) => ({
      model: withStartupSettled(applyFrame(model, frame)),
    }),

    CompletedWaitForStartupFrames: () => ({
      model: modifyFields(model, { startup: () => Startup.Ready() }),
    }),

    CompletedWaitForConfirmation: ({ requestId }) =>
      expiredConfirmation(model, requestId),

    ClickedPower: ({ target }) => {
      const isAlreadySetting = Option.exists(
        activityOf(model, target),
        activity => activity._tag === 'SettingPower',
      )
      if (isAlreadySetting || model.connection._tag !== 'Connected') {
        return { model }
      }
      const power: Power = targetStatus(model, target).isOn ? 'OFF' : 'ON'
      return startActivity(
        model,
        target,
        Activity.SettingPower({ power }),
        POWER_CONFIRM_TIMEOUT_MS,
        [SendFrameTwice({ frame: powerFrame(target.name, power) })],
      )
    },

    ClickedExpand: ({ target }) => ({
      model: modifyFields(model, {
        maybeExpanded: () =>
          isExpanded(model, target) ? Option.none() : Option.some(target),
      }),
    }),

    UpdatedSetting: ({ target, setting }) =>
      updatedSetting(model, target, setting),

    GotSliderMessage: ({ sliderId, message }) =>
      foldSliderMessage(sliderId)(model, message),

    GotActiveSliderMessage: ({ message }) =>
      Option.match(model.maybeActiveSlider, {
        onNone: () => ({ model }),
        onSome: ({ sliderId }) => foldSliderMessage(sliderId)(model, message),
      }),

    CompletedThrottleWait: ({ target, kind }) => {
      const isThisDraft = isDraftFor(target, kind)
      const replacingDraft =
        (replacement: Draft) => (drafts: ReadonlyArray<Draft>) =>
          Array.map(drafts, candidate =>
            isThisDraft(candidate) ? replacement : candidate,
          )
      return Option.match(Array.findFirst(model.drafts, isThisDraft), {
        onNone: () => ({ model }),
        onSome: draft => {
          if (draft.phase._tag === 'Settling') {
            return { model }
          }
          if (draft.phase.isDirty) {
            return {
              model: modifyFields(model, {
                drafts: replacingDraft(
                  throttlingDraft(model, target, draft.setting),
                ),
              }),
              commands: settingCommands(target, draft.setting),
            }
          }
          if (Array.isReadonlyArrayEmpty(draft.awaitingReports)) {
            return {
              model: modifyFields(model, {
                drafts: drafts =>
                  Array.filter(drafts, candidate => !isThisDraft(candidate)),
              }),
            }
          }
          return {
            model: modifyFields(model, {
              drafts: replacingDraft(
                modifyFields(draft, {
                  phase: () =>
                    DraftPhase.Settling({ requestId: model.nextRequestId }),
                }),
              ),
              nextRequestId: id => id + 1,
            }),
            commands: [
              WaitForConfirmation({
                requestId: model.nextRequestId,
                delayMs: DRAFT_SETTLE_TIMEOUT_MS,
              }),
            ],
          }
        },
      })
    },

    ClickedPreset: ({ target, preset }) => {
      const isAlreadyApplying = Option.exists(
        activityOf(model, target),
        activity =>
          activity._tag === 'ApplyingPreset' && activity.preset === preset,
      )
      if (isAlreadyApplying || model.connection._tag !== 'Connected') {
        return { model }
      }
      return startActivity(
        model,
        target,
        Activity.ApplyingPreset({ preset }),
        PRESET_APPLY_TIMEOUT_MS,
        [
          SendFrame({
            frame: Target.match(target, {
              Light: ({ name }) => applyLightPresetFrame(name, preset),
              Group: ({ name }) => applyPresetFrame(name, preset),
            }),
          }),
        ],
      )
    },

    ClickedNewPreset: () =>
      isEditorBusy(model.presetEditor)
        ? { model }
        : {
            model: modifyFields(model, {
              presetEditor: () =>
                PresetEditor.Open({
                  editing: {
                    maybeOriginalName: Option.none(),
                    name: '',
                    brightness: MAX_BRIGHTNESS,
                    look: SavablePresetLook.White({
                      colorTemp: DEFAULT_COLOR_TEMP,
                    }),
                  },
                  maybeFailure: Option.none(),
                }),
            }),
          },

    ClickedEditPreset: ({ preset }) =>
      pipe(
        Array.findFirst(model.presets, candidate => candidate.name === preset),
        Option.flatMap(editorFromPreset),
        Option.filter(() => !isEditorBusy(model.presetEditor)),
        Option.match({
          onNone: () => ({ model }),
          onSome: editing => ({
            model: modifyFields(model, {
              presetEditor: () =>
                PresetEditor.Open({ editing, maybeFailure: Option.none() }),
            }),
          }),
        }),
      ),

    UpdatedEditorName: ({ value }) =>
      modifyEditing(model, editing =>
        modifyFields(editing, { name: () => value }),
      ),

    UpdatedEditorLook: ({ look }) =>
      modifyEditing(model, editing =>
        modifyFields(editing, { look: () => look }),
      ),

    ClickedCancelEditor: () =>
      isEditorBusy(model.presetEditor)
        ? { model }
        : { model: closedEditor(model) },

    SubmittedEditor: () =>
      PresetEditor.match<UpdateReturn>(model.presetEditor, {
        Closed: () => ({ model }),
        Saving: () => ({ model }),
        Deleting: () => ({ model }),
        Open: ({ editing }) =>
          Option.isSome(presetEditorProblem(model, editing)) ||
          model.connection._tag !== 'Connected'
            ? { model }
            : startEditorRequest(
                model,
                PresetEditor.Saving({
                  editing,
                  requestId: model.nextRequestId,
                }),
                savePresetFrame(
                  editing.maybeOriginalName,
                  String.trim(editing.name),
                  editing.brightness,
                  editing.look,
                ),
              ),
      }),

    ClickedDeletePreset: () =>
      PresetEditor.match<UpdateReturn>(model.presetEditor, {
        Closed: () => ({ model }),
        Saving: () => ({ model }),
        Deleting: () => ({ model }),
        Open: ({ editing }) =>
          Option.match(editing.maybeOriginalName, {
            onNone: () => ({ model: closedEditor(model) }),
            onSome: name =>
              model.connection._tag === 'Connected'
                ? startEditorRequest(
                    model,
                    PresetEditor.Deleting({
                      editing,
                      requestId: model.nextRequestId,
                    }),
                    deletePresetFrame(name),
                  )
                : { model },
          }),
      }),

    SucceededSendFrame: () => ({ model }),

    FailedSendFrame: ({ error }) => ({
      model: modifyFields(model, {
        maybeProblem: () => Option.some(`Couldn't send that: ${error}`),
        activities: () => [],
        presetEditor: editor => failedEditor(editor, CONNECTION_LOST_FAILURE),
      }),
    }),
  })

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    connection: Connection.Connecting({ attempt: 0 }),
    startup: Startup.Loading({ missing: ['Lights', 'Groups', 'Presets'] }),
    isBridgeOnline: true,
    lights: [],
    groups: [],
    states: {},
    groupLevels: {},
    presets: [],
    drafts: [],
    activities: [],
    nextRequestId: 0,
    maybeExpanded: Option.none(),
    maybeActiveSlider: Option.none(),
    presetEditor: PresetEditor.Closed(),
    maybeProblem: Option.none(),
  },
})

// COMMAND

const sendOnSocket = (frame: string) =>
  Z2mSocket.get.pipe(
    Effect.flatMap(socket =>
      Effect.try({
        try: () => {
          socket.send(frame)
        },
        catch: () => 'the connection dropped',
      }),
    ),
    Effect.catchTag('ResourceNotAvailable', () => Effect.fail('not connected')),
  )

export const SendFrame = Command.define('SendFrame', {
  args: { frame: Schema.String },
  messages: [Message.SucceededSendFrame, Message.FailedSendFrame],
  execute: ({ frame }) =>
    sendOnSocket(frame).pipe(
      Effect.as(Message.SucceededSendFrame()),
      Effect.catch(error => Effect.succeed(Message.FailedSendFrame({ error }))),
    ),
})

export const SendFrameTwice = Command.define('SendFrameTwice', {
  args: { frame: Schema.String },
  messages: [Message.SucceededSendFrame, Message.FailedSendFrame],
  execute: ({ frame }) =>
    sendOnSocket(frame).pipe(
      Effect.andThen(
        Effect.sleep(Duration.millis(REPEAT_GROUP_POWER_DELAY_MS)),
      ),
      Effect.andThen(sendOnSocket(frame)),
      Effect.as(Message.SucceededSendFrame()),
      Effect.catch(error => Effect.succeed(Message.FailedSendFrame({ error }))),
    ),
})

export const WaitForThrottle = Command.define('WaitForThrottle', {
  args: { target: Target, kind: SettingKind },
  messages: [Message.CompletedThrottleWait],
  execute: ({ target, kind }) =>
    Effect.sleep(Duration.millis(SETTING_THROTTLE_MS)).pipe(
      Effect.as(Message.CompletedThrottleWait({ target, kind })),
    ),
})

export const WaitForConfirmation = Command.define('WaitForConfirmation', {
  args: { requestId: Schema.Number, delayMs: Schema.Number },
  messages: [Message.CompletedWaitForConfirmation],
  execute: ({ requestId, delayMs }) =>
    Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.as(Message.CompletedWaitForConfirmation({ requestId })),
    ),
})

export const WaitForStartupFrames = Command.define('WaitForStartupFrames', {
  messages: [Message.CompletedWaitForStartupFrames],
  execute: Effect.sleep(Duration.millis(STARTUP_FRAMES_TIMEOUT_MS)).pipe(
    Effect.as(Message.CompletedWaitForStartupFrames()),
  ),
})

export const WaitToReconnect = Command.define('WaitToReconnect', {
  args: { delayMs: Schema.Number },
  messages: [Message.CompletedWaitToReconnect],
  execute: ({ delayMs }) =>
    Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.as(Message.CompletedWaitToReconnect()),
    ),
})

// MANAGED RESOURCE

const socketUrl = (): string => {
  const url = new URL('/api', window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

export const managedResources = ManagedResource.make<Model, Message>()(
  entry => ({
    z2mSocket: entry(Schema.Option(Schema.Null), {
      resource: Z2mSocket,
      modelToMaybeRequirements: model =>
        Match.value(model.connection).pipe(
          Match.tag('WaitingToReconnect', () => Option.none()),
          Match.orElse(() => Option.some(null)),
        ),
      acquire: () =>
        Effect.callback<WebSocket, Error>(resume => {
          const socket = new WebSocket(socketUrl())

          const handleOpen = () => {
            socket.removeEventListener('error', handleError)
            resume(Effect.succeed(socket))
          }

          const handleError = () => {
            socket.removeEventListener('open', handleOpen)
            resume(Effect.fail(new Error('Failed to connect')))
          }

          socket.addEventListener('open', handleOpen)
          socket.addEventListener('error', handleError)

          return Effect.sync(() => {
            socket.removeEventListener('open', handleOpen)
            socket.removeEventListener('error', handleError)
            socket.close()
          })
        }).pipe(
          Effect.timeout(Duration.millis(CONNECTION_TIMEOUT_MS)),
          Effect.catchTag('TimeoutError', () =>
            Effect.fail(new Error('Connection timed out')),
          ),
        ),
      release: socket =>
        Effect.sync(() => {
          socket.close()
        }),
      onAcquired: () => Message.AcquiredSocket(),
      onReleased: () => Message.ReleasedSocket(),
      onAcquireError: error =>
        Message.FailedAcquireSocket({
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
    }),
  }),
)

// SUBSCRIPTION

const streamSocketMessages = (socket: WebSocket) =>
  Stream.callback<
    typeof Message.ReceivedFrame.Type | typeof Message.ClosedSocket.Type
  >(queue =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const handleMessage = (event: MessageEvent<unknown>) => {
          if (typeof event.data === 'string') {
            Option.map(decodeFrame(event.data), frame =>
              Queue.offerUnsafe(queue, Message.ReceivedFrame({ frame })),
            )
          }
        }
        const handleClose = () => {
          Queue.offerUnsafe(queue, Message.ClosedSocket())
          Queue.endUnsafe(queue)
        }

        socket.addEventListener('message', handleMessage)
        socket.addEventListener('close', handleClose)

        return { handleMessage, handleClose }
      }),
      ({ handleMessage, handleClose }) =>
        Effect.sync(() => {
          socket.removeEventListener('message', handleMessage)
          socket.removeEventListener('close', handleClose)
        }),
    ).pipe(Effect.flatMap(() => Effect.never)),
  )

const socketSubscriptions = Subscription.make<
  Model,
  Message,
  Z2mSocketService
>()(entry => ({
  socketFrames: entry(
    { isConnected: Schema.Boolean },
    {
      modelToDependencies: model => ({
        isConnected: model.connection._tag === 'Connected',
      }),
      dependenciesToStream: ({ isConnected }) =>
        Stream.when(
          Stream.unwrap(
            Z2mSocket.get.pipe(
              Effect.map(streamSocketMessages),
              Effect.catchTag('ResourceNotAvailable', () =>
                Effect.succeed(Stream.empty),
              ),
            ),
          ),
          Effect.sync(() => isConnected),
        ),
    },
  ),
}))

const activeSliderSubscriptions = Subscription.lift(Slider.subscriptions)<
  Model,
  Message
>({
  read: model => Option.map(model.maybeActiveSlider, active => active.slider),
  toParentMessage: message => Message.GotActiveSliderMessage({ message }),
})

export const subscriptions = Subscription.aggregate(
  socketSubscriptions,
  activeSliderSubscriptions,
)
