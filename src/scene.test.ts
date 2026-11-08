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
  Target,
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

const loaded: Model = {
  connection: Connection.Connected(),
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
  presets: [
    {
      name: 'Red',
      brightness: 254,
      look: PresetLook.Color({ hex: '#FF0000' }),
    },
    { name: 'Rainbow', brightness: 254, look: PresetLook.Rainbow() },
  ],
  drafts: [],
  maybeExpanded: Option.none(),
  maybeActiveSlider: Option.none(),
  presetEditor: PresetEditor.Closed(),
  maybeProblem: Option.none(),
}

describe('view', () => {
  test('shows a waiting state before any lights arrive', () => {
    scene(
      { update, view },
      given({
        ...loaded,
        lights: [],
        connection: Connection.Connecting({ attempt: 0 }),
      }),
      expect(text('Connecting to your lights…')).toExist(),
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

  test('clicking a bulb sends its power command', () => {
    scene(
      { update, view },
      given(loaded),
      click(role('switch', { name: 'Bedroom UFO power' })),
      Command.expectExact(
        SendFrame({
          frame: JSON.stringify({
            topic: 'Bedroom UFO/set',
            payload: { state: 'ON' },
          }),
        }),
      ),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
    )
  })

  test('clicking a group sends its command twice', () => {
    scene(
      { update, view },
      given(loaded),
      click(role('switch', { name: 'All Lights power' })),
      Command.resolve(SendFrameTwice, Message.SucceededSendFrame()),
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
})
