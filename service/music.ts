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
  type MusicCue,
  type MusicFollow,
  MusicFollowJson,
  type MusicSnapshot,
  type NowPlaying,
  NowPlayingJson,
  followedKinds,
  musicCommands,
} from '../src/music'
import { type MusicAnalysis, MusicAnalysisJson } from '../src/musicShow'
import { type FlashPort, type JsonObject, isLightOn } from './flash'
import {
  type ShowPorts,
  isMidSongChange,
  makeLightShow,
  showTarget,
} from './musicShow'

/*
 * Music colors. Listens to the music server's `/now-playing` feed and paints
 * the bulbs in one group with the cover color of the song playing. Commands
 * run under the same lock as the PR flash, so a flash never restores colors
 * over a song change or the other way round.
 *
 * On the TV the bulbs change with the music. The service tells the music
 * server it follows the TV (`Follow`), so the TV holds each song it jumps to
 * until it is loaded and its color known, then starts it with a cue for now.
 * A song that follows the last with no gap gets its cue ahead of time. A cue
 * is painted at its moment, with no waiting. Anything without a cue (music on
 * a phone, an older music server) is painted once the song has played for a
 * moment, so a run of skips doesn't flicker the bulbs.
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
  tryLightsLock: ShowPorts<E>['tryLightsLock']
  fetchAnalysis: ShowPorts<E>['fetchAnalysis']
  saveConfig: (config: MusicConfig) => Effect.Effect<void>
  feed: Stream.Stream<FeedEvent>
  /** Tell the music server whose songs the bulbs follow. */
  follow: (kinds: MusicFollow['kinds']) => Effect.Effect<void>
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

const colorKey = (videoId: string, color: string | null): string =>
  [videoId, color ?? ''].join(' ')

const songKey = (nowPlaying: NowPlaying): string =>
  colorKey(nowPlaying.track?.videoId ?? '', nowPlaying.color)

/**
 * Whether the bulbs should take a cue's color: on, following this player, and
 * not already showing it.
 */
export const shouldPaintCue = (
  cue: MusicCue,
  maybeNowPlaying: Option.Option<NowPlaying>,
  config: MusicConfig,
  maybeAppliedKey: Option.Option<string>,
): boolean =>
  config.isEnabled &&
  (!config.onlyOnTv ||
    Option.exists(maybeNowPlaying, ({ device }) => device?.kind === 'Tv')) &&
  !Option.contains(maybeAppliedKey, colorKey(cue.videoId, cue.color))

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

export type ApplyResult =
  | Readonly<{ _tag: 'Applied'; color: string; lights: number }>
  | Readonly<{ _tag: 'Skipped'; reason: string }>

const overlaps = (
  members: ReadonlyArray<string>,
  others: ReadonlyArray<string>,
): boolean => Array.some(members, member => Array.contains(others, member))

/**
 * Paints the lit bulbs in `group` one color, or warm white for none (see
 * `musicCommands`), after stopping any Rainbow loop that overlaps them. Music
 * colors and Screen colors both use it.
 */
export const applyColor = <E>(
  lights: MusicLightsPort<E>,
  maybeColor: Option.Option<string>,
  group: string,
): Effect.Effect<ApplyResult, E> =>
  Effect.gen(function* () {
    const members = lights.groupMembers(group)
    if (Array.isReadonlyArrayEmpty(members)) {
      return { _tag: 'Skipped', reason: `${group} has no lights.` }
    }
    const loopsToStop = Array.filter(lights.activeRainbowGroups(), other =>
      overlaps(lights.groupMembers(other), members),
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
    const commands = musicCommands(maybeColor, bulbs)
    const first = commands[0]
    if (first === undefined) {
      return {
        _tag: 'Skipped',
        reason: `No lights in ${group} were on.`,
      }
    }
    // NOTE: A Rainbow loop is stopped with a group command in x and y, twice,
    // as the flash does. A per-light command alone would not stop it.
    yield* Effect.forEach(
      loopsToStop,
      loop =>
        Effect.gen(function* () {
          yield* lights.log(`stopping Rainbow on ${loop} to paint ${group}`)
          const frame = { color: hexToXy(first.hex) }
          yield* lights.publishGroup(loop, frame)
          yield* lights.sleep(STOP_LOOP_REPEAT_MS)
          yield* lights.publishGroup(loop, frame)
          lights.markRainbowStopped(loop)
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
      color: first.hex,
      lights: commands.length,
    }
  })

export const applySong = <E>(
  lights: MusicLightsPort<E>,
  song: Pick<NowPlaying, 'color'>,
  config: MusicConfig,
): Effect.Effect<ApplyResult, E> =>
  applyColor(lights, Option.fromNullOr(song.color), config.group)

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
    /** The latest cue, or null once there is none: a new one replaces it. */
    const cues = yield* Queue.sliding<MusicCue | null>(1)
    const lastCueRef = yield* Ref.make<MusicCue | null>(null)
    const show = yield* makeLightShow(ports)

    const followShow = Effect.gen(function* () {
      const maybeNowPlaying = yield* Ref.get(nowPlayingRef)
      if (Option.exists(maybeNowPlaying, isMidSongChange)) {
        return
      }
      yield* show.follow(showTarget(maybeNowPlaying, yield* Ref.get(configRef)))
    })

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
      yield* paint(
        decision.key,
        decision.nowPlaying,
        decision.nowPlaying.track?.title ?? '',
        config,
      )
    })

    /** Paint a cue's color at its moment, unless something replaces it first. */
    const paintCue = (cue: MusicCue) =>
      Effect.gen(function* () {
        const wait = cue.at - (yield* ports.now)
        if (wait > 0) {
          yield* Effect.sleep(Duration.millis(wait))
        }
        const config = yield* Ref.get(configRef)
        const maybeNowPlaying = yield* Ref.get(nowPlayingRef)
        if (
          !shouldPaintCue(
            cue,
            maybeNowPlaying,
            config,
            yield* Ref.get(appliedKeyRef),
          )
        ) {
          return
        }
        const title = Option.match(
          Option.flatMap(maybeNowPlaying, ({ track }) =>
            Option.fromNullOr(track),
          ),
          {
            onNone: () => cue.videoId,
            onSome: track =>
              track.videoId === cue.videoId ? track.title : 'the next song',
          },
        )
        yield* paint(
          colorKey(cue.videoId, cue.color),
          { color: cue.color },
          title,
          config,
        )
      })

    const paint = (
      key: string,
      song: Pick<NowPlaying, 'color'>,
      title: string,
      config: MusicConfig,
    ) =>
      Effect.gen(function* () {
        yield* Ref.set(appliedKeyRef, Option.some(key))
        const result = yield* ports
          .withLightsLock(applySong(ports.lights, song, config))
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
          `music colors: ${title} on ${result.lights} lights (${result.color})`,
        )
        yield* Ref.set(lastSkipRef, Option.none())
        yield* Ref.set(
          lastAppliedRef,
          Option.some({
            at: yield* ports.now,
            title,
            color: result.color,
            lights: result.lights,
          }),
        )
      })

    /** Hand a frame's cue to the painter when it is new, or cancel one gone. */
    const takeCue = (nowPlaying: NowPlaying) =>
      Effect.gen(function* () {
        const cue = nowPlaying.cue ?? null
        const last = yield* Ref.getAndSet(lastCueRef, cue)
        if (JSON.stringify(cue) !== JSON.stringify(last)) {
          yield* Queue.offer(cues, cue)
        }
      })

    const handle = (event: FeedEvent): Effect.Effect<void> =>
      Match.value(event).pipe(
        Match.tagsExhaustive({
          Connected: () => Ref.set(connectionRef, 'Connected'),
          Disconnected: () =>
            Ref.set(connectionRef, 'Unreachable').pipe(
              Effect.andThen(show.follow(null)),
            ),
          Frame: ({ text }) =>
            Option.match(decodeFrame(text), {
              onNone: () =>
                ports.lights.log('music feed sent an unknown frame'),
              onSome: nowPlaying =>
                Ref.set(nowPlayingRef, Option.some(nowPlaying)).pipe(
                  Effect.andThen(takeCue(nowPlaying)),
                  Effect.andThen(followShow),
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
                maybeColor: Option.fromNullOr(nowPlaying.color),
              }),
        ),
        maybeLastApplied: yield* Ref.get(lastAppliedRef),
        maybeLastSkip: yield* Ref.get(lastSkipRef),
        maybeShow: yield* show.status,
      }
    })

    return {
      snapshot,
      saveConfig: config =>
        Effect.gen(function* () {
          yield* Ref.set(configRef, config)
          yield* ports.saveConfig(config)
          yield* ports.follow(followedKinds(config))
          yield* followShow
          // NOTE: New settings apply to the song already playing.
          yield* Ref.set(appliedKeyRef, Option.none())
          yield* Ref.set(lastSkipRef, Option.none())
          yield* nudge
        }),
      run: Effect.all(
        [
          Ref.get(configRef).pipe(
            Effect.flatMap(config => ports.follow(followedKinds(config))),
          ),
          ports.feed.pipe(Stream.runForEach(handle)),
          show.run,
          Stream.fromQueue(cues).pipe(
            Stream.switchMap(cue =>
              cue === null ? Stream.empty : Stream.fromEffect(paintCue(cue)),
            ),
            Stream.runDrain,
          ),
          Stream.fromQueue(nudges).pipe(
            Stream.debounce(Duration.millis(settleMs)),
            Stream.runForEach(() => consider),
          ),
        ],
        { concurrency: 'unbounded', discard: true },
      ),
    }
  })

// ANALYSIS

/** The music server analyzes a song on the spot, after it downloads. */
const ANALYSIS_TIMEOUT_MS = 150_000

const decodeAnalysis = Schema.decodeUnknownOption(MusicAnalysisJson)

/** Where the music server serves song analyses, next to its feed. */
export const analysisUrl = (feedUrl: string, videoId: string): string => {
  const url = new URL(feedUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = '/tv/analysis'
  url.search = new URLSearchParams({ videoId }).toString()
  return url.toString()
}

/**
 * Each song's beats, bars, sections, and drops from the music server, the
 * same analysis its TV visuals use. None when it has none for the song.
 */
export const makeAnalysisFetcher =
  (feedUrl: string, log: (text: string) => void) =>
  (videoId: string): Effect.Effect<Option.Option<MusicAnalysis>> =>
    Effect.tryPromise(async () => {
      const response = await fetch(analysisUrl(feedUrl, videoId), {
        signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS),
      })
      return response.ok ? await response.text() : undefined
    }).pipe(
      Effect.map(text =>
        text === undefined ? Option.none() : decodeAnalysis(text),
      ),
      Effect.tap(maybeAnalysis =>
        Effect.sync(() => {
          if (Option.isNone(maybeAnalysis)) {
            log(`light show: no analysis for ${videoId}`)
          }
        }),
      ),
      Effect.catch(error =>
        Effect.sync(() => {
          log(`light show: couldn't get the analysis for ${videoId}: ${error}`)
          return Option.none<MusicAnalysis>()
        }),
      ),
    )

// FEED

const encodeFollow = Schema.encodeSync(MusicFollowJson)

export type MusicFeed = Readonly<{
  /** Events from the socket. It reconnects on its own while this runs. */
  events: Stream.Stream<FeedEvent>
  /** Say whose songs the bulbs follow, now and after every reconnect. */
  follow: (kinds: MusicFollow['kinds']) => Effect.Effect<void>
}>

/**
 * A read-only WebSocket feed as a stream of events. It reconnects on its own,
 * every few seconds, for as long as the stream runs, and closes when the
 * stream ends. `name` is how the log calls it. `onOpen` and `onClose` see
 * each socket as it opens and closes.
 */
export const connectFeed = (
  url: string,
  name: string,
  log: (text: string) => void,
  hooks: Readonly<{
    onOpen?: (socket: WebSocket) => void
    onClose?: (socket: WebSocket) => void
  }> = {},
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
            log(`connected to the ${name} at ${url}`)
            hooks.onOpen?.(socket)
            Queue.offerUnsafe(queue, { _tag: 'Connected' })
          })
          socket.addEventListener('message', event => {
            Queue.offerUnsafe(queue, {
              _tag: 'Frame',
              text: String(event.data),
            })
          })
          socket.addEventListener('close', () => {
            hooks.onClose?.(socket)
            // NOTE: Closed on purpose: the stream ended.
            if (isClosed) {
              return
            }
            if (wasConnected) {
              log(`lost the ${name}; retrying`)
            }
            wasConnected = false
            Queue.offerUnsafe(queue, { _tag: 'Disconnected' })
            maybeTimer = setTimeout(connect, RECONNECT_MS)
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

/**
 * The music server's `/now-playing` WebSocket. It reconnects on its own,
 * every few seconds, for as long as `events` runs, and says again whom the
 * bulbs follow each time it connects.
 */
export const connectMusicFeed = (
  url: string,
  log: (text: string) => void,
): MusicFeed => {
  let kinds: MusicFollow['kinds'] = []
  let maybeOpenSocket: WebSocket | undefined

  const sendFollow = (socket: WebSocket): void => {
    socket.send(encodeFollow({ _tag: 'Follow', kinds }))
  }

  const events = connectFeed(url, 'music feed', log, {
    onOpen: socket => {
      maybeOpenSocket = socket
      sendFollow(socket)
    },
    onClose: socket => {
      if (maybeOpenSocket === socket) {
        maybeOpenSocket = undefined
      }
    },
  })

  return {
    events,
    follow: next =>
      Effect.sync(() => {
        kinds = next
        if (maybeOpenSocket !== undefined) {
          sendFollow(maybeOpenSocket)
        }
      }),
  }
}
