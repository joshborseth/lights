import {
  Array,
  Cause,
  Duration,
  Effect,
  Option,
  Ref,
  Schema,
  pipe,
} from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'
import { readFile } from 'node:fs/promises'

import { type FlashPort, OFF_FRAME, PRESET_GROUPS } from './flash'

const MILLIS_PER_SECOND = 1000
const MILLIS_PER_MINUTE = 60_000
// NOTE: The kernel waits 5 seconds, then asks three times a second apart, so a
// shorter wait reads a phone that is still being asked as one that is gone.
const REPLY_WAIT_MS = 10_000
const SWEEP_EVERY_MS = 5 * MILLIS_PER_MINUTE
const OFF_STEP_MS = 400

const MIN_PROBE_SECONDS = 15
const MAX_PROBE_SECONDS = 120
const MIN_AWAY_MINUTES = 5
const MAX_AWAY_MINUTES = 240

const MAC_ADDRESS = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/
const IPV4_ON_SLASH_24 = /^((?:\d{1,3}\.){3})\d{1,3}$/

// NOTE: Rest of the House goes first because a command to All Lights does not
// end a Rainbow loop on that group, and the loop would repaint its bulbs. All
// Lights goes twice to catch a frame already in flight.
const ALL_OFF_SEQUENCE: ReadonlyArray<string> = [
  'Rest of the House',
  'All Lights',
  'All Lights',
]

// CONFIG

export const PresenceAction = Schema.Literals(['LogOnly', 'TurnOffLights'])
export type PresenceAction = typeof PresenceAction.Type

export const PresencePhone = Schema.Struct({
  name: Schema.String,
  mac: Schema.String,
})
export type PresencePhone = typeof PresencePhone.Type

export const PresenceConfig = Schema.Struct({
  action: PresenceAction,
  gateway: Schema.String,
  phones: Schema.Array(PresencePhone),
  probeSeconds: Schema.Number,
  awayMinutes: Schema.Number,
})
export type PresenceConfig = typeof PresenceConfig.Type

const isWhole = (value: number, min: number, max: number): boolean =>
  Number.isInteger(value) && value >= min && value <= max

export const normalizePresenceConfig = (
  config: PresenceConfig,
): PresenceConfig => ({
  ...config,
  phones: Array.map(config.phones, phone => ({
    name: phone.name.trim(),
    mac: phone.mac.trim().toLowerCase().replaceAll('-', ':'),
  })),
})

export const presenceConfigProblem = (
  config: PresenceConfig,
): Option.Option<string> => {
  const macs = Array.map(config.phones, phone => phone.mac)
  const problems: ReadonlyArray<readonly [boolean, string]> = [
    [Array.isReadonlyArrayNonEmpty(config.phones), 'Add at least one phone.'],
    [
      Array.every(config.phones, phone => phone.name !== ''),
      'Every phone needs a name.',
    ],
    [
      Array.every(macs, mac => MAC_ADDRESS.test(mac)),
      'A phone has an invalid Wi-Fi address.',
    ],
    [new Set(macs).size === macs.length, 'Two phones share a Wi-Fi address.'],
    [
      IPV4_ON_SLASH_24.test(config.gateway),
      'The gateway must be an IPv4 address.',
    ],
    [
      isWhole(config.probeSeconds, MIN_PROBE_SECONDS, MAX_PROBE_SECONDS),
      `probeSeconds must be from ${MIN_PROBE_SECONDS} to ${MAX_PROBE_SECONDS}.`,
    ],
    [
      isWhole(config.awayMinutes, MIN_AWAY_MINUTES, MAX_AWAY_MINUTES),
      `awayMinutes must be from ${MIN_AWAY_MINUTES} to ${MAX_AWAY_MINUTES}.`,
    ],
  ]
  return pipe(
    problems,
    Array.findFirst(([isValid]) => !isValid),
    Option.map(([, problem]) => problem),
  )
}

export const PresenceConfigFile = defineTaggedUnion({
  Missing: {},
  Invalid: { problem: Schema.String },
  Ready: { config: PresenceConfig },
})
export type PresenceConfigFile = typeof PresenceConfigFile.Type

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const decodePresenceConfig = (text: string): PresenceConfigFile =>
  Option.match(Schema.decodeUnknownOption(PresenceConfig)(parseJson(text)), {
    onNone: () =>
      PresenceConfigFile.Invalid({ problem: 'The file could not be read.' }),
    onSome: decoded => {
      const config = normalizePresenceConfig(decoded)
      return Option.match(presenceConfigProblem(config), {
        onNone: () => PresenceConfigFile.Ready({ config }),
        onSome: problem => PresenceConfigFile.Invalid({ problem }),
      })
    },
  })

export const readPresenceConfig = (
  path: string,
): Effect.Effect<PresenceConfigFile> =>
  Effect.promise(() =>
    readFile(path, 'utf8').then(decodePresenceConfig, () =>
      PresenceConfigFile.Missing(),
    ),
  )

// STATE

export type PhoneStatus = 'Home' | 'Away'
export type HouseWatch = 'WaitingForSomeone' | 'WaitingForEmptyHouse'
export type NetworkStatus = 'Answering' | 'Silent'

export type TrackedPhone = Readonly<{
  name: string
  mac: string
  status: PhoneStatus
  lastSeenAt: number
  maybeAddress: Option.Option<string>
}>

export type PresenceState = Readonly<{
  phones: ReadonlyArray<TrackedPhone>
  house: HouseWatch
  network: NetworkStatus
  lastRoundAt: number
  lastSweepAt: number
}>

export const Neighbour = Schema.Struct({
  mac: Schema.String,
  address: Schema.String,
})
export type Neighbour = typeof Neighbour.Type

export const Observation = defineTaggedUnion({
  NetworkUnknown: {},
  Answered: { neighbours: Schema.Array(Neighbour) },
})
export type Observation = typeof Observation.Type

export const PresenceEvent = defineTaggedUnion({
  PhoneArrived: { name: Schema.String },
  PhoneLeft: { name: Schema.String },
  EveryoneLeft: {},
})
export type PresenceEvent = typeof PresenceEvent.Type

export type PresenceStep = Readonly<{
  state: PresenceState
  events: ReadonlyArray<PresenceEvent>
}>

// NOTE: Every phone starts Away with a fresh clock and nothing armed, so a
// restart with nobody seen yet can never turn the lights off.
export const initialPresence = (
  config: PresenceConfig,
  now: number,
): PresenceState => ({
  phones: Array.map(config.phones, ({ name, mac }) => ({
    name,
    mac,
    status: 'Away',
    lastSeenAt: now,
    maybeAddress: Option.none(),
  })),
  house: 'WaitingForSomeone',
  network: 'Answering',
  lastRoundAt: now,
  lastSweepAt: 0,
})

type ObservedPhone = Readonly<{
  phone: TrackedPhone
  maybeEvent: Option.Option<PresenceEvent>
}>

const observePhone = (
  phone: TrackedPhone,
  neighbours: ReadonlyArray<Neighbour>,
  now: number,
  awayMs: number,
): ObservedPhone =>
  Option.match(
    Array.findFirst(neighbours, neighbour => neighbour.mac === phone.mac),
    {
      onSome: ({ address }) => ({
        phone: {
          ...phone,
          status: 'Home',
          lastSeenAt: now,
          maybeAddress: Option.some(address),
        },
        maybeEvent:
          phone.status === 'Away'
            ? Option.some(PresenceEvent.PhoneArrived({ name: phone.name }))
            : Option.none(),
      }),
      onNone: () =>
        phone.status === 'Home' && now - phone.lastSeenAt >= awayMs
          ? {
              phone: { ...phone, status: 'Away' },
              maybeEvent: Option.some(
                PresenceEvent.PhoneLeft({ name: phone.name }),
              ),
            }
          : { phone, maybeEvent: Option.none() },
    },
  )

// NOTE: When this box cannot confirm the router is answering, silence from the
// phones means nothing. Their clocks stop for the length of the outage, so an
// outage never empties the house and a single missed reading costs one round.
export const stepPresence = (
  state: PresenceState,
  observation: Observation,
  now: number,
  awayMs: number,
): PresenceStep =>
  Observation.match(observation, {
    NetworkUnknown: (): PresenceStep => ({
      state: {
        ...state,
        network: 'Silent',
        lastRoundAt: now,
        phones: Array.map(state.phones, phone => ({
          ...phone,
          lastSeenAt: phone.lastSeenAt + (now - state.lastRoundAt),
        })),
      },
      events: [],
    }),
    Answered: ({ neighbours }): PresenceStep => {
      const observed = Array.map(state.phones, phone =>
        observePhone(phone, neighbours, now, awayMs),
      )
      const phones = Array.map(observed, entry => entry.phone)
      const isSomeoneHome = Array.some(phones, phone => phone.status === 'Home')
      const didEveryoneLeave =
        state.house === 'WaitingForEmptyHouse' && !isSomeoneHome
      return {
        state: {
          ...state,
          phones,
          network: 'Answering',
          lastRoundAt: now,
          house: isSomeoneHome ? 'WaitingForEmptyHouse' : 'WaitingForSomeone',
        },
        events: [
          ...Array.getSomes(Array.map(observed, entry => entry.maybeEvent)),
          ...(didEveryoneLeave ? [PresenceEvent.EveryoneLeft()] : []),
        ],
      }
    },
  })

// PROBING

export const subnetAddresses = (gateway: string): ReadonlyArray<string> => {
  const prefix = IPV4_ON_SLASH_24.exec(gateway)?.[1]
  return prefix === undefined
    ? []
    : Array.makeBy(254, index => `${prefix}${index + 1}`)
}

export type ProbePlan = Readonly<{
  addresses: ReadonlyArray<string>
  isSweep: boolean
}>

// NOTE: Most rounds ask only the phones' last addresses. Asking the whole
// subnet is what finds a phone whose address changed, but it broadcasts, so it
// stays rare.
export const planProbe = (
  state: PresenceState,
  gateway: string,
  now: number,
): ProbePlan => {
  const isSweep = now - state.lastSweepAt >= SWEEP_EVERY_MS
  return {
    isSweep,
    addresses: isSweep
      ? subnetAddresses(gateway)
      : Array.dedupe([
          gateway,
          ...Array.getSomes(
            Array.map(state.phones, phone => phone.maybeAddress),
          ),
        ]),
  }
}

export const turnOffAllLights = <E>(
  lights: Pick<FlashPort<E>, 'publishGroup' | 'markRainbowStopped' | 'sleep'>,
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    yield* Effect.forEach(
      ALL_OFF_SEQUENCE,
      group =>
        lights
          .publishGroup(group, OFF_FRAME)
          .pipe(Effect.andThen(lights.sleep(OFF_STEP_MS))),
      { discard: true },
    )
    PRESET_GROUPS.forEach(lights.markRainbowStopped)
  })

// WATCHER

export type PresencePorts<E> = Readonly<{
  nudge: (addresses: ReadonlyArray<string>) => Effect.Effect<void>
  observe: (gateway: string) => Effect.Effect<Observation>
  turnOffLights: Effect.Effect<void, E>
  now: Effect.Effect<number>
  sleep: (ms: number) => Effect.Effect<void>
  log: (text: string) => Effect.Effect<void>
  recordInfo: (text: string) => Effect.Effect<void>
  reportProblem: (text: string) => Effect.Effect<void>
  errorText: (error: E) => string
}>

export type PresenceWatcher = Readonly<{
  runRound: Effect.Effect<void>
  run: Effect.Effect<void>
}>

export const makePresenceWatcher = <E>(
  config: PresenceConfig,
  ports: PresencePorts<E>,
): Effect.Effect<PresenceWatcher> =>
  Effect.gen(function* () {
    const startedAt = yield* ports.now
    const stateRef = yield* Ref.make(initialPresence(config, startedAt))
    const awayMs = config.awayMinutes * MILLIS_PER_MINUTE

    const rearmAfterFailure = Ref.update(stateRef, (state): PresenceState => ({
      ...state,
      house: 'WaitingForEmptyHouse',
    }))

    const handleEveryoneLeft =
      config.action === 'LogOnly'
        ? ports.recordInfo('Nobody home. Would have turned all lights off.')
        : ports.turnOffLights.pipe(
            Effect.matchEffect({
              onFailure: error =>
                ports
                  .reportProblem(
                    `Presence could not turn the lights off: ${ports.errorText(error)}`,
                  )
                  .pipe(Effect.andThen(rearmAfterFailure)),
              onSuccess: () =>
                ports.recordInfo('Nobody home, so all lights were turned off.'),
            }),
          )

    const handleEvent = (event: PresenceEvent): Effect.Effect<void> =>
      PresenceEvent.match(event, {
        PhoneArrived: ({ name }) => ports.log(`presence: ${name} is home`),
        PhoneLeft: ({ name }) => ports.log(`presence: ${name} left`),
        EveryoneLeft: () => handleEveryoneLeft,
      })

    const runRound = Effect.gen(function* () {
      const before = yield* Ref.get(stateRef)
      const planned = yield* ports.now
      const plan = planProbe(before, config.gateway, planned)
      yield* ports.nudge(plan.addresses)
      yield* ports.sleep(REPLY_WAIT_MS)
      const observation = yield* ports.observe(config.gateway)
      const now = yield* ports.now
      const step = stepPresence(before, observation, now, awayMs)
      if (step.state.network !== before.network) {
        yield* ports.log(
          step.state.network === 'Silent'
            ? 'presence: the router stopped answering, so the away timers are paused'
            : 'presence: the router is answering again',
        )
      }
      yield* Ref.set(stateRef, {
        ...step.state,
        lastSweepAt: plan.isSweep ? planned : before.lastSweepAt,
      })
      yield* Effect.forEach(step.events, handleEvent, { discard: true })
    })

    const runRoundSafely = runRound.pipe(
      Effect.catchCause(cause =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : ports.reportProblem(`Presence crashed: ${Cause.pretty(cause)}`),
      ),
    )

    const run = Effect.forever(
      runRoundSafely.pipe(
        Effect.andThen(
          Effect.sleep(
            Duration.millis(config.probeSeconds * MILLIS_PER_SECOND),
          ),
        ),
      ),
    )

    return { runRound, run }
  })
