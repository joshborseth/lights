import { Option } from 'effect'
import {
  Command,
  CustomElement,
  click,
  expect,
  given,
  label,
  role,
  scene,
  selector,
  text,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { Tabs } from '@foldkit/ui'

import * as Automations from './automations'
import { Pairing } from './domain'
import { HouseSelection } from './house'
import { houseSceneSpec } from './houseElement'
import {
  Connection,
  Message,
  type Model,
  PageScroll,
  PresetEditor,
  SendFrameTwice,
  Startup,
  WaitForConfirmation,
  update,
} from './main'
import * as Manage from './manage'
import { view } from './view'

const SCENE = selector('lights-house-scene')

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
  tab: 'House',
  tabs: Tabs.init({ id: 'app-tabs' }),
  automations: Automations.init,
  manage: Manage.init,
  connection: Connection.Connected(),
  startup: Startup.Ready(),
  isBridgeOnline: true,
  newDevices: [],
  pairing: Pairing.Closed(),
  lights: [light('Bedroom UFO', 'b'), light('Porch', 'p')],
  groups: [{ name: 'Bedroom', memberAddresses: ['b'] }],
  states: { 'Bedroom UFO': on, Porch: { ...on, power: 'OFF' } },
  groupLevels: {},
  presets: [],
  drafts: [],
  activities: [],
  nextRequestId: 1,
  maybeExpanded: Option.none(),
  openGroups: [],
  maybeActiveSlider: Option.none(),
  pageScroll: PageScroll.Still(),
  presetEditor: PresetEditor.Closed(),
  houseSelection: HouseSelection.Nothing(),
  maybeHouseFailure: Option.none(),
  maybeProblem: Option.none(),
}

const withBedroomPicked: Model = {
  ...loaded,
  houseSelection: HouseSelection.Room({ roomId: 'Bedroom' }),
}

describe('house view', () => {
  test('selecting the tab shows the 3D view and a hint', () => {
    scene(
      { update, view },
      given({ ...loaded, tab: 'Lights' }),
      click(role('tab', { name: 'House' })),
      Command.resolve(Tabs.FocusTab, Tabs.Message.CompletedFocusTab()),
      expect(label('3D view of the house')).toExist(),
      expect(text('Tap a light or a room to control it.')).toExist(),
    )
  })

  test('tapping a bulb in the scene opens its controls', () => {
    scene(
      { update, view },
      given(loaded),
      CustomElement.emit(houseSceneSpec, SCENE, 'picked-bulb', {
        name: 'Bedroom UFO',
      }),
      expect(role('slider', { name: 'Bedroom UFO brightness' })).toExist(),
    )
  })

  test('tapping a room with a matching group opens the group controls', () => {
    scene(
      { update, view },
      given(loaded),
      CustomElement.emit(houseSceneSpec, SCENE, 'picked-room', {
        roomId: 'Bedroom',
      }),
      expect(role('slider', { name: 'Bedroom brightness' })).toExist(),
    )
  })

  test('a room button selects the same room as tapping it', () => {
    scene(
      { update, view },
      given(loaded),
      click(role('button', { name: 'Bedroom' })),
      expect(role('slider', { name: 'Bedroom brightness' })).toExist(),
      expect(role('button', { name: 'Bedroom' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
    )
  })

  test('a room with no group lists the bulbs placed in it', () => {
    scene(
      { update, view },
      given(loaded),
      click(role('button', { name: 'Stairs' })),
      expect(role('slider', { name: 'Porch brightness' })).toExist(),
    )
  })

  test('a room whose group is empty lists the bulbs placed in it', () => {
    scene(
      { update, view },
      given({
        ...loaded,
        lights: [light('Kitchen Light', 'k')],
        groups: [{ name: 'Kitchen', memberAddresses: [] }],
        states: { 'Kitchen Light': on },
      }),
      click(role('button', { name: 'Kitchen' })),
      expect(role('slider', { name: 'Kitchen Light brightness' })).toExist(),
    )
  })

  test('tapping outside the house clears the selection', () => {
    scene(
      { update, view },
      given(withBedroomPicked),
      CustomElement.emit(houseSceneSpec, SCENE, 'cleared-pick', {}),
      expect(text('Tap a light or a room to control it.')).toExist(),
    )
  })

  test('the power switch sends the same repeated command as the Lights tab', () => {
    scene(
      { update, view },
      given(withBedroomPicked),
      click(role('switch', { name: 'Bedroom power' })),
      Command.expectHas(
        SendFrameTwice({
          frame: JSON.stringify({
            topic: 'Bedroom/set',
            payload: { state: 'OFF' },
          }),
        }),
      ),
      Command.resolve(SendFrameTwice, Message.SucceededSendFrame()),
      Command.resolve(
        WaitForConfirmation,
        Message.CompletedWaitForConfirmation({ requestId: 1 }),
      ),
      Command.resolve(
        WaitForConfirmation,
        Message.CompletedWaitForConfirmation({ requestId: 2 }),
      ),
    )
  })

  test('a scene that cannot start explains why and keeps the room buttons', () => {
    scene(
      { update, view },
      given(loaded),
      CustomElement.emit(houseSceneSpec, SCENE, 'failed-scene', {
        reason: 'WebGL is unavailable',
      }),
      expect(label('3D view of the house')).not.toExist(),
      expect(
        text(
          "The 3D view couldn't start on this device: WebGL is unavailable. The room buttons below still work.",
        ),
      ).toExist(),
      expect(role('button', { name: 'Bedroom' })).toExist(),
    )
  })

  test('controls are inert while disconnected', () => {
    scene(
      { update, view },
      given({
        ...withBedroomPicked,
        connection: Connection.WaitingToReconnect({ attempt: 1 }),
      }),
      expect(role('slider', { name: 'Bedroom brightness' })).toExist(),
      expect(
        selector('div[inert] [aria-label="Bedroom brightness"]'),
      ).toExist(),
    )
  })
})
