import {
  Duration,
  Effect,
  Match,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from 'effect'

import {
  type ScreenApplied,
  type ScreenColors,
  ScreenColorsJson,
  type ScreenConfig,
  type ScreenConnection,
  type ScreenSnapshot,
} from '../src/screen'
import {
  type ApplyResult,
  type FeedEvent,
  type PaintLightsPort,
  applyColor,
} from './paint'

/*
 * Screen colors. While Screen colors is on, listens to the Joshflix relay's
 * screen feed and paints the bulbs in one group the color on screen. The
 * relay already waits for a new color to hold before sending it, so only a
 * short settle is needed here. While it is off, the service doesn't listen
 * at all, so the TV stops reading its picture. Commands run under the same
 * lock as the PR flash.
 */

/** How long a new color must stay current before the bulbs follow it. */
export const SETTLE_MS = 400

export type ScreenPorts<E> = Readonly<{
  lights: PaintLightsPort<E>
  withLightsLock: <A, E2>(effect: Effect.Effect<A, E2>) => Effect.Effect<A, E2>
  saveConfig: (config: ScreenConfig) => Effect.Effect<void>
  /** The relay's feed. Run only while Screen colors is on. */
  feed: Stream.Stream<FeedEvent>
  now: Effect.Effect<number>
  errorText: (error: E) => string
  settleMs?: number
}>

export type ScreenSync = Readonly<{
  snapshot: Effect.Effect<ScreenSnapshot>
  saveConfig: (config: ScreenConfig) => Effect.Effect<void>
  run: Effect.Effect<void>
}>

// DECISION

export type Decision =
  | Readonly<{ _tag: 'Wait' }>
  | Readonly<{ _tag: 'Apply'; color: string; title: string }>

/**
 * Whether the bulbs should take the screen's color now. Each color is applied
 * once. A dark or grey picture (no color), a pause, or a stop leaves the
 * lights as they are.
 */
export const decide = (
  maybeFrame: Option.Option<ScreenColors>,
  config: ScreenConfig,
  maybeAppliedColor: Option.Option<string>,
): Decision => {
  if (!config.isEnabled || Option.isNone(maybeFrame)) {
    return { _tag: 'Wait' }
  }
  const { playing, color, title } = maybeFrame.value
  if (!playing || color === null || Option.contains(maybeAppliedColor, color)) {
    return { _tag: 'Wait' }
  }
  return { _tag: 'Apply', color, title: title ?? 'Joshflix' }
}

// SYNC

type ScreenEvent =
  | FeedEvent
  | Readonly<{ _tag: 'Off' }>
  | Readonly<{ _tag: 'Listening' }>

const decodeFrame = Schema.decodeUnknownOption(ScreenColorsJson)

export const makeScreenSync = <E>(
  ports: ScreenPorts<E>,
  initialConfig: ScreenConfig,
): Effect.Effect<ScreenSync> =>
  Effect.gen(function* () {
    const configRef = yield* Ref.make(initialConfig)
    const connectionRef = yield* Ref.make<ScreenConnection>(
      initialConfig.isEnabled ? 'Connecting' : 'Off',
    )
    const frameRef = yield* Ref.make(Option.none<ScreenColors>())
    const appliedColorRef = yield* Ref.make(Option.none<string>())
    const lastAppliedRef = yield* Ref.make(Option.none<ScreenApplied>())
    const lastSkipRef = yield* Ref.make(Option.none<string>())
    const nudges = yield* Queue.sliding<void>(1)
    const enabledChanges = yield* Queue.sliding<boolean>(1)
    yield* Queue.offer(enabledChanges, initialConfig.isEnabled)

    const nudge = Queue.offer(nudges, undefined).pipe(Effect.asVoid)

    const consider = Effect.gen(function* () {
      const config = yield* Ref.get(configRef)
      const decision = decide(
        yield* Ref.get(frameRef),
        config,
        yield* Ref.get(appliedColorRef),
      )
      if (decision._tag === 'Wait') {
        return
      }
      const { color, title } = decision
      yield* Ref.set(appliedColorRef, Option.some(color))
      const result = yield* ports
        .withLightsLock(applyColor(ports.lights, color, config.group))
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
          `screen colors skipped ${title}: ${result.reason}`,
        )
        yield* Ref.set(lastSkipRef, Option.some(result.reason))
        return
      }
      yield* ports.lights.log(
        `screen colors: ${title} on ${result.lights} lights (${result.color})`,
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

    const onFrame = (frame: ScreenColors): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.set(frameRef, Option.some(frame))
        // NOTE: After a pause or stop, the next color is sent again even when
        // it is the same, so the lights pick up where the picture is.
        if (!frame.playing) {
          yield* Ref.set(appliedColorRef, Option.none())
        }
        yield* nudge
      })

    const handle = (event: ScreenEvent): Effect.Effect<void> =>
      Match.value(event).pipe(
        Match.tagsExhaustive({
          Off: () =>
            Effect.all([
              Ref.set(connectionRef, 'Off'),
              Ref.set(frameRef, Option.none()),
              Ref.set(appliedColorRef, Option.none()),
            ]),
          Listening: () => Ref.set(connectionRef, 'Connecting'),
          Connected: () => Ref.set(connectionRef, 'Connected'),
          Disconnected: () => Ref.set(connectionRef, 'Unreachable'),
          Frame: ({ text }) =>
            Option.match(decodeFrame(text), {
              onNone: () =>
                ports.lights.log('screen feed sent an unknown frame'),
              onSome: onFrame,
            }),
        }),
        Effect.asVoid,
      )

    const settleMs = ports.settleMs ?? SETTLE_MS

    const snapshot: Effect.Effect<ScreenSnapshot> = Effect.gen(function* () {
      const maybeFrame = yield* Ref.get(frameRef)
      return {
        generatedAt: yield* ports.now,
        config: yield* Ref.get(configRef),
        connection: yield* Ref.get(connectionRef),
        maybeShow: Option.flatMap(maybeFrame, frame =>
          frame.title === null
            ? Option.none()
            : Option.some({
                title: frame.title,
                isPlaying: frame.playing,
                maybeColor: Option.fromNullOr(frame.color),
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
          // NOTE: New settings apply to the color already on screen.
          yield* Ref.set(appliedColorRef, Option.none())
          yield* Ref.set(lastSkipRef, Option.none())
          yield* Queue.offer(enabledChanges, config.isEnabled)
          yield* nudge
        }),
      run: Effect.all(
        [
          Stream.fromQueue(enabledChanges).pipe(
            Stream.changes,
            Stream.switchMap((isEnabled): Stream.Stream<ScreenEvent> =>
              isEnabled
                ? Stream.concat(
                    Stream.succeed<ScreenEvent>({ _tag: 'Listening' }),
                    ports.feed,
                  )
                : Stream.succeed<ScreenEvent>({ _tag: 'Off' }),
            ),
            Stream.runForEach(handle),
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
