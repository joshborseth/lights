import { Option } from 'effect'
import {
  Command,
  click,
  expect,
  expectIgnored,
  given,
  keydown,
  pointerDown,
  role,
  scene,
  text,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import * as Automations from './automations'
import { Pairing, PresetLook } from './domain'
import { HouseFocus } from './house'
import { type RoomId } from './housePlan'
import {
  Connection,
  Message,
  type Model,
  PageScroll,
  PresetEditor,
  SendFrame,
  SendFrameTwice,
  Startup,
  Target,
  WaitForConfirmation,
  WaitForThrottle,
  update,
} from './main'
import * as Manage from './manage'
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
  screen: 'House',
  focus: HouseFocus.Overview(),
  automations: Automations.init,
  manage: Manage.init,
  connection: Connection.Connected(),
  startup: Startup.Ready(),
  isBridgeOnline: true,
  newDevices: [],
  pairing: Pairing.Closed(),
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
  maybeActiveSlider: Option.none(),
  pageScroll: PageScroll.Still(),
  presetEditor: PresetEditor.Closed(),
  maybeHouseFailure: Option.none(),
  maybeProblem: Option.none(),
}

const onBulb = (name: string): Model => ({
  ...loaded,
  focus: HouseFocus.Bulb({ name }),
})

const onRoom = (roomId: RoomId): Model => ({
  ...loaded,
  focus: HouseFocus.Room({ roomId }),
})

const onScenes: Model = { ...loaded, screen: 'Scenes' }

describe('view', () => {
  test('a group room shows its stored level, not its brightest bulb', () => {
    scene(
      { update, view },
      given({ ...onRoom('Bedroom'), groupLevels: { Bedroom: 60 } }),
      expect(role('slider', { name: 'Bedroom brightness' })).toHaveAttr(
        'aria-valuenow',
        '60',
      ),
    )
  })

  test('a bulb slider shows its reported brightness', () => {
    scene(
      { update, view },
      given(onBulb('Living Room Orb')),
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
      expect(role('switch', { name: 'Bedroom power' })).not.toExist(),
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

  test('keeps the house while reconnecting, without live controls', () => {
    scene(
      { update, view },
      given({
        ...loaded,
        connection: Connection.WaitingToReconnect({ attempt: 0 }),
      }),
      expect(role('status')).toHaveText('Reconnecting…'),
      expect(text('Bedroom')).toExist(),
    )
  })

  test('marks a bulb busy while its power change is confirmed', () => {
    scene(
      { update, view },
      given(onBulb('Bedroom UFO')),
      click(role('switch', { name: 'Bedroom UFO power' })),
      expect(role('region', { name: 'Bedroom UFO' })).toHaveAttr(
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
        ...onBulb('Bedroom UFO'),
        states: { 'Living Room Orb': on },
      }),
      expect(text('Not reporting')).toExist(),
    )
  })

  test('a bulb names what its percentage measures', () => {
    scene(
      { update, view },
      given(onBulb('Living Room Orb')),
      expect(text('47% brightness')).toExist(),
    )
  })

  test('a bulb at its lowest level never reads as zero', () => {
    scene(
      { update, view },
      given({
        ...onBulb('Living Room Orb'),
        states: { 'Living Room Orb': { ...on, brightness: 1 } },
      }),
      expect(text('1% brightness')).toExist(),
    )
  })

  test('the brightness knob carries the value it shows while dragged', () => {
    scene(
      { update, view },
      given(onBulb('Living Room Orb')),
      expect(role('slider', { name: 'Living Room Orb brightness' })).toHaveText(
        '47%',
      ),
    )
  })

  test.each([
    [370, 'Warm'],
    [250, 'Neutral'],
    [153, 'Cool'],
  ])('a color temperature of %i mireds reads as %s', (mireds, name) => {
    scene(
      { update, view },
      given({
        ...onBulb('Living Room Orb'),
        states: {
          'Living Room Orb': { ...on, maybeColorTemp: Option.some(mireds) },
        },
      }),
      expect(
        role('slider', { name: 'Living Room Orb temperature' }),
      ).toHaveAttr('aria-valuetext', name),
    )
  })

  test('the overview shows each room with live status', () => {
    scene(
      { update, view },
      given(loaded),
      expect(role('status')).toHaveText('Live'),
      expect(text('1 of 2 on')).toExist(),
      expect(role('switch', { name: 'Living Room power' })).toHaveAttr(
        'aria-checked',
        'true',
      ),
      expect(role('switch', { name: 'Bedroom power' })).toHaveAttr(
        'aria-checked',
        'false',
      ),
    )
  })

  test('a room offers presets for its group', () => {
    scene(
      { update, view },
      given(onRoom('Bedroom')),
      click(role('button', { name: 'Red on Bedroom' })),
      Command.expectHas(
        SendFrame({
          frame: JSON.stringify({
            topic: 'preset/set',
            payload: { name: 'Red', group: 'Bedroom' },
          }),
        }),
      ),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      settleTimedOut(1),
    )
  })

  test('a bulb offers presets for itself', () => {
    scene(
      { update, view },
      given(onBulb('Bedroom UFO')),
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
        ...onBulb('Living Room Orb'),
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
      expect(role('button', { name: 'Warm on Living Room Orb' })).toExist(),
      expect(role('button', { name: 'Red on Living Room Orb' })).not.toExist(),
      expect(
        role('button', { name: 'Rainbow on Living Room Orb' }),
      ).not.toExist(),
      expect(role('slider', { name: 'Living Room Orb color' })).not.toExist(),
    )
  })

  test('a bulb power button sends its repeated command', () => {
    scene(
      { update, view },
      given(onBulb('Bedroom UFO')),
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

  test('the dock turns the whole house off through its group', () => {
    scene(
      { update, view },
      given(loaded),
      click(role('button', { name: 'All off' })),
      Command.expectHas(
        SendFrameTwice({
          frame: JSON.stringify({
            topic: 'All Lights/set',
            payload: { state: 'OFF' },
          }),
        }),
      ),
      Command.resolve(SendFrameTwice, Message.SucceededSendFrame()),
      settleTimedOut(1),
      settleTimedOut(2),
    )
  })

  test('the dock says All on when every light is off', () => {
    scene(
      { update, view },
      given({
        ...loaded,
        states: {
          'Living Room Orb': { ...on, power: 'OFF' },
          'Bedroom UFO': { ...on, power: 'OFF' },
        },
      }),
      expect(role('button', { name: 'All on' })).toExist(),
    )
  })

  test('arrow key on a brightness slider sends one throttled change', () => {
    const orb = Target.Light({ name: 'Living Room Orb' })
    scene(
      { update, view },
      given(onBulb('Living Room Orb')),
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

  test('the color slider sends hue and saturation, never hex', () => {
    const orb = Target.Light({ name: 'Living Room Orb' })
    scene(
      { update, view },
      given(onBulb('Living Room Orb')),
      keydown(role('slider', { name: 'Living Room Orb color' }), 'ArrowRight'),
      Command.expectHas(
        SendFrame({
          frame: JSON.stringify({
            topic: 'Living Room Orb/set',
            payload: { color: { hue: 33, saturation: 100 } },
          }),
        }),
      ),
      Command.expectHas(WaitForThrottle({ target: orb, kind: 'Color' })),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      Command.resolve(
        WaitForThrottle,
        Message.CompletedThrottleWait({ target: orb, kind: 'Color' }),
      ),
      settleTimedOut(1),
    )
  })

  describe('touching a slider', () => {
    const orbSlider = role('slider', { name: 'Living Room Orb brightness' })
    const touch = {
      pointerType: 'touch',
      pointerId: 7,
      clientX: 100,
      clientY: 300,
    }
    const bulbSheet = onBulb('Living Room Orb')
    const viewWithSliderProbe: typeof view = (model, h) => {
      const page = view(model, h)
      return {
        ...page,
        body: h.div(
          [],
          [
            page.body,
            h.p(
              [],
              [
                Option.isSome(model.maybeActiveSlider)
                  ? 'gesture started'
                  : 'no gesture',
              ],
            ),
          ],
        ),
      }
    }

    test('a finger press leaves the light alone', () => {
      scene(
        { update, view },
        given(bulbSheet),
        pointerDown(orbSlider, touch),
        Command.expectNone(),
        expect(orbSlider).toHaveAttr('aria-valuenow', '120'),
      )
    })

    test('a touch while the page is still starts a gesture', () => {
      scene(
        { update, view: viewWithSliderProbe },
        given(bulbSheet),
        pointerDown(orbSlider, touch),
        expect(text('gesture started')).toExist(),
      )
    })

    test('a touch while the sheet is scrolling is ignored', () => {
      scene(
        { update, view: viewWithSliderProbe },
        given({ ...bulbSheet, pageScroll: PageScroll.Moving() }),
        pointerDown(orbSlider, touch),
        expectIgnored(),
        Command.expectNone(),
        expect(text('no gesture')).toExist(),
      )
    })

    test('a touch on the track leaves the slider alone', () => {
      scene(
        { update, view: viewWithSliderProbe },
        given(bulbSheet),
        pointerDown('[data-slot="slider-track"]', touch),
        expectIgnored(),
        Command.expectNone(),
        expect(text('no gesture')).toExist(),
      )
    })

    test('the knob leaves vertical panning to the browser', () => {
      scene(
        { update, view },
        given(bulbSheet),
        expect(orbSlider).toHaveStyle('touch-action', 'pan-y'),
      )
    })
  })

  describe('with the rooms nested', () => {
    const nested: Model = {
      ...loaded,
      lights: [
        light('Living Room Orb', 'a'),
        light('Living Room Shroom', 'c'),
        light('Bedroom UFO', 'b'),
        light('Bathroom Orb', 'd'),
      ],
      groups: [
        { name: 'All Lights', memberAddresses: ['a', 'b', 'c', 'd'] },
        { name: 'Bedroom', memberAddresses: ['b'] },
        { name: 'Rest of the House', memberAddresses: ['a', 'c', 'd'] },
        { name: 'Living Room', memberAddresses: ['a', 'c'] },
      ],
      states: {
        'Living Room Orb': on,
        'Living Room Shroom': { ...on, brightness: 40 },
        'Bedroom UFO': { ...on, power: 'OFF' },
        'Bathroom Orb': on,
      },
    }

    test('a bulb is named by what sets it apart in its room', () => {
      scene(
        { update, view },
        given({ ...nested, focus: HouseFocus.Room({ roomId: 'LivingRoom' }) }),
        expect(text('Orb')).toExist(),
        expect(text('Shroom')).toExist(),
      )
    })

    test('a room says when its bulbs differ', () => {
      scene(
        { update, view },
        given({ ...nested, focus: HouseFocus.Room({ roomId: 'LivingRoom' }) }),
        expect(text('All on · mixed')).toExist(),
      )
    })

    test('the house labels each room by which of its lights are on', () => {
      scene(
        { update, view },
        given(nested),
        expect(text('All on')).toExist(),
        expect(text('On')).toExist(),
        expect(text('Off')).toExist(),
        expect(text('47%')).toBeAbsent(),
      )
    })

    test('a partly lit room says how many lights are on', () => {
      scene(
        { update, view },
        given({
          ...nested,
          states: {
            ...nested.states,
            'Living Room Shroom': { ...on, power: 'OFF' },
          },
        }),
        expect(text('1 of 2 on')).toExist(),
      )
    })

    test('a room is commanded as one group, sent twice', () => {
      scene(
        { update, view },
        given(nested),
        click(role('switch', { name: 'Living Room power' })),
        Command.expectHas(
          SendFrameTwice({
            frame: JSON.stringify({
              topic: 'Living Room/set',
              payload: { state: 'OFF' },
            }),
          }),
        ),
        Command.resolve(SendFrameTwice, Message.SucceededSendFrame()),
        settleTimedOut(1),
        settleTimedOut(2),
      )
    })
  })

  describe('a room without a usable group', () => {
    const kitchen: Model = {
      ...loaded,
      lights: [light('Kitchen Left', 'k1'), light('Kitchen Right', 'k2')],
      groups: [
        { name: 'Kitchen', memberAddresses: [] },
        { name: 'All Lights', memberAddresses: ['k1', 'k2'] },
      ],
      states: { 'Kitchen Left': on, 'Kitchen Right': on },
      focus: HouseFocus.Room({ roomId: 'Kitchen' }),
    }

    test('power goes to each bulb, twice', () => {
      scene(
        { update, view },
        given(kitchen),
        click(role('switch', { name: 'Kitchen power' })),
        Command.expectHas(
          SendFrameTwice({
            frame: JSON.stringify({
              topic: 'Kitchen Left/set',
              payload: { state: 'OFF' },
            }),
          }),
        ),
        Command.expectHas(
          SendFrameTwice({
            frame: JSON.stringify({
              topic: 'Kitchen Right/set',
              payload: { state: 'OFF' },
            }),
          }),
        ),
        Command.resolve(
          SendFrameTwice({
            frame: JSON.stringify({
              topic: 'Kitchen Left/set',
              payload: { state: 'OFF' },
            }),
          }),
          Message.SucceededSendFrame(),
        ),
        Command.resolve(
          SendFrameTwice({
            frame: JSON.stringify({
              topic: 'Kitchen Right/set',
              payload: { state: 'OFF' },
            }),
          }),
          Message.SucceededSendFrame(),
        ),
        settleTimedOut(1),
        settleTimedOut(2),
      )
    })

    test('a preset goes to each bulb', () => {
      scene(
        { update, view },
        given(kitchen),
        click(role('button', { name: 'Red on Kitchen' })),
        Command.expectHas(
          SendFrame({
            frame: JSON.stringify({
              topic: 'preset/set',
              payload: { name: 'Red', light: 'Kitchen Left' },
            }),
          }),
        ),
        Command.expectHas(
          SendFrame({
            frame: JSON.stringify({
              topic: 'preset/set',
              payload: { name: 'Red', light: 'Kitchen Right' },
            }),
          }),
        ),
        Command.resolve(
          SendFrame({
            frame: JSON.stringify({
              topic: 'preset/set',
              payload: { name: 'Red', light: 'Kitchen Left' },
            }),
          }),
          Message.SucceededSendFrame(),
        ),
        Command.resolve(
          SendFrame({
            frame: JSON.stringify({
              topic: 'preset/set',
              payload: { name: 'Red', light: 'Kitchen Right' },
            }),
          }),
          Message.SucceededSendFrame(),
        ),
        settleTimedOut(1),
      )
    })
  })

  test('the Scenes page has no edit button for Rainbow', () => {
    scene(
      { update, view },
      given(onScenes),
      expect(role('button', { name: 'Edit Red' })).toExist(),
      expect(role('button', { name: 'Edit Rainbow' })).not.toExist(),
    )
  })

  test('new preset opens an editor that needs a name', () => {
    scene(
      { update, view },
      given(onScenes),
      click(role('button', { name: 'New preset' })),
      expect(text('Give the preset a name.')).toExist(),
      expect(role('button', { name: 'Save' })).toBeDisabled(),
    )
  })

  test('saving shows progress and locks the editor', () => {
    scene(
      { update, view },
      given(onScenes),
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
