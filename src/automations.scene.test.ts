import { Option } from 'effect'
import {
  Command,
  click,
  expect,
  given,
  label,
  role,
  scene,
  text,
  type,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { Tabs } from '@foldkit/ui'

import { DEFAULT_CONFIG, type Snapshot, WatcherMode } from './automation'
import * as Automations from './automations'
import { Connection, type Model, PresetEditor, Startup, update } from './main'
import { view } from './view'

const snapshot: Snapshot = {
  generatedAt: 100_000,
  startedAt: 40_000,
  config: DEFAULT_CONFIG,
  mode: WatcherMode.Watching({ isScheduleOpen: true }),
  heldMerges: 0,
  poll: {
    maybeLastStartedAt: Option.some(95_000),
    maybeLastSucceededAt: Option.some(95_000),
    maybeLastDurationMs: Option.some(120),
    consecutiveFailures: 0,
    maybeLastError: Option.none(),
    maybePartialError: Option.none(),
    scopes: ['user:joshborseth', 'org:example-org'],
  },
  accounts: [
    {
      login: 'joshborseth',
      token: 'Ok',
      maybeCore: Option.some({ remaining: 4497, limit: 5000, resetsAt: 0 }),
      maybeGraphql: Option.some({ remaining: 4864, limit: 5000, resetsAt: 0 }),
    },
  ],
  maybeLastMergeAt: Option.some(70_000),
  maybeLastFlashAt: Option.none(),
  overall: 'Healthy',
  checks: [
    {
      id: 'polling',
      label: 'GitHub polling',
      level: 'Ok',
      detail: 'Last good poll 5s ago.',
    },
    {
      id: 'broker',
      label: 'MQTT broker',
      level: 'Failing',
      detail: 'Not connected, so lights cannot flash.',
    },
  ],
  activity: [
    { at: 70_000, kind: 'Merge', text: 'a/b#1 merged by joshborseth.' },
  ],
}

const base: Model = {
  tab: 'Lights',
  tabs: Tabs.init({ id: 'app-tabs' }),
  automations: Automations.init,
  connection: Connection.Connected(),
  startup: Startup.Ready(),
  isBridgeOnline: true,
  lights: [],
  groups: [
    { name: 'All Lights', memberAddresses: [] },
    { name: 'Bedroom', memberAddresses: [] },
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
}

const onAutomations = (automations: Automations.Model): Model => ({
  ...base,
  tab: 'Automations',
  automations,
})

const loaded = onAutomations({
  ...Automations.init,
  remote: Automations.Remote.Loaded({ snapshot }),
})

const withMode = (mode: WatcherMode): Model =>
  onAutomations({
    ...Automations.init,
    remote: Automations.Remote.Loaded({
      snapshot: { ...snapshot, mode },
    }),
  })

describe('tabs', () => {
  test('starts on Lights and switches to Automations', () => {
    scene(
      { update, view },
      given(base),
      expect(role('tab', { name: 'Lights' })).toHaveAttr(
        'aria-selected',
        'true',
      ),
      expect(text('Loading automations…')).not.toExist(),
      click(role('tab', { name: 'Automations' })),
      Command.resolve(Tabs.FocusTab, Tabs.Message.CompletedFocusTab()),
      expect(text('Loading automations…')).toExist(),
    )
  })
})

describe('Automations panel', () => {
  test('says when the service cannot be reached', () => {
    scene(
      { update, view },
      given(
        onAutomations({
          ...Automations.init,
          remote: Automations.Remote.Unreachable({ reason: 'no answer' }),
        }),
      ),
      expect(role('alert')).toHaveText('Service unreachable: no answer.'),
    )
  })

  test('shows status, health checks, rate limits, and activity', () => {
    scene(
      { update, view },
      given(loaded),
      expect(role('status', { name: 'Automation health' })).toHaveText(
        'Healthy',
      ),
      expect(text('Watching. The next merge will flash the lights.')).toExist(),
      expect(text('Not connected, so lights cannot flash.')).toExist(),
      expect(text('joshborseth: 4497 / 5000, 4864 / 5000')).toExist(),
      expect(text('a/b#1 merged by joshborseth.')).toExist(),
      expect(text('Watching: user:joshborseth, org:example-org')).toExist(),
    )
  })

  test('does not show a stale Healthy when the service stops answering', () => {
    scene(
      { update, view },
      given({
        ...loaded,
        automations: {
          ...loaded.automations,
          maybeUnreachableReason: Option.some('no answer'),
        },
      }),
      expect(role('status', { name: 'Automation health' })).toHaveText(
        'Not responding',
      ),
      expect(role('alert')).toHaveText(
        'Service not responding: no answer. Showing the last status it reported.',
      ),
    )
  })

  test('the switch turns the automation off', () => {
    const action = Automations.Action.SetEnabled({ isEnabled: false })
    scene(
      { update, view },
      given(loaded),
      click(role('switch', { name: 'PR merge lights automation' })),
      Command.expectExact(Automations.RunAction({ action })),
      Command.resolve(
        Automations.RunAction,
        Automations.Message.SucceededRunAction({
          snapshot: { ...snapshot, mode: WatcherMode.Off(), overall: 'Off' },
        }),
      ),
      expect(role('status', { name: 'Automation health' })).toHaveText('Off'),
    )
  })

  test('test flash goes through the service', () => {
    const action = Automations.Action.TestFlash()
    scene(
      { update, view },
      given(loaded),
      click(role('button', { name: 'Test flash' })),
      Command.expectExact(Automations.RunAction({ action })),
      expect(role('button', { name: 'Flashing…' })).toBeDisabled(),
      Command.resolve(
        Automations.RunAction,
        Automations.Message.SucceededRunAction({ snapshot }),
      ),
    )
  })

  test('pause offers durations, and paused offers resume', () => {
    const action = Automations.Action.Pause({ minutes: 60 })
    scene(
      { update, view },
      given(loaded),
      click(role('button', { name: 'Pause for 1 hour' })),
      Command.expectExact(Automations.RunAction({ action })),
      Command.resolve(
        Automations.RunAction,
        Automations.Message.SucceededRunAction({ snapshot }),
      ),
    )
    scene(
      { update, view },
      given(withMode(WatcherMode.Paused({ until: 200_000 }))),
      expect(role('button', { name: 'Resume now' })).toExist(),
      expect(role('button', { name: 'Pause for 1 hour' })).not.toExist(),
    )
  })

  test('save appears only after an edit, and blocks an unsafe flash speed', () => {
    scene(
      { update, view },
      given(loaded),
      expect(role('button', { name: 'Save settings' })).not.toExist(),
      type(label('On time (ms)'), '100'),
      expect(role('alert')).toHaveText(
        'On time must be a whole number from 400 to 10000.',
      ),
      expect(role('button', { name: 'Save settings' })).toBeDisabled(),
      click(role('button', { name: 'Discard' })),
      expect(role('button', { name: 'Save settings' })).not.toExist(),
    )
  })

  test('saves an edited poll interval', () => {
    const draft = {
      ...DEFAULT_CONFIG,
      polling: { ...DEFAULT_CONFIG.polling, intervalSeconds: 30 },
    }
    scene(
      { update, view },
      given(loaded),
      type(label('Poll every (seconds)'), '30'),
      click(role('button', { name: 'Save settings' })),
      Command.expectExact(Automations.SaveDraft({ draft })),
      Command.resolve(
        Automations.SaveDraft,
        Automations.Message.SucceededSaveDraft({
          snapshot: { ...snapshot, config: draft },
        }),
      ),
      expect(label('Poll every (seconds)')).toHaveValue('30'),
    )
  })

  test('each schedule day can be turned off and edited', () => {
    scene(
      { update, view },
      given(loaded),
      expect(role('switch', { name: 'Flash on Saturday' })).toHaveAttr(
        'aria-checked',
        'false',
      ),
      click(role('switch', { name: 'Flash on Monday' })),
      expect(role('switch', { name: 'Flash on Monday' })).toHaveAttr(
        'aria-checked',
        'false',
      ),
    )
  })

  test('the group list comes from Zigbee2MQTT', () => {
    scene(
      { update, view },
      given(loaded),
      expect(role('option', { name: 'Bedroom' })).toExist(),
    )
  })
})
