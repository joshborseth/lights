import {
  Array,
  Duration,
  Effect,
  Match,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
  pipe,
} from 'effect'

import { hexToXy } from '../src/automation'
import {
  type BulbCapabilities,
  type MusicApplied,
  type MusicConfig,
  type MusicConnection,
  type MusicSnapshot,
  type NowPlaying,
  NowPlayingJson,
  musicCommands,
} from '../src/music'
import { type FlashPort, type JsonObject, isLightOn } from './flash'

/*
 * Music colors. Listens to the music server's `/now-playing` feed and, once a
 * new song has played for a moment, paints the bulbs in one group with its
 * cover's colors. Waiting for the song to settle keeps a run of skips from
 * flickering the bulbs. Commands run under the same lock as the PR flash, so
 * a flash never restores colors over a song change or the other way round.
 */

/** How long a song must stay current before the bulbs follow it. */
export const SETTLE_MS = 1500
const RECONNECT_MS = 5000
const STOP_LOOP_REPEAT_MS = 400

export type FeedEvent =
  | Readonly<{ _tag: 'Connected' }>
  | Readonly<{ _tag: 'Disconnected' }>
  | Readonly<{ _tag: 'Frame'; text: string }>

export type MusicLightsPort<E> = Pick<
  FlashPort<E>,
  | 'groupMembers'
  | 'activeRainbowGroups'
  | 'markRainbowStopped'
  | 'readStates'
  | 'publishLight'
  | 'publishGroup'
  | 'sleep'
  | 'log'
> &
  Readonly<{ capabilitiesOf: (name: string) => BulbCapabilities }>

export type MusicPorts<E> = Readonly<{
  lights: MusicLightsPort<E>
  withLightsLock: <A, E2>(effect: Effect.Effect<A, E2>) => Effect.Effect<A, E2>
  saveConfig: (config: MusicConfig) => Effect.Effect<void>
  feed: Stream.Stream<FeedEvent>
  now: Effect.Effect<number>
  errorText: (error: E) => string
  settleMs?: number
}>

export type MusicSync = Readonly<{
  snapshot: Effect.Effect<MusicSnapshot>
  saveConfig: (config: MusicConfig) => Effect.Effect<void>
  run: Effect.Effect<void>
}>

// DECISION

const songKey = (nowPlaying: NowPlaying): string =>
  [
    nowPlaying.track?.videoId ?? '',
    ...Array.map(nowPlaying.palette, ({ hex }) => hex),
  ].join(' ')

export type Decision =
  | Readonly<{ _tag: 'Wait' }>
  | Readonly<{ _tag: 'Skip'; reason: string }>
  | Readonly<{ _tag: 'Apply'; key: string; nowPlaying: NowPlaying }>

/**
 * Whether the bulbs should follow the song now. A song is applied once; a
 * song skipped only because it plays on the phone is looked at again when it
 * moves to the TV.
 */
export const decide = (
  maybeNowPlaying: Option.Option<NowPlaying>,
  config: MusicConfig,
  maybeAppliedKey: Option.Option<string>,
): Decision => {
  if (!config.isEnabled || Option.isNone(maybeNowPlaying)) {
    return { _tag: 'Wait' }
  }
  const nowPlaying = maybeNowPlaying.value
  if (nowPlaying.track === null || !nowPlaying.playing) {
    return { _tag: 'Wait' }
  }
  if (config.onlyOnTv && nowPlaying.device?.kind !== 'Tv') {
    return { _tag: 'Skip', reason: 'Playing on a phone, not the TV.' }
  }
  const key = songKey(nowPlaying)
  return Option.contains(maybeAppliedKey, key)
    ? { _tag: 'Wait' }
    : { _tag: 'Apply', key, nowPlaying }
}

// APPLY

type ApplyResult =
  | Readonly<{ _tag: 'Applied'; colors: ReadonlyArray<string>; lights: number }>
  | Readonly<{ _tag: 'Skipped'; reason: string }>

const overlaps = (
  members: ReadonlyArray<string>,
  others: ReadonlyArray<string>,
): boolean => Array.some(members, member => Array.contains(others, member))

export const applySong = <E>(
  lights: MusicLightsPort<E>,
  nowPlaying: NowPlaying,
  config: MusicConfig,
): Effect.Effect<ApplyResult, E> =>
  Effect.gen(function* () {
    const members = lights.groupMembers(config.group)
    if (Array.isReadonlyArrayEmpty(members)) {
      return { _tag: 'Skipped', reason: `${config.group} has no lights.` }
    }
    const loopsToStop = Array.filter(lights.activeRainbowGroups(), group =>
      overlaps(lights.groupMembers(group), members),
    )
    // NOTE: Ask only for bulbs we have never heard from, and only `state`
    // (see readStates). While a Rainbow runs, listen instead, as the flash does.
    const known = yield* lights.readStates(members, { shouldAskBulbs: false })
    const missing = Array.filter(members, name => known[name] === undefined)
    const asked =
      Array.isReadonlyArrayEmpty(missing) ||
      Array.isReadonlyArrayNonEmpty(loopsToStop)
        ? {}
        : yield* lights.readStates(missing, { shouldAskBulbs: true })
    const states: Readonly<Record<string, JsonObject>> = { ...known, ...asked }
    const bulbs = pipe(
      members,
      Array.filter(name => states[name] !== undefined),
      Array.map(name => ({
        name,
        isOn: isLightOn(states[name] ?? {}),
        capabilities: lights.capabilitiesOf(name),
      })),
    )
    const commands = musicCommands(
      Array.map(nowPlaying.palette, ({ hex }) => hex),
      bulbs,
      config,
    )
    const first = commands[0]
    if (first === undefined) {
      return {
        _tag: 'Skipped',
        reason: `No lights in ${config.group} were on.`,
      }
    }
    // NOTE: A Rainbow loop is stopped with a group command in x and y, twice,
    // as the flash does. A per-light command alone would not stop it.
    yield* Effect.forEach(
      loopsToStop,
      group =>
        Effect.gen(function* () {
          yield* lights.log(`stopping Rainbow on ${group} for music colors`)
          const frame = { color: hexToXy(first.hex) }
          yield* lights.publishGroup(group, frame)
          yield* lights.sleep(STOP_LOOP_REPEAT_MS)
          yield* lights.publishGroup(group, frame)
          lights.markRainbowStopped(group)
        }),
      { discard: true },
    )
    yield* Effect.forEach(
      commands,
      command => lights.publishLight(command.name, command.payload),
      { discard: true },
    )
    return {
      _tag: 'Applied',
      colors: Array.dedupe(Array.map(commands, ({ hex }) => hex)),
      lights: commands.length,
    }
  })

// SYNC

const decodeFrame = Schema.decodeUnknownOption(NowPlayingJson)

export const makeMusicSync = <E>(
  ports: MusicPorts<E>,
  initialConfig: MusicConfig,
): Effect.Effect<MusicSync> =>
  Effect.gen(function* () {
    const configRef = yield* Ref.make(initialConfig)
    const connectionRef = yield* Ref.make<MusicConnection>('Connecting')
    const nowPlayingRef = yield* Ref.make(Option.none<NowPlaying>())
    const appliedKeyRef = yield* Ref.make(Option.none<string>())
    const lastAppliedRef = yield* Ref.make(Option.none<MusicApplied>())
    const lastSkipRef = yield* Ref.make(Option.none<string>())
    const nudges = yield* Queue.sliding<void>(1)

    const nudge = Queue.offer(nudges, undefined).pipe(Effect.asVoid)

    const consider = Effect.gen(function* () {
      const config = yield* Ref.get(configRef)
      const decision = decide(
        yield* Ref.get(nowPlayingRef),
        config,
        yield* Ref.get(appliedKeyRef),
      )
      if (decision._tag === 'Wait') {
        return
      }
      if (decision._tag === 'Skip') {
        yield* Ref.set(lastSkipRef, Option.some(decision.reason))
        return
      }
      yield* Ref.set(appliedKeyRef, Option.some(decision.key))
      const title = decision.nowPlaying.track?.title ?? ''
      const result = yield* ports
        .withLightsLock(applySong(ports.lights, decision.nowPlaying, config))
        .pipe(
          Effect.catch(error =>
            Effect.succeed<ApplyResult>({
              _tag: 'Skipped',
              reason: `Couldn't reach the lights: ${ports.errorText(error)}`,
            }),
          ),
        )
      if (result._tag === 'Skipped') {
        yield* ports.lights.log(
          `music colors skipped ${title}: ${result.reason}`,
        )
        yield* Ref.set(lastSkipRef, Option.some(result.reason))
        return
      }
      yield* ports.lights.log(
        `music colors: ${title} on ${result.lights} lights (${result.colors.join(' ')})`,
      )
      yield* Ref.set(lastSkipRef, Option.none())
      yield* Ref.set(
        lastAppliedRef,
        Option.some({
          at: yield* ports.now,
          title,
          colors: result.colors,
          lights: result.lights,
        }),
      )
    })

    const handle = (event: FeedEvent): Effect.Effect<void> =>
      Match.value(event).pipe(
        Match.tagsExhaustive({
          Connected: () => Ref.set(connectionRef, 'Connected'),
          Disconnected: () => Ref.set(connectionRef, 'Unreachable'),
          Frame: ({ text }) =>
            Option.match(decodeFrame(text), {
              onNone: () =>
                ports.lights.log('music feed sent an unknown frame'),
              onSome: nowPlaying =>
                Ref.set(nowPlayingRef, Option.some(nowPlaying)).pipe(
                  Effect.andThen(nudge),
                ),
            }),
        }),
      )

    const settleMs = ports.settleMs ?? SETTLE_MS

    const snapshot: Effect.Effect<MusicSnapshot> = Effect.gen(function* () {
      const maybeNowPlaying = yield* Ref.get(nowPlayingRef)
      return {
        generatedAt: yield* ports.now,
        config: yield* Ref.get(configRef),
        connection: yield* Ref.get(connectionRef),
        maybeSong: Option.flatMap(maybeNowPlaying, nowPlaying =>
          nowPlaying.track === null
            ? Option.none()
            : Option.some({
                title: nowPlaying.track.title,
                artists: nowPlaying.track.artists,
                isPlaying: nowPlaying.playing,
                isOnTv: nowPlaying.device?.kind === 'Tv',
                colors: Array.map(nowPlaying.palette, ({ hex }) => hex),
              }),
        ),
        maybeLastApplied: yield* Ref.get(lastAppliedRef),
        maybeLastSkip: yield* Ref.get(lastSkipRef),
      }
    })

    return {
      snapshot,
      saveConfig: config =>
        Effect.gen(function* () {
          yield* Ref.set(configRef, config)
          yield* ports.saveConfig(config)
          // NOTE: New settings apply to the song already playing.
          yield* Ref.set(appliedKeyRef, Option.none())
          yield* Ref.set(lastSkipRef, Option.none())
          yield* nudge
        }),
      run: Effect.all(
        [
          ports.feed.pipe(Stream.runForEach(handle)),
          Stream.fromQueue(nudges).pipe(
            Stream.debounce(Duration.millis(settleMs)),
            Stream.runForEach(() => consider),
          ),
        ],
        { concurrency: 'unbounded', discard: true },
      ),
    }
  })

// FEED

/**
 * The music server's `/now-playing` WebSocket as a stream of events. It
 * reconnects on its own, every few seconds, for as long as the stream runs.
 */
export const connectMusicFeed = (
  url: string,
  log: (text: string) => void,
): Stream.Stream<FeedEvent> =>
  Stream.callback<FeedEvent>(queue =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let isClosed = false
        let maybeSocket: WebSocket | undefined
        let maybeTimer: ReturnType<typeof setTimeout> | undefined
        let wasConnected = true

        const connect = (): void => {
          const socket = new WebSocket(url)
          maybeSocket = socket
          socket.addEventListener('open', () => {
            wasConnected = true
            log(`connected to the music feed at ${url}`)
            Queue.offerUnsafe(queue, { _tag: 'Connected' })
          })
          socket.addEventListener('message', event => {
            Queue.offerUnsafe(queue, {
              _tag: 'Frame',
              text: String(event.data),
            })
          })
          socket.addEventListener('close', () => {
            if (wasConnected) {
              log('lost the music feed; retrying')
            }
            wasConnected = false
            Queue.offerUnsafe(queue, { _tag: 'Disconnected' })
            if (!isClosed) {
              maybeTimer = setTimeout(connect, RECONNECT_MS)
            }
          })
        }

        connect()
        return () => {
          isClosed = true
          clearTimeout(maybeTimer)
          maybeSocket?.close()
        }
      }),
      close => Effect.sync(close),
    ),
  )
