import { Duration, Effect, Match, Option, Schema, Stream, pipe } from 'effect'
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
  normalizeConfig,
} from './automation'

// MODEL

export const Remote = defineTaggedUnion({
  Loading: {},
  Unreachable: { reason: Schema.String },
  Loaded: { snapshot: SnapshotValue },
})
export type Remote = typeof Remote.Type

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

export const Model = Schema.Struct({
  remote: Remote,
  maybeDraft: Schema.Option(PrMergeConfig),
  saveState: SaveState,
  maybeRunningAction: Schema.Option(Action),
  maybeProblem: Schema.Option(Schema.String),
  maybeUnreachableReason: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const init: Model = {
  remote: Remote.Loading(),
  maybeDraft: Option.none(),
  saveState: SaveState.Idle(),
  maybeRunningAction: Option.none(),
  maybeProblem: Option.none(),
  maybeUnreachableReason: Option.none(),
}

// MESSAGE

export const Message = defineMessageUnion({
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
})
export type Message = typeof Message.Type

// COMMAND

const decodeSnapshot = Schema.decodeUnknownEffect(Snapshot)
const decodeFailure = Schema.decodeUnknownOption(ServiceFailure)

const requestSnapshot = (
  path: string,
  init: RequestInit,
): Effect.Effect<typeof SnapshotValue.Type, string> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: signal =>
        fetch(`${AUTOMATION_API_PATH}${path}`, { ...init, signal }),
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
    return yield* decodeSnapshot(body).pipe(
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

const withSnapshot = (model: Model, snapshot: Snapshot): Model =>
  modifyFields(model, { remote: () => Remote.Loaded({ snapshot }) })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    TickedRefresh: () => ({ model, commands: [FetchSnapshot()] }),

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

    UpdatedDraft: ({ draft }) => ({
      model: modifyFields(model, {
        maybeDraft: () => Option.some(draft),
        saveState: () => SaveState.Idle(),
      }),
    }),

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
  })
