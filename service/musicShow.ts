import {
  Array,
  Duration,
  Effect,
  Fiber,
  Option,
  Queue,
  Ref,
  Stream,
  pipe,
} from 'effect'

import type { MusicClock, MusicConfig, NowPlaying } from '../src/music'
import {
  MIN_BULB_GAP_SECONDS,
  type MusicAnalysis,
  type ShowCommand,
  levelsAt,
  planShow,
  sectionNameAt,
} from '../src/musicShow'
import { type JsonObject, isLightOn } from './flash'
import type { MusicLightsPort } from './music'

/*
 * Plays the light show (`src/musicShow.ts`) against the song's clock from the
 * music server. Each song's plan is worked out once, when it starts, for the
 * lights that are on then; each command goes out when its beat is heard.
 *
 * The show only moves brightness. Each light's brightness from before the
 * show is kept and put back when the show stops: on pause, when nothing
 * plays, when music moves to a phone (with Only on the TV), or when the show
 * is turned off. A light turned off during the show stays off.
 *
 * Show commands never wait for the lights lock: a beat that comes while the
 * PR flash runs is skipped, so the show never lands late.
 */

/**
 * The TV reports the position it hands to its audio output; the sound comes
 * out of the speakers about this much later.
 */
const SOUND_DELAY_MS = 120
/** From publishing a command to the bulb changing, over Zigbee. */
const ZIGBEE_DELAY_MS = 60
/** Brightness kept from before the show stays good for this long after it is put back. */
const BASELINE_REUSE_MS = 10_000
const ANALYSES_KEPT = 12
/** A song with no analysis is asked for again after this long. */
const MISSING_RETRY_MS = 60_000
const FULL_BRIGHTNESS = 254

/**
 * Whether a frame is mid song change: its clock belongs to another song than
 * its track. The music server sends none, but the show keeps going through
 * one rather than stop and start again.
 */
export const isMidSongChange = (nowPlaying: NowPlaying): boolean => {
  const clock = nowPlaying.clock ?? null
  return clock !== null && clock.videoId !== nowPlaying.track?.videoId
}

export type ShowTarget = Readonly<{
  videoId: string
  clock: MusicClock
  group: string
  offsetMs: number
}>

/** The show to play now, or none. */
export const showTarget = (
  maybeNowPlaying: Option.Option<NowPlaying>,
  config: MusicConfig,
): ShowTarget | null => {
  if (!config.isEnabled || !config.isShowOn) {
    return null
  }
  return pipe(
    maybeNowPlaying,
    Option.filter(
      nowPlaying =>
        nowPlaying.playing &&
        (!config.onlyOnTv || nowPlaying.device?.kind === 'Tv'),
    ),
    Option.flatMap(nowPlaying =>
      Option.fromNullOr(nowPlaying.clock ?? null).pipe(
        Option.filter(clock => clock.videoId === nowPlaying.track?.videoId),
      ),
    ),
    Option.map(clock => ({
      videoId: clock.videoId,
      clock,
      group: config.group,
      offsetMs: config.showOffsetMs,
    })),
    Option.getOrNull,
  )
}

/** When a moment of the song is heard, as this machine's time in ms. */
export const heardAt = (target: ShowTarget, seconds: number): number =>
  target.clock.at +
  (seconds - target.clock.positionSeconds) * 1000 +
  SOUND_DELAY_MS +
  target.offsetMs

/** When to publish a command so the bulb changes as its beat is heard. */
export const sendAt = (target: ShowTarget, seconds: number): number =>
  heardAt(target, seconds) - ZIGBEE_DELAY_MS

/** Where in the song the bulbs should be at this machine's time `now`. */
export const songSecondsAt = (target: ShowTarget, now: number): number =>
  target.clock.positionSeconds +
  (now + ZIGBEE_DELAY_MS - SOUND_DELAY_MS - target.offsetMs - target.clock.at) /
    1000

/** Commands that share a moment, in time order. */
export const batches = (
  commands: ReadonlyArray<ShowCommand>,
): ReadonlyArray<ReadonlyArray<ShowCommand>> => {
  const groups: Array<Array<ShowCommand>> = []
  commands.forEach(command => {
    const last = groups[groups.length - 1]
    if (last !== undefined && last[0]?.at === command.at) {
      last.push(command)
    } else {
      groups.push([command])
    }
  })
  return groups
}

const brightnessOf = (state: JsonObject): number => {
  const brightness = state['brightness']
  return typeof brightness === 'number' && brightness > 0
    ? brightness
    : FULL_BRIGHTNESS
}

/**
 * Where to set each light when the show joins a song at `seconds`: the level
 * the plan has it at by then, for lights whose next command is not due
 * within a bulb's gap. Lights the plan hasn't reached keep their brightness.
 */
export const catchUp = (
  commands: ReadonlyArray<ShowCommand>,
  lights: ReadonlyArray<string>,
  seconds: number,
): ReadonlyArray<ShowCommand> => {
  const levels = levelsAt(commands, seconds)
  return Array.flatMap(lights, light => {
    const brightness = levels.get(light)
    const isNextSoon = commands.some(
      command =>
        command.light === light &&
        command.at > seconds &&
        command.at - seconds < MIN_BULB_GAP_SECONDS,
    )
    return brightness === undefined || isNextSoon
      ? []
      : [{ at: seconds, light, brightness }]
  })
}

export type ShowPorts<E> = Readonly<{
  lights: MusicLightsPort<E>
  /** Run light commands only if no flash holds the lights right now. */
  tryLightsLock: <A, E2>(
    effect: Effect.Effect<A, E2>,
  ) => Effect.Effect<Option.Option<A>, E2>
  withLightsLock: <A, E2>(effect: Effect.Effect<A, E2>) => Effect.Effect<A, E2>
  /** The song's beats from the music server; none when it has none. */
  fetchAnalysis: (
    videoId: string,
  ) => Effect.Effect<Option.Option<MusicAnalysis>>
  now: Effect.Effect<number>
  errorText: (error: E) => string
}>

export type LightShow = Readonly<{
  /** Play this show from now on, or stop with null. */
  follow: (target: ShowTarget | null) => Effect.Effect<void>
  status: Effect.Effect<Option.Option<string>>
  run: Effect.Effect<void>
}>

type Baseline = Readonly<{
  brightness: ReadonlyMap<string, number>
  /** When it was last put back on the bulbs, if it was. */
  maybeRestoredAt: Option.Option<number>
}>

type Plan = Readonly<{
  videoId: string
  lightsKey: string
  commands: ReadonlyArray<ShowCommand>
}>

export const makeLightShow = <E>(
  ports: ShowPorts<E>,
): Effect.Effect<LightShow> =>
  Effect.gen(function* () {
    const targets = yield* Queue.sliding<ShowTarget | null>(1)
    const statusRef = yield* Ref.make(Option.none<string>())
    /** The brightness to put back, while the show has moved the lights. */
    const baselineRef = yield* Ref.make(Option.none<Baseline>())
    /** Whether the show has sent anything since the lights were put back. */
    const isShowingRef = yield* Ref.make(false)
    const planRef = yield* Ref.make(Option.none<Plan>())
    /** The song the show last played, so a new clock for it doesn't jump. */
    const playedVideoRef = yield* Ref.make(Option.none<string>())
    const analyses = new Map<string, MusicAnalysis>()
    const missing = new Map<string, number>()
    /**
     * Requests on their way. A new clock restarts the show, which must not
     * throw away an analysis the music server is still working out.
     */
    const fetching = new Map<
      string,
      Fiber.Fiber<Option.Option<MusicAnalysis>>
    >()

    const setStatus = (text: string) => Ref.set(statusRef, Option.some(text))

    const analysisFor = (videoId: string) =>
      Effect.gen(function* () {
        const cached = analyses.get(videoId)
        if (cached !== undefined) {
          return Option.some(cached)
        }
        const now = yield* ports.now
        const missedAt = missing.get(videoId)
        if (missedAt !== undefined && now - missedAt < MISSING_RETRY_MS) {
          return Option.none<MusicAnalysis>()
        }
        const pending = fetching.get(videoId)
        if (pending !== undefined) {
          return yield* Fiber.join(pending)
        }
        const fiber = yield* Effect.forkDetach(
          ports.fetchAnalysis(videoId).pipe(
            Effect.tap(maybeAnalysis =>
              Effect.gen(function* () {
                const answeredAt = yield* ports.now
                Option.match(maybeAnalysis, {
                  onNone: () => {
                    missing.set(videoId, answeredAt)
                  },
                  onSome: analysis => {
                    if (analyses.size >= ANALYSES_KEPT) {
                      analyses.clear()
                    }
                    analyses.set(videoId, analysis)
                    missing.delete(videoId)
                  },
                })
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                fetching.delete(videoId)
              }),
            ),
          ),
        )
        fetching.set(videoId, fiber)
        return yield* Fiber.join(fiber)
      })

    /** The song's analysis, asking again every so often until there is one. */
    const awaitAnalysis = (videoId: string): Effect.Effect<MusicAnalysis> =>
      Effect.gen(function* () {
        if (!analyses.has(videoId)) {
          yield* setStatus('Getting the beats of this song…')
        }
        const maybeAnalysis = yield* analysisFor(videoId)
        if (Option.isSome(maybeAnalysis)) {
          return maybeAnalysis.value
        }
        yield* setStatus(
          'The music app has no beats for this song yet. Colors only for now.',
        )
        yield* Effect.sleep(Duration.millis(MISSING_RETRY_MS))
        return yield* awaitAnalysis(videoId)
      })

    const readKnown = (names: ReadonlyArray<string>) =>
      ports.lights.readStates(names, { shouldAskBulbs: false })

    const rainbowOverlaps = (members: ReadonlyArray<string>) =>
      Array.some(ports.lights.activeRainbowGroups(), group =>
        Array.some(ports.lights.groupMembers(group), member =>
          Array.contains(members, member),
        ),
      )

    /** Brightness to put back later, kept from before the show moved it. */
    const keepBaseline = (
      states: Readonly<Record<string, JsonObject>>,
      lit: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const now = yield* ports.now
        const maybeBaseline = yield* Ref.get(baselineRef)
        const isShowing = yield* Ref.get(isShowingRef)
        const isFresh = Option.exists(
          maybeBaseline,
          ({ maybeRestoredAt }) =>
            isShowing ||
            Option.exists(
              maybeRestoredAt,
              restoredAt => now - restoredAt < BASELINE_REUSE_MS,
            ),
        )
        const brightness = new Map(
          isFresh
            ? Option.match(maybeBaseline, {
                onNone: () => [],
                onSome: baseline => [...baseline.brightness],
              })
            : [],
        )
        lit.forEach(name => {
          if (!brightness.has(name)) {
            brightness.set(name, brightnessOf(states[name] ?? {}))
          }
        })
        yield* Ref.set(
          baselineRef,
          Option.some({ brightness, maybeRestoredAt: Option.none() }),
        )
      })

    /** Send one moment's commands to the lights that are still on. */
    const sendBatch = (
      batch: ReadonlyArray<ShowCommand>,
      members: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        if (rainbowOverlaps(members)) {
          yield* setStatus('Waiting for the Rainbow on these lights to stop.')
          return
        }
        yield* ports.tryLightsLock(
          Effect.gen(function* () {
            const states = yield* readKnown(
              Array.map(batch, ({ light }) => light),
            )
            // NOTE: Before publishing, so a show stopped part way through a
            // batch still puts the lights back.
            yield* Ref.set(isShowingRef, true)
            yield* Effect.forEach(
              batch,
              ({ light, brightness }) =>
                isLightOn(states[light] ?? {})
                  ? ports.lights.publishLight(light, { brightness })
                  : Effect.void,
              { discard: true },
            )
          }),
        )
      })

    const play = (target: ShowTarget) =>
      Effect.gen(function* () {
        const analysis = yield* awaitAnalysis(target.videoId)
        const members = ports.lights.groupMembers(target.group)
        const states = yield* readKnown(members)
        const lit = pipe(
          members,
          Array.filter(name => isLightOn(states[name] ?? {})),
          Array.sort((x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)),
        )
        if (Array.isReadonlyArrayEmpty(lit)) {
          yield* setStatus(`No lights in ${target.group} are on.`)
          return
        }
        yield* keepBaseline(states, lit)
        const lightsKey = lit.join('\n')
        const plan = yield* Ref.get(planRef).pipe(
          Effect.map(
            Option.filter(
              cached =>
                cached.videoId === target.videoId &&
                cached.lightsKey === lightsKey,
            ),
          ),
          Effect.map(
            Option.getOrElse(() => ({
              videoId: target.videoId,
              lightsKey,
              commands: planShow(analysis, lit),
            })),
          ),
        )
        yield* Ref.set(planRef, Option.some(plan))

        const status = (seconds: number) =>
          [
            `Following the beat at ${Math.round(analysis.tempo)} BPM`,
            sectionNameAt(analysis, seconds),
          ]
            .filter(part => part !== undefined)
            .join(' · ')

        const startedAt = songSecondsAt(target, yield* ports.now)
        yield* setStatus(status(startedAt))
        const isSameSong = Option.contains(
          yield* Ref.get(playedVideoRef),
          target.videoId,
        )
        yield* Ref.set(playedVideoRef, Option.some(target.videoId))
        // NOTE: Joining a song part way through sets each light to where the
        // show has it by now, unless its next level is about to come anyway.
        // A light the show hasn't reached yet keeps its brightness. A new
        // clock for the same song carries on.
        if (!isSameSong) {
          yield* sendBatch(catchUp(plan.commands, lit, startedAt), members)
        }
        const ahead = Array.filter(
          batches(plan.commands),
          batch => (batch[0]?.at ?? 0) > startedAt,
        )
        yield* Effect.forEach(
          ahead,
          batch =>
            Effect.gen(function* () {
              const at = batch[0]?.at ?? 0
              const wait = sendAt(target, at) - (yield* ports.now)
              if (wait > 0) {
                yield* Effect.sleep(Duration.millis(wait))
              }
              yield* sendBatch(batch, members)
              yield* setStatus(status(at))
            }),
          { discard: true },
        )
      }).pipe(
        Effect.catch(error =>
          setStatus(`Couldn't reach the lights: ${ports.errorText(error)}`),
        ),
      )

    /** Put each light's brightness back, if the show moved it. */
    const stop = Effect.gen(function* () {
      yield* Ref.set(statusRef, Option.none())
      yield* Ref.set(playedVideoRef, Option.none())
      if (!(yield* Ref.get(isShowingRef))) {
        return
      }
      const maybeBaseline = yield* Ref.get(baselineRef)
      if (Option.isNone(maybeBaseline)) {
        return
      }
      const brightness = maybeBaseline.value.brightness
      const names = [...brightness.keys()]
      // NOTE: Any command to a bulb ends a Rainbow on a group that holds it.
      // A Rainbow started during the show has set its own brightness, so it
      // is left running and the kept brightness is dropped.
      if (rainbowOverlaps(names)) {
        yield* ports.lights.log(
          'light show stopped; a Rainbow runs on these lights, so brightness stays',
        )
        yield* Ref.set(isShowingRef, false)
        yield* Ref.set(baselineRef, Option.none())
        return
      }
      const isRestored = yield* ports
        .withLightsLock(
          Effect.gen(function* () {
            const states = yield* readKnown(names)
            yield* Effect.forEach(
              names,
              name => {
                const level = brightness.get(name)
                return level !== undefined && isLightOn(states[name] ?? {})
                  ? ports.lights.publishLight(name, { brightness: level })
                  : Effect.void
              },
              { discard: true },
            )
          }),
        )
        .pipe(
          Effect.as(true),
          Effect.catch(error =>
            ports.lights
              .log(
                `light show couldn't put brightness back: ${ports.errorText(error)}`,
              )
              .pipe(Effect.as(false)),
          ),
        )
      // NOTE: Still showing, so the next stop tries again and the next show
      // keeps the brightness from before.
      if (!isRestored) {
        return
      }
      yield* ports.lights.log('light show stopped; brightness put back')
      yield* Ref.set(isShowingRef, false)
      yield* Ref.set(
        baselineRef,
        Option.some({
          brightness,
          maybeRestoredAt: Option.some(yield* ports.now),
        }),
      )
    })

    return {
      follow: target => Queue.offer(targets, target).pipe(Effect.asVoid),
      status: Ref.get(statusRef),
      run: Stream.fromQueue(targets).pipe(
        Stream.changesWith((x, y) => JSON.stringify(x) === JSON.stringify(y)),
        Stream.switchMap(target =>
          Stream.fromEffect(target === null ? stop : play(target)),
        ),
        Stream.runDrain,
      ),
    }
  })
