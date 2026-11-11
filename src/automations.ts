import {
  Array,
  Duration,
  Effect,
  Match,
  Option,
  Schema,
  Stream,
  String,
  pipe,
} from 'effect'
import { Command, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import {
  AUTOMATION_API_PATH,
  PrMergeConfig,
  ServiceFailure,
  Snapshot,
  SnapshotValue,
  configProblem,
  hasSameHours,
  normalizeConfig,
  sharedHours,
  withSameHours,
} from './automation'
import {
  MUSIC_API_PATH,
  MusicConfig,
  MusicSnapshot,
  MusicSnapshotValue,
} from './music'

// MODEL

export const Remote = defineTaggedUnion({
  Loading: {},
  Unreachable: { reason: Schema.String },
  Loaded: { snapshot: SnapshotValue },
})
export type Remote = typeof Remote.Type

export const MusicRemote = defineTaggedUnion({
  Loading: {},
  Unavailable: { reason: Schema.String },
  Loaded: { snapshot: MusicSnapshotValue },
})
export type MusicRemote = typeof MusicRemote.Type

export const SaveState = defineTaggedUnion({
  Idle: {},
  Saving: {},
  Failed: { reason: Schema.String },
})
export type SaveState = typeof SaveState.Type

export const Action = defineTaggedUnion({
  SetEnabled: { isEnabled: Schema.Boolean },
  Pause: { minutes: Schema.Number },
  Resume: {},
  TestFlash: {},
  CheckNow: {},
  Restart: {},
})
export type Action = typeof Action.Type

export const PrMergedSection = Schema.Literals([
  'Pause',
  'When',
  'OnlyDuring',
  'Do',
])
export type PrMergedSection = typeof PrMergedSection.Type

export const ConnectionSection = Schema.Literals([
  'GitHub',
  'Lights',
  'Service',
])
export type ConnectionSection = typeof ConnectionSection.Type

export const Screen = defineTaggedUnion({
  List: {},
  PrMerged: { maybeOpenSection: Schema.Option(PrMergedSection) },
  Connections: { maybeOpenSection: Schema.Option(ConnectionSection) },
  Music: {},
})
export type Screen = typeof Screen.Type

export const Reveal = Schema.Literals([
  'PerDayHours',
  'TimeZone',
  'FlashDetails',
  'GitHubDetails',
  'AllActivity',
])
export type Reveal = typeof Reveal.Type

export const EntryList = Schema.Literals(['Accounts', 'IgnoredRepos'])
export type EntryList = typeof EntryList.Type

export const Model = Schema.Struct({
  remote: Remote,
  screen: Screen,
  revealed: Schema.Array(Reveal),
  accountEntry: Schema.String,
  ignoredRepoEntry: Schema.String,
  maybeDraft: Schema.Option(PrMergeConfig),
  saveState: SaveState,
  maybeRunningAction: Schema.Option(Action),
  maybeProblem: Schema.Option(Schema.String),
  maybeUnreachableReason: Schema.Option(Schema.String),
  music: MusicRemote,
  isSavingMusic: Schema.Boolean,
})
export type Model = typeof Model.Type

export const init: Model = {
  remote: Remote.Loading(),
  screen: Screen.List(),
  revealed: [],
  accountEntry: '',
  ignoredRepoEntry: '',
  maybeDraft: Option.none(),
  saveState: SaveState.Idle(),
  maybeRunningAction: Option.none(),
  maybeProblem: Option.none(),
  maybeUnreachableReason: Option.none(),
  music: MusicRemote.Loading(),
  isSavingMusic: false,
}

// MESSAGE

export const Message = defineMessageUnion({
  SelectedScreen: { screen: Screen },
  ClickedReveal: { reveal: Reveal },
  ClickedUseSameHours: {},
  UpdatedEntry: { list: EntryList, value: Schema.String },
  ClickedAddEntry: { list: EntryList },
  TickedRefresh: {},
  SucceededFetchSnapshot: { snapshot: SnapshotValue },
  FailedFetchSnapshot: { error: Schema.String },
  ClickedAction: { action: Action },
  SucceededRunAction: { snapshot: SnapshotValue },
  FailedRunAction: { error: Schema.String },
  UpdatedDraft: { draft: PrMergeConfig },
  ClickedDiscardDraft: {},
  SubmittedDraft: {},
  SucceededSaveDraft: { snapshot: SnapshotValue },
  FailedSaveDraft: { error: Schema.String },
  CompletedFollowGroupRename: { maybeSnapshot: Schema.Option(SnapshotValue) },
  FailedFollowGroupRename: { error: Schema.String },
  SucceededFetchMusic: { snapshot: MusicSnapshotValue },
  FailedFetchMusic: { error: Schema.String },
  ChangedMusicConfig: { config: MusicConfig },
  SucceededSaveMusic: { snapshot: MusicSnapshotValue },
  FailedSaveMusic: { error: Schema.String },
})
export type Message = typeof Message.Type

// COMMAND

const decodeSnapshot = Schema.decodeUnknownEffect(Snapshot)
const decodeFailure = Schema.decodeUnknownOption(ServiceFailure)

const requestSnapshot = (
  path: string,
  init: RequestInit,
): Effect.Effect<typeof SnapshotValue.Type, string> =>
  requestDecoded(`${AUTOMATION_API_PATH}${path}`, init, decodeSnapshot)

const decodeMusicSnapshot = Schema.decodeUnknownEffect(MusicSnapshot)

const requestMusic = (
  path: string,
  init: RequestInit,
): Effect.Effect<typeof MusicSnapshotValue.Type, string> =>
  requestDecoded(`${MUSIC_API_PATH}${path}`, init, decodeMusicSnapshot)

const requestDecoded = <A, E>(
  url: string,
  init: RequestInit,
  decode: (body: unknown) => Effect.Effect<A, E>,
): Effect.Effect<A, string> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: signal => fetch(url, { ...init, signal }),
      catch: () => 'the automations service is not responding',
    })
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => 'the automations service sent an unreadable answer',
    })
    if (!response.ok) {
      return yield* Effect.fail(
        Option.match(decodeFailure(body), {
          onNone: () => `the automations service answered ${response.status}`,
          onSome: failure => failure.error,
        }),
      )
    }
    return yield* decode(body).pipe(
      Effect.mapError(
        () => 'the automations service sent an unreadable answer',
      ),
    )
  })

const sendJson = (method: string, path: string, body: unknown) =>
  requestSnapshot(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

export const FetchSnapshot = Command.define('FetchSnapshot', {
  messages: [Message.SucceededFetchSnapshot, Message.FailedFetchSnapshot],
  execute: requestSnapshot('', {}).pipe(
    Effect.map(snapshot => Message.SucceededFetchSnapshot({ snapshot })),
    Effect.catch(error =>
      Effect.succeed(Message.FailedFetchSnapshot({ error })),
    ),
  ),
})

const runAction = (action: Action) =>
  Action.match(action, {
    SetEnabled: ({ isEnabled }) => sendJson('POST', '/enabled', { isEnabled }),
    Pause: ({ minutes }) => sendJson('POST', '/pause', { minutes }),
    Resume: () => sendJson('POST', '/resume', {}),
    TestFlash: () => sendJson('POST', '/test-flash', {}),
    CheckNow: () => sendJson('POST', '/check-now', {}),
    Restart: () => sendJson('POST', '/restart', {}),
  })

export const RunAction = Command.define('RunAction', {
  args: { action: Action },
  messages: [Message.SucceededRunAction, Message.FailedRunAction],
  execute: ({ action }) =>
    runAction(action).pipe(
      Effect.map(snapshot => Message.SucceededRunAction({ snapshot })),
      Effect.catch(error => Effect.succeed(Message.FailedRunAction({ error }))),
    ),
})

export const SaveDraft = Command.define('SaveDraft', {
  args: { draft: PrMergeConfig },
  messages: [Message.SucceededSaveDraft, Message.FailedSaveDraft],
  execute: ({ draft }) =>
    sendJson('PUT', '/config', draft).pipe(
      Effect.map(snapshot => Message.SucceededSaveDraft({ snapshot })),
      Effect.catch(error => Effect.succeed(Message.FailedSaveDraft({ error }))),
    ),
})

export const FetchMusic = Command.define('FetchMusic', {
  messages: [Message.SucceededFetchMusic, Message.FailedFetchMusic],
  execute: requestMusic('', {}).pipe(
    Effect.map(snapshot => Message.SucceededFetchMusic({ snapshot })),
    Effect.catch(error => Effect.succeed(Message.FailedFetchMusic({ error }))),
  ),
})

const putMusicConfig = (config: MusicConfig) =>
  requestMusic('/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  })

export const SaveMusic = Command.define('SaveMusic', {
  args: { config: MusicConfig },
  messages: [Message.SucceededSaveMusic, Message.FailedSaveMusic],
  execute: ({ config }) =>
    putMusicConfig(config).pipe(
      Effect.map(snapshot => Message.SucceededSaveMusic({ snapshot })),
      Effect.catch(error => Effect.succeed(Message.FailedSaveMusic({ error }))),
    ),
})

// NOTE: Music colors also stores its group by name.
export const FollowMusicGroupRename = Command.define('FollowMusicGroupRename', {
  args: { from: Schema.String, to: Schema.String },
  messages: [Message.SucceededSaveMusic, Message.FailedSaveMusic],
  execute: ({ from, to }) =>
    requestMusic('', {}).pipe(
      Effect.flatMap(snapshot =>
        snapshot.config.group === from
          ? putMusicConfig({ ...snapshot.config, group: to })
          : Effect.succeed(snapshot),
      ),
      Effect.map(snapshot => Message.SucceededSaveMusic({ snapshot })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSaveMusic({
            error: `couldn't point music colors at the renamed group: ${error}`,
          }),
        ),
      ),
    ),
})

const withFlashGroup = (config: PrMergeConfig, group: string): PrMergeConfig =>
  modifyFields(config, {
    flash: flash => modifyFields(flash, { group: () => group }),
  })

// NOTE: Automations store the group by name, so a rename made on the Manage
// tab has to be carried over or the flash would point at a group that is gone.
export const FollowGroupRename = Command.define('FollowGroupRename', {
  args: { from: Schema.String, to: Schema.String },
  messages: [
    Message.CompletedFollowGroupRename,
    Message.FailedFollowGroupRename,
  ],
  execute: ({ from, to }) =>
    requestSnapshot('', {}).pipe(
      Effect.flatMap(snapshot =>
        snapshot.config.flash.group === from
          ? sendJson(
              'PUT',
              '/config',
              withFlashGroup(snapshot.config, to),
            ).pipe(Effect.map(Option.some))
          : Effect.succeed(Option.none()),
      ),
      Effect.map(maybeSnapshot =>
        Message.CompletedFollowGroupRename({ maybeSnapshot }),
      ),
      Effect.catch(error =>
        Effect.succeed(Message.FailedFollowGroupRename({ error })),
      ),
    ),
})

// VIEW HELPERS

export const updated = (draft: PrMergeConfig): Message =>
  Message.UpdatedDraft({ draft })

// DERIVED

export const draftProblem = (draft: PrMergeConfig): Option.Option<string> =>
  configProblem(normalizeConfig(draft))

// SUBSCRIPTION

export const refreshTicks = (periodMs: number): Stream.Stream<Message> =>
  Stream.tick(Duration.millis(periodMs)).pipe(
    Stream.map(() => Message.TickedRefresh()),
  )

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

export const renamedGroup = (
  model: Model,
  { from, to }: Readonly<{ from: string; to: string }>,
): UpdateReturn => ({
  model: modifyFields(model, {
    maybeDraft: maybeDraft =>
      Option.map(maybeDraft, draft =>
        draft.flash.group === from ? withFlashGroup(draft, to) : draft,
      ),
  }),
  commands: [
    FollowGroupRename({ from, to }),
    FollowMusicGroupRename({ from, to }),
  ],
})

const withSnapshot = (model: Model, snapshot: Snapshot): Model =>
  modifyFields(model, { remote: () => Remote.Loaded({ snapshot }) })

const currentConfig = (model: Model): Option.Option<PrMergeConfig> =>
  Option.orElse(model.maybeDraft, () =>
    Match.value(model.remote).pipe(
      Match.withReturnType<Option.Option<PrMergeConfig>>(),
      Match.tag('Loaded', ({ snapshot }) => Option.some(snapshot.config)),
      Match.orElse(() => Option.none()),
    ),
  )

const withEdit = (model: Model, draft: PrMergeConfig): Model =>
  modifyFields(model, {
    maybeDraft: () => Option.some(draft),
    saveState: () => SaveState.Idle(),
  })

const splitEntries = (raw: string): ReadonlyArray<string> =>
  pipe(raw.split(','), Array.map(String.trim), Array.filter(String.isNonEmpty))

const entryText = (model: Model, list: EntryList): string =>
  list === 'Accounts' ? model.accountEntry : model.ignoredRepoEntry

const withEntryText = (model: Model, list: EntryList, value: string): Model =>
  list === 'Accounts'
    ? modifyFields(model, { accountEntry: () => value })
    : modifyFields(model, { ignoredRepoEntry: () => value })

const withAddedEntries = (
  config: PrMergeConfig,
  list: EntryList,
  entries: ReadonlyArray<string>,
): PrMergeConfig =>
  list === 'Accounts'
    ? { ...config, accounts: Array.dedupe([...config.accounts, ...entries]) }
    : {
        ...config,
        ignoredRepos: Array.dedupe([...config.ignoredRepos, ...entries]),
      }

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SelectedScreen: ({ screen }) => ({
      model: modifyFields(model, {
        screen: () => screen,
        revealed: revealed =>
          screen._tag === model.screen._tag ? revealed : [],
      }),
    }),

    ClickedReveal: ({ reveal }) => ({
      model: modifyFields(model, {
        revealed: revealed =>
          Array.contains(revealed, reveal)
            ? Array.filter(revealed, candidate => candidate !== reveal)
            : [...revealed, reveal],
      }),
    }),

    ClickedUseSameHours: () => {
      const collapsed = modifyFields(model, {
        revealed: revealed =>
          Array.filter(revealed, reveal => reveal !== 'PerDayHours'),
      })
      return pipe(
        currentConfig(model),
        Option.filter(config => !hasSameHours(config.schedule)),
        Option.match({
          onNone: () => ({ model: collapsed }),
          onSome: config => {
            const { start, end } = sharedHours(config.schedule)
            return {
              model: withEdit(collapsed, {
                ...config,
                schedule: withSameHours(config.schedule, start, end),
              }),
            }
          },
        }),
      )
    },

    UpdatedEntry: ({ list, value }) => ({
      model: withEntryText(model, list, value),
    }),

    ClickedAddEntry: ({ list }) => {
      const entries = splitEntries(entryText(model, list))
      return pipe(
        currentConfig(model),
        Option.filter(() => Array.isReadonlyArrayNonEmpty(entries)),
        Option.match({
          onNone: () => ({ model }),
          onSome: config => ({
            model: withEntryText(
              withEdit(model, withAddedEntries(config, list, entries)),
              list,
              '',
            ),
          }),
        }),
      )
    },

    TickedRefresh: () => ({
      model,
      commands: model.isSavingMusic
        ? [FetchSnapshot()]
        : [FetchSnapshot(), FetchMusic()],
    }),

    SucceededFetchSnapshot: ({ snapshot }) => ({
      model: modifyFields(withSnapshot(model, snapshot), {
        maybeUnreachableReason: () => Option.none(),
      }),
    }),

    FailedFetchSnapshot: ({ error }) =>
      Match.value(model.remote).pipe(
        Match.withReturnType<UpdateReturn>(),
        Match.tag('Loaded', () => ({
          model: modifyFields(model, {
            maybeUnreachableReason: () => Option.some(error),
          }),
        })),
        Match.orElse(() => ({
          model: modifyFields(model, {
            remote: () => Remote.Unreachable({ reason: error }),
          }),
        })),
      ),

    ClickedAction: ({ action }) =>
      Option.isSome(model.maybeRunningAction)
        ? { model }
        : {
            model: modifyFields(model, {
              maybeRunningAction: () => Option.some(action),
              maybeProblem: () => Option.none(),
            }),
            commands: [RunAction({ action })],
          },

    SucceededRunAction: ({ snapshot }) => ({
      model: modifyFields(withSnapshot(model, snapshot), {
        maybeRunningAction: () => Option.none(),
      }),
    }),

    FailedRunAction: ({ error }) => ({
      model: modifyFields(model, {
        maybeRunningAction: () => Option.none(),
        maybeProblem: () => Option.some(`That didn't work: ${error}.`),
      }),
    }),

    UpdatedDraft: ({ draft }) => ({ model: withEdit(model, draft) }),

    ClickedDiscardDraft: () => ({
      model: modifyFields(model, {
        maybeDraft: () => Option.none(),
        saveState: () => SaveState.Idle(),
      }),
    }),

    SubmittedDraft: () =>
      pipe(
        model.maybeDraft,
        Option.map(normalizeConfig),
        Option.filter(draft => Option.isNone(configProblem(draft))),
        Option.match({
          onNone: () => ({ model }),
          onSome: draft => ({
            model: modifyFields(model, {
              saveState: () => SaveState.Saving(),
            }),
            commands: [SaveDraft({ draft })],
          }),
        }),
      ),

    SucceededSaveDraft: ({ snapshot }) => ({
      model: modifyFields(withSnapshot(model, snapshot), {
        maybeDraft: () => Option.none(),
        saveState: () => SaveState.Idle(),
      }),
    }),

    FailedSaveDraft: ({ error }) => ({
      model: modifyFields(model, {
        saveState: () => SaveState.Failed({ reason: error }),
      }),
    }),

    CompletedFollowGroupRename: ({ maybeSnapshot }) => ({
      model: Option.match(maybeSnapshot, {
        onNone: () => model,
        onSome: snapshot => withSnapshot(model, snapshot),
      }),
    }),

    SucceededFetchMusic: ({ snapshot }) =>
      model.isSavingMusic
        ? { model }
        : {
            model: modifyFields(model, {
              music: () => MusicRemote.Loaded({ snapshot }),
            }),
          },

    FailedFetchMusic: ({ error }) => ({
      model: MusicRemote.match(model.music, {
        Loaded: () => model,
        Loading: () =>
          modifyFields(model, {
            music: () => MusicRemote.Unavailable({ reason: error }),
          }),
        Unavailable: () =>
          modifyFields(model, {
            music: () => MusicRemote.Unavailable({ reason: error }),
          }),
      }),
    }),

    // NOTE: Music settings save as soon as they change, with no save bar.
    ChangedMusicConfig: ({ config }) =>
      MusicRemote.match(model.music, {
        Loading: () => ({ model }),
        Unavailable: () => ({ model }),
        Loaded: ({ snapshot }) => ({
          model: modifyFields(model, {
            music: () =>
              MusicRemote.Loaded({ snapshot: { ...snapshot, config } }),
            isSavingMusic: () => true,
            maybeProblem: () => Option.none(),
          }),
          commands: [SaveMusic({ config })],
        }),
      }),

    SucceededSaveMusic: ({ snapshot }) => ({
      model: modifyFields(model, {
        music: () => MusicRemote.Loaded({ snapshot }),
        isSavingMusic: () => false,
      }),
    }),

    FailedSaveMusic: ({ error }) => ({
      model: modifyFields(model, {
        isSavingMusic: () => false,
        maybeProblem: () =>
          Option.some(`Music colors weren't saved: ${error}.`),
      }),
      commands: [FetchMusic()],
    }),

    FailedFollowGroupRename: ({ error }) => ({
      model: modifyFields(model, {
        maybeProblem: () =>
          Option.some(
            `Couldn't point the PR flash at the renamed group: ${error}. Choose the group again in its settings.`,
          ),
      }),
    }),
  })
