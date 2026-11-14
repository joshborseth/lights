import { Array, Option, Schema, String, pipe } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const
export const Weekday = Schema.Literals(WEEKDAYS)
export type Weekday = typeof Weekday.Type

// CONFIG

export const DayWindow = Schema.Struct({
  day: Weekday,
  isEnabled: Schema.Boolean,
  start: Schema.String,
  end: Schema.String,
})
export type DayWindow = typeof DayWindow.Type

export const OutsideWindow = Schema.Literals(['Skip', 'WaitForWindow'])
export type OutsideWindow = typeof OutsideWindow.Type

export const ScheduleConfig = Schema.Struct({
  timeZone: Schema.String,
  whenOutside: OutsideWindow,
  days: Schema.Array(DayWindow),
})
export type ScheduleConfig = typeof ScheduleConfig.Type

export const PollingConfig = Schema.Struct({
  intervalSeconds: Schema.Number,
  catchUpMinutes: Schema.Number,
  lookbackHours: Schema.Number,
  scopeRefreshMinutes: Schema.Number,
  requestTimeoutSeconds: Schema.Number,
})
export type PollingConfig = typeof PollingConfig.Type

export const FlashConfig = Schema.Struct({
  group: Schema.String,
  count: Schema.Number,
  onMs: Schema.Number,
  offMs: Schema.Number,
  hex: Schema.String,
  brightness: Schema.Number,
  onlyLightsAlreadyOn: Schema.Boolean,
  shouldRestore: Schema.Boolean,
  shouldResumeRainbow: Schema.Boolean,
})
export type FlashConfig = typeof FlashConfig.Type

export const HealthConfig = Schema.Struct({
  failuresBeforeUnhealthy: Schema.Number,
  staleAfterSeconds: Schema.Number,
  lowRateLimit: Schema.Number,
  probeMinutes: Schema.Number,
})
export type HealthConfig = typeof HealthConfig.Type

export const PrMergeConfig = Schema.Struct({
  accounts: Schema.Array(Schema.String),
  ignoredRepos: Schema.Array(Schema.String),
  polling: PollingConfig,
  schedule: ScheduleConfig,
  flash: FlashConfig,
  health: HealthConfig,
})
export type PrMergeConfig = typeof PrMergeConfig.Type

const workdayWindow = (day: Weekday): DayWindow => ({
  day,
  isEnabled: day !== 'Saturday' && day !== 'Sunday',
  start: '09:00',
  end: '17:00',
})

export const DEFAULT_CONFIG: PrMergeConfig = {
  accounts: ['joshborseth'],
  ignoredRepos: [],
  polling: {
    intervalSeconds: 5,
    catchUpMinutes: 45,
    lookbackHours: 36,
    scopeRefreshMinutes: 10,
    requestTimeoutSeconds: 40,
  },
  schedule: {
    timeZone: 'America/Vancouver',
    whenOutside: 'Skip',
    days: Array.map(WEEKDAYS, workdayWindow),
  },
  flash: {
    group: 'All Lights',
    count: 4,
    onMs: 700,
    offMs: 450,
    hex: '#AA00FF',
    brightness: 254,
    onlyLightsAlreadyOn: true,
    shouldRestore: true,
    shouldResumeRainbow: true,
  },
  health: {
    failuresBeforeUnhealthy: 12,
    staleAfterSeconds: 120,
    lowRateLimit: 200,
    probeMinutes: 5,
  },
}

// VALIDATION

// NOTE: 400 ms is the fastest bulbs reliably apply commands. Faster flashes are dropped.
export const MIN_FLASH_STEP_MS = 400
const MAX_FLASH_STEP_MS = 10_000
const MIN_POLL_SECONDS = 5
const MAX_POLL_SECONDS = 3600
const MAX_FLASHES = 20

const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/
const HEX_COLOR = /^#[0-9a-f]{6}$/i

const isWhole = (value: number, min: number, max: number): boolean =>
  Number.isInteger(value) && value >= min && value <= max

const rangeProblem = (
  label: string,
  value: number,
  min: number,
  max: number,
): Option.Option<string> =>
  isWhole(value, min, max)
    ? Option.none()
    : Option.some(`${label} must be a whole number from ${min} to ${max}.`)

const whenFalse = (isValid: boolean, problem: string): Option.Option<string> =>
  isValid ? Option.none() : Option.some(problem)

export const isValidTimeZone = (timeZone: string): boolean => {
  if (String.isEmpty(timeZone)) {
    return false
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

const dayProblem = (window: DayWindow): Option.Option<string> =>
  !CLOCK_TIME.test(window.start) || !CLOCK_TIME.test(window.end)
    ? Option.some(`${window.day} needs a start and end time.`)
    : window.isEnabled && window.start >= window.end
      ? Option.some(`${window.day} must start before it ends.`)
      : Option.none()

export const configProblem = (config: PrMergeConfig): Option.Option<string> => {
  const { accounts, ignoredRepos, polling, schedule, flash, health } = config
  const hasEveryDay =
    schedule.days.length === WEEKDAYS.length &&
    Array.every(WEEKDAYS, day =>
      Array.some(schedule.days, window => window.day === day),
    )
  return pipe(
    [
      whenFalse(
        Array.isReadonlyArrayNonEmpty(accounts),
        'Add at least one GitHub account.',
      ),
      whenFalse(
        Array.every(accounts, account => GITHUB_LOGIN.test(account)),
        'One of the GitHub account names is not valid.',
      ),
      whenFalse(
        Array.every(ignoredRepos, repo => REPO_NAME.test(repo)),
        'Write ignored repositories as owner/name.',
      ),
      rangeProblem(
        'Poll interval',
        polling.intervalSeconds,
        MIN_POLL_SECONDS,
        MAX_POLL_SECONDS,
      ),
      rangeProblem('Catch-up window', polling.catchUpMinutes, 1, 1440),
      rangeProblem('Search lookback', polling.lookbackHours, 1, 168),
      rangeProblem(
        'Organization refresh',
        polling.scopeRefreshMinutes,
        1,
        1440,
      ),
      rangeProblem('Request timeout', polling.requestTimeoutSeconds, 5, 120),
      whenFalse(
        isValidTimeZone(schedule.timeZone),
        'Enter a valid time zone, like America/Vancouver.',
      ),
      whenFalse(hasEveryDay, 'The schedule must include each day of the week.'),
      ...Array.map(schedule.days, dayProblem),
      whenFalse(!String.isEmpty(flash.group), 'Choose a group to flash.'),
      rangeProblem('Flash count', flash.count, 1, MAX_FLASHES),
      rangeProblem('On time', flash.onMs, MIN_FLASH_STEP_MS, MAX_FLASH_STEP_MS),
      rangeProblem(
        'Off time',
        flash.offMs,
        MIN_FLASH_STEP_MS,
        MAX_FLASH_STEP_MS,
      ),
      whenFalse(HEX_COLOR.test(flash.hex), 'Choose a flash color.'),
      rangeProblem('Brightness', flash.brightness, 1, 254),
      rangeProblem(
        'Failures before unhealthy',
        health.failuresBeforeUnhealthy,
        1,
        1000,
      ),
      rangeProblem('Stale after', health.staleAfterSeconds, 10, 86_400),
      rangeProblem('Low rate limit', health.lowRateLimit, 0, 5000),
      rangeProblem('Health check interval', health.probeMinutes, 1, 1440),
    ],
    Array.getSomes,
    Array.head,
  )
}

export const normalizeConfig = (config: PrMergeConfig): PrMergeConfig => ({
  ...config,
  accounts: pipe(
    config.accounts,
    Array.map(String.trim),
    Array.filter(String.isNonEmpty),
  ),
  ignoredRepos: pipe(
    config.ignoredRepos,
    Array.map(String.trim),
    Array.filter(String.isNonEmpty),
  ),
  schedule: {
    ...config.schedule,
    timeZone: String.trim(config.schedule.timeZone),
  },
})

// SCHEDULE

const WEEKDAY_FORMAT_OPTIONS = {
  weekday: 'long',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
} as const

type LocalMoment = Readonly<{ day: string; clock: string }>

const localMoment = (atMs: number, timeZone: string): LocalMoment => {
  const parts = new Intl.DateTimeFormat('en-US', {
    ...WEEKDAY_FORMAT_OPTIONS,
    timeZone,
  }).formatToParts(new Date(atMs))
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    pipe(
      parts,
      Array.findFirst(candidate => candidate.type === type),
      Option.match({ onNone: () => '', onSome: found => found.value }),
    )
  return { day: part('weekday'), clock: `${part('hour')}:${part('minute')}` }
}

export const isScheduleOpen = (
  schedule: ScheduleConfig,
  atMs: number,
): boolean => {
  const { day, clock } = localMoment(atMs, schedule.timeZone)
  return Array.some(
    schedule.days,
    window =>
      window.isEnabled &&
      window.day === day &&
      window.start <= clock &&
      clock < window.end,
  )
}

const enabledDays = (schedule: ScheduleConfig): ReadonlyArray<DayWindow> =>
  Array.filter(schedule.days, window => window.isEnabled)

export const hasSameHours = (schedule: ScheduleConfig): boolean =>
  Option.match(Array.head(enabledDays(schedule)), {
    onNone: () => true,
    onSome: first =>
      Array.every(
        enabledDays(schedule),
        window => window.start === first.start && window.end === first.end,
      ),
  })

export const sharedHours = (
  schedule: ScheduleConfig,
): Readonly<{ start: string; end: string }> =>
  pipe(
    Array.head(enabledDays(schedule)),
    Option.orElse(() => Array.head(schedule.days)),
    Option.match({
      onNone: () => ({ start: '09:00', end: '17:00' }),
      onSome: ({ start, end }) => ({ start, end }),
    }),
  )

export const withSameHours = (
  schedule: ScheduleConfig,
  start: string,
  end: string,
): ScheduleConfig => ({
  ...schedule,
  days: Array.map(schedule.days, window => ({ ...window, start, end })),
})

// COLOR

const roundToFourPlaces = (value: number): number =>
  Math.round(value * 10_000) / 10_000

// NOTE: The same matrix Zigbee2MQTT uses, with no gamma step, so a color lands
// where its hue and saturation conversion put it on bulbs that only take x and y.
export const hexToXy = (hex: string): Readonly<{ x: number; y: number }> => {
  const channel = (start: number): number =>
    parseInt(hex.slice(start, start + 2), 16) / 255
  const red = channel(1)
  const green = channel(3)
  const blue = channel(5)
  const X = red * 0.664511 + green * 0.154324 + blue * 0.162028
  const Y = red * 0.283881 + green * 0.668433 + blue * 0.047685
  const Z = red * 0.000088 + green * 0.07231 + blue * 0.986039
  const total = X + Y + Z
  return total === 0
    ? { x: 0, y: 0 }
    : { x: roundToFourPlaces(X / total), y: roundToFourPlaces(Y / total) }
}

// STATUS

export const WatcherMode = defineTaggedUnion({
  Off: {},
  Paused: { until: Schema.Number },
  Watching: { isScheduleOpen: Schema.Boolean },
})
export type WatcherMode = typeof WatcherMode.Type

export const CheckLevel = Schema.Literals([
  'Ok',
  'Warning',
  'Failing',
  'Inactive',
])
export type CheckLevel = typeof CheckLevel.Type

export const HealthCheck = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  level: CheckLevel,
  detail: Schema.String,
})
export type HealthCheck = typeof HealthCheck.Type

export const OverallHealth = Schema.Literals([
  'Healthy',
  'Warning',
  'Unhealthy',
  'Off',
])
export type OverallHealth = typeof OverallHealth.Type

export const RateWindow = Schema.Struct({
  remaining: Schema.Number,
  limit: Schema.Number,
  resetsAt: Schema.Number,
})
export type RateWindow = typeof RateWindow.Type

export const TokenStatus = Schema.Literals([
  'Unknown',
  'Ok',
  'Missing',
  'Rejected',
])
export type TokenStatus = typeof TokenStatus.Type

export const AccountStatus = Schema.Struct({
  login: Schema.String,
  token: TokenStatus,
  maybeCore: Schema.OptionFromNullOr(RateWindow),
  maybeGraphql: Schema.OptionFromNullOr(RateWindow),
})
export type AccountStatus = typeof AccountStatus.Type

export const PollStatus = Schema.Struct({
  maybeLastStartedAt: Schema.OptionFromNullOr(Schema.Number),
  maybeLastSucceededAt: Schema.OptionFromNullOr(Schema.Number),
  maybeLastDurationMs: Schema.OptionFromNullOr(Schema.Number),
  consecutiveFailures: Schema.Number,
  maybeLastError: Schema.OptionFromNullOr(Schema.String),
  maybePartialError: Schema.OptionFromNullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
})
export type PollStatus = typeof PollStatus.Type

export const ActivityKind = Schema.Literals([
  'Info',
  'Merge',
  'Flash',
  'Skip',
  'Problem',
])
export type ActivityKind = typeof ActivityKind.Type

export const ActivityEntry = Schema.Struct({
  at: Schema.Number,
  kind: ActivityKind,
  text: Schema.String,
})
export type ActivityEntry = typeof ActivityEntry.Type

export const Snapshot = Schema.Struct({
  generatedAt: Schema.Number,
  startedAt: Schema.Number,
  config: PrMergeConfig,
  mode: WatcherMode,
  heldMerges: Schema.Number,
  poll: PollStatus,
  accounts: Schema.Array(AccountStatus),
  maybeLastMergeAt: Schema.OptionFromNullOr(Schema.Number),
  maybeLastFlashAt: Schema.OptionFromNullOr(Schema.Number),
  overall: OverallHealth,
  checks: Schema.Array(HealthCheck),
  activity: Schema.Array(ActivityEntry),
})
export type Snapshot = typeof Snapshot.Type
export const SnapshotValue = Schema.toType(Snapshot)

export const PauseRequest = Schema.Struct({ minutes: Schema.Number })
export type PauseRequest = typeof PauseRequest.Type

export const EnabledRequest = Schema.Struct({ isEnabled: Schema.Boolean })
export type EnabledRequest = typeof EnabledRequest.Type

export const ServiceFailure = Schema.Struct({ error: Schema.String })
export type ServiceFailure = typeof ServiceFailure.Type

export const AUTOMATION_API_PATH = '/automations/pr-merge'
