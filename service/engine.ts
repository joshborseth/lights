import {
  Array,
  Cause,
  Duration,
  Effect,
  Option,
  Queue,
  Ref,
  Semaphore,
  pipe,
} from 'effect'

import {
  type AccountStatus,
  type ActivityEntry,
  type ActivityKind,
  type PollStatus,
  type PrMergeConfig,
  type RateWindow,
  type Snapshot,
  type TokenStatus,
  WatcherMode,
  isScheduleOpen,
} from '../src/automation'
import { type FlashPort, type FlashResult, runFlash } from './flash'
import { type GitHubError, type GitHubPort, type RateResource } from './github'
import { healthChecks, overallHealth } from './health'
import { type Merge, classifyMerges, searchDayFloor } from './merges'

const MAX_ACTIVITY = 200
const noErrors: ReadonlyArray<string> = []
const MAX_SEEN_MERGES = 5000
const INITIAL_PROBE_DELAY_MS = 2000

export type LightsPort<E> = FlashPort<E> &
  Readonly<{
    isBrokerConnected: () => boolean
    maybeIsBridgeOnline: () => Option.Option<boolean>
  }>

export type ControlState = Readonly<{
  isEnabled: boolean
  maybePausedUntil: Option.Option<number>
  heldMerges: ReadonlyArray<string>
}>

export type StorePort = Readonly<{
  saveConfig: (config: PrMergeConfig) => Effect.Effect<void>
  saveControl: (control: ControlState) => Effect.Effect<void>
  saveSeen: (seen: ReadonlyArray<string>) => Effect.Effect<void>
  saveActivity: (activity: ReadonlyArray<ActivityEntry>) => Effect.Effect<void>
}>

export type EngineInitial = Readonly<{
  config: PrMergeConfig
  maybeConfigFileError: Option.Option<string>
  control: ControlState
  seen: ReadonlyArray<string>
  activity: ReadonlyArray<ActivityEntry>
}>

export type EnginePorts<E> = Readonly<{
  github: GitHubPort
  lights: LightsPort<E>
  store: StorePort
  now: Effect.Effect<number>
  errorText: (error: E) => string
}>

type AccountHealth = Readonly<{
  token: TokenStatus
  maybeCore: Option.Option<RateWindow>
  maybeGraphql: Option.Option<RateWindow>
}>

type ScopePair = Readonly<{ account: string; scope: string }>

type EngineState = Readonly<{
  config: PrMergeConfig
  control: ControlState
  poll: PollStatus
  scopePairs: ReadonlyArray<ScopePair>
  maybeScopesFetchedAt: Option.Option<number>
  seen: ReadonlyArray<string>
  isNextPollSilent: boolean
  maybeLastMergeAt: Option.Option<number>
  maybeLastFlashAt: Option.Option<number>
  activity: ReadonlyArray<ActivityEntry>
}>

export type Engine = Readonly<{
  snapshot: Effect.Effect<Snapshot>
  saveConfig: (config: PrMergeConfig) => Effect.Effect<void>
  setEnabled: (isEnabled: boolean) => Effect.Effect<void>
  pause: (minutes: number) => Effect.Effect<void>
  resume: Effect.Effect<void>
  testFlash: Effect.Effect<Option.Option<string>>
  checkNow: Effect.Effect<void>
  pollOnce: Effect.Effect<void>
  waitForFlashToFinish: Effect.Effect<void>
  /** Runs light commands from elsewhere without overlapping a flash. */
  withLightsLock: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
  run: Effect.Effect<void>
}>

const emptyAccountHealth: AccountHealth = {
  token: 'Unknown',
  maybeCore: Option.none(),
  maybeGraphql: Option.none(),
}

const emptyPoll: PollStatus = {
  maybeLastStartedAt: Option.none(),
  maybeLastSucceededAt: Option.none(),
  maybeLastDurationMs: Option.none(),
  consecutiveFailures: 0,
  maybeLastError: Option.none(),
  maybePartialError: Option.none(),
  scopes: [],
}

type Outcome<A> =
  | Readonly<{ _tag: 'Ok'; value: A }>
  | Readonly<{ _tag: 'Failed'; reason: string }>

const attempt = <A>(
  effect: Effect.Effect<A, GitHubError>,
): Effect.Effect<Outcome<A>> =>
  effect.pipe(
    Effect.match({
      onFailure: (error): Outcome<A> => ({
        _tag: 'Failed',
        reason: `${error.account}: ${error.reason}`,
      }),
      onSuccess: (value): Outcome<A> => ({ _tag: 'Ok', value }),
    }),
  )

const successes = <A>(outcomes: ReadonlyArray<Outcome<A>>): ReadonlyArray<A> =>
  Array.getSomes(
    Array.map(outcomes, outcome =>
      outcome._tag === 'Ok' ? Option.some(outcome.value) : Option.none(),
    ),
  )

const failures = <A>(
  outcomes: ReadonlyArray<Outcome<A>>,
): ReadonlyArray<string> =>
  Array.getSomes(
    Array.map(outcomes, outcome =>
      outcome._tag === 'Failed' ? Option.some(outcome.reason) : Option.none(),
    ),
  )

export const pollDelayMs = (
  intervalSeconds: number,
  elapsedMs: number,
): number => Math.max(0, intervalSeconds * 1000 - elapsedMs)

const flashNotes = (result: FlashResult): string =>
  [
    ...(Array.isReadonlyArrayEmpty(result.leftOff)
      ? []
      : [`Left off: ${result.leftOff.join(', ')}.`]),
    ...(Array.isReadonlyArrayEmpty(result.unresponsive)
      ? []
      : [`No answer: ${result.unresponsive.join(', ')}.`]),
  ]
    .map(note => ` ${note}`)
    .join('')

export const watcherMode = (
  control: ControlState,
  config: PrMergeConfig,
  now: number,
): WatcherMode => {
  if (!control.isEnabled) {
    return WatcherMode.Off()
  }
  return Option.match(
    Option.filter(control.maybePausedUntil, until => until > now),
    {
      onSome: until => WatcherMode.Paused({ until }),
      onNone: () =>
        WatcherMode.Watching({
          isScheduleOpen: isScheduleOpen(config.schedule, now),
        }),
    },
  )
}

export const makeEngine = <E>(
  ports: EnginePorts<E>,
  initial: EngineInitial,
  accountHealth: Map<string, AccountHealth>,
): Effect.Effect<Engine> =>
  Effect.gen(function* () {
    const startedAt = yield* ports.now
    const stateRef = yield* Ref.make<EngineState>({
      config: initial.config,
      control: initial.control,
      poll: emptyPoll,
      scopePairs: [],
      maybeScopesFetchedAt: Option.none(),
      seen: initial.seen,
      isNextPollSilent: false,
      maybeLastMergeAt: Option.none(),
      maybeLastFlashAt: Option.none(),
      activity: initial.activity,
    })
    const flashLock = yield* Semaphore.make(1)
    const pollLock = yield* Semaphore.make(1)
    const wakeQueue = yield* Queue.unbounded<true>()
    const { github, lights, store } = ports

    const modify = (change: (state: EngineState) => EngineState) =>
      Ref.update(stateRef, change)

    const logActivity = (kind: ActivityKind, text: string) =>
      Effect.gen(function* () {
        const at = yield* ports.now
        const next = yield* Ref.updateAndGet(stateRef, state => ({
          ...state,
          activity: Array.take(
            [{ at, kind, text }, ...state.activity],
            MAX_ACTIVITY,
          ),
        }))
        yield* store.saveActivity(next.activity)
      })

    const logProblem = (text: string) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        const isRepeat = Option.exists(
          Array.findFirst(state.activity, entry => entry.kind === 'Problem'),
          entry => entry.text === text,
        )
        if (!isRepeat) {
          yield* logActivity('Problem', text)
        }
      })

    const saveControl = (change: (control: ControlState) => ControlState) =>
      Effect.gen(function* () {
        const next = yield* Ref.updateAndGet(stateRef, state => ({
          ...state,
          control: change(state.control),
        }))
        yield* store.saveControl(next.control)
      })

    const recordSeen = (keys: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (Array.isReadonlyArrayEmpty(keys)) {
          return
        }
        const next = yield* Ref.updateAndGet(stateRef, state => ({
          ...state,
          seen: Array.takeRight(
            Array.dedupe([...state.seen, ...keys]),
            MAX_SEEN_MERGES,
          ),
        }))
        yield* store.saveSeen(next.seen)
      })

    const wake = Queue.offer(wakeQueue, true).pipe(Effect.asVoid)

    // FLASH

    const flashLights = (reason: string): Effect.Effect<boolean> =>
      flashLock.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef)
          return yield* runFlash(lights, state.config.flash).pipe(
            Effect.matchEffect({
              onFailure: error =>
                logProblem(
                  `Flash failed for ${reason}: ${ports.errorText(error)}`,
                ).pipe(Effect.as(false)),
              onSuccess: result =>
                Effect.gen(function* () {
                  const at = yield* ports.now
                  yield* modify(current => ({
                    ...current,
                    maybeLastFlashAt: Option.some(at),
                  }))
                  yield* Option.match(result.skippedReason, {
                    onSome: skipped =>
                      logActivity('Skip', `Skipped flash: ${skipped}`),
                    onNone: () =>
                      logActivity(
                        'Flash',
                        `Flashed ${result.flashed.length} lights for ${reason}.${flashNotes(result)}`,
                      ),
                  })
                  return true
                }),
            }),
          )
        }),
      )

    const flashHeldMerges = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef)
      const now = yield* ports.now
      const mode = watcherMode(state.control, state.config, now)
      const isOpen = mode._tag === 'Watching' && mode.isScheduleOpen
      if (!isOpen || Array.isReadonlyArrayEmpty(state.control.heldMerges)) {
        return
      }
      const count = state.control.heldMerges.length
      const didFlash = yield* flashLights(`${count} held merges`)
      if (didFlash) {
        yield* saveControl(control => ({ ...control, heldMerges: [] }))
      }
    })

    const celebrate = (merges: ReadonlyArray<Merge>) =>
      Effect.gen(function* () {
        const now = yield* ports.now
        yield* modify(state => ({
          ...state,
          maybeLastMergeAt: Option.some(now),
        }))
        yield* Effect.forEach(
          merges,
          merge =>
            logActivity('Merge', `${merge.key} merged by ${merge.actor}.`),
          { discard: true },
        )
        const keys = Array.map(merges, merge => merge.key)
        const state = yield* Ref.get(stateRef)
        const mode = watcherMode(state.control, state.config, now)
        const label = keys.join(', ')

        yield* WatcherMode.match(mode, {
          Off: () => recordSeen(keys),
          Paused: () =>
            logActivity('Skip', `Paused, so ${label} did not flash.`).pipe(
              Effect.andThen(recordSeen(keys)),
            ),
          Watching: ({ isScheduleOpen: isOpen }) =>
            Effect.gen(function* () {
              if (isOpen) {
                const didFlash = yield* flashLights(label)
                if (didFlash) {
                  yield* recordSeen(keys)
                }
                return
              }
              if (state.config.schedule.whenOutside === 'WaitForWindow') {
                yield* saveControl(control => ({
                  ...control,
                  heldMerges: Array.dedupe([...control.heldMerges, ...keys]),
                }))
                yield* logActivity(
                  'Skip',
                  `Outside the schedule, so ${label} will flash when it opens.`,
                )
              } else {
                yield* logActivity(
                  'Skip',
                  `Outside the schedule, so ${label} did not flash.`,
                )
              }
              yield* recordSeen(keys)
            }),
        })
      })

    // POLL

    const resolveScopes = (state: EngineState, now: number) =>
      Effect.gen(function* () {
        const { accounts, polling } = state.config
        const isFresh = Option.exists(
          state.maybeScopesFetchedAt,
          fetchedAt => now - fetchedAt < polling.scopeRefreshMinutes * 60_000,
        )
        if (isFresh && Array.isReadonlyArrayNonEmpty(state.scopePairs)) {
          return { pairs: state.scopePairs, errors: noErrors }
        }
        const organizationOutcomes = yield* Effect.forEach(
          accounts,
          account =>
            attempt(github.fetchOrganizations(account)).pipe(
              Effect.map(outcome => ({ account, outcome })),
            ),
          { concurrency: 4 },
        )
        const seenScopes = new Set<string>()
        const claim = (scope: string): boolean => {
          if (seenScopes.has(scope)) {
            return false
          }
          seenScopes.add(scope)
          return true
        }
        const pairs = Array.flatMap(
          organizationOutcomes,
          ({ account, outcome }) => {
            const organizations = outcome._tag === 'Ok' ? outcome.value : []
            return pipe(
              [
                ...Array.map(organizations, login => `org:${login}`),
                `user:${account}`,
              ],
              Array.filter(claim),
              Array.map(scope => ({ account, scope })),
            )
          },
        )
        const errors = failures(
          Array.map(organizationOutcomes, entry => entry.outcome),
        )
        if (Array.isReadonlyArrayEmpty(errors)) {
          yield* modify(current => ({
            ...current,
            scopePairs: pairs,
            maybeScopesFetchedAt: Option.some(now),
          }))
        }
        return {
          pairs: Array.isReadonlyArrayEmpty(errors) ? pairs : state.scopePairs,
          errors,
        }
      })

    const pollCycle = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef)
      if (!state.control.isEnabled) {
        return
      }
      const started = yield* ports.now
      yield* modify(current => ({
        ...current,
        poll: { ...current.poll, maybeLastStartedAt: Option.some(started) },
      }))
      const { accounts, polling } = state.config
      const scopes = yield* resolveScopes(state, started)
      const sinceDay = searchDayFloor(started, polling.lookbackHours)
      const eventOutcomes = yield* Effect.forEach(
        accounts,
        account => attempt(github.fetchMergeEvents(account, accounts)),
        { concurrency: 4 },
      )
      const searchOutcomes = yield* Effect.forEach(
        scopes.pairs,
        ({ account, scope }) =>
          attempt(github.fetchMergedPulls(account, scope, sinceDay, accounts)),
        { concurrency: 4 },
      )
      const outcomes = [...eventOutcomes, ...searchOutcomes]
      const errors = [...scopes.errors, ...failures(outcomes)]
      const worked = successes(outcomes)
      const finished = yield* ports.now
      const scopeLabels = Array.map(scopes.pairs, pair => pair.scope)

      if (Array.isReadonlyArrayEmpty(worked)) {
        const reason = errors.join('; ') || 'No accounts could be polled.'
        yield* modify(current => ({
          ...current,
          poll: {
            ...current.poll,
            maybeLastDurationMs: Option.some(finished - started),
            consecutiveFailures: current.poll.consecutiveFailures + 1,
            maybeLastError: Option.some(reason),
            maybePartialError: Option.none(),
            scopes: scopeLabels,
          },
        }))
        yield* logProblem(`Poll failed: ${reason}`)
        return
      }

      yield* modify(current => ({
        ...current,
        poll: {
          ...current.poll,
          maybeLastSucceededAt: Option.some(finished),
          maybeLastDurationMs: Option.some(finished - started),
          consecutiveFailures: 0,
          maybeLastError: Option.none(),
          maybePartialError: Array.isReadonlyArrayEmpty(errors)
            ? Option.none()
            : Option.some(errors.join('; ')),
          scopes: scopeLabels,
        },
      }))

      if (Array.isReadonlyArrayNonEmpty(errors)) {
        yield* logProblem(`Poll partly failed: ${errors.join('; ')}`)
      }

      const current = yield* Ref.get(stateRef)
      const batch = classifyMerges(
        Array.flatten(worked),
        new Set(current.seen),
        current.config.ignoredRepos,
        finished - current.config.polling.catchUpMinutes * 60_000,
      )
      if (current.isNextPollSilent) {
        yield* modify(next => ({ ...next, isNextPollSilent: false }))
        yield* recordSeen([
          ...batch.toRecordSilently,
          ...Array.map(batch.toCelebrate, merge => merge.key),
        ])
        return
      }
      yield* recordSeen(batch.toRecordSilently)
      if (Array.isReadonlyArrayNonEmpty(batch.toCelebrate)) {
        yield* celebrate(batch.toCelebrate)
      }
      yield* flashHeldMerges
    })

    const keepRunningOnDefect = <A>(name: string, effect: Effect.Effect<A>) =>
      effect.pipe(
        Effect.catchCause(cause =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : logProblem(`${name} crashed: ${Cause.pretty(cause)}`),
        ),
      )

    const pollOnce = pollLock.withPermits(1)(
      keepRunningOnDefect('Poll', pollCycle),
    )

    const pollLoop = Effect.forever(
      Effect.gen(function* () {
        const started = yield* ports.now
        yield* pollOnce
        const finished = yield* ports.now
        const state = yield* Ref.get(stateRef)
        yield* Effect.raceFirst(
          Effect.sleep(
            Duration.millis(
              pollDelayMs(
                state.config.polling.intervalSeconds,
                finished - started,
              ),
            ),
          ),
          Queue.take(wakeQueue),
        )
      }),
    )

    const probeAccounts = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef)
      if (!state.control.isEnabled) {
        return
      }
      yield* Effect.forEach(
        state.config.accounts,
        account => Effect.ignore(github.checkAccount(account)),
        { concurrency: 4, discard: true },
      )
    })

    const probeLoop = Effect.sleep(
      Duration.millis(INITIAL_PROBE_DELAY_MS),
    ).pipe(
      Effect.andThen(
        Effect.forever(
          Effect.gen(function* () {
            yield* keepRunningOnDefect('Health check', probeAccounts)
            const state = yield* Ref.get(stateRef)
            yield* Effect.sleep(
              Duration.minutes(state.config.health.probeMinutes),
            )
          }),
        ),
      ),
    )

    // API

    const snapshot: Effect.Effect<Snapshot> = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef)
      const now = yield* ports.now
      const mode = watcherMode(state.control, state.config, now)
      const accounts: ReadonlyArray<AccountStatus> = Array.map(
        state.config.accounts,
        login => ({
          login,
          ...(accountHealth.get(login) ?? emptyAccountHealth),
        }),
      )
      const members = lights.groupMembers(state.config.flash.group)
      const checks = healthChecks({
        now,
        config: state.config,
        mode,
        poll: state.poll,
        accounts,
        isBrokerConnected: lights.isBrokerConnected(),
        maybeIsBridgeOnline: lights.maybeIsBridgeOnline(),
        maybeTargetMembers: Option.isSome(lights.maybeIsBridgeOnline())
          ? Option.some(members.length)
          : Option.none(),
        maybeConfigFileError: initial.maybeConfigFileError,
      })
      return {
        generatedAt: now,
        startedAt,
        config: state.config,
        mode,
        heldMerges: state.control.heldMerges.length,
        poll: state.poll,
        accounts,
        maybeLastMergeAt: state.maybeLastMergeAt,
        maybeLastFlashAt: state.maybeLastFlashAt,
        overall: overallHealth(mode, checks),
        checks,
        activity: state.activity,
      }
    })

    return {
      snapshot,
      saveConfig: config =>
        Effect.gen(function* () {
          yield* modify(state => ({
            ...state,
            config,
            maybeScopesFetchedAt: Option.none(),
          }))
          yield* store.saveConfig(config)
          yield* logActivity('Info', 'Settings saved.')
          yield* wake
        }),
      setEnabled: isEnabled =>
        Effect.gen(function* () {
          yield* modify(state => ({
            ...state,
            isNextPollSilent: isEnabled && !state.control.isEnabled,
          }))
          yield* saveControl(control => ({
            ...control,
            isEnabled,
            maybePausedUntil: Option.none(),
          }))
          yield* logActivity('Info', isEnabled ? 'Turned on.' : 'Turned off.')
          yield* wake
        }),
      pause: minutes =>
        Effect.gen(function* () {
          const now = yield* ports.now
          yield* saveControl(control => ({
            ...control,
            maybePausedUntil: Option.some(now + minutes * 60_000),
          }))
          yield* logActivity('Info', `Paused for ${minutes} minutes.`)
        }),
      resume: Effect.gen(function* () {
        yield* saveControl(control => ({
          ...control,
          maybePausedUntil: Option.none(),
        }))
        yield* logActivity('Info', 'Resumed.')
        yield* wake
      }),
      testFlash: Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        return yield* flashLock.withPermits(1)(
          runFlash(lights, state.config.flash).pipe(
            Effect.matchEffect({
              onFailure: error =>
                Effect.gen(function* () {
                  const reason = ports.errorText(error)
                  yield* logProblem(`Test flash failed: ${reason}`)
                  return Option.some(reason)
                }),
              onSuccess: result =>
                Effect.gen(function* () {
                  yield* Option.match(result.skippedReason, {
                    onSome: skipped =>
                      logActivity('Skip', `Test flash skipped: ${skipped}`),
                    onNone: () =>
                      logActivity(
                        'Flash',
                        `Test flash on ${result.flashed.length} lights.${flashNotes(result)}`,
                      ),
                  })
                  return result.skippedReason
                }),
            }),
          ),
        )
      }),
      checkNow: Effect.gen(function* () {
        yield* probeAccounts
        yield* pollOnce
      }),
      pollOnce,
      waitForFlashToFinish: flashLock.withPermits(1)(Effect.void),
      withLightsLock: effect => flashLock.withPermits(1)(effect),
      run: Effect.all([pollLoop, probeLoop], {
        concurrency: 'unbounded',
        discard: true,
      }),
    }
  })

export const makeAccountHealth = () => {
  const health = new Map<string, AccountHealth>()
  const read = (account: string): AccountHealth =>
    health.get(account) ?? emptyAccountHealth
  return {
    health,
    observer: {
      onTokenStatus: (account: string, token: TokenStatus) => {
        health.set(account, { ...read(account), token })
      },
      onRate: (account: string, resource: RateResource, window: RateWindow) => {
        const current = read(account)
        health.set(
          account,
          resource === 'core'
            ? { ...current, maybeCore: Option.some(window) }
            : { ...current, maybeGraphql: Option.some(window) },
        )
      },
    },
  }
}
