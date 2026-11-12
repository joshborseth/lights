import { Effect, Fiber, Option, Queue, Stream } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  DEFAULT_MUSIC_CONFIG,
  type MusicConfig,
  type NowPlaying,
} from '../src/music'
import { type JsonObject, type LightStates } from './flash'
import {
  type FeedEvent,
  type MusicLightsPort,
  applySong,
  decide,
  makeMusicSync,
} from './music'

type Sent =
  | Readonly<{ kind: 'light'; name: string; payload: JsonObject }>
  | Readonly<{ kind: 'group'; group: string; payload: JsonObject }>

const ON: JsonObject = {
  state: 'ON',
  brightness: 120,
  color: { x: 0.3, y: 0.3 },
}
const OFF: JsonObject = { state: 'OFF' }
const ENABLED: MusicConfig = { ...DEFAULT_MUSIC_CONFIG, isEnabled: true }

const nowPlaying = (
  videoId: string,
  overrides: Partial<NowPlaying> = {},
): NowPlaying => ({
  _tag: 'NowPlaying',
  track: { videoId, title: videoId, artists: 'Artist' },
  playing: true,
  device: { kind: 'Tv' },
  color: '#1281b6',
  ...overrides,
})

const makePort = (
  options: Readonly<{
    states: LightStates
    rainbow?: ReadonlyArray<string>
    groups?: Readonly<Record<string, ReadonlyArray<string>>>
  }>,
) => {
  const sent: Array<Sent> = []
  const asked: Array<ReadonlyArray<string>> = []
  const stopped: Array<string> = []
  const groups = options.groups ?? { 'All Lights': ['Orb', 'Shroom'] }
  const port: MusicLightsPort<string> = {
    groupMembers: group => groups[group] ?? [],
    activeRainbowGroups: () => options.rainbow ?? [],
    markRainbowStopped: group => {
      stopped.push(group)
    },
    readStates: (names, { shouldAskBulbs }) =>
      Effect.sync(() => {
        if (shouldAskBulbs) asked.push(names)
        return Object.fromEntries(
          names.flatMap(name => {
            const state = options.states[name]
            return state === undefined ? [] : [[name, state]]
          }),
        )
      }),
    capabilitiesOf: () => ({ supportsColor: true, supportsColorTemp: true }),
    publishLight: (name, payload) =>
      Effect.sync(() => {
        sent.push({ kind: 'light', name, payload })
      }),
    publishGroup: (group, payload) =>
      Effect.sync(() => {
        sent.push({ kind: 'group', group, payload })
      }),
    sleep: () => Effect.void,
    log: () => Effect.void,
  }
  return { port, sent, asked, stopped }
}

describe('decide', () => {
  const playing = Option.some(nowPlaying('a'))

  test('waits while off, paused, or with nothing playing', () => {
    expect(decide(playing, DEFAULT_MUSIC_CONFIG, Option.none())._tag).toBe(
      'Wait',
    )
    expect(
      decide(
        Option.some(nowPlaying('a', { playing: false })),
        ENABLED,
        Option.none(),
      )._tag,
    ).toBe('Wait')
    expect(
      decide(
        Option.some(nowPlaying('a', { track: null })),
        ENABLED,
        Option.none(),
      )._tag,
    ).toBe('Wait')
  })

  test('skips music on a phone unless told to follow it', () => {
    const onPhone = Option.some(nowPlaying('a', { device: { kind: 'Web' } }))
    expect(decide(onPhone, ENABLED, Option.none())._tag).toBe('Skip')
    expect(
      decide(onPhone, { ...ENABLED, onlyOnTv: false }, Option.none())._tag,
    ).toBe('Apply')
  })

  test('applies each song once', () => {
    const first = decide(playing, ENABLED, Option.none())
    expect(first._tag).toBe('Apply')
    const key = first._tag === 'Apply' ? first.key : ''
    expect(decide(playing, ENABLED, Option.some(key))._tag).toBe('Wait')
    expect(
      decide(Option.some(nowPlaying('b')), ENABLED, Option.some(key))._tag,
    ).toBe('Apply')
  })
})

describe('applySong', () => {
  test('colors only the lights that are on, as x and y', async () => {
    const { port, sent } = makePort({ states: { Orb: ON, Shroom: OFF } })
    const result = await Effect.runPromise(
      applySong(port, nowPlaying('a'), ENABLED),
    )
    expect(result._tag).toBe('Applied')
    expect(sent.map(entry => entry.kind === 'light' && entry.name)).toEqual([
      'Orb',
    ])
    const text = JSON.stringify(sent)
    expect(text).toContain('"x":')
    for (const banned of ['hex', 'hue', 'transition', 'state', 'brightness']) {
      expect(text).not.toContain(banned)
    }
  })

  test('skips when every light in the group is off', async () => {
    const { port, sent } = makePort({ states: { Orb: OFF, Shroom: OFF } })
    const result = await Effect.runPromise(
      applySong(port, nowPlaying('a'), ENABLED),
    )
    expect(result).toEqual({
      _tag: 'Skipped',
      reason: 'No lights in All Lights were on.',
    })
    expect(sent).toEqual([])
  })

  test('asks only the bulbs it has not heard from', async () => {
    const { port, asked } = makePort({ states: { Orb: ON } })
    await Effect.runPromise(applySong(port, nowPlaying('a'), ENABLED))
    expect(asked).toEqual([['Shroom']])
  })

  test('stops an overlapping Rainbow with a group x and y command, twice', async () => {
    const { port, sent, stopped } = makePort({
      states: { Orb: ON, Shroom: ON },
      rainbow: ['All Lights', 'Elsewhere'],
      groups: { 'All Lights': ['Orb', 'Shroom'], Elsewhere: ['Lamp'] },
    })
    await Effect.runPromise(applySong(port, nowPlaying('a'), ENABLED))
    const groupSends = sent.filter(entry => entry.kind === 'group')
    expect(groupSends).toHaveLength(2)
    expect(
      groupSends.every(
        entry => entry.kind === 'group' && entry.group === 'All Lights',
      ),
    ).toBe(true)
    expect(JSON.stringify(groupSends)).not.toContain('hex')
    expect(stopped).toEqual(['All Lights'])
    expect(sent.slice(0, 2)).toEqual(groupSends)
  })
})

describe('makeMusicSync', () => {
  const run = async (
    events: ReadonlyArray<FeedEvent>,
    config: MusicConfig = ENABLED,
  ) => {
    const { port, sent } = makePort({ states: { Orb: ON, Shroom: ON } })
    const saved: Array<MusicConfig> = []
    return Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<FeedEvent>()
        const sync = yield* makeMusicSync(
          {
            lights: port,
            withLightsLock: effect => effect,
            saveConfig: next => Effect.sync(() => void saved.push(next)),
            feed: Stream.fromQueue(queue),
            now: Effect.succeed(1000),
            errorText: error => error,
            settleMs: 20,
          },
          config,
        )
        const fiber = yield* Effect.forkChild(sync.run)
        yield* Queue.offerAll(queue, events)
        yield* Effect.sleep('80 millis')
        const before = yield* sync.snapshot
        const sentBeforeSave = sent.length
        yield* sync.saveConfig({ ...config, isEnabled: true })
        yield* Effect.sleep('80 millis')
        yield* Fiber.interrupt(fiber)
        return {
          sent,
          sentBeforeSave,
          before,
          after: yield* sync.snapshot,
          saved,
        }
      }),
    )
  }

  const frame = (value: NowPlaying): FeedEvent => ({
    _tag: 'Frame',
    text: JSON.stringify(value),
  })

  test('follows only the song that settles after a run of skips', async () => {
    const { sentBeforeSave, before } = await run([
      { _tag: 'Connected' },
      frame(nowPlaying('first')),
      frame(nowPlaying('second', { color: '#e03070' })),
    ])
    expect(before.connection).toBe('Connected')
    expect(Option.map(before.maybeLastApplied, ({ title }) => title)).toEqual(
      Option.some('second'),
    )
    expect(sentBeforeSave).toBe(2)
  })

  test('turning it on paints the song already playing', async () => {
    const { sentBeforeSave, sent, after, saved } = await run(
      [{ _tag: 'Connected' }, frame(nowPlaying('a'))],
      DEFAULT_MUSIC_CONFIG,
    )
    expect(sentBeforeSave).toBe(0)
    expect(sent).toHaveLength(2)
    expect(saved).toHaveLength(1)
    expect(Option.isSome(after.maybeLastApplied)).toBe(true)
  })

  test('ignores frames it cannot read', async () => {
    const { sentBeforeSave, before } = await run([
      { _tag: 'Frame', text: '{"_tag":"Something"}' },
      { _tag: 'Frame', text: 'not json' },
    ])
    expect(sentBeforeSave).toBe(0)
    expect(before.maybeSong).toEqual(Option.none())
  })

  test('reports a lost connection', async () => {
    const { before } = await run([
      { _tag: 'Connected' },
      { _tag: 'Disconnected' },
    ])
    expect(before.connection).toBe('Unreachable')
  })
})
