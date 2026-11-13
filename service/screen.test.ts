import { Effect, Fiber, Option, Queue, Stream } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  DEFAULT_SCREEN_CONFIG,
  type ScreenColors,
  type ScreenConfig,
} from '../src/screen'
import { type JsonObject } from './flash'
import { type FeedEvent, type PaintLightsPort } from './paint'
import { decide, makeScreenSync } from './screen'

const ON: JsonObject = { state: 'ON', brightness: 120 }
const ENABLED: ScreenConfig = { ...DEFAULT_SCREEN_CONFIG, isEnabled: true }

const screenColors = (overrides: Partial<ScreenColors> = {}): ScreenColors => ({
  _tag: 'ScreenColors',
  playing: true,
  title: 'Dune: Part Two',
  color: '#c8742f',
  ...overrides,
})

const frame = (overrides: Partial<ScreenColors> = {}): FeedEvent => ({
  _tag: 'Frame',
  text: JSON.stringify(screenColors(overrides)),
})

describe('decide', () => {
  const playing = Option.some(screenColors())

  test('waits while off, paused, dark, or with nothing playing', () => {
    expect(decide(playing, DEFAULT_SCREEN_CONFIG, Option.none())._tag).toBe(
      'Wait',
    )
    expect(decide(Option.none(), ENABLED, Option.none())._tag).toBe('Wait')
    for (const overrides of [{ playing: false }, { color: null }]) {
      expect(
        decide(Option.some(screenColors(overrides)), ENABLED, Option.none())
          ._tag,
      ).toBe('Wait')
    }
  })

  test('applies each color once', () => {
    expect(decide(playing, ENABLED, Option.none())).toEqual({
      _tag: 'Apply',
      color: '#c8742f',
      title: 'Dune: Part Two',
    })
    expect(decide(playing, ENABLED, Option.some('#c8742f'))._tag).toBe('Wait')
    expect(
      decide(
        Option.some(screenColors({ color: '#1e3cc8' })),
        ENABLED,
        Option.some('#c8742f'),
      )._tag,
    ).toBe('Apply')
  })
})

describe('makeScreenSync', () => {
  const setup = (config: ScreenConfig) => {
    const sent: Array<Readonly<{ name: string; payload: JsonObject }>> = []
    const feedOpens: Array<'open' | 'close'> = []
    const port: PaintLightsPort<string> = {
      groupMembers: group =>
        group === 'All Lights' ? ['Orb', 'Shroom'] : ['Lamp'],
      activeRainbowGroups: () => [],
      markRainbowStopped: () => {},
      readStates: names =>
        Effect.succeed(Object.fromEntries(names.map(name => [name, ON]))),
      capabilitiesOf: () => ({ supportsColor: true, supportsColorTemp: true }),
      publishLight: (name, payload) =>
        Effect.sync(() => {
          sent.push({ name, payload })
        }),
      publishGroup: () => Effect.void,
      sleep: () => Effect.void,
      log: () => Effect.void,
    }
    return Effect.gen(function* () {
      const queue = yield* Queue.unbounded<FeedEvent>()
      const feed = Stream.unwrap(
        Effect.sync(() => {
          feedOpens.push('open')
          return Stream.fromQueue(queue)
        }),
      ).pipe(Stream.ensuring(Effect.sync(() => void feedOpens.push('close'))))
      const sync = yield* makeScreenSync(
        {
          lights: port,
          withLightsLock: effect => effect,
          saveConfig: () => Effect.void,
          feed,
          now: Effect.succeed(1000),
          errorText: error => error,
          settleMs: 20,
        },
        config,
      )
      const fiber = yield* Effect.forkChild(sync.run)
      const settle = Effect.sleep('80 millis')
      return { sync, queue, fiber, sent, feedOpens, settle }
    })
  }

  test('listens to the relay only while it is on', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { sync, fiber, feedOpens, settle } = yield* setup(
          DEFAULT_SCREEN_CONFIG,
        )
        yield* settle
        const whileOff = [...feedOpens]
        const offSnapshot = yield* sync.snapshot
        yield* sync.saveConfig(ENABLED)
        yield* settle
        const whileOn = [...feedOpens]
        yield* sync.saveConfig(DEFAULT_SCREEN_CONFIG)
        yield* settle
        const afterOff = [...feedOpens]
        const lastSnapshot = yield* sync.snapshot
        yield* Fiber.interrupt(fiber)
        return { whileOff, offSnapshot, whileOn, afterOff, lastSnapshot }
      }),
    )
    expect(result.whileOff).toEqual([])
    expect(result.offSnapshot.connection).toBe('Off')
    expect(result.whileOn).toEqual(['open'])
    expect(result.afterOff).toEqual(['open', 'close'])
    expect(result.lastSnapshot.connection).toBe('Off')
  })

  test('paints the lit bulbs each new color, holding through dark scenes and pauses', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { sync, queue, fiber, sent, settle } = yield* setup(ENABLED)
        const step = (event: FeedEvent) =>
          Queue.offer(queue, event).pipe(Effect.andThen(settle))
        const counts: Array<number> = []
        yield* step({ _tag: 'Connected' })
        yield* step(frame())
        counts.push(sent.length)
        yield* step(frame({ color: null }))
        counts.push(sent.length)
        yield* step(frame({ playing: false }))
        counts.push(sent.length)
        // After a pause, the same color goes out again.
        yield* step(frame())
        counts.push(sent.length)
        yield* step(frame({ color: '#1e3cc8' }))
        counts.push(sent.length)
        const snapshot = yield* sync.snapshot
        yield* Fiber.interrupt(fiber)
        return { counts, sent, snapshot }
      }),
    )
    expect(result.counts).toEqual([2, 2, 2, 4, 6])
    expect(result.sent.slice(0, 2).map(({ name }) => name)).toEqual([
      'Orb',
      'Shroom',
    ])
    const text = JSON.stringify(result.sent)
    expect(text).toContain('"x":')
    for (const banned of ['hex', 'hue', 'transition', 'state', 'brightness']) {
      expect(text).not.toContain(banned)
    }
    expect(result.snapshot.connection).toBe('Connected')
    expect(
      Option.map(result.snapshot.maybeLastApplied, ({ title, lights }) => ({
        title,
        lights,
      })),
    ).toEqual(Option.some({ title: 'Dune: Part Two', lights: 2 }))
    expect(
      Option.map(result.snapshot.maybeShow, ({ maybeColor }) => maybeColor),
    ).toEqual(Option.some(Option.some('#1e3cc8')))
  })

  test('follows only the color that settles', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { sync, queue, fiber, sent, settle } = yield* setup(ENABLED)
        yield* Queue.offerAll(queue, [
          { _tag: 'Connected' },
          frame({ color: '#c8742f' }),
          frame({ color: '#1e3cc8' }),
        ])
        yield* settle
        const snapshot = yield* sync.snapshot
        yield* Fiber.interrupt(fiber)
        return { sent, snapshot }
      }),
    )
    expect(result.sent).toHaveLength(2)
    expect(
      Option.map(result.snapshot.maybeLastApplied, ({ color }) => color),
    ).not.toEqual(Option.some('#c8742f'))
  })

  test('ignores frames it cannot read and reports a lost connection', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { sync, queue, fiber, sent, settle } = yield* setup(ENABLED)
        yield* Queue.offerAll(queue, [
          { _tag: 'Frame', text: '{"_tag":"NowPlaying"}' },
          { _tag: 'Frame', text: 'not json' },
          { _tag: 'Disconnected' },
        ])
        yield* settle
        const snapshot = yield* sync.snapshot
        yield* Fiber.interrupt(fiber)
        return { sent, snapshot }
      }),
    )
    expect(result.sent).toEqual([])
    expect(result.snapshot.maybeShow).toEqual(Option.none())
    expect(result.snapshot.connection).toBe('Unreachable')
  })
})
