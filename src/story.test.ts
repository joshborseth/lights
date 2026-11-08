import { Option, Record } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import * as Slider from '@/components/ui/slider'

import {
  IncomingFrame,
  type LightState,
  type Preset,
  PresetLook,
  SavablePresetLook,
  Setting,
} from './domain'
import {
  Connection,
  Message,
  type Model,
  PresetEditor,
  SendFrame,
  SendFrameTwice,
  SliderId,
  Target,
  WaitForThrottle,
  WaitToReconnect,
  sliderDomId,
  targetStatus,
  update,
} from './main'

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
  connection: Connection.Connected(),
  isBridgeOnline: true,
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
  maybeExpanded: Option.none(),
  maybeActiveSlider: Option.none(),
  presetEditor: PresetEditor.Closed(),
  maybeProblem: Option.none(),
}

const orb = Target.Light({ name: 'Orb' })
const allLights = Target.Group({ name: 'All Lights' })
const frameOf = (topic: string, payload: unknown) =>
  JSON.stringify({ topic, payload })

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
        drafts: [
          {
            target: orb,
            setting: Setting.Brightness({ value: 5 }),
            isDirty: true,
          },
        ],
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
      Command.expectExact(
        SendFrameTwice({ frame: frameOf('Orb/set', { state: 'ON' }) }),
      ),
      Command.resolve(SendFrameTwice, Message.SucceededSendFrame()),
    )
  })

  test('a group with any member on turns off, sent twice', () => {
    story(
      update,
      given(base),
      message(Message.ClickedPower({ target: allLights })),
      Command.expectExact(
        SendFrameTwice({
          frame: frameOf('All Lights/set', { state: 'OFF' }),
        }),
      ),
      Command.resolve(SendFrameTwice, Message.SucceededSendFrame()),
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
            isDirty: true,
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
        drafts: [
          {
            target: orb,
            setting: Setting.Brightness({ value: 50 }),
            isDirty: false,
          },
        ],
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
      model(next => {
        expect(next.drafts).toHaveLength(0)
      }),
    )
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
      message(fromActiveSlider(Slider.Message.ReleasedDragPointer())),
      model(next => {
        expect(Option.isNone(next.maybeActiveSlider)).toBe(true)
      }),
      message(fromActiveSlider(Slider.Message.MovedDragPointer({ value: 90 }))),
      Command.expectNone(),
    )
  })
})

describe('slider throttle', () => {
  const brightness = (value: number) => Setting.Brightness({ value })

  const holding: Model = {
    ...base,
    drafts: [{ target: orb, setting: brightness(10), isDirty: false }],
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
    )
  })
})

describe('presets', () => {
  test('applying names the group', () => {
    story(
      update,
      given(base),
      message(
        Message.ClickedPreset({
          target: Target.Group({ name: 'Rest of the House' }),
          preset: 'Red',
        }),
      ),
      Command.expectExact(
        SendFrame({
          frame: frameOf('preset/set', {
            name: 'Red',
            group: 'Rest of the House',
          }),
        }),
      ),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
    )
  })

  test('applying to a bulb names the light', () => {
    story(
      update,
      given(base),
      message(Message.ClickedPreset({ target: orb, preset: 'Red' })),
      Command.expectExact(
        SendFrame({
          frame: frameOf('preset/set', { name: 'Red', light: 'Orb' }),
        }),
      ),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
    )
  })

  test('saving a new preset sends its look and closes the editor', () => {
    story(
      update,
      given(editorModel()),
      message(Message.SubmittedEditor()),
      model(next => {
        expect(next.presetEditor._tag).toBe('Closed')
      }),
      Command.expectExact(
        SendFrame({
          frame: frameOf('preset/save', {
            name: 'Movie',
            brightness: 90,
            color_temp: 300,
          }),
        }),
      ),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
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
      Command.expectExact(
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

  test('deleting sends the original name', () => {
    story(
      update,
      given(editorModel({ maybeOriginalName: Option.some('Red') })),
      message(Message.ClickedDeletePreset()),
      Command.expectExact(
        SendFrame({ frame: frameOf('preset/delete', { name: 'Red' }) }),
      ),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
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
