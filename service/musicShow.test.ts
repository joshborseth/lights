import { Effect, Fiber, Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  DEFAULT_MUSIC_CONFIG,
  type MusicConfig,
  type NowPlaying,
} from '../src/music'
import { type MusicAnalysis } from '../src/musicShow'
import { type JsonObject, type LightStates } from './flash'
import { type MusicLightsPort } from './music'
import {
  type ShowTarget,
  catchUp,
  isMidSongChange,
  makeLightShow,
  sendAt,
  showTarget,
  songSecondsAt,
} from './musicShow'

const SHOW: MusicConfig = {
  ...DEFAULT_MUSIC_CONFIG,
  isEnabled: true,
  isShowOn: true,
}

const clock = { videoId: 'abc', positionSeconds: 10, at: 1_000_000 }

const nowPlaying = (overrides: Partial<NowPlaying> = {}): NowPlaying => ({
  _tag: 'NowPlaying',
  track: { videoId: 'abc', title: 'Song', artists: 'Artist' },
  playing: true,
  device: { kind: 'Tv' },
  color: '#1281b6',
  clock,
  ...overrides,
})

describe('showTarget', () => {
  test('plays the song on the TV from its clock', () => {
    expect(showTarget(Option.some(nowPlaying()), SHOW)).toEqual({
      videoId: 'abc',
      clock,
      group: 'All Lights',
      offsetMs: 0,
    })
  })

  test('stops when off, paused, on a phone, or without a clock', () => {
    const some = (overrides: Partial<NowPlaying>) =>
      showTarget(Option.some(nowPlaying(overrides)), SHOW)
    expect(
      showTarget(Option.some(nowPlaying()), { ...SHOW, isShowOn: false }),
    ).toBeNull()
    expect(
      showTarget(Option.some(nowPlaying()), { ...SHOW, isEnabled: false }),
    ).toBeNull()
    expect(some({ playing: false })).toBeNull()
    expect(some({ device: { kind: 'Web' } })).toBeNull()
    expect(some({ clock: null })).toBeNull()
    expect(some({ clock: { ...clock, videoId: 'other' } })).toBeNull()
    expect(showTarget(Option.none(), SHOW)).toBeNull()
  })

  test('follows a phone when not only on the TV', () => {
    expect(
      showTarget(Option.some(nowPlaying({ device: { kind: 'Web' } })), {
        ...SHOW,
        onlyOnTv: false,
      }),
    ).not.toBeNull()
  })
})

describe('isMidSongChange', () => {
  test('spots a clock that belongs to the next song', () => {
    expect(isMidSongChange(nowPlaying())).toBe(false)
    expect(isMidSongChange(nowPlaying({ clock: null }))).toBe(false)
    expect(
      isMidSongChange(nowPlaying({ clock: { ...clock, videoId: 'next' } })),
    ).toBe(true)
  })
})

describe('catchUp', () => {
  const commands = [
    { at: 1, light: 'A', brightness: 76 },
    { at: 1, light: 'B', brightness: 76 },
    { at: 5.2, light: 'B', brightness: 254 },
  ]

  test('sets each light to where the plan has it by now', () => {
    expect(catchUp(commands, ['A', 'B'], 3)).toEqual([
      { at: 3, light: 'A', brightness: 76 },
      { at: 3, light: 'B', brightness: 76 },
    ])
  })

  test('leaves lights the plan has not reached, or will reach in a moment', () => {
    expect(catchUp(commands, ['A', 'B'], 0.5)).toEqual([])
    expect(catchUp(commands, ['A', 'B'], 5)).toEqual([
      { at: 5, light: 'A', brightness: 76 },
    ])
  })
})

describe('timing', () => {
  const target: ShowTarget = {
    videoId: 'abc',
    clock,
    group: 'All Lights',
    offsetMs: 0,
  }

  test('sends ahead of the bulb so it changes as the beat is heard', () => {
    const sent = sendAt(target, 12)
    expect(sent).toBeGreaterThan(clock.at + 2000 - 200)
    expect(songSecondsAt(target, sent)).toBeCloseTo(12, 6)
  })

  test('the timing setting moves the show later or earlier', () => {
    expect(sendAt({ ...target, offsetMs: 100 }, 12)).toBe(
      sendAt(target, 12) + 100,
    )
    expect(sendAt({ ...target, offsetMs: -100 }, 12)).toBe(
      sendAt(target, 12) - 100,
    )
  })
})

describe('makeLightShow', () => {
  const ON = (brightness: number): JsonObject => ({
    state: 'ON',
    brightness,
    color: { x: 0.3, y: 0.3 },
  })

  const analysis: MusicAnalysis = {
    videoId: 'abc',
    durationSeconds: 2,
    tempo: 120,
    beats: [0, 0.5, 1, 1.5],
    downbeats: [0],
    sections: [{ kind: 'Chorus', startSeconds: 0, endSeconds: 2, energy: 1 }],
    drops: [],
  }

  const run = (
    options: Readonly<{
      states: LightStates
      isLockFree?: boolean
      /** A Rainbow starts on the lights after this many sends. */
      rainbowAfterSends?: number
      /** Putting brightness back fails this many times. */
      failedRestores?: number
    }>,
  ) => {
    let failedRestores = options.failedRestores ?? 0
    let isStopping = false
    const sent: Array<Readonly<{ name: string; payload: JsonObject }>> = []
    const logs: Array<string> = []
    const port: MusicLightsPort<string> = {
      groupMembers: () => ['Orb', 'Shroom', 'Lamp'],
      activeRainbowGroups: () =>
        options.rainbowAfterSends !== undefined &&
        sent.length >= options.rainbowAfterSends
          ? ['All Lights']
          : [],
      markRainbowStopped: () => {},
      readStates: names =>
        Effect.succeed(
          Object.fromEntries(
            names.flatMap(name => {
              const state = options.states[name]
              return state === undefined ? [] : [[name, state]]
            }),
          ),
        ),
      capabilitiesOf: () => ({ supportsColor: true, supportsColorTemp: true }),
      publishLight: (name, payload) =>
        isStopping && failedRestores > 0
          ? Effect.suspend(() => {
              failedRestores -= 1
              return Effect.fail('no broker')
            })
          : Effect.sync(() => {
              sent.push({ name, payload })
            }),
      publishGroup: () => Effect.void,
      sleep: () => Effect.void,
      log: text => Effect.sync(() => void logs.push(text)),
    }
    return Effect.runPromise(
      Effect.gen(function* () {
        const show = yield* makeLightShow({
          lights: port,
          tryLightsLock: effect =>
            options.isLockFree === false
              ? Effect.succeed(Option.none())
              : Effect.map(effect, Option.some),
          withLightsLock: effect => effect,
          fetchAnalysis: videoId =>
            Effect.succeed(
              videoId === 'abc' ? Option.some(analysis) : Option.none(),
            ),
          now: Effect.sync(() => Date.now()),
          errorText: error => error,
        })
        const fiber = yield* Effect.forkChild(show.run)
        // NOTE: The song started just now; offset the built-in delays so
        // each beat goes out at its own time.
        yield* show.follow({
          videoId: 'abc',
          clock: { videoId: 'abc', positionSeconds: 0, at: Date.now() },
          group: 'All Lights',
          offsetMs: -60,
        })
        yield* Effect.sleep('1200 millis')
        const status = yield* show.status
        const sentWhilePlaying = [...sent]
        isStopping = true
        yield* show.follow(null)
        yield* Effect.sleep('50 millis')
        const statusAfter = yield* show.status
        // NOTE: Play and stop once more, quickly, to see what a failed
        // restore leaves for the next stop.
        const sentBeforeSecond = sent.length
        yield* show.follow({
          videoId: 'abc',
          clock: { videoId: 'abc', positionSeconds: 1.8, at: Date.now() },
          group: 'All Lights',
          offsetMs: -60,
        })
        yield* Effect.sleep('50 millis')
        yield* show.follow(null)
        yield* Effect.sleep('50 millis')
        const sentSecond = sent.slice(sentBeforeSecond)
        yield* Fiber.interrupt(fiber)
        return {
          sent,
          sentWhilePlaying,
          sentSecond,
          status,
          statusAfter,
          logs,
        }
      }),
    )
  }

  test('moves the lights that are on with the beat, and puts them back after', async () => {
    const result = await run({
      states: { Orb: ON(120), Shroom: ON(80), Lamp: { state: 'OFF' } },
    })
    expect(result.sentWhilePlaying.length).toBeGreaterThan(2)
    expect(result.sent.some(({ name }) => name === 'Lamp')).toBe(false)
    result.sent.forEach(({ payload }) => {
      expect(Object.keys(payload)).toEqual(['brightness'])
    })
    expect(Option.getOrNull(result.status)).toBe(
      'Following the beat at 120 BPM · Chorus',
    )
    expect(result.sent.slice(-2)).toEqual([
      { name: 'Orb', payload: { brightness: 120 } },
      { name: 'Shroom', payload: { brightness: 80 } },
    ])
    expect(Option.isNone(result.statusAfter)).toBe(true)
  })

  test('leaves a Rainbow started during the show running when it stops', async () => {
    const result = await run({
      states: { Orb: ON(120), Shroom: ON(80) },
      rainbowAfterSends: 2,
    })
    expect(result.sentWhilePlaying).toHaveLength(2)
    expect(result.sent.slice(2, 4)).not.toContainEqual({
      name: 'Orb',
      payload: { brightness: 120 },
    })
    expect(result.logs.join('\n')).toContain('a Rainbow runs')
  })

  test('tries again to put brightness back after a failed try', async () => {
    const result = await run({
      states: { Orb: ON(120), Shroom: ON(80) },
      failedRestores: 1,
    })
    expect(result.logs.join('\n')).toContain("couldn't put brightness back")
    expect(result.sentSecond.slice(-2)).toEqual([
      { name: 'Orb', payload: { brightness: 120 } },
      { name: 'Shroom', payload: { brightness: 80 } },
    ])
  })

  test('skips beats while a flash holds the lights, and has nothing to put back', async () => {
    const result = await run({
      states: { Orb: ON(120), Shroom: ON(80) },
      isLockFree: false,
    })
    expect(result.sent).toEqual([])
  })

  test('leaves the lights alone when none are on', async () => {
    const result = await run({ states: { Orb: { state: 'OFF' } } })
    expect(result.sent).toEqual([])
    expect(Option.getOrNull(result.status)).toBe(
      'No lights in All Lights are on.',
    )
  })
})
