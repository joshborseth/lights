import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  type AccountStatus,
  DEFAULT_CONFIG,
  type PollStatus,
  WatcherMode,
} from '../src/automation'
import { type HealthInputs, healthChecks, overallHealth } from './health'

const NOW = 1_000_000

const goodPoll: PollStatus = {
  maybeLastStartedAt: Option.some(NOW - 1000),
  maybeLastSucceededAt: Option.some(NOW - 1000),
  maybeLastDurationMs: Option.some(100),
  consecutiveFailures: 0,
  maybeLastError: Option.none(),
  maybePartialError: Option.none(),
  scopes: [],
}

const goodAccount: AccountStatus = {
  login: 'me',
  token: 'Ok',
  maybeCore: Option.some({ remaining: 4000, limit: 5000, resetsAt: NOW }),
  maybeGraphql: Option.none(),
}

const inputs = (change: Partial<HealthInputs> = {}): HealthInputs => ({
  now: NOW,
  config: DEFAULT_CONFIG,
  mode: WatcherMode.Watching({ isScheduleOpen: true }),
  poll: goodPoll,
  accounts: [goodAccount],
  isBrokerConnected: true,
  maybeIsBridgeOnline: Option.some(true),
  maybeTargetMembers: Option.some(7),
  maybeConfigFileError: Option.none(),
  ...change,
})

const level = (given: HealthInputs, id: string) =>
  healthChecks(given).find(item => item.id === id)?.level

const overall = (given: HealthInputs) =>
  overallHealth(given.mode, healthChecks(given))

describe('health', () => {
  test('is healthy when everything works', () => {
    expect(overall(inputs())).toBe('Healthy')
  })

  test('warns on a partial poll', () => {
    const given = inputs({
      poll: { ...goodPoll, maybePartialError: Option.some('me: HTTP 504') },
    })
    expect(level(given, 'polling')).toBe('Warning')
    expect(overall(given)).toBe('Warning')
  })

  test('fails when polling has gone stale', () => {
    const given = inputs({
      poll: {
        ...goodPoll,
        maybeLastSucceededAt: Option.some(
          NOW - DEFAULT_CONFIG.health.staleAfterSeconds * 1000 - 1000,
        ),
      },
    })
    expect(level(given, 'polling')).toBe('Failing')
  })

  test('fails when a login is rejected or missing', () => {
    expect(
      overall(inputs({ accounts: [{ ...goodAccount, token: 'Rejected' }] })),
    ).toBe('Unhealthy')
    expect(
      overall(inputs({ accounts: [{ ...goodAccount, token: 'Missing' }] })),
    ).toBe('Unhealthy')
  })

  test('warns when GitHub requests run low', () => {
    const given = inputs({
      accounts: [
        {
          ...goodAccount,
          maybeGraphql: Option.some({
            remaining: 5,
            limit: 5000,
            resetsAt: NOW,
          }),
        },
      ],
    })
    expect(level(given, 'account-me')).toBe('Warning')
  })

  test('fails without the broker, Zigbee2MQTT, or group members', () => {
    expect(level(inputs({ isBrokerConnected: false }), 'broker')).toBe(
      'Failing',
    )
    expect(
      level(inputs({ maybeIsBridgeOnline: Option.some(false) }), 'bridge'),
    ).toBe('Failing')
    expect(level(inputs({ maybeTargetMembers: Option.some(0) }), 'group')).toBe(
      'Failing',
    )
  })

  test('reports Off and does not flag polling while off', () => {
    const given = inputs({
      mode: WatcherMode.Off(),
      poll: { ...goodPoll, maybeLastSucceededAt: Option.some(0) },
    })
    expect(overall(given)).toBe('Off')
    expect(level(given, 'polling')).toBe('Inactive')
  })

  test('warns when the settings file could not be used', () => {
    const given = inputs({ maybeConfigFileError: Option.some('bad file') })
    expect(level(given, 'config')).toBe('Warning')
  })
})
