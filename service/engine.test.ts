import { Effect, Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  DEFAULT_CONFIG,
  type PrMergeConfig,
  WatcherMode,
} from '../src/automation'
import {
  type ControlState,
  type Engine,
  type LightsPort,
  makeAccountHealth,
  makeEngine,
  pollDelayMs,
} from './engine'
import { type LightStates } from './flash'
import { GitHubError, type GitHubPort } from './github'
import { type Merge } from './merges'

const MONDAY_9_30 = Date.UTC(2026, 10, 9, 16, 30)
const MONDAY_20_00 = Date.UTC(2026, 10, 10, 3, 0)

const merge = (key: string, at: number): Merge => ({
  key,
  actor: 'joshborseth',
  repo: key.split('#')[0] ?? '',
  maybeMergedAt: Option.some(at),
})

const noMerges: ReadonlyArray<Merge> = []
const noOrganizations: ReadonlyArray<string> = []

const baseControl: ControlState = {
  isEnabled: true,
  maybePausedUntil: Option.none(),
  heldMerges: [],
}

type Harness = Readonly<{
  engine: Engine
  clock: { value: number }
  feed: {
    merges: ReadonlyArray<Merge>
    failure: Option.Option<string>
    searchFailure: Option.Option<string>
  }
  lightsState: { flashes: number; failNext: boolean }
  saved: { seen: ReadonlyArray<string>; control: ControlState }
}>

const harness = (
  options: Readonly<{
    now: number
    config?: PrMergeConfig
    control?: ControlState
    seen?: ReadonlyArray<string>
    statesReported?: LightStates
  }>,
): Promise<Harness> => {
  const clock = { value: options.now }
  const feed: Harness['feed'] = {
    merges: [],
    failure: Option.none<string>(),
    searchFailure: Option.none<string>(),
  }
  const lightsState = { flashes: 0, failNext: false }
  const saved: Harness['saved'] = {
    seen: options.seen ?? [],
    control: options.control ?? baseControl,
  }

  const respond = <A>(value: A, account: string) =>
    Option.match(feed.failure, {
      onNone: () => Effect.succeed(value),
      onSome: reason => Effect.fail(new GitHubError({ account, reason })),
    })

  const github: GitHubPort = {
    fetchMergeEvents: account =>
      Effect.suspend(() => respond(feed.merges, account)),
    fetchMergedPulls: (account, _scope, _sinceDay, _accounts) =>
      Effect.suspend(() =>
        Option.match(feed.searchFailure, {
          onNone: () => respond(noMerges, account),
          onSome: reason => Effect.fail(new GitHubError({ account, reason })),
        }),
      ),
    fetchOrganizations: account =>
      Effect.suspend(() => respond(noOrganizations, account)),
    checkAccount: () => Effect.void,
  }

  const lights: LightsPort<string> = {
    isBrokerConnected: () => true,
    maybeIsBridgeOnline: () => Option.some(true),
    groupMembers: () => ['Orb'],
    activeRainbowGroups: () => [],
    markRainbowStopped: () => undefined,
    readStates: () =>
      Effect.succeed(options.statesReported ?? { Orb: { state: 'ON' } }),
    publishLight: (_name, payload) =>
      Effect.suspend(() => {
        if (
          payload['brightness'] !== undefined &&
          payload['color'] !== undefined
        ) {
          if (lightsState.failNext) {
            lightsState.failNext = false
            return Effect.fail('broker down')
          }
          lightsState.flashes += 1
        }
        return Effect.void
      }),
    publishGroup: () => Effect.void,
    applyPreset: () => Effect.void,
    sleep: () => Effect.void,
    log: () => Effect.void,
  }

  return Effect.runPromise(
    makeEngine(
      {
        github,
        lights,
        store: {
          saveConfig: () => Effect.void,
          saveControl: control =>
            Effect.sync(() => {
              saved.control = control
            }),
          saveSeen: seen =>
            Effect.sync(() => {
              saved.seen = seen
            }),
          saveActivity: () => Effect.void,
        },
        now: Effect.sync(() => clock.value),
        errorText: (error: string) => error,
      },
      {
        config: options.config ?? DEFAULT_CONFIG,
        maybeConfigFileError: Option.none(),
        control: options.control ?? baseControl,
        seen: options.seen ?? [],
        activity: [],
      },
      makeAccountHealth().health,
    ),
  ).then(engine => ({ engine, clock, feed, lightsState, saved }))
}

const onePass = (count: number) => DEFAULT_CONFIG.flash.count * count

describe('poll', () => {
  test('flashes for a new merge inside the schedule, once', async () => {
    const { engine, feed, lightsState, saved } = await harness({
      now: MONDAY_9_30,
    })
    feed.merges = [merge('a/b#1', MONDAY_9_30 - 1000)]
    await Effect.runPromise(engine.pollOnce)
    await Effect.runPromise(engine.pollOnce)
    expect(lightsState.flashes).toBe(onePass(1))
    expect(saved.seen).toContain('a/b#1')
  })

  test('collapses merges from one poll into one flash', async () => {
    const { engine, feed, lightsState } = await harness({ now: MONDAY_9_30 })
    feed.merges = [
      merge('a/b#1', MONDAY_9_30 - 1000),
      merge('a/b#2', MONDAY_9_30 - 1000),
    ]
    await Effect.runPromise(engine.pollOnce)
    expect(lightsState.flashes).toBe(onePass(1))
  })

  test('records a merge outside the schedule without flashing or replaying', async () => {
    const { engine, clock, feed, lightsState, saved } = await harness({
      now: MONDAY_20_00,
    })
    feed.merges = [merge('a/b#1', MONDAY_20_00 - 1000)]
    await Effect.runPromise(engine.pollOnce)
    clock.value = MONDAY_9_30 + 86_400_000
    await Effect.runPromise(engine.pollOnce)
    expect(lightsState.flashes).toBe(0)
    expect(saved.seen).toContain('a/b#1')
  })

  test('holds an outside-schedule merge when set to wait, then flashes once', async () => {
    const config: PrMergeConfig = {
      ...DEFAULT_CONFIG,
      schedule: { ...DEFAULT_CONFIG.schedule, whenOutside: 'WaitForWindow' },
    }
    const { engine, clock, feed, lightsState, saved } = await harness({
      now: MONDAY_20_00,
      config,
    })
    feed.merges = [merge('a/b#1', MONDAY_20_00 - 1000)]
    await Effect.runPromise(engine.pollOnce)
    expect(lightsState.flashes).toBe(0)
    expect(saved.control.heldMerges).toEqual(['a/b#1'])

    clock.value = MONDAY_9_30 + 86_400_000
    await Effect.runPromise(engine.pollOnce)
    await Effect.runPromise(engine.pollOnce)
    expect(lightsState.flashes).toBe(onePass(1))
    expect(saved.control.heldMerges).toEqual([])
  })

  test('does not flash while paused but still records the merge', async () => {
    const { engine, feed, lightsState, saved } = await harness({
      now: MONDAY_9_30,
      control: {
        ...baseControl,
        maybePausedUntil: Option.some(MONDAY_9_30 + 60_000),
      },
    })
    feed.merges = [merge('a/b#1', MONDAY_9_30 - 1000)]
    await Effect.runPromise(engine.pollOnce)
    expect(lightsState.flashes).toBe(0)
    expect(saved.seen).toContain('a/b#1')
  })

  test('does not poll while off', async () => {
    const { engine, feed, lightsState, saved } = await harness({
      now: MONDAY_9_30,
      control: { ...baseControl, isEnabled: false },
    })
    feed.merges = [merge('a/b#1', MONDAY_9_30 - 1000)]
    await Effect.runPromise(engine.pollOnce)
    expect(lightsState.flashes).toBe(0)
    expect(saved.seen).toEqual([])
  })

  test('turning back on does not flash merges from while it was off', async () => {
    const { engine, feed, lightsState, saved } = await harness({
      now: MONDAY_9_30,
      control: { ...baseControl, isEnabled: false },
    })
    feed.merges = [merge('a/b#1', MONDAY_9_30 - 1000)]
    await Effect.runPromise(engine.setEnabled(true))
    await Effect.runPromise(engine.pollOnce)
    expect(lightsState.flashes).toBe(0)
    expect(saved.seen).toContain('a/b#1')
  })

  test('retries a failed flash on the next poll', async () => {
    const { engine, feed, lightsState, saved } = await harness({
      now: MONDAY_9_30,
    })
    lightsState.failNext = true
    feed.merges = [merge('a/b#1', MONDAY_9_30 - 1000)]
    await Effect.runPromise(engine.pollOnce)
    expect(saved.seen).toEqual([])
    await Effect.runPromise(engine.pollOnce)
    expect(saved.seen).toContain('a/b#1')
  })

  test('marks polling unhealthy after the configured failures', async () => {
    const config: PrMergeConfig = {
      ...DEFAULT_CONFIG,
      health: { ...DEFAULT_CONFIG.health, failuresBeforeUnhealthy: 2 },
    }
    const { engine, feed } = await harness({ now: MONDAY_9_30, config })
    feed.failure = Option.some('HTTP 504')
    await Effect.runPromise(engine.pollOnce)
    const first = await Effect.runPromise(engine.snapshot)
    expect(first.overall).toBe('Warning')
    await Effect.runPromise(engine.pollOnce)
    const second = await Effect.runPromise(engine.snapshot)
    expect(second.overall).toBe('Unhealthy')
    expect(second.poll.consecutiveFailures).toBe(2)

    feed.failure = Option.none()
    await Effect.runPromise(engine.pollOnce)
    const recovered = await Effect.runPromise(engine.snapshot)
    expect(recovered.poll.consecutiveFailures).toBe(0)
  })

  test('records a partial poll failure once in the activity log', async () => {
    const { engine, feed } = await harness({ now: MONDAY_9_30 })
    feed.searchFailure = Option.some('HTTP 504')
    await Effect.runPromise(engine.pollOnce)
    await Effect.runPromise(engine.pollOnce)
    const snapshot = await Effect.runPromise(engine.snapshot)
    const problems = snapshot.activity.filter(item => item.kind === 'Problem')
    expect(problems).toHaveLength(1)
    expect(problems[0]?.text).toContain('Poll partly failed')
    expect(snapshot.poll.consecutiveFailures).toBe(0)
  })

  test('logs a repeating poll failure once', async () => {
    const { engine, feed } = await harness({ now: MONDAY_9_30 })
    feed.failure = Option.some('HTTP 504')
    await Effect.runPromise(engine.pollOnce)
    await Effect.runPromise(engine.pollOnce)
    const snapshot = await Effect.runPromise(engine.snapshot)
    expect(
      snapshot.activity.filter(item => item.kind === 'Problem'),
    ).toHaveLength(1)
  })
})

test('the poll interval includes the time the poll took', () => {
  expect(pollDelayMs(5, 1100)).toBe(3900)
  expect(pollDelayMs(5, 8000)).toBe(0)
})

describe('controls', () => {
  test('pause expires by itself', async () => {
    const { engine, clock } = await harness({ now: MONDAY_9_30 })
    await Effect.runPromise(engine.pause(30))
    const paused = await Effect.runPromise(engine.snapshot)
    expect(paused.mode._tag).toBe('Paused')
    clock.value = MONDAY_9_30 + 31 * 60_000
    const after = await Effect.runPromise(engine.snapshot)
    expect(after.mode).toEqual(WatcherMode.Watching({ isScheduleOpen: true }))
  })

  test('off reports Off instead of a health problem', async () => {
    const { engine } = await harness({
      now: MONDAY_9_30,
      control: { ...baseControl, isEnabled: false },
    })
    const snapshot = await Effect.runPromise(engine.snapshot)
    expect(snapshot.overall).toBe('Off')
  })

  test('test flash ignores the schedule', async () => {
    const { engine, lightsState } = await harness({ now: MONDAY_20_00 })
    const result = await Effect.runPromise(engine.testFlash)
    expect(result).toEqual(Option.none())
    expect(lightsState.flashes).toBe(onePass(1))
  })

  test('test flash says why nothing flashed', async () => {
    const { engine } = await harness({
      now: MONDAY_20_00,
      statesReported: { Orb: { state: 'OFF' } },
    })
    const result = await Effect.runPromise(engine.testFlash)
    expect(result).toEqual(Option.some('No lights were on.'))
  })

  test('test flash reports a failure', async () => {
    const { engine, lightsState } = await harness({ now: MONDAY_20_00 })
    lightsState.failNext = true
    const result = await Effect.runPromise(engine.testFlash)
    expect(result).toEqual(Option.some('broker down'))
  })
})
