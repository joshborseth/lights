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
  within,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import * as Automations from './automations'
import { Pairing, PresetLook } from './domain'
import { HouseFocus } from './house'
import { houseSceneSpec } from './houseElement'
import {
  Connection,
  Message,
  type Model,
  PageScroll,
  PresetEditor,
  SendFrame,
  SendFrameTwice,
  Startup,
  WaitForConfirmation,
  update,
} from './main'
import * as Manage from './manage'
import { sheetGrabberSpec } from './sheetGrabber'
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
  screen: 'House',
  focus: HouseFocus.Overview(),
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
  maybeActiveSlider: Option.none(),
  pageScroll: PageScroll.Still(),
  presetEditor: PresetEditor.Closed(),
  maybeHouseFailure: Option.none(),
  maybeProblem: Option.none(),
}

const withBedroomPicked: Model = {
  ...loaded,
  focus: HouseFocus.Room({ roomId: 'Bedroom' }),
}

describe('house view', () => {
  test('the house is the screen and each room has its control', () => {
    scene(
      { update, view },
      given(loaded),
      expect(label('3D view of the house')).toExist(),
      expect(role('button', { name: 'Bedroom controls' })).toExist(),
      expect(role('button', { name: 'Scenes' })).toExist(),
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

  test('tapping a room with no lights does nothing', () => {
    scene(
      { update, view },
      given({ ...loaded, lights: [light('Bedroom UFO', 'b')] }),
      CustomElement.emit(houseSceneSpec, SCENE, 'picked-room', {
        roomId: 'Kitchen',
      }),
      expect(role('region', { name: 'Kitchen' })).not.toExist(),
    )
  })

  test('a room control opens the same room as tapping it', () => {
    scene(
      { update, view },
      given(loaded),
      click(role('button', { name: 'Bedroom controls' })),
      expect(role('slider', { name: 'Bedroom brightness' })).toExist(),
    )
  })

  test('a room shows its bulbs at their fixtures, and each opens', () => {
    scene(
      { update, view },
      given(withBedroomPicked),
      click(role('button', { name: 'Bedroom UFO' })),
      expect(role('slider', { name: 'Bedroom UFO brightness' })).toExist(),
      expect(role('button', { name: 'Bedroom UFO' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
      click(role('button', { name: 'Back to Bedroom' })),
      expect(role('slider', { name: 'Bedroom brightness' })).toExist(),
    )
  })

  test('a bulb with no room of its own is controlled from the Stairs', () => {
    scene(
      { update, view },
      given(loaded),
      click(role('button', { name: 'Stairs controls' })),
      expect(role('slider', { name: 'Stairs brightness' })).toExist(),
    )
  })

  test('tapping outside the house returns to the overview', () => {
    scene(
      { update, view },
      given(withBedroomPicked),
      CustomElement.emit(houseSceneSpec, SCENE, 'cleared-pick', {}),
      expect(role('region', { name: 'Bedroom' })).not.toExist(),
      expect(role('button', { name: 'Scenes' })).toExist(),
    )
  })

  test('swiping the sheet down returns to the overview', () => {
    scene(
      { update, view },
      given(withBedroomPicked),
      CustomElement.emit(
        sheetGrabberSpec,
        selector('lights-sheet-grabber'),
        'dismissed',
        {},
      ),
      expect(role('region', { name: 'Bedroom' })).not.toExist(),
    )
  })

  test('the back button returns to the overview', () => {
    scene(
      { update, view },
      given(withBedroomPicked),
      click(role('button', { name: 'Back to the whole house' })),
      expect(role('region', { name: 'Bedroom' })).not.toExist(),
    )
  })

  test('the room sheet sends the same repeated power command', () => {
    scene(
      { update, view },
      given(withBedroomPicked),
      click(
        within(
          role('region', { name: 'Bedroom' }),
          role('switch', { name: 'Bedroom power' }),
        ),
      ),
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

  test('scenes open from the dock and apply to the whole house', () => {
    scene(
      { update, view },
      given({
        ...loaded,
        groups: [
          { name: 'Bedroom', memberAddresses: ['b'] },
          { name: 'All Lights', memberAddresses: ['b', 'p'] },
        ],
        presets: [
          {
            name: 'Red',
            brightness: 254,
            look: PresetLook.Color({ hex: '#FF0000' }),
          },
        ],
      }),
      click(role('button', { name: 'Scenes' })),
      click(role('button', { name: 'Red on All Lights' })),
      Command.expectHas(
        SendFrame({
          frame: JSON.stringify({
            topic: 'preset/set',
            payload: { name: 'Red', group: 'All Lights' },
          }),
        }),
      ),
      Command.resolve(SendFrame, Message.SucceededSendFrame()),
      Command.resolve(
        WaitForConfirmation,
        Message.CompletedWaitForConfirmation({ requestId: 1 }),
      ),
    )
  })

  test('Edit in the scenes sheet opens the Scenes page', () => {
    scene(
      { update, view },
      given({ ...loaded, focus: HouseFocus.Scenes() }),
      click(role('button', { name: 'Edit' })),
      expect(role('button', { name: 'New preset' })).toExist(),
      click(role('button', { name: 'Back to the house' })),
      expect(role('button', { name: 'New preset' })).not.toExist(),
    )
  })

  test('automations and devices open as pages over the house', () => {
    scene(
      { update, view },
      given(loaded),
      click(role('button', { name: 'Automations' })),
      expect(role('heading', { name: 'Automations' })).toExist(),
      click(role('button', { name: 'Back to the house' })),
      click(role('button', { name: 'Devices' })),
      expect(role('heading', { name: 'Devices' })).toExist(),
      expect(label('3D view of the house')).toExist(),
    )
  })

  test('a scene that cannot start explains why and keeps the rooms', () => {
    scene(
      { update, view },
      given(loaded),
      CustomElement.emit(houseSceneSpec, SCENE, 'failed-scene', {
        reason: 'WebGL is unavailable',
      }),
      expect(label('3D view of the house')).not.toExist(),
      expect(
        text(
          "The 3D view couldn't start on this device: WebGL is unavailable. The rooms below still work.",
        ),
      ).toExist(),
      expect(role('button', { name: 'Bedroom controls' })).toExist(),
    )
  })

  test('the closet keeps its own controls', () => {
    scene(
      { update, view },
      given({
        ...loaded,
        lights: [...loaded.lights, light('Closet', 'c')],
        states: { ...loaded.states, Closet: on },
        presets: [
          {
            name: 'Red',
            brightness: 254,
            look: PresetLook.Color({ hex: '#FF0000' }),
          },
        ],
        focus: HouseFocus.Room({ roomId: 'Closet' }),
      }),
      expect(role('switch', { name: 'Closet power' })).toExist(),
      expect(role('slider', { name: 'Closet brightness' })).toExist(),
      expect(role('button', { name: 'Red on Closet' })).toExist(),
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
