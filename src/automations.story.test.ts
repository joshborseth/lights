import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import {
  DEFAULT_CONFIG,
  type PrMergeConfig,
  type Snapshot,
  WatcherMode,
} from './automation'
import {
  Action,
  FetchMusic,
  FetchScreenColors,
  FetchSnapshot,
  Message,
  type Model,
  MusicRemote,
  Remote,
  RunAction,
  SaveDraft,
  SaveMusic,
  SaveScreenColors,
  SaveState,
  Screen,
  ScreenRemote,
  init,
  update,
} from './automations'
import { DEFAULT_MUSIC_CONFIG, type MusicSnapshot } from './music'
import { DEFAULT_SCREEN_CONFIG, type ScreenSnapshot } from './screen'

const snapshot: Snapshot = {
  generatedAt: 10_000,
  startedAt: 1000,
  config: DEFAULT_CONFIG,
  mode: WatcherMode.Watching({ isScheduleOpen: true }),
  heldMerges: 0,
  poll: {
    maybeLastStartedAt: Option.some(9000),
    maybeLastSucceededAt: Option.some(9000),
    maybeLastDurationMs: Option.some(120),
    consecutiveFailures: 0,
    maybeLastError: Option.none(),
    maybePartialError: Option.none(),
    scopes: ['user:joshborseth'],
  },
  accounts: [],
  maybeLastMergeAt: Option.none(),
  maybeLastFlashAt: Option.none(),
  overall: 'Healthy',
  checks: [],
  activity: [],
}

const loaded: Model = {
  ...init,
  remote: Remote.Loaded({ snapshot }),
}

const music: MusicSnapshot = {
  generatedAt: 10_000,
  config: DEFAULT_MUSIC_CONFIG,
  connection: 'Connected',
  maybeSong: Option.none(),
  maybeLastApplied: Option.none(),
  maybeLastSkip: Option.none(),
}

const musicLoaded: Model = {
  ...loaded,
  music: MusicRemote.Loaded({ snapshot: music }),
}

const screenColors: ScreenSnapshot = {
  generatedAt: 10_000,
  config: DEFAULT_SCREEN_CONFIG,
  connection: 'Off',
  maybeShow: Option.none(),
  maybeLastApplied: Option.none(),
  maybeLastSkip: Option.none(),
}

const screenLoaded: Model = {
  ...loaded,
  screenColors: ScreenRemote.Loaded({ snapshot: screenColors }),
}

const editedDraft: PrMergeConfig = {
  ...DEFAULT_CONFIG,
  flash: { ...DEFAULT_CONFIG.flash, count: 2 },
}

describe('Automations update', () => {
  test('a refresh tick fetches the latest status', () => {
    story(
      update,
      given(init),
      message(Message.TickedRefresh()),
      Command.expectHas(FetchSnapshot),
      Command.resolve(
        FetchSnapshot,
        Message.SucceededFetchSnapshot({ snapshot }),
      ),
      Command.resolve(
        FetchMusic,
        Message.SucceededFetchMusic({ snapshot: music }),
      ),
      Command.resolve(
        FetchScreenColors,
        Message.SucceededFetchScreenColors({ snapshot: screenColors }),
      ),
      model(current => {
        expect(current.remote._tag).toBe('Loaded')
        expect(current.music._tag).toBe('Loaded')
        expect(current.screenColors._tag).toBe('Loaded')
      }),
    )
  })

  test('shows the service as unreachable before the first answer', () => {
    story(
      update,
      given(init),
      message(Message.FailedFetchSnapshot({ error: 'no answer' })),
      model(current => {
        expect(current.remote).toEqual(
          Remote.Unreachable({ reason: 'no answer' }),
        )
      }),
    )
  })

  test('keeps the last status when a later refresh fails', () => {
    story(
      update,
      given(loaded),
      message(Message.FailedFetchSnapshot({ error: 'no answer' })),
      model(current => {
        expect(current.remote._tag).toBe('Loaded')
        expect(current.maybeUnreachableReason).toEqual(Option.some('no answer'))
      }),
    )
  })

  test('clears the warning once the service answers again', () => {
    story(
      update,
      given({ ...loaded, maybeUnreachableReason: Option.some('no answer') }),
      message(Message.SucceededFetchSnapshot({ snapshot })),
      model(current => {
        expect(Option.isNone(current.maybeUnreachableReason)).toBe(true)
      }),
    )
  })

  test('a refresh does not discard unsaved edits', () => {
    story(
      update,
      given({ ...loaded, maybeDraft: Option.some(editedDraft) }),
      message(Message.SucceededFetchSnapshot({ snapshot })),
      model(current => {
        expect(current.maybeDraft).toEqual(Option.some(editedDraft))
      }),
    )
  })

  test('runs an action and shows the result', () => {
    const action = Action.TestFlash()
    story(
      update,
      given(loaded),
      message(Message.ClickedAction({ action })),
      Command.expectHas(RunAction({ action })),
      model(current => {
        expect(current.maybeRunningAction).toEqual(Option.some(action))
      }),
      Command.resolve(
        RunAction({ action }),
        Message.SucceededRunAction({ snapshot }),
      ),
      model(current => {
        expect(Option.isNone(current.maybeRunningAction)).toBe(true)
      }),
    )
  })

  test('runs one action at a time', () => {
    story(
      update,
      given({
        ...loaded,
        maybeRunningAction: Option.some(Action.TestFlash()),
      }),
      message(Message.ClickedAction({ action: Action.CheckNow() })),
      Command.expectNone(),
    )
  })

  test('shows why an action failed', () => {
    story(
      update,
      given({
        ...loaded,
        maybeRunningAction: Option.some(Action.TestFlash()),
      }),
      message(Message.FailedRunAction({ error: 'not connected to MQTT' })),
      model(current => {
        expect(current.maybeProblem).toEqual(
          Option.some("That didn't work: not connected to MQTT."),
        )
      }),
    )
  })

  test('saves valid edits and clears the draft', () => {
    story(
      update,
      given({ ...loaded, maybeDraft: Option.some(editedDraft) }),
      message(Message.SubmittedDraft()),
      Command.expectHas(SaveDraft({ draft: editedDraft })),
      model(current => {
        expect(current.saveState).toEqual(SaveState.Saving())
      }),
      Command.resolve(
        SaveDraft({ draft: editedDraft }),
        Message.SucceededSaveDraft({ snapshot }),
      ),
      model(current => {
        expect(Option.isNone(current.maybeDraft)).toBe(true)
        expect(current.saveState).toEqual(SaveState.Idle())
      }),
    )
  })

  test('does not submit invalid edits', () => {
    const invalid: PrMergeConfig = {
      ...DEFAULT_CONFIG,
      flash: { ...DEFAULT_CONFIG.flash, onMs: 10 },
    }
    story(
      update,
      given({ ...loaded, maybeDraft: Option.some(invalid) }),
      message(Message.SubmittedDraft()),
      Command.expectNone(),
      model(current => {
        expect(current.saveState).toEqual(SaveState.Idle())
      }),
    )
  })

  test('keeps edits when saving fails', () => {
    story(
      update,
      given({
        ...loaded,
        maybeDraft: Option.some(editedDraft),
        saveState: SaveState.Saving(),
      }),
      message(Message.FailedSaveDraft({ error: 'rejected' })),
      model(current => {
        expect(current.maybeDraft).toEqual(Option.some(editedDraft))
        expect(current.saveState).toEqual(
          SaveState.Failed({ reason: 'rejected' }),
        )
      }),
    )
  })

  test('discard drops the draft', () => {
    story(
      update,
      given({ ...loaded, maybeDraft: Option.some(editedDraft) }),
      message(Message.ClickedDiscardDraft()),
      model(current => {
        expect(Option.isNone(current.maybeDraft)).toBe(true)
      }),
    )
  })

  test('leaving a screen closes what it had revealed, and keeps edits', () => {
    story(
      update,
      given({
        ...loaded,
        screen: Screen.PrMerged({ maybeOpenSection: Option.some('Do') }),
        revealed: ['FlashDetails'],
        maybeDraft: Option.some(editedDraft),
      }),
      message(Message.SelectedScreen({ screen: Screen.List() })),
      model(current => {
        expect(current.screen).toEqual(Screen.List())
        expect(current.revealed).toEqual([])
        expect(current.maybeDraft).toEqual(Option.some(editedDraft))
      }),
    )
  })

  test('switching sections on a screen keeps what it has revealed', () => {
    story(
      update,
      given({
        ...loaded,
        screen: Screen.PrMerged({ maybeOpenSection: Option.some('Do') }),
        revealed: ['AllActivity'],
      }),
      message(
        Message.SelectedScreen({
          screen: Screen.PrMerged({ maybeOpenSection: Option.some('When') }),
        }),
      ),
      model(current => {
        expect(current.revealed).toEqual(['AllActivity'])
      }),
    )
  })

  test('same hours copies the first active day onto every day', () => {
    const mixed: PrMergeConfig = {
      ...DEFAULT_CONFIG,
      schedule: {
        ...DEFAULT_CONFIG.schedule,
        days: DEFAULT_CONFIG.schedule.days.map(window =>
          window.day === 'Tuesday' ? { ...window, start: '11:00' } : window,
        ),
      },
    }
    story(
      update,
      given({
        ...loaded,
        revealed: ['PerDayHours'],
        maybeDraft: Option.some(mixed),
      }),
      message(Message.ClickedUseSameHours()),
      model(current => {
        expect(current.revealed).toEqual([])
        expect(
          Option.map(current.maybeDraft, draft =>
            draft.schedule.days.every(window => window.start === '09:00'),
          ),
        ).toEqual(Option.some(true))
      }),
    )
  })

  test('adding entries splits commas, drops repeats, and clears the input', () => {
    story(
      update,
      given({ ...loaded, ignoredRepoEntry: 'a/b, c/d,a/b' }),
      message(Message.ClickedAddEntry({ list: 'IgnoredRepos' })),
      model(current => {
        expect(
          Option.map(current.maybeDraft, draft => draft.ignoredRepos),
        ).toEqual(Option.some(['a/b', 'c/d']))
        expect(current.ignoredRepoEntry).toBe('')
      }),
    )
  })

  test('an empty entry changes nothing', () => {
    story(
      update,
      given({ ...loaded, accountEntry: ' , ' }),
      message(Message.ClickedAddEntry({ list: 'Accounts' })),
      model(current => {
        expect(Option.isNone(current.maybeDraft)).toBe(true)
      }),
    )
  })
})

describe('Music colors update', () => {
  const enabled = { ...DEFAULT_MUSIC_CONFIG, isEnabled: true }

  test('a change shows at once and saves without the save bar', () => {
    story(
      update,
      given(musicLoaded),
      message(Message.ChangedMusicConfig({ config: enabled })),
      model(current => {
        expect(current.isSavingMusic).toBe(true)
        expect(Option.isNone(current.maybeDraft)).toBe(true)
        expect(
          MusicRemote.match(current.music, {
            Loading: () => false,
            Unavailable: () => false,
            Loaded: ({ snapshot }) => snapshot.config.isEnabled,
          }),
        ).toBe(true)
      }),
      Command.expectHas(SaveMusic),
      Command.resolve(
        SaveMusic,
        Message.SucceededSaveMusic({
          snapshot: { ...music, config: enabled },
        }),
      ),
      model(current => {
        expect(current.isSavingMusic).toBe(false)
      }),
    )
  })

  test('a refresh during a save does not undo the change', () => {
    story(
      update,
      given({ ...musicLoaded, isSavingMusic: true }),
      message(Message.TickedRefresh()),
      Command.expectHas(FetchSnapshot),
      Command.resolve(
        FetchSnapshot,
        Message.SucceededFetchSnapshot({ snapshot }),
      ),
      Command.resolve(
        FetchScreenColors,
        Message.SucceededFetchScreenColors({ snapshot: screenColors }),
      ),
      message(Message.SucceededFetchMusic({ snapshot: music })),
      model(current => {
        expect(current.isSavingMusic).toBe(true)
      }),
    )
  })

  test('a failed save says so and reloads the saved settings', () => {
    story(
      update,
      given(musicLoaded),
      message(Message.ChangedMusicConfig({ config: enabled })),
      Command.resolve(
        SaveMusic,
        Message.FailedSaveMusic({ error: 'no answer' }),
      ),
      model(current => {
        expect(current.isSavingMusic).toBe(false)
        expect(current.maybeProblem).toEqual(
          Option.some("Music colors weren't saved: no answer."),
        )
      }),
      Command.resolve(
        FetchMusic,
        Message.SucceededFetchMusic({ snapshot: music }),
      ),
      model(current => {
        expect(current.music).toEqual(MusicRemote.Loaded({ snapshot: music }))
      }),
    )
  })

  test('an older service without music colors shows it as unavailable', () => {
    story(
      update,
      given(loaded),
      message(Message.FailedFetchMusic({ error: 'Not found.' })),
      model(current => {
        expect(current.music).toEqual(
          MusicRemote.Unavailable({ reason: 'Not found.' }),
        )
      }),
    )
  })
})

describe('Screen colors update', () => {
  const enabled = { ...DEFAULT_SCREEN_CONFIG, isEnabled: true }

  test('a change shows at once and saves without the save bar', () => {
    story(
      update,
      given(screenLoaded),
      message(Message.ChangedScreenConfig({ config: enabled })),
      model(current => {
        expect(current.isSavingScreenColors).toBe(true)
        expect(
          ScreenRemote.match(current.screenColors, {
            Loaded: ({ snapshot: loadedSnapshot }) =>
              loadedSnapshot.config.isEnabled,
            Loading: () => false,
            Unavailable: () => false,
          }),
        ).toBe(true)
      }),
      Command.expectHas(SaveScreenColors),
      Command.resolve(
        SaveScreenColors,
        Message.SucceededSaveScreenColors({
          snapshot: {
            ...screenColors,
            config: enabled,
            connection: 'Connecting',
          },
        }),
      ),
      model(current => {
        expect(current.isSavingScreenColors).toBe(false)
      }),
    )
  })

  test('a refresh during a save fetches neither saving automation', () => {
    story(
      update,
      given({
        ...screenLoaded,
        isSavingScreenColors: true,
        isSavingMusic: true,
      }),
      message(Message.TickedRefresh()),
      Command.resolve(
        FetchSnapshot,
        Message.SucceededFetchSnapshot({ snapshot }),
      ),
      message(Message.SucceededFetchScreenColors({ snapshot: screenColors })),
      model(current => {
        expect(current.isSavingScreenColors).toBe(true)
      }),
    )
  })

  test('a failed save says so and reloads the saved settings', () => {
    story(
      update,
      given(screenLoaded),
      message(Message.ChangedScreenConfig({ config: enabled })),
      Command.resolve(
        SaveScreenColors,
        Message.FailedSaveScreenColors({ error: 'no answer' }),
      ),
      model(current => {
        expect(current.isSavingScreenColors).toBe(false)
        expect(current.maybeProblem).toEqual(
          Option.some("Screen colors weren't saved: no answer."),
        )
      }),
      Command.resolve(
        FetchScreenColors,
        Message.SucceededFetchScreenColors({ snapshot: screenColors }),
      ),
      model(current => {
        expect(current.screenColors).toEqual(
          ScreenRemote.Loaded({ snapshot: screenColors }),
        )
      }),
    )
  })

  test('an older service without screen colors shows it as unavailable', () => {
    story(
      update,
      given(loaded),
      message(Message.FailedFetchScreenColors({ error: 'Not found.' })),
      model(current => {
        expect(current.screenColors).toEqual(
          ScreenRemote.Unavailable({ reason: 'Not found.' }),
        )
      }),
    )
  })
})
