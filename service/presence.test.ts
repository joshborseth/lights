import { Effect, Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { type JsonObject, OFF_FRAME } from './flash'
import { observationFromNeighbourTable } from './network'
import {
  Observation,
  type PresenceConfig,
  PresenceConfigFile,
  type PresenceEvent,
  type PresenceState,
  decodePresenceConfig,
  initialPresence,
  makePresenceWatcher,
  planProbe,
  stepPresence,
  subnetAddresses,
  turnOffAllLights,
} from './presence'

const MINUTE = 60_000
const AWAY_MS = 15 * MINUTE
const START = 1_000_000_000
const GATEWAY = '192.168.1.254'
const ALICE_MAC = 'aa:aa:aa:aa:aa:aa'
const SAM_MAC = 'bb:bb:bb:bb:bb:bb'

const CONFIG: PresenceConfig = {
  action: 'TurnOffLights',
  gateway: GATEWAY,
  phones: [
    { name: 'Alice', mac: ALICE_MAC },
    { name: 'Sam', mac: SAM_MAC },
  ],
  probeSeconds: 30,
  awayMinutes: 15,
}

const answered = (...macs: ReadonlyArray<string>): Observation =>
  Observation.Answered({
    neighbours: [
      { mac: '02:00:00:00:00:fe', address: GATEWAY },
      ...macs.map((mac, index) => ({
        mac,
        address: `192.168.1.${index + 10}`,
      })),
    ],
  })

const tags = (events: ReadonlyArray<PresenceEvent>) =>
  events.map(event => event._tag)

const advance = (state: PresenceState, observation: Observation, at: number) =>
  stepPresence(state, observation, at, AWAY_MS)

describe('stepPresence', () => {
  test('never fires after a restart when nobody has been seen', () => {
    const first = advance(initialPresence(CONFIG, START), answered(), START)
    const later = advance(first.state, answered(), START + 120 * MINUTE)
    expect(tags(first.events)).toEqual([])
    expect(tags(later.events)).toEqual([])
  })

  test('a phone stays home through silence shorter than the grace period', () => {
    const seen = advance(
      initialPresence(CONFIG, START),
      answered(ALICE_MAC),
      START,
    )
    const quiet = advance(seen.state, answered(), START + 14 * MINUTE)
    expect(tags(quiet.events)).toEqual([])
    expect(quiet.state.phones[0]?.status).toBe('Home')
  })

  test('fires once when the only phone at home has been gone long enough', () => {
    const seen = advance(
      initialPresence(CONFIG, START),
      answered(ALICE_MAC),
      START,
    )
    const gone = advance(seen.state, answered(), START + AWAY_MS)
    const after = advance(gone.state, answered(), START + AWAY_MS + MINUTE)
    expect(tags(gone.events)).toEqual(['PhoneLeft', 'EveryoneLeft'])
    expect(tags(after.events)).toEqual([])
  })

  test('does not fire while the other phone is still home', () => {
    const seen = advance(
      initialPresence(CONFIG, START),
      answered(ALICE_MAC, SAM_MAC),
      START,
    )
    const oneGone = advance(seen.state, answered(SAM_MAC), START + AWAY_MS)
    expect(tags(oneGone.events)).toEqual(['PhoneLeft'])
  })

  test('fires again only after someone has come back', () => {
    const seen = advance(
      initialPresence(CONFIG, START),
      answered(ALICE_MAC),
      START,
    )
    const gone = advance(seen.state, answered(), START + AWAY_MS)
    const back = advance(gone.state, answered(SAM_MAC), START + 20 * MINUTE)
    const goneAgain = advance(back.state, answered(), START + 40 * MINUTE)
    expect(tags(back.events)).toEqual(['PhoneArrived'])
    expect(tags(goneAgain.events)).toEqual(['PhoneLeft', 'EveryoneLeft'])
  })

  test('an unknown network pauses the clocks instead of emptying the house', () => {
    const seen = advance(
      initialPresence(CONFIG, START),
      answered(ALICE_MAC),
      START,
    )
    const outage = advance(
      seen.state,
      Observation.NetworkUnknown(),
      START + 60 * MINUTE,
    )
    const restored = advance(outage.state, answered(), START + 61 * MINUTE)
    expect(tags(outage.events)).toEqual([])
    expect(tags(restored.events)).toEqual([])
    expect(restored.state.phones[0]?.status).toBe('Home')
  })

  test('follows a phone to a new address', () => {
    const seen = advance(
      initialPresence(CONFIG, START),
      Observation.Answered({
        neighbours: [{ mac: ALICE_MAC, address: '192.168.1.99' }],
      }),
      START,
    )
    expect(seen.state.phones[0]?.maybeAddress).toEqual(
      Option.some('192.168.1.99'),
    )
  })
})

describe('a brief network blip', () => {
  test('pauses the clock for that round only', () => {
    const seen = advance(
      initialPresence(CONFIG, START),
      answered(ALICE_MAC),
      START,
    )
    const quiet = advance(seen.state, answered(), START + 10 * MINUTE)
    const blip = advance(
      quiet.state,
      Observation.NetworkUnknown(),
      START + 11 * MINUTE,
    )
    const still = advance(blip.state, answered(), START + 15 * MINUTE)
    const gone = advance(still.state, answered(), START + 16 * MINUTE)
    expect(tags(still.events)).toEqual([])
    expect(tags(gone.events)).toEqual(['PhoneLeft', 'EveryoneLeft'])
  })
})

describe('planProbe', () => {
  test('sweeps the subnet first, then only known addresses until it is due', () => {
    const state = initialPresence(CONFIG, START)
    const first = planProbe(state, GATEWAY, START)
    expect(first.isSweep).toBe(true)
    expect(first.addresses).toHaveLength(254)

    const swept: PresenceState = {
      ...advance(state, answered(ALICE_MAC), START).state,
      lastSweepAt: START,
    }
    const next = planProbe(swept, GATEWAY, START + MINUTE)
    expect(next.isSweep).toBe(false)
    expect(next.addresses).toEqual([GATEWAY, '192.168.1.10'])

    expect(planProbe(swept, GATEWAY, START + 5 * MINUTE).isSweep).toBe(true)
  })

  test('derives every host on the gateway subnet', () => {
    const addresses = subnetAddresses(GATEWAY)
    expect(addresses[0]).toBe('192.168.1.1')
    expect(addresses[253]).toBe(GATEWAY)
  })
})

describe('turnOffAllLights', () => {
  test('ends the Rainbow loop first and sends only exact off frames', async () => {
    const sent: Array<readonly [string, JsonObject]> = []
    const stopped: Array<string> = []
    await Effect.runPromise(
      turnOffAllLights<never>({
        publishGroup: (group, payload) =>
          Effect.sync(() => {
            sent.push([group, payload])
          }),
        markRainbowStopped: group => {
          stopped.push(group)
        },
        sleep: () => Effect.void,
      }),
    )
    expect(sent.map(([group]) => group)).toEqual([
      'Rest of the House',
      'All Lights',
      'All Lights',
    ])
    expect(sent.every(([, payload]) => payload === OFF_FRAME)).toBe(true)
    expect(OFF_FRAME).toEqual({ state: 'OFF' })
    expect(stopped).toEqual(['All Lights', 'Rest of the House'])
  })
})

const makeHarness = (
  config: PresenceConfig,
  options: Readonly<{ failTurnOff?: boolean }> = {},
) => {
  const clock = { value: START }
  const network: { observation: Observation } = { observation: answered() }
  const failure = { shouldFail: options.failTurnOff ?? false }
  const record = {
    turnOffs: 0,
    info: new Array<string>(),
    problems: new Array<string>(),
    nudged: new Array<ReadonlyArray<string>>(),
  }
  const watcher = Effect.runPromise(
    makePresenceWatcher<string>(config, {
      nudge: addresses =>
        Effect.sync(() => {
          record.nudged.push(addresses)
        }),
      observe: () => Effect.sync(() => network.observation),
      turnOffLights: Effect.suspend(() =>
        failure.shouldFail
          ? Effect.fail('not connected to MQTT')
          : Effect.sync(() => {
              record.turnOffs += 1
            }),
      ),
      now: Effect.sync(() => clock.value),
      sleep: () => Effect.void,
      log: () => Effect.void,
      recordInfo: text =>
        Effect.sync(() => {
          record.info.push(text)
        }),
      reportProblem: text =>
        Effect.sync(() => {
          record.problems.push(text)
        }),
      errorText: error => error,
    }),
  )
  const roundAt = async (at: number, observation: Observation) => {
    clock.value = at
    network.observation = observation
    await Effect.runPromise((await watcher).runRound)
  }
  return { failure, record, roundAt }
}

describe('makePresenceWatcher', () => {
  test('turns the lights off once when everyone has left', async () => {
    const { record, roundAt } = makeHarness(CONFIG)
    await roundAt(START, answered(ALICE_MAC))
    await roundAt(START + AWAY_MS, answered())
    await roundAt(START + AWAY_MS + MINUTE, answered())
    expect(record.turnOffs).toBe(1)
    expect(record.info).toEqual(['Nobody home, so all lights were turned off.'])
  })

  test('in log-only mode it reports what it would do and sends nothing', async () => {
    const { record, roundAt } = makeHarness({ ...CONFIG, action: 'LogOnly' })
    await roundAt(START, answered(ALICE_MAC))
    await roundAt(START + AWAY_MS, answered())
    expect(record.turnOffs).toBe(0)
    expect(record.info).toEqual([
      'Nobody home. Would have turned all lights off.',
    ])
  })

  test('tries again next round when turning the lights off fails', async () => {
    const { failure, record, roundAt } = makeHarness(CONFIG, {
      failTurnOff: true,
    })
    await roundAt(START, answered(ALICE_MAC))
    await roundAt(START + AWAY_MS, answered())
    expect(record.turnOffs).toBe(0)
    expect(record.problems).toHaveLength(1)

    failure.shouldFail = false
    await roundAt(START + AWAY_MS + MINUTE, answered())
    expect(record.turnOffs).toBe(1)
  })

  test('an outage leaves the lights alone', async () => {
    const { record, roundAt } = makeHarness(CONFIG)
    await roundAt(START, answered(ALICE_MAC))
    await roundAt(START + AWAY_MS, Observation.NetworkUnknown())
    await roundAt(START + AWAY_MS + MINUTE, answered())
    expect(record.turnOffs).toBe(0)
  })
})

describe('decodePresenceConfig', () => {
  const fileWith = (changes: object) =>
    JSON.stringify({ ...CONFIG, ...changes })

  test('accepts a valid file and normalizes addresses', () => {
    const file = decodePresenceConfig(
      fileWith({ phones: [{ name: ' Alice ', mac: 'AA-AA-AA-AA-AA-AA' }] }),
    )
    expect(file).toEqual(
      PresenceConfigFile.Ready({
        config: { ...CONFIG, phones: [{ name: 'Alice', mac: ALICE_MAC }] },
      }),
    )
  })

  test.each([
    ['no phones', { phones: [] }],
    ['a bad address', { phones: [{ name: 'Alice', mac: 'nope' }] }],
    [
      'a duplicate phone',
      {
        phones: [
          { name: 'Alice', mac: ALICE_MAC },
          { name: 'Sam', mac: ALICE_MAC },
        ],
      },
    ],
    ['a grace period too short to survive phone sleep', { awayMinutes: 1 }],
    ['an unknown action', { action: 'Explode' }],
  ])('rejects %s', (_label, changes) => {
    expect(decodePresenceConfig(fileWith(changes))._tag).toBe('Invalid')
  })

  test('rejects text that is not JSON', () => {
    expect(decodePresenceConfig('{')._tag).toBe('Invalid')
  })
})

describe('observationFromNeighbourTable', () => {
  const entry = (dst: string, lladdr: string | undefined, state: string) => ({
    dst,
    ...(lladdr === undefined ? {} : { lladdr }),
    state: [state],
  })

  test('counts only IPv4 entries that answered', () => {
    const observation = observationFromNeighbourTable(
      JSON.stringify([
        entry(GATEWAY, '02:00:00:00:00:fe', 'REACHABLE'),
        entry('192.168.1.10', ALICE_MAC, 'REACHABLE'),
        entry('192.168.1.11', SAM_MAC, 'STALE'),
        entry('192.168.1.12', undefined, 'FAILED'),
        entry('fe80::1', 'cc:cc:cc:cc:cc:cc', 'REACHABLE'),
      ]),
      GATEWAY,
    )
    expect(observation).toEqual(
      Observation.Answered({
        neighbours: [
          { mac: '02:00:00:00:00:fe', address: GATEWAY },
          { mac: ALICE_MAC, address: '192.168.1.10' },
        ],
      }),
    )
  })

  test('is unknown when the router did not answer', () => {
    const table = JSON.stringify([entry(GATEWAY, '02:00:00:00:00:fe', 'STALE')])
    expect(observationFromNeighbourTable(table, GATEWAY)._tag).toBe(
      'NetworkUnknown',
    )
  })

  test('is unknown when the table cannot be read', () => {
    expect(observationFromNeighbourTable('not json', GATEWAY)._tag).toBe(
      'NetworkUnknown',
    )
  })
})
