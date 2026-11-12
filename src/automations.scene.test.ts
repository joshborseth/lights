import { Option } from 'effect'
import {
  Command,
  change,
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

import { DEFAULT_CONFIG, type Snapshot, WatcherMode } from './automation'
import * as Automations from './automations'
import { Pairing } from './domain'
import { HouseFocus } from './house'
import {
  Connection,
  type Model,
  PageScroll,
  PresetEditor,
  Startup,
  update,
} from './main'
import * as Manage from './manage'
import { DEFAULT_MUSIC_CONFIG, type MusicSnapshot } from './music'
import { DEFAULT_SCREEN_CONFIG, type ScreenSnapshot } from './screen'
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
  screen: 'House',
  focus: HouseFocus.Overview(),
  automations: Automations.init,
  manage: Manage.init,
  connection: Connection.Connected(),
  startup: Startup.Ready(),
  isBridgeOnline: true,
  newDevices: [],
  pairing: Pairing.Closed(),
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
  maybeActiveSlider: Option.none(),
  pageScroll: PageScroll.Still(),
  presetEditor: PresetEditor.Closed(),
  maybeHouseFailure: Option.none(),
  maybeProblem: Option.none(),
}

const onAutomations = (automations: Automations.Model): Model => ({
  ...base,
  screen: 'Automations',
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

const healthyLoaded = onAutomations({
  ...Automations.init,
  remote: Automations.Remote.Loaded({
    snapshot: {
      ...snapshot,
      checks: [
        {
          id: 'polling',
          label: 'GitHub polling',
          level: 'Ok',
          detail: 'Last good poll 5s ago.',
        },
      ],
    },
  }),
})

const onScreen = (screen: Automations.Screen): Model => ({
  ...loaded,
  automations: { ...loaded.automations, screen },
})

const prMerged = (section: Automations.PrMergedSection): Model =>
  onScreen(
    Automations.Screen.PrMerged({ maybeOpenSection: Option.some(section) }),
  )

const connections = (section: Automations.ConnectionSection): Model =>
  onScreen(
    Automations.Screen.Connections({ maybeOpenSection: Option.some(section) }),
  )

const withActivity = (activity: Snapshot['activity']): Model => {
  const model = prMerged('When')
  return {
    ...model,
    automations: {
      ...model.automations,
      remote: Automations.Remote.Loaded({
        snapshot: { ...snapshot, activity },
      }),
    },
  }
}

describe('opening Automations', () => {
  test('starts on the house and opens as a page', () => {
    scene(
      { update, view },
      given(base),
      expect(text('Loading automations…')).not.toExist(),
      click(role('button', { name: 'Automations' })),
      expect(text('Loading automations…')).toExist(),
    )
  })
})

describe('Automations list', () => {
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

  test('shows one row per automation and hides its settings', () => {
    scene(
      { update, view },
      given(healthyLoaded),
      expect(role('button', { name: 'Open PR merged' })).toExist(),
      expect(text('Weekdays, 9 AM to 5 PM')).toExist(),
      expect(label('Poll every (seconds)')).not.toExist(),
      expect(text('Service started')).not.toExist(),
    )
  })

  test('puts a problem on the row', () => {
    scene(
      { update, view },
      given(loaded),
      expect(text('Not connected, so lights cannot flash.')).toExist(),
    )
  })

  test('says Not responding when the service stops answering', () => {
    scene(
      { update, view },
      given({
        ...healthyLoaded,
        automations: {
          ...healthyLoaded.automations,
          maybeUnreachableReason: Option.some('no answer'),
        },
      }),
      expect(text('Not responding')).toExist(),
      expect(role('alert')).toHaveText(
        'Service not responding: no answer. Showing the last status it reported.',
      ),
    )
  })

  test('the row switch turns the automation off', () => {
    const action = Automations.Action.SetEnabled({ isEnabled: false })
    scene(
      { update, view },
      given(loaded),
      click(role('switch', { name: 'PR merged' })),
      Command.expectExact(Automations.RunAction({ action })),
      Command.resolve(
        Automations.RunAction,
        Automations.Message.SucceededRunAction({
          snapshot: { ...snapshot, mode: WatcherMode.Off(), overall: 'Off' },
        }),
      ),
      expect(role('switch', { name: 'PR merged' })).toHaveAttr(
        'aria-checked',
        'false',
      ),
      expect(text('Off')).toExist(),
    )
  })

  test('opens a row and comes back', () => {
    scene(
      { update, view },
      given(loaded),
      click(role('button', { name: 'Open PR merged' })),
      expect(role('heading', { name: 'PR merged' })).toExist(),
      expect(text('Watching. The next merge will flash the lights.')).toExist(),
      click(role('button', { name: 'Automations' })),
      expect(role('button', { name: 'Open PR merged' })).toExist(),
    )
  })
})

describe('PR merged detail', () => {
  test('sections show their value and open one at a time', () => {
    scene(
      { update, view },
      given(
        onScreen(
          Automations.Screen.PrMerged({ maybeOpenSection: Option.none() }),
        ),
      ),
      expect(label('Flashes')).not.toExist(),
      click(
        role('button', {
          name: 'Do: Flash All Lights 4 times',
        }),
      ),
      expect(label('Flashes')).toExist(),
      click(
        role('button', {
          name: 'Only during: Weekdays, 9 AM to 5 PM',
        }),
      ),
      expect(label('Flashes')).not.toExist(),
      expect(label('Start time')).toExist(),
    )
  })

  test('Try it goes through the service', () => {
    const action = Automations.Action.TestFlash()
    scene(
      { update, view },
      given(prMerged('When')),
      click(role('button', { name: 'Try it' })),
      Command.expectExact(Automations.RunAction({ action })),
      expect(role('button', { name: 'Flashing…' })).toBeDisabled(),
      Command.resolve(
        Automations.RunAction,
        Automations.Message.SucceededRunAction({ snapshot }),
      ),
    )
  })

  test('pause tucks durations away, and paused offers resume', () => {
    const action = Automations.Action.Pause({ minutes: 60 })
    scene(
      { update, view },
      given(prMerged('When')),
      expect(role('button', { name: 'Pause for 1 hour' })).not.toExist(),
      click(role('button', { name: 'Pause' })),
      click(role('button', { name: 'Pause for 1 hour' })),
      Command.expectExact(Automations.RunAction({ action })),
      Command.resolve(
        Automations.RunAction,
        Automations.Message.SucceededRunAction({ snapshot }),
      ),
    )
    const paused = withMode(WatcherMode.Paused({ until: 200_000 }))
    scene(
      { update, view },
      given({
        ...paused,
        automations: {
          ...paused.automations,
          screen: Automations.Screen.PrMerged({
            maybeOpenSection: Option.none(),
          }),
        },
      }),
      expect(role('button', { name: 'Resume now' })).toExist(),
      expect(role('button', { name: 'Pause' })).not.toExist(),
    )
  })

  test('save appears only after an edit, and blocks an unsafe flash speed', () => {
    scene(
      { update, view },
      given(prMerged('Do')),
      expect(role('button', { name: 'Save settings' })).not.toExist(),
      click(
        role('button', {
          name: 'Fine-tune brightness, timing, and restore options',
        }),
      ),
      type(label('On time (ms)'), '100'),
      expect(role('alert')).toHaveText(
        'On time must be a whole number from 400 to 10000.',
      ),
      expect(role('button', { name: 'Save settings' })).toBeDisabled(),
      click(role('button', { name: 'Discard' })),
      expect(role('button', { name: 'Save settings' })).not.toExist(),
    )
  })

  test('a speed choice sets both flash timings', () => {
    const draft = {
      ...DEFAULT_CONFIG,
      flash: { ...DEFAULT_CONFIG.flash, onMs: 400, offMs: 400 },
    }
    scene(
      { update, view },
      given(prMerged('Do')),
      expect(role('radio', { name: 'Normal' })).toHaveAttr(
        'aria-checked',
        'true',
      ),
      click(role('radio', { name: 'Fast' })),
      click(role('button', { name: 'Save settings' })),
      Command.expectExact(Automations.SaveDraft({ draft })),
      Command.resolve(
        Automations.SaveDraft,
        Automations.Message.SucceededSaveDraft({
          snapshot: { ...snapshot, config: draft },
        }),
      ),
    )
  })

  test('unsaved edits stay on screen after going back', () => {
    scene(
      { update, view },
      given(prMerged('Do')),
      click(role('radio', { name: 'Fast' })),
      click(role('button', { name: 'Automations' })),
      expect(role('button', { name: 'Open PR merged' })).toExist(),
      expect(role('button', { name: 'Save settings' })).toExist(),
    )
  })

  test('day chips turn days on and off', () => {
    scene(
      { update, view },
      given(prMerged('OnlyDuring')),
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

  test('hours can be set per day', () => {
    scene(
      { update, view },
      given(prMerged('OnlyDuring')),
      expect(label('Monday start')).not.toExist(),
      click(role('button', { name: 'Set different hours per day' })),
      expect(label('Monday start')).toExist(),
      click(role('button', { name: 'Use the same hours every day' })),
      expect(label('Monday start')).not.toExist(),
      expect(role('button', { name: 'Save settings' })).not.toExist(),
    )
  })

  test('accounts are added and removed as chips', () => {
    const draft = { ...DEFAULT_CONFIG, accounts: ['joshborseth', 'octocat'] }
    scene(
      { update, view },
      given(prMerged('When')),
      click(role('button', { name: 'Remove hubot' })),
      type(label('Add to GitHub accounts'), 'octocat'),
      click(role('button', { name: 'Add GitHub accounts' })),
      click(role('button', { name: 'Save settings' })),
      Command.expectExact(Automations.SaveDraft({ draft })),
      Command.resolve(
        Automations.SaveDraft,
        Automations.Message.SucceededSaveDraft({
          snapshot: { ...snapshot, config: draft },
        }),
      ),
    )
  })

  test('the group list comes from Zigbee2MQTT', () => {
    scene(
      { update, view },
      given(prMerged('Do')),
      expect(role('option', { name: 'Bedroom' })).toExist(),
    )
  })

  test('shows three activity rows until asked for all', () => {
    const entry = (at: number) => ({
      at,
      kind: 'Merge' as const,
      text: `a/b#${at} merged.`,
    })
    scene(
      { update, view },
      given(withActivity([entry(4), entry(3), entry(2), entry(1)])),
      expect(text('a/b#2 merged.')).toExist(),
      expect(text('a/b#1 merged.')).not.toExist(),
      click(role('button', { name: 'See all activity' })),
      expect(text('a/b#1 merged.')).toExist(),
    )
  })
})

describe('Connections', () => {
  test('shows health, checks, and rate limits', () => {
    scene(
      { update, view },
      given(connections('GitHub')),
      expect(role('status', { name: 'Automation health' })).toHaveText(
        'Healthy',
      ),
      expect(text('joshborseth: 4497 / 5000, 4864 / 5000')).toExist(),
      click(
        role('button', {
          name: 'Lights: Not connected, so lights cannot flash.',
        }),
      ),
      expect(text('MQTT broker')).toExist(),
    )
  })

  test('does not show a stale Healthy when the service stops answering', () => {
    const model = connections('GitHub')
    scene(
      { update, view },
      given({
        ...model,
        automations: {
          ...model.automations,
          maybeUnreachableReason: Option.some('no answer'),
        },
      }),
      expect(role('status', { name: 'Automation health' })).toHaveText(
        'Not responding',
      ),
    )
  })

  test('restart lives under Service', () => {
    const action = Automations.Action.Restart()
    scene(
      { update, view },
      given(connections('Service')),
      click(role('button', { name: 'Restart service' })),
      Command.expectExact(Automations.RunAction({ action })),
      Command.resolve(
        Automations.RunAction,
        Automations.Message.SucceededRunAction({ snapshot }),
      ),
    )
  })

  test('saves an edited poll interval from the advanced options', () => {
    const draft = {
      ...DEFAULT_CONFIG,
      polling: { ...DEFAULT_CONFIG.polling, intervalSeconds: 30 },
    }
    scene(
      { update, view },
      given(connections('GitHub')),
      expect(label('Poll every (seconds)')).not.toExist(),
      click(role('button', { name: 'Advanced polling and health limits' })),
      expect(text('Watching: user:joshborseth, org:example-org')).toExist(),
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
})

const music: MusicSnapshot = {
  generatedAt: 100_000,
  config: { ...DEFAULT_MUSIC_CONFIG, isEnabled: true, group: 'Bedroom' },
  connection: 'Connected',
  maybeSong: Option.some({
    title: 'Nevermind',
    artists: 'Nirvana',
    isPlaying: true,
    isOnTv: true,
    maybeColor: Option.some('#1281b6'),
  }),
  maybeLastApplied: Option.some({
    at: 40_000,
    title: 'Nevermind',
    color: '#0091ff',
    lights: 3,
  }),
  maybeLastSkip: Option.none(),
  maybeShow: Option.none(),
}

const withMusic = (
  snapshotValue: MusicSnapshot,
  screen: Automations.Screen = Automations.Screen.List(),
): Model => ({
  ...loaded,
  automations: {
    ...loaded.automations,
    screen,
    music: Automations.MusicRemote.Loaded({ snapshot: snapshotValue }),
  },
})

describe('Music colors', () => {
  test('lists the automation with the last song it followed', () => {
    scene(
      { update, view },
      given(withMusic(music)),
      expect(role('button', { name: 'Open Music colors' })).toExist(),
      expect(text('Nevermind · 1m ago')).toExist(),
      expect(role('switch', { name: 'Music colors' })).toBeChecked(),
    )
  })

  test('says Off on the row when it is off', () => {
    scene(
      { update, view },
      given(
        withMusic({
          ...music,
          config: { ...music.config, isEnabled: false },
        }),
      ),
      expect(role('switch', { name: 'Music colors' })).not.toBeChecked(),
      expect(text('Off')).toExist(),
    )
  })

  test('opens to what is playing, what changed, and its settings', () => {
    scene(
      { update, view },
      given(withMusic(music)),
      click(role('button', { name: 'Open Music colors' })),
      expect(role('heading', { name: 'Music colors' })).toExist(),
      expect(text('Listening to the music app')).toExist(),
      expect(text('Nevermind · Nirvana · on the TV')).toExist(),
      expect(text('Lights changed 1m ago')).toExist(),
      expect(text('Nevermind on 3 lights')).toExist(),
      expect(role('combobox')).toHaveValue('Bedroom'),
      expect(role('switch', { name: 'Only on the TV' })).toExist(),
      expect(role('switch', { name: 'Mix colors' })).not.toExist(),
    )
  })

  test('a setting saves as soon as it changes', () => {
    scene(
      { update, view },
      given(withMusic(music, Automations.Screen.Music())),
      click(role('switch', { name: 'Only on the TV' })),
      Command.expectHas(Automations.SaveMusic),
      expect(role('switch', { name: 'Only on the TV' })).toBeDisabled(),
      Command.resolve(
        Automations.SaveMusic,
        Automations.Message.SucceededSaveMusic({
          snapshot: {
            ...music,
            config: { ...music.config, onlyOnTv: false },
          },
        }),
      ),
      expect(role('switch', { name: 'Only on the TV' })).not.toBeChecked(),
    )
  })

  test('says why the latest song left the lights alone', () => {
    scene(
      { update, view },
      given(
        withMusic(
          {
            ...music,
            maybeLastApplied: Option.none(),
            maybeLastSkip: Option.some('No lights in Bedroom were on.'),
          },
          Automations.Screen.Music(),
        ),
      ),
      expect(text('Left alone: No lights in Bedroom were on.')).toExist(),
    )
  })

  test('offers the light show, off until turned on', () => {
    scene(
      { update, view },
      given(withMusic(music, Automations.Screen.Music())),
      expect(role('switch', { name: 'Light show' })).not.toBeChecked(),
      expect(role('combobox', { name: 'Timing' })).not.toExist(),
      click(role('switch', { name: 'Light show' })),
      Command.expectHas(Automations.SaveMusic),
      Command.resolve(
        Automations.SaveMusic,
        Automations.Message.SucceededSaveMusic({
          snapshot: { ...music, config: { ...music.config, isShowOn: true } },
        }),
      ),
      expect(role('switch', { name: 'Light show' })).toBeChecked(),
      expect(text('Starts when a song plays.')).toExist(),
      expect(role('combobox', { name: 'Timing' })).toHaveValue('0'),
    )
  })

  test('shows what the light show is doing, and saves its timing', () => {
    const showing: MusicSnapshot = {
      ...music,
      config: { ...music.config, isShowOn: true },
      maybeShow: Option.some('Following the beat at 128 BPM · Chorus'),
    }
    scene(
      { update, view },
      given(withMusic(showing, Automations.Screen.Music())),
      expect(text('Following the beat at 128 BPM · Chorus')).toExist(),
      change(role('combobox', { name: 'Timing' }), '-100'),
      Command.expectHas(Automations.SaveMusic),
      Command.resolve(
        Automations.SaveMusic,
        Automations.Message.SucceededSaveMusic({
          snapshot: {
            ...showing,
            config: { ...showing.config, showOffsetMs: -100 },
          },
        }),
      ),
      expect(role('combobox', { name: 'Timing' })).toHaveValue('-100'),
      expect(text('100 ms earlier')).toExist(),
    )
  })

  test('says when the music app cannot be reached', () => {
    scene(
      { update, view },
      given(withMusic({ ...music, connection: 'Unreachable' })),
      expect(text("Can't reach the music app")).toExist(),
    )
  })
})

const screenColors: ScreenSnapshot = {
  generatedAt: 100_000,
  config: { ...DEFAULT_SCREEN_CONFIG, isEnabled: true, group: 'Living Room' },
  connection: 'Connected',
  maybeShow: Option.some({
    title: 'Dune: Part Two',
    isPlaying: true,
    maybeColor: Option.some('#c8742f'),
  }),
  maybeLastApplied: Option.some({
    at: 70_000,
    title: 'Dune: Part Two',
    color: '#ff8a1f',
    lights: 2,
  }),
  maybeLastSkip: Option.none(),
}

const withScreenColors = (
  snapshotValue: ScreenSnapshot,
  screen: Automations.Screen = Automations.Screen.List(),
): Model => ({
  ...loaded,
  automations: {
    ...loaded.automations,
    screen,
    screenColors: Automations.ScreenRemote.Loaded({ snapshot: snapshotValue }),
  },
})

describe('Screen colors', () => {
  test('lists the automation with the last show it followed', () => {
    scene(
      { update, view },
      given(withScreenColors(screenColors)),
      expect(role('button', { name: 'Open Screen colors' })).toExist(),
      expect(text('Dune: Part Two · 30s ago')).toExist(),
      expect(role('switch', { name: 'Screen colors' })).toBeChecked(),
    )
  })

  test('says Off on the row when it is off', () => {
    scene(
      { update, view },
      given(
        withScreenColors({
          ...screenColors,
          config: { ...screenColors.config, isEnabled: false },
          connection: 'Off',
        }),
      ),
      expect(role('switch', { name: 'Screen colors' })).not.toBeChecked(),
      expect(text('Off')).toExist(),
    )
  })

  test('opens to what is playing, what changed, and its settings', () => {
    scene(
      { update, view },
      given(withScreenColors(screenColors)),
      click(role('button', { name: 'Open Screen colors' })),
      expect(role('heading', { name: 'Screen colors' })).toExist(),
      expect(text('Listening to Joshflix')).toExist(),
      expect(text('Dune: Part Two')).toExist(),
      expect(text('Lights changed 30s ago')).toExist(),
      expect(text('Dune: Part Two on 2 lights')).toExist(),
      expect(role('combobox')).toHaveValue('Living Room'),
    )
  })

  test('turning it off saves at once', () => {
    scene(
      { update, view },
      given(withScreenColors(screenColors, Automations.Screen.ScreenColors())),
      click(role('switch', { name: 'Screen colors' })),
      Command.expectHas(Automations.SaveScreenColors),
      expect(role('switch', { name: 'Screen colors' })).toBeDisabled(),
      Command.resolve(
        Automations.SaveScreenColors,
        Automations.Message.SucceededSaveScreenColors({
          snapshot: {
            ...screenColors,
            config: { ...screenColors.config, isEnabled: false },
            connection: 'Off',
          },
        }),
      ),
      expect(role('switch', { name: 'Screen colors' })).not.toBeChecked(),
      expect(text('Not listening to Joshflix')).toExist(),
    )
  })

  test('says when a film is paused', () => {
    scene(
      { update, view },
      given(
        withScreenColors(
          {
            ...screenColors,
            maybeShow: Option.some({
              title: 'Dune: Part Two',
              isPlaying: false,
              maybeColor: Option.none(),
            }),
          },
          Automations.Screen.ScreenColors(),
        ),
      ),
      expect(text('Dune: Part Two (paused)')).toExist(),
    )
  })

  test('says when Joshflix cannot be reached', () => {
    scene(
      { update, view },
      given(withScreenColors({ ...screenColors, connection: 'Unreachable' })),
      expect(text("Can't reach Joshflix")).toExist(),
    )
  })
})
