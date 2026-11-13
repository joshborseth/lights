import { Array, Effect, Queue, Stream, pipe } from 'effect'

import { hexToXy } from '../src/automation'
import { type BulbCapabilities, colorCommands } from '../src/bulbColor'
import { type FlashPort, type JsonObject, isLightOn } from './flash'

/*
 * Painting a group one color, under the rules in docs/migration-plan.md, and
 * the WebSocket feed Screen colors listens to.
 */

const RECONNECT_MS = 5000
const STOP_LOOP_REPEAT_MS = 400

export type PaintLightsPort<E> = Pick<
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

export type ApplyResult =
  | Readonly<{ _tag: 'Applied'; color: string; lights: number }>
  | Readonly<{ _tag: 'Skipped'; reason: string }>

const overlaps = (
  members: ReadonlyArray<string>,
  others: ReadonlyArray<string>,
): boolean => Array.some(members, member => Array.contains(others, member))

/**
 * Paints the lit bulbs in `group` one color (see `colorCommands`), after
 * stopping any Rainbow loop that overlaps them.
 */
export const applyColor = <E>(
  lights: PaintLightsPort<E>,
  color: string,
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
    const commands = colorCommands(color, bulbs)
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

// FEED

export type FeedEvent =
  | Readonly<{ _tag: 'Connected' }>
  | Readonly<{ _tag: 'Disconnected' }>
  | Readonly<{ _tag: 'Frame'; text: string }>

/**
 * A read-only WebSocket feed as a stream of events. It reconnects on its own,
 * every few seconds, for as long as the stream runs, and closes when the
 * stream ends. `name` is how the log calls it.
 */
export const connectFeed = (
  url: string,
  name: string,
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
            log(`connected to the ${name} at ${url}`)
            Queue.offerUnsafe(queue, { _tag: 'Connected' })
          })
          socket.addEventListener('message', event => {
            Queue.offerUnsafe(queue, {
              _tag: 'Frame',
              text: String(event.data),
            })
          })
          socket.addEventListener('close', () => {
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
