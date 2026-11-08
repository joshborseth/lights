import { Option } from 'effect'
import {
  Command,
  Subscription,
  click,
  expect,
  given,
  label,
  role,
  scene,
  submit,
  text,
  type,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { Tabs } from '@foldkit/ui'

import * as Automations from './automations'
import { IncomingFrame, Pairing } from './domain'
import {
  Connection,
  Message,
  type Model,
  PageScroll,
  PresetEditor,
  SendFrame,
  Startup,
  update,
} from './main'
import * as Manage from './manage'
import { view } from './view'

const light = (name: string, address: string) => ({
  name,
  address,
  maybeColorTempRange: Option.none(),
  supportsColor: true,
})

const base: Model = {
  tab: 'Manage',
  tabs: Tabs.init({ id: 'app-tabs' }),
  automations: Automations.init,
  manage: { ...Manage.init, clientTag: 'x' },
  connection: Connection.Connected(),
  startup: Startup.Ready(),
  isBridgeOnline: true,
  newDevices: [],
  pairing: Pairing.Closed(),
  lights: [light('Orb', 'a'), light('UFO', 'b')],
  groups: [
    { name: 'All Lights', memberAddresses: ['a', 'b'] },
    { name: 'Bedroom', memberAddresses: ['b'] },
    { name: 'Kitchen', memberAddresses: [] },
  ],
  states: {},
  groupLevels: {},
  presets: [],
  drafts: [],
  activities: [],
  nextRequestId: 0,
  maybeExpanded: Option.none(),
  openGroups: [],
  maybeActiveSlider: Option.none(),
  presetEditor: PresetEditor.Closed(),
  maybeProblem: Option.none(),
  pageScroll: PageScroll.Still(),
}

const sent = Command.resolve(SendFrame, Message.SucceededSendFrame())

const respond = (requestId: number) =>
  Subscription.emit(
    Message.ReceivedFrame({
      frame: IncomingFrame.ReportedBridgeResponse({
        transaction: `lights-x-${requestId}`,
        maybeError: Option.none(),
      }),
    }),
  )

const staleDeadline = Command.resolve(
  Manage.WaitForResponse,
  Manage.Message.CompletedWaitForResponse({ requestId: -1 }),
)

const withNewBulb: Model = {
  ...base,
  lights: [...base.lights, light('0x9', '0x9')],
  newDevices: [
    {
      address: '0x9',
      setup: 'ReadyLight',
      maybeDescription: Option.some('TRADFRI bulb'),
    },
  ],
}

describe('Manage tab', () => {
  test('starting pairing asks the bridge to open the network', () => {
    scene(
      { update, view },
      given(base),
      expect(role('heading', { name: 'Add a light' })).toExist(),
      click(role('button', { name: 'Start pairing' })),
      sent,
      staleDeadline,
      respond(0),
      expect(text('Working on it…')).not.toExist(),
    )
  })

  test('an open network shows the countdown and a way to stop', () => {
    scene(
      { update, view },
      given({
        ...base,
        pairing: Pairing.Open({ maybeEndsAt: Option.some(70_000) }),
        manage: { ...base.manage, maybeNowMs: Option.some(10_000) },
      }),
      expect(
        role('heading', { name: 'Looking for new lights · 1:00 left' }),
      ).toExist(),
      expect(role('button', { name: 'Stop pairing' })).toExist(),
    )
  })

  test('a paired bulb can be named and placed in one go', () => {
    scene(
      { update, view },
      given(withNewBulb),
      expect(text('Waiting for a name')).toExist(),
      click(role('button', { name: 'Open New device' })),
      expect(role('heading', { name: 'New light' })).toExist(),
      expect(role('radio', { name: 'All Lights' })).toHaveAttr(
        'aria-checked',
        'true',
      ),
      type(label('Name'), 'Porch Lamp'),
      click(role('radio', { name: 'Bedroom' })),
      submit(role('form')),
      sent,
      staleDeadline,
      respond(0),
      sent,
      staleDeadline,
      respond(1),
      sent,
      staleDeadline,
      respond(2),
      sent,
      expect(text('Porch Lamp is ready.')).toExist(),
    )
  })

  test('a taken name is explained and blocks saving', () => {
    scene(
      { update, view },
      given(withNewBulb),
      click(role('button', { name: 'Open New device' })),
      type(label('Name'), 'Orb'),
      expect(text('Another light or group already has that name.')).toExist(),
      expect(role('button', { name: 'Add light' })).toHaveAttr(
        'aria-disabled',
        'true',
      ),
    )
  })

  test('a light can be moved with one tap', () => {
    scene(
      { update, view },
      given(base),
      click(role('button', { name: 'Open Orb' })),
      expect(role('radio', { name: 'All Lights' })).toHaveAttr(
        'aria-checked',
        'true',
      ),
      click(role('radio', { name: 'Bedroom' })),
      expect(text('Working on it…')).toExist(),
      sent,
      staleDeadline,
      respond(0),
      expect(text('Working on it…')).not.toExist(),
    )
  })

  test('removing a light asks for confirmation first', () => {
    scene(
      { update, view },
      given(base),
      click(role('button', { name: 'Open Orb' })),
      click(role('button', { name: 'Remove light' })),
      expect(role('button', { name: 'Remove' })).toExist(),
      click(role('button', { name: 'Cancel' })),
      expect(role('button', { name: 'Remove light' })).toExist(),
    )
  })

  test('a group lists every light as a checkbox', () => {
    scene(
      { update, view },
      given(base),
      click(role('button', { name: 'Open Bedroom' })),
      expect(role('checkbox', { name: 'UFO' })).toHaveAttr(
        'aria-checked',
        'true',
      ),
      expect(role('checkbox', { name: 'Orb' })).toHaveAttr(
        'aria-checked',
        'false',
      ),
    )
  })

  test('warns before renaming a group other things depend on', () => {
    scene(
      { update, view },
      given(base),
      click(role('button', { name: 'Open All Lights' })),
      expect(
        text(
          'Presets and scene buttons look for this group by name, so renaming or removing it can stop them working.',
        ),
      ).toExist(),
    )
  })
})
