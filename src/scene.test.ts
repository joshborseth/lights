import { Option } from 'effect'
import {
  Command,
  click,
  expect,
  given,
  keydown,
  role,
  scene,
  text,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { PresetLook } from './domain'
import {
  Connection,
  Message,
  type Model,
  PresetEditor,
  SendFrame,
  SendFrameTwice,
  Startup,
  Target,
  WaitForConfirmation,
  WaitForThrottle,
  update,
} from './main'
import { view } from './view'

const light = (name: string, address: string) => ({
  name,
  address,
  maybeColorTempRange: Option.some({ min: 153, max: 555 }),
  supportsColor: true,
})

const on = {
  power: 'ON' as const,
  brightness: 120,
  maybeColorTemp: Option.some(370),
  maybeHueSaturation: Option.some({ hue: 32, saturation: 82 }),
}

const settleTimedOut = (requestId: number) =>
  Command.resolve(
    WaitForConfirmation,
    Message.CompletedWaitForConfirmation({ requestId }),
  )

const loaded: Model = {
  connection: Connection.Connected(),
  startup: Startup.Ready(),
  isBridgeOnline: true,
  lights: [light('Living Room Orb', 'a'), light('Bedroom UFO', 'b')],
  groups: [
    { name: 'Bedroom', memberAddresses: ['b'] },
    { name: 'All Lights', memberAddresses: ['a', 'b'] },
  ],
  states: {
    'Living Room Orb': on,
    'Bedroom UFO': { ...on, power: 'OFF' },
  },
  groupLevels: {},
  presets: [
    {
      name: 'Red',
      brightness: 254,
      look: PresetLook.Color({ hex: '#FF0000' }),
    },
    { name: 'Rainbow', brightness: 254, look: PresetLook.Rainbow() },
  ],
  drafts: [],
  activities: [],
  nextRequestId: 1,
  maybeExpanded: Option.none(),
  maybeActiveSlider: Option.none(),
  presetEditor: PresetEditor.Closed(),
  maybeProblem: Option.none(),
}

describe('view', () => {
  test('a group slider shows its stored level, not its brightest bulb', () => {
    scene(
      { update, view },
      given({ ...loaded, groupLevels: { 'All Lights': 60 } }),
      expect(role('slider', { name: 'All Lights brightness' })).toHaveAttr(
        'aria-valuenow',
        '60',
      ),
      expect(role('slider', { name: 'Living Room Orb brightness' })).toHaveAttr(
        'aria-valuenow',
        '120',
      ),
    )
  })

  test('shows a waiting state before any lights arrive', () => {
    scene(
      { update, view },
      given({
        ...loaded,
        lights: [],
        startup: Startup.Loading({ missing: ['Lights', 'Groups', 'Presets'] }),
        connection: Connection.Connecting({ attempt: 0 }),
      }),
      expect(text('Connecting to your lights…')).toExist(),
      expect(role('switch', { name: 'Bedroom UFO power' })).not.toExist(),
    )
  })

  test('says so when the bridge stays unreachable', () => {
    scene(
      { update, view },
      given({
        ...loaded,
        startup: Startup.Loading({ missing: ['Lights', 'Groups', 'Presets'] }),
        connection: Connection.WaitingToReconnect({ attempt: 3 }),
      }),
      expect(text("Can't reach Zigbee2MQTT")).toExist(),
    )
  })

  test('explains an empty network instead of spinning', () => {
    scene(
      { update, view },
      given({ ...loaded, lights: [], groups: [] }),
      expect(text('No lights found')).toExist(),
    )
  })

  test('keeps the page while reconnecting, without live controls', () => {
    scene(
      { update, view },
      given({
        ...loaded,
        connection: Connection.WaitingToReconnect({ attempt: 0 }),
      }),
      expect(role('status')).toHaveText('Reconnecting…'),
      expect(text('Living Room Orb')).toExist(),
    )
  })

  test('marks a bulb busy while its power change is confirmed', () => {
    scene(
      { update, view },
      given(loaded),
      click(role('switch', { name: 'Bedroom UFO power' })),
      expect(role('article', { name: 'Bedroom UFO' })).toHaveAttr(
        'aria-busy',
        'true',
      ),
      expect(role('switch', { name: 'Bedroom UFO power' })).toHaveAttr(
        'aria-checked',
        'false',
      ),
      Command.resolve(SendFrameTwice, Message.SucceededSendFrame()),
      settleTimedOut(1),
      expect(text('No response')).toExist(),
      settleTimedOut(2),
      expect(text('No response')).not.toExist(),
    )
  })

  test('a light that never reported is not shown as off', () => {
    scene(
      { update, view },
      given({
        ...loaded,
        states: { 'Living Room Orb': on },
      }),
      expect(text('Not reporting')).toExist(),
    )
  })

  test('shows groups, rooms, and live status', () => {
    scene(
      { update, view },
      given(loaded),
      expect(role('status')).toHaveText('Live'),
      expect(role('article', { name: 'All Lights' })).toExist(),
      expect(role('region', { name: 'Living Room' })).toExist(),
      expect(role('switch', { name: 'Living Room Orb power' })).toHaveAttr(
        'aria-checked',
        'true',
      ),
      expect(role('switch', { name: 'Bedroom UFO power' })).toHaveAttr(
        'aria-checked',
        'false',
      ),
      expect(role('slider', { name: 'Living Room Orb brightness' })).toHaveAttr(
        'aria-valuenow',
        '120',
      ),
    )
  })

  test('offers presets on All Lights but never on Bedroom', () => {
    scene(
      { update, view },
      given(loaded),
      expect(role('button', { name: 'Red on All Lights' })).toExist(),
      expect(role('button', { name: 'Red on Bedroom' })).not.toExist(),
    )
  })

  test('offers each bulb its presets once it is expanded', () => {
    scene(
      { update, view },
      given(loaded),
      expect(role('button', { name: 'Red on Bedroom UFO' })).not.toExist(),
      click(role('button', { name: 'Bedroom UFO color' })),
      click(role('button', { name: 'Rainbow on Bedroom UFO' })),
      Command.expectHas(
        SendFrame({
          frame: JSON.stringify({
            topic: 'preset/set',
            payload: { name: 'Rainbow', light: 'Bedroom UFO' },
          }),
        }),
      ),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      settleTimedOut(1),
    )
  })

  test('hides presets a bulb cannot show', () => {
    scene(
      { update, view },
      given({
        ...loaded,
        lights: [
          {
            ...light('Living Room Orb', 'a'),
            supportsColor: false,
          },
        ],
        presets: [
          ...loaded.presets,
          {
            name: 'Warm',
            brightness: 200,
            look: PresetLook.White({ colorTemp: 370 }),
          },
        ],
      }),
      click(role('button', { name: 'Living Room Orb color' })),
      expect(role('button', { name: 'Warm on Living Room Orb' })).toExist(),
      expect(role('button', { name: 'Red on Living Room Orb' })).not.toExist(),
      expect(
        role('button', { name: 'Rainbow on Living Room Orb' }),
      ).not.toExist(),
    )
  })

  test('clicking a bulb sends its power command', () => {
    scene(
      { update, view },
      given(loaded),
      click(role('switch', { name: 'Bedroom UFO power' })),
      Command.expectHas(
        SendFrameTwice({
          frame: JSON.stringify({
            topic: 'Bedroom UFO/set',
            payload: { state: 'ON' },
          }),
        }),
      ),
      Command.resolve(SendFrameTwice, Message.SucceededSendFrame()),
      settleTimedOut(1),
      settleTimedOut(2),
    )
  })

  test('clicking a group sends its command twice', () => {
    scene(
      { update, view },
      given(loaded),
      click(role('switch', { name: 'All Lights power' })),
      Command.resolve(SendFrameTwice, Message.SucceededSendFrame()),
      settleTimedOut(1),
      settleTimedOut(2),
    )
  })

  test('arrow key on a brightness slider sends one throttled change', () => {
    const orb = Target.Light({ name: 'Living Room Orb' })
    scene(
      { update, view },
      given(loaded),
      keydown(
        role('slider', { name: 'Living Room Orb brightness' }),
        'ArrowRight',
      ),
      Command.expectHas(
        SendFrame({
          frame: JSON.stringify({
            topic: 'Living Room Orb/set',
            payload: { brightness: 121 },
          }),
        }),
      ),
      Command.expectHas(WaitForThrottle({ target: orb, kind: 'Brightness' })),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      Command.resolve(
        WaitForThrottle,
        Message.CompletedThrottleWait({ target: orb, kind: 'Brightness' }),
      ),
      settleTimedOut(1),
    )
  })

  test('reveals color controls on request', () => {
    scene(
      { update, view },
      given(loaded),
      expect(role('slider', { name: 'Bedroom UFO temperature' })).not.toExist(),
      click(role('button', { name: 'Bedroom UFO color' })),
      expect(role('slider', { name: 'Bedroom UFO temperature' })).toExist(),
    )
  })

  test('Rainbow has no edit button', () => {
    scene(
      { update, view },
      given(loaded),
      expect(role('button', { name: 'Edit Red' })).toExist(),
      expect(role('button', { name: 'Edit Rainbow' })).not.toExist(),
    )
  })

  test('new preset opens an editor that needs a name', () => {
    scene(
      { update, view },
      given(loaded),
      click(role('button', { name: 'New preset' })),
      expect(text('Give the preset a name.')).toExist(),
      expect(role('button', { name: 'Save' })).toBeDisabled(),
    )
  })

  test('saving shows progress and locks the editor', () => {
    scene(
      { update, view },
      given(loaded),
      click(role('button', { name: 'Edit Red' })),
      click(role('button', { name: 'Save' })),
      expect(role('button', { name: 'Saving…' })).toBeDisabled(),
      expect(role('button', { name: 'Cancel' })).toBeDisabled(),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      settleTimedOut(1),
      expect(text("Didn't hear back from Zigbee2MQTT. Try again.")).toExist(),
      expect(role('button', { name: 'Save' })).not.toBeDisabled(),
    )
  })
})
