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
  type Update,
} from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import {
  type ColorTempRange,
  DEFAULT_COLOR_TEMP,
  Group,
  IncomingFrame,
  Light,
  LightState,
  MAX_BRIGHTNESS,
  type Power,
  Preset,
  PresetLook,
  SavablePresetLook,
  Setting,
  applyPresetFrame,
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

const Draft = Schema.Struct({
  target: Target,
  setting: Setting,
  isDirty: Schema.Boolean,
})
type Draft = typeof Draft.Type

export const EditingPreset = Schema.Struct({
  maybeOriginalName: Schema.Option(Schema.String),
  name: Schema.String,
  brightness: Schema.Number,
  look: SavablePresetLook,
})
export type EditingPreset = typeof EditingPreset.Type

export const PresetEditor = defineTaggedUnion({
  Closed: {},
  Open: { editing: EditingPreset },
})
export type PresetEditor = typeof PresetEditor.Type

export const Model = Schema.Struct({
  connection: Connection,
  isBridgeOnline: Schema.Boolean,
  lights: Schema.Array(Light),
  groups: Schema.Array(Group),
  states: Schema.Record(Schema.String, LightState),
  presets: Schema.Array(Preset),
  drafts: Schema.Array(Draft),
  maybeExpanded: Schema.Option(Target),
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
  ClickedPreset: { group: Schema.String, preset: Schema.String },
  ClickedNewPreset: {},
  ClickedEditPreset: { preset: Schema.String },
  UpdatedEditorName: { value: Schema.String },
  UpdatedEditorBrightness: { value: Schema.Number },
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
  return statusOf(lights, statesOf(model, lights))
}

const settingKindOf = (setting: Setting): SettingKind => setting._tag

const isSameTarget = (first: Target, second: Target): boolean =>
  first._tag === second._tag && first.name === second.name

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
    }),
    commands: [WaitToReconnect({ delayMs: reconnectDelayMs(attempt) })],
  }
}

const applyFrame = (model: Model, frame: IncomingFrame): UpdateReturn =>
  IncomingFrame.match<UpdateReturn>(frame, {
    ReportedLights: ({ lights }) => ({
      model: modifyFields(model, { lights: () => lights }),
    }),
    ReportedGroups: ({ groups }) => ({
      model: modifyFields(model, { groups: () => groups }),
    }),
    ReportedLightState: ({ name, state }) => ({
      model: modifyFields(model, {
        states: states => Record.set(states, name, state),
      }),
    }),
    ReportedBridge: ({ isOnline }) => ({
      model: modifyFields(model, { isBridgeOnline: () => isOnline }),
    }),
    ReportedPresets: ({ presets }) => ({
      model: modifyFields(model, { presets: () => presets }),
    }),
    Unreadable: ({ topic }) => ({
      model: modifyFields(model, {
        maybeProblem: () =>
          Option.some(
            `Zigbee2MQTT sent a ${topic} update this app can't read.`,
          ),
      }),
    }),
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
        Open: ({ editing }) => PresetEditor.Open({ editing: modify(editing) }),
      }),
  }),
})

const closedEditor = (model: Model) =>
  modifyFields(model, { presetEditor: () => PresetEditor.Closed() })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    AcquiredSocket: () => ({
      model: modifyFields(model, {
        connection: () => Connection.Connected(),
        maybeProblem: () => Option.none(),
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

    ReceivedFrame: ({ frame }) => applyFrame(model, frame),

    ClickedPower: ({ target }) => {
      const power: Power = targetStatus(model, target).isOn ? 'OFF' : 'ON'
      const frame = powerFrame(target.name, power)
      return {
        model,
        commands: [
          Target.match(target, {
            Light: () => SendFrame({ frame }),
            Group: () => SendFrameTwice({ frame }),
          }),
        ],
      }
    },

    ClickedExpand: ({ target }) => ({
      model: modifyFields(model, {
        maybeExpanded: () =>
          isExpanded(model, target) ? Option.none() : Option.some(target),
      }),
    }),

    UpdatedSetting: ({ target, setting }) => {
      const isThisDraft = isDraftFor(target, settingKindOf(setting))
      return Option.match(Array.findFirst(model.drafts, isThisDraft), {
        onNone: () => ({
          model: modifyFields(model, {
            drafts: drafts => [...drafts, { target, setting, isDirty: false }],
          }),
          commands: settingCommands(target, setting),
        }),
        onSome: () => ({
          model: modifyFields(model, {
            drafts: drafts =>
              Array.map(drafts, draft =>
                isThisDraft(draft) ? { target, setting, isDirty: true } : draft,
              ),
          }),
        }),
      })
    },

    CompletedThrottleWait: ({ target, kind }) => {
      const isThisDraft = isDraftFor(target, kind)
      return Option.match(Array.findFirst(model.drafts, isThisDraft), {
        onNone: () => ({ model }),
        onSome: draft =>
          draft.isDirty
            ? {
                model: modifyFields(model, {
                  drafts: drafts =>
                    Array.map(drafts, candidate =>
                      isThisDraft(candidate)
                        ? { ...candidate, isDirty: false }
                        : candidate,
                    ),
                }),
                commands: settingCommands(target, draft.setting),
              }
            : {
                model: modifyFields(model, {
                  drafts: drafts =>
                    Array.filter(drafts, candidate => !isThisDraft(candidate)),
                }),
              },
      })
    },

    ClickedPreset: ({ group, preset }) => ({
      model,
      commands: [SendFrame({ frame: applyPresetFrame(group, preset) })],
    }),

    ClickedNewPreset: () => ({
      model: modifyFields(model, {
        presetEditor: () =>
          PresetEditor.Open({
            editing: {
              maybeOriginalName: Option.none(),
              name: '',
              brightness: MAX_BRIGHTNESS,
              look: SavablePresetLook.White({ colorTemp: DEFAULT_COLOR_TEMP }),
            },
          }),
      }),
    }),

    ClickedEditPreset: ({ preset }) =>
      pipe(
        Array.findFirst(model.presets, candidate => candidate.name === preset),
        Option.flatMap(editorFromPreset),
        Option.match({
          onNone: () => ({ model }),
          onSome: editing => ({
            model: modifyFields(model, {
              presetEditor: () => PresetEditor.Open({ editing }),
            }),
          }),
        }),
      ),

    UpdatedEditorName: ({ value }) =>
      modifyEditing(model, editing =>
        modifyFields(editing, { name: () => value }),
      ),

    UpdatedEditorBrightness: ({ value }) =>
      modifyEditing(model, editing =>
        modifyFields(editing, { brightness: () => value }),
      ),

    UpdatedEditorLook: ({ look }) =>
      modifyEditing(model, editing =>
        modifyFields(editing, { look: () => look }),
      ),

    ClickedCancelEditor: () => ({ model: closedEditor(model) }),

    SubmittedEditor: () =>
      PresetEditor.match<UpdateReturn>(model.presetEditor, {
        Closed: () => ({ model }),
        Open: ({ editing }) =>
          Option.isSome(presetEditorProblem(model, editing))
            ? { model }
            : {
                model: closedEditor(model),
                commands: [
                  SendFrame({
                    frame: savePresetFrame(
                      editing.maybeOriginalName,
                      String.trim(editing.name),
                      editing.brightness,
                      editing.look,
                    ),
                  }),
                ],
              },
      }),

    ClickedDeletePreset: () =>
      PresetEditor.match<UpdateReturn>(model.presetEditor, {
        Closed: () => ({ model }),
        Open: ({ editing }) =>
          Option.match(editing.maybeOriginalName, {
            onNone: () => ({ model: closedEditor(model) }),
            onSome: name => ({
              model: closedEditor(model),
              commands: [SendFrame({ frame: deletePresetFrame(name) })],
            }),
          }),
      }),

    SucceededSendFrame: () => ({ model }),

    FailedSendFrame: ({ error }) => ({
      model: modifyFields(model, {
        maybeProblem: () => Option.some(`Couldn't send that: ${error}`),
      }),
    }),
  })

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    connection: Connection.Connecting({ attempt: 0 }),
    isBridgeOnline: true,
    lights: [],
    groups: [],
    states: {},
    presets: [],
    drafts: [],
    maybeExpanded: Option.none(),
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

export const subscriptions = Subscription.make<
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
