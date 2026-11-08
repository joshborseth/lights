import { Array, Match, Option, pipe } from 'effect'

import {
  type AccountStatus,
  type CheckLevel,
  type HealthCheck,
  type OverallHealth,
  type PollStatus,
  type PrMergeConfig,
  type RateWindow,
  type WatcherMode,
} from '../src/automation'

export type HealthInputs = Readonly<{
  now: number
  config: PrMergeConfig
  mode: WatcherMode
  poll: PollStatus
  accounts: ReadonlyArray<AccountStatus>
  isBrokerConnected: boolean
  maybeIsBridgeOnline: Option.Option<boolean>
  maybeTargetMembers: Option.Option<number>
  maybeConfigFileError: Option.Option<string>
}>

const check = (
  id: string,
  label: string,
  level: CheckLevel,
  detail: string,
): HealthCheck => ({ id, label, level, detail })

const secondsAgo = (now: number, at: number): string =>
  `${Math.max(0, Math.round((now - at) / 1000))}s ago`

const pollingCheck = (inputs: HealthInputs): HealthCheck => {
  const { now, config, mode, poll } = inputs
  const { failuresBeforeUnhealthy, staleAfterSeconds } = config.health
  if (mode._tag === 'Off') {
    return check(
      'polling',
      'GitHub polling',
      'Inactive',
      'Not polling while off.',
    )
  }
  const reason = Option.getOrElse(poll.maybeLastError, () => 'Unknown error')
  if (poll.consecutiveFailures >= failuresBeforeUnhealthy) {
    return check(
      'polling',
      'GitHub polling',
      'Failing',
      `${poll.consecutiveFailures} polls failed in a row. ${reason}`,
    )
  }
  return Option.match(poll.maybeLastSucceededAt, {
    onNone: () =>
      poll.consecutiveFailures > 0
        ? check('polling', 'GitHub polling', 'Warning', reason)
        : check(
            'polling',
            'GitHub polling',
            'Inactive',
            'Waiting for the first poll.',
          ),
    onSome: succeededAt => {
      if (now - succeededAt > staleAfterSeconds * 1000) {
        return check(
          'polling',
          'GitHub polling',
          'Failing',
          `No successful poll since ${secondsAgo(now, succeededAt)}.`,
        )
      }
      if (poll.consecutiveFailures > 0) {
        return check('polling', 'GitHub polling', 'Warning', reason)
      }
      return Option.match(poll.maybePartialError, {
        onNone: () =>
          check(
            'polling',
            'GitHub polling',
            'Ok',
            `Last good poll ${secondsAgo(now, succeededAt)}.`,
          ),
        onSome: partial =>
          check(
            'polling',
            'GitHub polling',
            'Warning',
            `Partial poll. ${partial}`,
          ),
      })
    },
  })
}

const lowestRemaining = (account: AccountStatus): Option.Option<RateWindow> =>
  pipe(
    [account.maybeCore, account.maybeGraphql],
    Array.getSomes,
    Array.match({
      onEmpty: () => Option.none<RateWindow>(),
      onNonEmpty: windows =>
        Option.some(
          Array.reduce(windows, windows[0], (lowest, window) =>
            window.remaining < lowest.remaining ? window : lowest,
          ),
        ),
    }),
  )

const accountCheck =
  (inputs: HealthInputs) =>
  (account: AccountStatus): HealthCheck => {
    const id = `account-${account.login}`
    const label = `GitHub login: ${account.login}`
    if (inputs.mode._tag === 'Off') {
      return check(id, label, 'Inactive', 'Not checked while off.')
    }
    return Match.value(account.token).pipe(
      Match.when('Missing', () =>
        check(
          id,
          label,
          'Failing',
          'No gh login on this machine for this account.',
        ),
      ),
      Match.when('Rejected', () =>
        check(
          id,
          label,
          'Failing',
          'GitHub rejected this login. Run gh auth login again.',
        ),
      ),
      Match.when('Unknown', () =>
        check(id, label, 'Inactive', 'Not checked yet.'),
      ),
      Match.when('Ok', () =>
        Option.match(lowestRemaining(account), {
          onNone: () => check(id, label, 'Ok', 'Signed in.'),
          onSome: window =>
            window.remaining < inputs.config.health.lowRateLimit
              ? check(
                  id,
                  label,
                  'Warning',
                  `Only ${window.remaining} of ${window.limit} requests left this hour.`,
                )
              : check(
                  id,
                  label,
                  'Ok',
                  `${window.remaining} of ${window.limit} requests left this hour.`,
                ),
        }),
      ),
      Match.exhaustive,
    )
  }

const brokerCheck = (inputs: HealthInputs): HealthCheck =>
  inputs.isBrokerConnected
    ? check('broker', 'MQTT broker', 'Ok', 'Connected.')
    : check(
        'broker',
        'MQTT broker',
        'Failing',
        'Not connected, so lights cannot flash.',
      )

const bridgeCheck = (inputs: HealthInputs): HealthCheck =>
  Option.match(inputs.maybeIsBridgeOnline, {
    onNone: () =>
      check('bridge', 'Zigbee2MQTT', 'Inactive', 'No status received yet.'),
    onSome: isOnline =>
      isOnline
        ? check('bridge', 'Zigbee2MQTT', 'Ok', 'Online.')
        : check(
            'bridge',
            'Zigbee2MQTT',
            'Failing',
            'Offline, so lights cannot flash.',
          ),
  })

const groupCheck = (inputs: HealthInputs): HealthCheck => {
  const { group } = inputs.config.flash
  return Option.match(inputs.maybeTargetMembers, {
    onNone: () =>
      check(
        'group',
        'Flash group',
        'Inactive',
        `Waiting for ${group} from Zigbee2MQTT.`,
      ),
    onSome: members =>
      members === 0
        ? check(
            'group',
            'Flash group',
            'Failing',
            `${group} has no lights, or does not exist.`,
          )
        : check(
            'group',
            'Flash group',
            'Ok',
            `${group} has ${members} lights.`,
          ),
  })
}

const configCheck = (inputs: HealthInputs): ReadonlyArray<HealthCheck> =>
  Option.match(inputs.maybeConfigFileError, {
    onNone: () => [],
    onSome: error => [
      check('config', 'Settings file', 'Warning', `Using defaults. ${error}`),
    ],
  })

export const healthChecks = (
  inputs: HealthInputs,
): ReadonlyArray<HealthCheck> => [
  pollingCheck(inputs),
  ...Array.map(inputs.accounts, accountCheck(inputs)),
  brokerCheck(inputs),
  bridgeCheck(inputs),
  groupCheck(inputs),
  ...configCheck(inputs),
]

export const overallHealth = (
  mode: WatcherMode,
  checks: ReadonlyArray<HealthCheck>,
): OverallHealth => {
  if (mode._tag === 'Off') {
    return 'Off'
  }
  if (Array.some(checks, item => item.level === 'Failing')) {
    return 'Unhealthy'
  }
  return Array.some(checks, item => item.level === 'Warning')
    ? 'Warning'
    : 'Healthy'
}
