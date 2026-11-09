import { Option, Record } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import * as Slider from '@/components/ui/slider'

import * as Automations from './automations'
import {
  IncomingFrame,
  type LightState,
  Pairing,
  type Preset,
  PresetLook,
  SavablePresetLook,
  Setting,
} from './domain'
import { HouseFocus } from './house'
import {
  Activity,
  Connection,
  DraftPhase,
  Message,
  type Model,
  PageScroll,
  PresetEditor,
  SendFrame,
  SendFrameTwice,
  SliderId,
  Startup,
  Target,
  WaitForConfirmation,
  WaitForStartupFrames,
  WaitForThrottle,
  WaitToReconnect,
  sliderDomId,
  statesWithDrafts,
  targetStatus,
  update,
} from './main'
import * as Manage from './manage'

const state = (power: 'ON' | 'OFF'): LightState => ({
  power,
  brightness: 200,
  maybeColorTemp: Option.some(370),
  maybeHueSaturation: Option.none(),
})

const presets: ReadonlyArray<Preset> = [
  { name: 'Red', brightness: 254, look: PresetLook.Color({ hex: '#FF0000' }) },
  { name: 'Rainbow', brightness: 254, look: PresetLook.Rainbow() },
]

const base: Model = {
  screen: 'House',
  focus: HouseFocus.Overview(),
  automations: Automations.init,
  manage: Manage.init,
  connection: Connection.Connected(),
  startup: Startup.Ready(),
  isBridgeOnline: true,
  newDevices: [],
  pairing: Pairing.Closed(),
  lights: [
    {
      name: 'Orb',
      address: 'a',
      maybeColorTempRange: Option.none(),
      supportsColor: true,
    },
    {
      name: 'Shroom',
      address: 'b',
      maybeColorTempRange: Option.none(),
      supportsColor: true,
    },
  ],
  groups: [{ name: 'All Lights', memberAddresses: ['a', 'b'] }],
  states: { Orb: state('OFF'), Shroom: state('ON') },
  groupLevels: {},
  presets,
  drafts: [],
  activities: [],
  nextRequestId: 1,
  maybeActiveSlider: Option.none(),
  pageScroll: PageScroll.Still(),
  presetEditor: PresetEditor.Closed(),
  maybeHouseFailure: Option.none(),
  maybeProblem: Option.none(),
}

const orb = Target.Light({ name: 'Orb' })
const allLights = Target.Group({ name: 'All Lights' })
const frameOf = (topic: string, payload: unknown) =>
  JSON.stringify({ topic, payload })

const throttling = (setting: Setting, isDirty = false) => ({
  target: orb,
  setting,
  phase: DraftPhase.Throttling({ isDirty }),
  awaitingReports: ['Orb'],
})

const settingOrbOn: Model = {
  ...base,
  activities: [
    {
      requestId: 1,
      target: orb,
      activity: Activity.SettingPower({ power: 'ON' }),
    },
  ],
}

const reported = (name: string, power: 'ON' | 'OFF') =>
  Message.ReceivedFrame({
    frame: IncomingFrame.ReportedLightState({ name, state: state(power) }),
  })

const reportedBrightness = (name: string, brightness: number) =>
  Message.ReceivedFrame({
    frame: IncomingFrame.ReportedLightState({
      name,
      state: { ...state('ON'), brightness },
    }),
  })

const settleTimedOut = (requestId: number) =>
  Command.resolve(
    WaitForConfirmation,
    Message.CompletedWaitForConfirmation({ requestId }),
  )

const editorModel = (editing: Partial<PresetEditorEditing> = {}): Model => ({
  ...base,
  presetEditor: PresetEditor.Open({
    editing: {
      maybeOriginalName: Option.none(),
      name: 'Movie',
      brightness: 90,
      look: SavablePresetLook.White({ colorTemp: 300 }),
      ...editing,
    },
    maybeFailure: Option.none(),
  }),
})
const savingModel = (): Model => ({
  ...base,
  presetEditor: PresetEditor.Saving({
    editing: {
      maybeOriginalName: Option.none(),
      name: 'Movie',
      brightness: 90,
      look: SavablePresetLook.White({ colorTemp: 300 }),
    },
    requestId: 1,
  }),
})
type PresetEditorEditing = Extract<
  Model['presetEditor'],
  { _tag: 'Open' }
>['editing']

describe('connection', () => {
  test('a closed socket waits, then reconnects', () => {
    story(
      update,
      given(base),
      message(Message.ClosedSocket()),
      model(next => {
        expect(next.connection._tag).toBe('WaitingToReconnect')
      }),
      Command.expectExact(WaitToReconnect({ delayMs: 500 })),
      Command.resolve(WaitToReconnect, Message.CompletedWaitToReconnect()),
      model(next => {
        expect(next.connection._tag).toBe('Connecting')
      }),
    )
  })

  test('backoff doubles for each failed attempt', () => {
    story(
      update,
      given({ ...base, connection: Connection.Connecting({ attempt: 2 }) }),
      message(Message.FailedAcquireSocket({ error: 'nope' })),
      Command.expectExact(WaitToReconnect({ delayMs: 4000 })),
      Command.resolve(WaitToReconnect, Message.CompletedWaitToReconnect()),
    )
  })

  test('backoff caps at 30 seconds', () => {
    story(
      update,
      given({ ...base, connection: Connection.Connecting({ attempt: 20 }) }),
      message(Message.FailedAcquireSocket({ error: 'nope' })),
      Command.expectExact(WaitToReconnect({ delayMs: 30_000 })),
      Command.resolve(WaitToReconnect, Message.CompletedWaitToReconnect()),
    )
  })

  test('a long absence replaces a socket that looks connected', () => {
    story(
      update,
      given({ ...base, connection: Connection.Connected() }),
      message(Message.ResumedApp({ hiddenForMs: 60_000 })),
      model(next => {
        expect(next.connection._tag).toBe('WaitingToReconnect')
      }),
      Command.expectExact(WaitToReconnect({ delayMs: 500 })),
      Command.resolve(WaitToReconnect, Message.CompletedWaitToReconnect()),
      model(next => {
        expect(next.connection._tag).toBe('Connecting')
      }),
    )
  })

  test('a brief absence keeps the socket', () => {
    story(
      update,
      given({ ...base, connection: Connection.Connected() }),
      message(Message.ResumedApp({ hiddenForMs: 1000 })),
      model(next => {
        expect(next.connection._tag).toBe('Connected')
      }),
    )
  })

  test('resuming skips the remaining backoff', () => {
    story(
      update,
      given({
        ...base,
        connection: Connection.WaitingToReconnect({ attempt: 6 }),
      }),
      message(Message.ResumedApp({ hiddenForMs: 1000 })),
      model(next => {
        expect(next.connection).toEqual(Connection.Connecting({ attempt: 0 }))
      }),
    )
  })

  test('resuming leaves a connection in progress alone', () => {
    story(
      update,
      given({ ...base, connection: Connection.Connecting({ attempt: 3 }) }),
      message(Message.ResumedApp({ hiddenForMs: 60_000 })),
      model(next => {
        expect(next.connection).toEqual(Connection.Connecting({ attempt: 3 }))
      }),
    )
  })

  test('a late close does not start a second wait', () => {
    story(
      update,
      given({
        ...base,
        connection: Connection.WaitingToReconnect({ attempt: 1 }),
      }),
      message(Message.ClosedSocket()),
      Command.expectNone(),
    )
  })

  test('losing the socket drops unsent slider drafts', () => {
    story(
      update,
      given({
        ...base,
        drafts: [throttling(Setting.Brightness({ value: 5 }), true)],
      }),
      message(Message.ClosedSocket()),
      model(next => {
        expect(next.drafts).toHaveLength(0)
      }),
      Command.resolve(WaitToReconnect, Message.CompletedWaitToReconnect()),
    )
  })
})

describe('frames', () => {
  test('reported state replaces what was known', () => {
    story(
      update,
      given(base),
      message(
        Message.ReceivedFrame({
          frame: IncomingFrame.ReportedLightState({
            name: 'Orb',
            state: state('ON'),
          }),
        }),
      ),
      model(next => {
        expect(next.states['Orb']?.power).toBe('ON')
      }),
    )
  })

  test('an unreadable frame is reported', () => {
    story(
      update,
      given(base),
      message(
        Message.ReceivedFrame({
          frame: IncomingFrame.Unreadable({ topic: 'bridge/devices' }),
        }),
      ),
      model(next => {
        expect(Option.isSome(next.maybeProblem)).toBe(true)
      }),
    )
  })
})

describe('power', () => {
  test('a light gets its exact power command, sent twice', () => {
    story(
      update,
      given(base),
      message(Message.ClickedPower({ target: orb })),
      Command.expectHas(
        SendFrameTwice({ frame: frameOf('Orb/set', { state: 'ON' }) }),
      ),
      Command.resolve(SendFrameTwice, Message.SucceededSendFrame()),
      settleTimedOut(1),
      settleTimedOut(2),
    )
  })

  test('a group with any member on turns off, sent twice', () => {
    story(
      update,
      given(base),
      message(Message.ClickedPower({ target: allLights })),
      Command.expectHas(
        SendFrameTwice({
          frame: frameOf('All Lights/set', { state: 'OFF' }),
        }),
      ),
      Command.resolve(SendFrameTwice, Message.SucceededSendFrame()),
      settleTimedOut(1),
      settleTimedOut(2),
    )
  })

  test('the switch waits for the bulb instead of assuming', () => {
    story(
      update,
      given(base),
      message(Message.ClickedPower({ target: orb })),
      model(next => {
        expect(next.states['Orb']?.power).toBe('OFF')
        expect(next.activities).toHaveLength(1)
      }),
      Command.resolve(SendFrameTwice, Message.SucceededSendFrame()),
      settleTimedOut(1),
      settleTimedOut(2),
    )
  })

  test('the matching report ends the wait', () => {
    story(
      update,
      given(settingOrbOn),
      message(reported('Orb', 'ON')),
      model(next => {
        expect(next.activities).toHaveLength(0)
      }),
    )
  })

  test('a second tap while waiting sends nothing', () => {
    story(
      update,
      given(settingOrbOn),
      message(Message.ClickedPower({ target: orb })),
      Command.expectNone(),
    )
  })

  test('an unrelated report does not end the wait', () => {
    story(
      update,
      given(settingOrbOn),
      message(reported('Shroom', 'ON')),
      model(next => {
        expect(next.activities).toHaveLength(1)
      }),
    )
  })

  test('a report of the old state does not end the wait', () => {
    story(
      update,
      given(settingOrbOn),
      message(reported('Orb', 'OFF')),
      model(next => {
        expect(next.activities).toHaveLength(1)
      }),
    )
  })

  test('a bulb that never answers shows no response, then clears', () => {
    story(
      update,
      given(base),
      message(Message.ClickedPower({ target: orb })),
      Command.resolve(SendFrameTwice, Message.SucceededSendFrame()),
      settleTimedOut(1),
      model(next => {
        expect(next.activities[0]?.activity._tag).toBe('NoResponse')
      }),
      settleTimedOut(2),
      model(next => {
        expect(next.activities).toHaveLength(0)
      }),
    )
  })

  test('a stale timer leaves a newer request alone', () => {
    story(
      update,
      given({
        ...base,
        activities: [
          {
            requestId: 7,
            target: orb,
            activity: Activity.SettingPower({ power: 'ON' }),
          },
        ],
      }),
      message(Message.CompletedWaitForConfirmation({ requestId: 3 })),
      model(next => {
        expect(next.activities[0]?.activity._tag).toBe('SettingPower')
      }),
    )
  })

  test('losing the socket ends every wait', () => {
    story(
      update,
      given(settingOrbOn),
      message(Message.ClosedSocket()),
      model(next => {
        expect(next.activities).toHaveLength(0)
      }),
      Command.resolve(WaitToReconnect, Message.CompletedWaitToReconnect()),
    )
  })

  test('nothing is sent while disconnected', () => {
    story(
      update,
      given({
        ...base,
        connection: Connection.WaitingToReconnect({ attempt: 0 }),
      }),
      message(Message.ClickedPower({ target: orb })),
      Command.expectNone(),
      message(Message.ClickedPreset({ target: allLights, preset: 'Red' })),
      Command.expectNone(),
    )
  })
})

describe('group brightness level', () => {
  const lit = (brightness: number): LightState => ({
    ...state('ON'),
    brightness,
  })
  const reported = (name: string, lightState: LightState) =>
    message(
      Message.ReceivedFrame({
        frame: IncomingFrame.ReportedLightState({
          name,
          state: lightState,
        }),
      }),
    )
  const expectLevel = (target: Target, level: number) =>
    model<Model>(next => {
      expect(targetStatus(next, target).brightness).toBe(level)
    })
  const light = (name: string, address: string) => ({
    name,
    address,
    maybeColorTempRange: Option.none(),
    supportsColor: true,
  })
  const bedroom = Target.Group({ name: 'Bedroom' })
  const settled: Model = {
    ...base,
    lights: [light('Orb', 'a'), light('Shroom', 'b'), light('Lamp', 'c')],
    groups: [
      { name: 'All Lights', memberAddresses: ['a', 'b', 'c'] },
      { name: 'Bedroom', memberAddresses: ['b', 'c'] },
    ],
    states: { Orb: lit(100), Shroom: lit(100), Lamp: lit(100) },
    groupLevels: { 'All Lights': 100, Bedroom: 100 },
  }

  test('editing one bulb inside the range leaves the group alone', () => {
    story(
      update,
      given(settled),
      reported('Orb', lit(200)),
      expectLevel(allLights, 100),
      reported('Orb', lit(150)),
      expectLevel(allLights, 100),
      expectLevel(orb, 150),
    )
  })

  test('the group follows once every bulb is past it', () => {
    story(
      update,
      given(settled),
      reported('Orb', lit(180)),
      reported('Shroom', lit(150)),
      expectLevel(allLights, 100),
      reported('Lamp', lit(160)),
      expectLevel(allLights, 150),
    )
  })

  test('the group lands on the value every bulb agrees on', () => {
    story(
      update,
      given(settled),
      reported('Orb', lit(40)),
      reported('Shroom', lit(40)),
      expectLevel(allLights, 100),
      reported('Lamp', lit(40)),
      expectLevel(allLights, 40),
    )
  })

  test('turning off the brightest bulb leaves the group alone', () => {
    story(
      update,
      given({
        ...settled,
        states: { Orb: lit(200), Shroom: lit(100), Lamp: lit(100) },
        groupLevels: { 'All Lights': 200, Bedroom: 100 },
      }),
      reported('Orb', { ...lit(200), power: 'OFF' }),
      expectLevel(allLights, 200),
    )
  })

  test('a group keeps its level when a bulb misses the command', () => {
    story(
      update,
      given(settled),
      message(
        Message.UpdatedSetting({
          target: allLights,
          setting: Setting.Brightness({ value: 40 }),
        }),
      ),
      Command.resolveAll([SendFrame, Message.SucceededSendFrame()]),
      Command.resolve(
        WaitForThrottle,
        Message.CompletedThrottleWait({
          target: allLights,
          kind: 'Brightness',
        }),
      ),
      settleTimedOut(1),
      reported('Shroom', lit(40)),
      reported('Lamp', lit(40)),
      expectLevel(allLights, 40),
      expectLevel(bedroom, 40),
      expectLevel(orb, 100),
    )
  })

  test('frames during a drag cannot pull the level back', () => {
    story(
      update,
      given({
        ...settled,
        drafts: [
          {
            target: allLights,
            setting: Setting.Brightness({ value: 40 }),
            phase: DraftPhase.Throttling({ isDirty: true }),
            awaitingReports: ['Orb', 'Shroom', 'Lamp'],
          },
        ],
        groupLevels: { 'All Lights': 40, Bedroom: 100 },
      }),
      reported('Orb', lit(100)),
      expectLevel(allLights, 40),
    )
  })

  test('editing one group only moves another once its bulbs are past it', () => {
    story(
      update,
      given(settled),
      reported('Shroom', lit(40)),
      expectLevel(bedroom, 100),
      expectLevel(allLights, 100),
      reported('Lamp', lit(40)),
      expectLevel(bedroom, 40),
      expectLevel(allLights, 100),
    )
  })

  test('a group starts at its brightest lit bulb once all have reported', () => {
    story(
      update,
      given({
        ...settled,
        states: {},
        groupLevels: {},
      }),
      reported('Orb', lit(50)),
      model(next => {
        expect(Option.isNone(Record.get(next.groupLevels, 'All Lights'))).toBe(
          true,
        )
      }),
      reported('Shroom', lit(200)),
      reported('Lamp', { ...lit(254), power: 'OFF' }),
      expectLevel(allLights, 200),
      reported('Orb', lit(120)),
      expectLevel(allLights, 200),
    )
  })
})

describe('slider drag', () => {
  const sliderId = SliderId.TargetBrightness({ target: orb })
  const fromSlider = (sliderMessage: Slider.Message) =>
    Message.GotSliderMessage({ sliderId, message: sliderMessage })
  const fromActiveSlider = (sliderMessage: Slider.Message) =>
    Message.GotActiveSliderMessage({ message: sliderMessage })

  test('pressing the track starts a drag and sends through the throttle', () => {
    story(
      update,
      given(base),
      message(
        fromSlider(
          Slider.Message.PressedPointer({ value: 50, originValue: 200 }),
        ),
      ),
      Command.expectHas(
        SendFrame({ frame: frameOf('Orb/set', { brightness: 50 }) }),
      ),
      Command.expectHas(WaitForThrottle({ target: orb, kind: 'Brightness' })),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      Command.resolve(
        WaitForThrottle,
        Message.CompletedThrottleWait({ target: orb, kind: 'Brightness' }),
      ),
      settleTimedOut(1),
      model(next => {
        expect(Option.isSome(next.maybeActiveSlider)).toBe(true)
      }),
    )
  })

  test('moves inside the window send only the last value', () => {
    const draggingSlider = Slider.update(
      Slider.init({ id: sliderDomId(sliderId), min: 1, max: 254, step: 1 }),
      Slider.Message.PressedThumb({ originValue: 50 }),
    ).model
    story(
      update,
      given({
        ...base,
        drafts: [throttling(Setting.Brightness({ value: 50 }))],
        maybeActiveSlider: Option.some({ sliderId, slider: draggingSlider }),
      }),
      message(fromActiveSlider(Slider.Message.MovedDragPointer({ value: 60 }))),
      Command.expectNone(),
      message(fromActiveSlider(Slider.Message.MovedDragPointer({ value: 70 }))),
      Command.expectNone(),
      message(
        Message.CompletedThrottleWait({ target: orb, kind: 'Brightness' }),
      ),
      Command.expectHas(
        SendFrame({ frame: frameOf('Orb/set', { brightness: 70 }) }),
      ),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      Command.resolve(
        WaitForThrottle,
        Message.CompletedThrottleWait({ target: orb, kind: 'Brightness' }),
      ),
      settleTimedOut(1),
      model(next => {
        expect(next.drafts).toHaveLength(0)
      }),
    )
  })

  describe('by touch', () => {
    const pressedByTouch = fromSlider(
      Slider.Message.PressedTouch({
        pointerId: 7,
        along: 100,
        across: 300,
        originValue: 200,
      }),
    )
    const fingerAt = (along: number, across: number) =>
      fromActiveSlider(
        Slider.Message.MovedTouch({
          pointerId: 7,
          along,
          across,
          valuePerPixel: 1,
        }),
      )

    test('a press sends nothing', () => {
      story(
        update,
        given(base),
        message(pressedByTouch),
        Command.expectNone(),
        model(next => {
          expect(Option.isSome(next.maybeActiveSlider)).toBe(true)
        }),
      )
    })

    test('a vertical swipe sends nothing and ends the gesture', () => {
      story(
        update,
        given(base),
        message(pressedByTouch),
        message(fingerAt(102, 340)),
        Command.expectNone(),
        message(fingerAt(160, 340)),
        Command.expectNone(),
      )
    })

    test('a sideways drag sends the distance dragged from the current value', () => {
      story(
        update,
        given(base),
        message(pressedByTouch),
        message(fingerAt(112, 301)),
        Command.expectNone(),
        message(fingerAt(92, 301)),
        Command.expectHas(
          SendFrame({ frame: frameOf('Orb/set', { brightness: 180 }) }),
        ),
        Command.resolve(SendFrame, Message.SucceededSendFrame()),
        Command.resolve(
          WaitForThrottle,
          Message.CompletedThrottleWait({ target: orb, kind: 'Brightness' }),
        ),
        settleTimedOut(1),
      )
    })

    test('a browser takeover ends the gesture and sends nothing', () => {
      story(
        update,
        given(base),
        message(pressedByTouch),
        message(
          fromActiveSlider(Slider.Message.ReleasedTouch({ pointerId: 7 })),
        ),
        Command.expectNone(),
        model(next => {
          expect(Option.isNone(next.maybeActiveSlider)).toBe(true)
        }),
      )
    })
  })

  test('releasing ends the drag and ignores later pointer moves', () => {
    story(
      update,
      given(base),
      message(
        fromSlider(
          Slider.Message.PressedPointer({ value: 50, originValue: 200 }),
        ),
      ),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      Command.resolve(
        WaitForThrottle,
        Message.CompletedThrottleWait({ target: orb, kind: 'Brightness' }),
      ),
      settleTimedOut(1),
      message(fromActiveSlider(Slider.Message.ReleasedDragPointer())),
      model(next => {
        expect(Option.isNone(next.maybeActiveSlider)).toBe(true)
      }),
      message(fromActiveSlider(Slider.Message.MovedDragPointer({ value: 90 }))),
      Command.expectNone(),
    )
  })
})

describe('page scroll', () => {
  test('tracks whether the page is moving', () => {
    story(
      update,
      given(base),
      message(Message.StartedPageScroll()),
      model(next => {
        expect(next.pageScroll).toEqual(PageScroll.Moving())
      }),
      message(Message.SettledPageScroll()),
      model(next => {
        expect(next.pageScroll).toEqual(PageScroll.Still())
      }),
    )
  })
})

describe('slider throttle', () => {
  const brightness = (value: number) => Setting.Brightness({ value })

  const holding: Model = {
    ...base,
    drafts: [throttling(brightness(10))],
  }

  test('sends the first value and opens a throttle window', () => {
    story(
      update,
      given(base),
      message(Message.UpdatedSetting({ target: orb, setting: brightness(10) })),
      Command.expectHas(
        SendFrame({ frame: frameOf('Orb/set', { brightness: 10 }) }),
      ),
      Command.expectHas(WaitForThrottle({ target: orb, kind: 'Brightness' })),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      Command.resolve(
        WaitForThrottle,
        Message.CompletedThrottleWait({ target: orb, kind: 'Brightness' }),
      ),
      settleTimedOut(1),
      model(next => {
        expect(next.drafts).toHaveLength(0)
      }),
    )
  })

  test('holds values during the window, then sends only the last', () => {
    story(
      update,
      given(holding),
      message(Message.UpdatedSetting({ target: orb, setting: brightness(20) })),
      Command.expectNone(),
      message(Message.UpdatedSetting({ target: orb, setting: brightness(30) })),
      Command.expectNone(),
      message(
        Message.CompletedThrottleWait({ target: orb, kind: 'Brightness' }),
      ),
      Command.expectHas(
        SendFrame({ frame: frameOf('Orb/set', { brightness: 30 }) }),
      ),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      Command.resolve(
        WaitForThrottle,
        Message.CompletedThrottleWait({ target: orb, kind: 'Brightness' }),
      ),
      settleTimedOut(1),
      model(next => {
        expect(next.drafts).toHaveLength(0)
      }),
    )
  })

  test('different settings throttle independently', () => {
    story(
      update,
      given(base),
      message(Message.UpdatedSetting({ target: orb, setting: brightness(10) })),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      Command.resolve(
        WaitForThrottle,
        Message.CompletedThrottleWait({ target: orb, kind: 'Brightness' }),
      ),
      settleTimedOut(1),
      message(
        Message.UpdatedSetting({
          target: orb,
          setting: Setting.ColorTemp({ value: 300 }),
        }),
      ),
      Command.expectHas(
        SendFrame({ frame: frameOf('Orb/set', { color_temp: 300 }) }),
      ),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      Command.resolve(
        WaitForThrottle,
        Message.CompletedThrottleWait({ target: orb, kind: 'ColorTemp' }),
      ),
      settleTimedOut(2),
    )
  })

  test('the slider holds its value after the last send', () => {
    story(
      update,
      given(holding),
      message(
        Message.CompletedThrottleWait({ target: orb, kind: 'Brightness' }),
      ),
      model(next => {
        expect(next.drafts[0]?.phase._tag).toBe('Settling')
      }),
      Command.expectExact(WaitForConfirmation({ requestId: 1, delayMs: 1500 })),
      settleTimedOut(1),
      model(next => {
        expect(next.drafts).toHaveLength(0)
      }),
    )
  })

  test('the next report releases a settling slider', () => {
    story(
      update,
      given({
        ...base,
        drafts: [
          {
            target: orb,
            setting: brightness(10),
            phase: DraftPhase.Settling({ requestId: 4 }),
            awaitingReports: ['Orb'],
          },
        ],
      }),
      message(reportedBrightness('Orb', 10)),
      model(next => {
        expect(next.drafts).toHaveLength(0)
      }),
    )
  })

  test('a late report of an earlier position does not release the slider', () => {
    story(
      update,
      given({
        ...base,
        drafts: [
          {
            target: orb,
            setting: brightness(10),
            phase: DraftPhase.Settling({ requestId: 4 }),
            awaitingReports: ['Orb'],
          },
        ],
      }),
      message(reportedBrightness('Orb', 60)),
      model(next => {
        expect(next.drafts).toHaveLength(1)
      }),
    )
  })

  test('a report that landed during the window releases the slider at once', () => {
    story(
      update,
      given(holding),
      message(reportedBrightness('Orb', 10)),
      message(
        Message.CompletedThrottleWait({ target: orb, kind: 'Brightness' }),
      ),
      Command.expectNone(),
      model(next => {
        expect(next.drafts).toHaveLength(0)
      }),
    )
  })

  test('a group draft waits for every member', () => {
    const groupDraft = {
      target: allLights,
      setting: brightness(10),
      phase: DraftPhase.Settling({ requestId: 4 }),
      awaitingReports: ['Orb', 'Shroom'],
    }
    story(
      update,
      given({ ...base, drafts: [groupDraft] }),
      message(reportedBrightness('Orb', 10)),
      model(next => {
        expect(next.drafts).toHaveLength(1)
      }),
      message(reportedBrightness('Shroom', 10)),
      model(next => {
        expect(next.drafts).toHaveLength(0)
      }),
    )
  })

  test('dragging again while settling sends straight away', () => {
    story(
      update,
      given({
        ...base,
        drafts: [
          {
            target: orb,
            setting: brightness(10),
            phase: DraftPhase.Settling({ requestId: 4 }),
            awaitingReports: ['Orb'],
          },
        ],
      }),
      message(Message.UpdatedSetting({ target: orb, setting: brightness(40) })),
      Command.expectHas(
        SendFrame({ frame: frameOf('Orb/set', { brightness: 40 }) }),
      ),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      Command.resolve(
        WaitForThrottle,
        Message.CompletedThrottleWait({ target: orb, kind: 'Brightness' }),
      ),
      settleTimedOut(1),
    )
  })
})

describe('startup', () => {
  const loading: Model = {
    ...base,
    startup: Startup.Loading({ missing: ['Lights', 'Groups', 'Presets'] }),
    lights: [],
    groups: [],
    presets: [],
    states: {},
  }

  test('becomes ready once every first frame has landed', () => {
    story(
      update,
      given(loading),
      message(
        Message.ReceivedFrame({
          frame: IncomingFrame.ReportedLights({
            lights: base.lights,
            newDevices: [],
          }),
        }),
      ),
      message(
        Message.ReceivedFrame({
          frame: IncomingFrame.ReportedGroups({ groups: base.groups }),
        }),
      ),
      message(
        Message.ReceivedFrame({
          frame: IncomingFrame.ReportedPresets({ presets }),
        }),
      ),
      message(reported('Orb', 'ON')),
      model(next => {
        expect(next.startup._tag).toBe('Loading')
      }),
      message(reported('Shroom', 'ON')),
      model(next => {
        expect(next.startup._tag).toBe('Ready')
      }),
    )
  })

  test('stops waiting if a frame never comes', () => {
    story(
      update,
      given({
        ...loading,
        connection: Connection.Connecting({ attempt: 0 }),
      }),
      message(Message.AcquiredSocket()),
      Command.expectExact(WaitForStartupFrames()),
      Command.resolve(
        WaitForStartupFrames,
        Message.CompletedWaitForStartupFrames(),
      ),
      model(next => {
        expect(next.startup._tag).toBe('Ready')
      }),
    )
  })

  test('reconnecting keeps the loaded page', () => {
    story(
      update,
      given({ ...base, connection: Connection.Connecting({ attempt: 1 }) }),
      message(Message.AcquiredSocket()),
      Command.expectNone(),
      model(next => {
        expect(next.startup._tag).toBe('Ready')
      }),
    )
  })
})

describe('presets', () => {
  test('applying names the group and waits for a report', () => {
    story(
      update,
      given(base),
      message(Message.ClickedPreset({ target: allLights, preset: 'Red' })),
      Command.expectHas(
        SendFrame({
          frame: frameOf('preset/set', {
            name: 'Red',
            group: 'All Lights',
          }),
        }),
      ),
      model(next => {
        expect(next.activities[0]?.activity._tag).toBe('ApplyingPreset')
      }),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      settleTimedOut(1),
    )
  })

  test('applying to a bulb names the light and waits for it', () => {
    story(
      update,
      given(base),
      message(Message.ClickedPreset({ target: orb, preset: 'Red' })),
      Command.expectHas(
        SendFrame({
          frame: frameOf('preset/set', { name: 'Red', light: 'Orb' }),
        }),
      ),
      model(next => {
        expect(next.activities[0]?.activity._tag).toBe('ApplyingPreset')
      }),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      settleTimedOut(1),
    )
  })

  test('a report from any member ends the preset wait', () => {
    story(
      update,
      given({
        ...base,
        activities: [
          {
            requestId: 1,
            target: allLights,
            activity: Activity.ApplyingPreset({ preset: 'Red' }),
          },
        ],
      }),
      message(reported('Orb', 'ON')),
      model(next => {
        expect(next.activities).toHaveLength(0)
      }),
    )
  })

  test('an unanswered preset quietly stops waiting', () => {
    story(
      update,
      given(base),
      message(Message.ClickedPreset({ target: allLights, preset: 'Red' })),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      settleTimedOut(1),
      model(next => {
        expect(next.activities).toHaveLength(0)
      }),
    )
  })

  test('saving a new preset sends it and stays open', () => {
    story(
      update,
      given(editorModel()),
      message(Message.SubmittedEditor()),
      model(next => {
        expect(next.presetEditor._tag).toBe('Saving')
      }),
      Command.expectHas(
        SendFrame({
          frame: frameOf('preset/save', {
            name: 'Movie',
            brightness: 90,
            color_temp: 300,
          }),
        }),
      ),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      settleTimedOut(1),
    )
  })

  test('the list closes the editor once the preset is in it', () => {
    story(
      update,
      given(savingModel()),
      message(
        Message.ReceivedFrame({
          frame: IncomingFrame.ReportedPresets({ presets }),
        }),
      ),
      model(next => {
        expect(next.presetEditor._tag).toBe('Saving')
      }),
      message(
        Message.ReceivedFrame({
          frame: IncomingFrame.ReportedPresets({
            presets: [
              ...presets,
              {
                name: 'Movie',
                brightness: 90,
                look: PresetLook.White({ colorTemp: 300 }),
              },
            ],
          }),
        }),
      ),
      model(next => {
        expect(next.presetEditor._tag).toBe('Closed')
      }),
    )
  })

  test('a save that is never confirmed reopens with the failure', () => {
    story(
      update,
      given(editorModel()),
      message(Message.SubmittedEditor()),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      settleTimedOut(1),
      model(next => {
        expect(next.presetEditor._tag).toBe('Open')
        if (next.presetEditor._tag === 'Open') {
          expect(Option.isSome(next.presetEditor.maybeFailure)).toBe(true)
          expect(next.presetEditor.editing.name).toBe('Movie')
        }
      }),
    )
  })

  test('losing the socket mid-save keeps the edits', () => {
    story(
      update,
      given(savingModel()),
      message(Message.ClosedSocket()),
      model(next => {
        expect(next.presetEditor._tag).toBe('Open')
      }),
      Command.resolve(WaitToReconnect, Message.CompletedWaitToReconnect()),
    )
  })

  test('saving an edit names the original', () => {
    story(
      update,
      given(
        editorModel({
          maybeOriginalName: Option.some('Red'),
          name: 'Crimson',
          look: SavablePresetLook.Color({ hex: '#aa0000' }),
        }),
      ),
      message(Message.SubmittedEditor()),
      Command.expectHas(
        SendFrame({
          frame: frameOf('preset/save', {
            name: 'Crimson',
            brightness: 90,
            previous_name: 'Red',
            color: { hex: '#aa0000' },
          }),
        }),
      ),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      settleTimedOut(1),
    )
  })

  test('edits are ignored while a save is in flight', () => {
    story(
      update,
      given(savingModel()),
      message(Message.UpdatedEditorName({ value: 'Changed' })),
      message(Message.ClickedCancelEditor()),
      model(next => {
        expect(next.presetEditor._tag).toBe('Saving')
      }),
    )
  })

  test.each([
    ['a blank name', '   '],
    ['a taken name', 'Red'],
    ['a long name', 'x'.repeat(41)],
  ])('%s does not save', (_label, name) => {
    story(
      update,
      given(editorModel({ name })),
      message(Message.SubmittedEditor()),
      model(next => {
        expect(next.presetEditor._tag).toBe('Open')
      }),
      Command.expectNone(),
    )
  })

  test('deleting sends the original name and stays open', () => {
    story(
      update,
      given(editorModel({ maybeOriginalName: Option.some('Red') })),
      message(Message.ClickedDeletePreset()),
      model(next => {
        expect(next.presetEditor._tag).toBe('Deleting')
      }),
      Command.expectHas(
        SendFrame({ frame: frameOf('preset/delete', { name: 'Red' }) }),
      ),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      settleTimedOut(1),
    )
  })

  test('the list closes the editor once the preset is gone', () => {
    story(
      update,
      given({
        ...base,
        presetEditor: PresetEditor.Deleting({
          editing: {
            maybeOriginalName: Option.some('Red'),
            name: 'Red',
            brightness: 90,
            look: SavablePresetLook.Color({ hex: '#FF0000' }),
          },
          requestId: 1,
        }),
      }),
      message(
        Message.ReceivedFrame({
          frame: IncomingFrame.ReportedPresets({ presets }),
        }),
      ),
      model(next => {
        expect(next.presetEditor._tag).toBe('Deleting')
      }),
      message(
        Message.ReceivedFrame({
          frame: IncomingFrame.ReportedPresets({
            presets: [
              {
                name: 'Rainbow',
                brightness: 254,
                look: PresetLook.Rainbow(),
              },
            ],
          }),
        }),
      ),
      model(next => {
        expect(next.presetEditor._tag).toBe('Closed')
      }),
    )
  })

  test('Rainbow cannot be opened for editing', () => {
    story(
      update,
      given(base),
      message(Message.ClickedEditPreset({ preset: 'Rainbow' })),
      model(next => {
        expect(next.presetEditor._tag).toBe('Closed')
      }),
    )
  })
})

describe('moving around the house', () => {
  const inRoom = (roomId: 'Bedroom' | 'Kitchen'): Model => ({
    ...base,
    focus: HouseFocus.Room({ roomId }),
  })

  test('Escape from a bulb goes back to its room, then the house', () => {
    story(
      update,
      given({ ...base, focus: HouseFocus.Bulb({ name: 'Orb' }) }),
      message(Message.PressedEscape()),
      model(({ focus }) => {
        expect(focus).toEqual(HouseFocus.Room({ roomId: 'Stairs' }))
      }),
      message(Message.PressedEscape()),
      model(({ focus }) => {
        expect(focus).toEqual(HouseFocus.Overview())
      }),
    )
  })

  test('Escape closes a page first and leaves the room in focus', () => {
    story(
      update,
      given({ ...inRoom('Bedroom'), screen: 'Automations' }),
      message(Message.PressedEscape()),
      model(({ focus, screen }) => {
        expect(screen).toBe('House')
        expect(focus).toEqual(HouseFocus.Room({ roomId: 'Bedroom' }))
      }),
    )
  })

  test('the scenes button opens and closes the scenes sheet', () => {
    story(
      update,
      given(base),
      message(Message.ClickedScenes()),
      model(({ focus }) => {
        expect(focus).toEqual(HouseFocus.Scenes())
      }),
      message(Message.ClickedScenes()),
      model(({ focus }) => {
        expect(focus).toEqual(HouseFocus.Overview())
      }),
    )
  })

  test('a room with no lights cannot be focused', () => {
    story(
      update,
      given(base),
      message(Message.PickedHouseRoom({ roomId: 'Kitchen' })),
      model(({ focus }) => {
        expect(focus).toEqual(HouseFocus.Overview())
      }),
    )
  })
})

describe('previewing a drag in the house', () => {
  const target = Target.Light({ name: 'Orb' })
  const dragged = (setting: Setting): Model => ({
    ...base,
    drafts: [
      {
        target,
        setting,
        phase: DraftPhase.Throttling({ isDirty: false }),
        awaitingReports: ['Orb'],
      },
    ],
  })

  test('a brightness drag shows before the bulb reports it', () => {
    expect(
      statesWithDrafts(dragged(Setting.Brightness({ value: 30 })))['Orb']
        ?.brightness,
    ).toBe(30)
  })

  test('a color drag shows full-saturation color', () => {
    expect(
      statesWithDrafts(dragged(Setting.Color({ hue: 200 })))['Orb']
        ?.maybeHueSaturation,
    ).toEqual(Option.some({ hue: 200, saturation: 100 }))
  })

  test('a temperature drag replaces any reported color', () => {
    const preview = statesWithDrafts(
      dragged(Setting.ColorTemp({ value: 300 })),
    )['Orb']
    expect(preview?.maybeColorTemp).toEqual(Option.some(300))
    expect(preview?.maybeHueSaturation).toEqual(Option.none())
  })

  test('with no drag the reported state stands', () => {
    expect(statesWithDrafts(base)).toEqual(base.states)
  })
})
