import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  DEFAULT_CONFIG,
  type PrMergeConfig,
  configProblem,
  hexToHueSaturation,
  isScheduleOpen,
  normalizeConfig,
} from './automation'

const MONDAY_9_30_VANCOUVER = Date.UTC(2026, 10, 9, 16, 30)
const MONDAY_17_30_VANCOUVER = Date.UTC(2026, 10, 10, 0, 30)
const SATURDAY_10_VANCOUVER = Date.UTC(2026, 10, 14, 17, 0)

const withConfig = (
  change: (config: PrMergeConfig) => PrMergeConfig,
): PrMergeConfig => change(DEFAULT_CONFIG)

describe('schedule', () => {
  test('is open on a weekday inside the window', () => {
    expect(isScheduleOpen(DEFAULT_CONFIG.schedule, MONDAY_9_30_VANCOUVER)).toBe(
      true,
    )
  })

  test('closes at the end of the window', () => {
    expect(
      isScheduleOpen(DEFAULT_CONFIG.schedule, MONDAY_17_30_VANCOUVER),
    ).toBe(false)
  })

  test('stays closed on a disabled day', () => {
    expect(isScheduleOpen(DEFAULT_CONFIG.schedule, SATURDAY_10_VANCOUVER)).toBe(
      false,
    )
  })

  test('uses the configured time zone', () => {
    const losAngeles = {
      ...DEFAULT_CONFIG.schedule,
      timeZone: 'America/Los_Angeles',
    }
    const justBeforeNineVancouverPlusOneHour = Date.UTC(2026, 10, 9, 16, 30)
    expect(isScheduleOpen(losAngeles, justBeforeNineVancouverPlusOneHour)).toBe(
      false,
    )
  })
})

describe('configProblem', () => {
  test('accepts the defaults', () => {
    expect(configProblem(DEFAULT_CONFIG)).toEqual(Option.none())
  })

  test.each([
    ['poll interval under the floor', { intervalSeconds: 1 }, 'Poll interval'],
  ])('rejects %s', (_label, polling, expected) => {
    const problem = configProblem(
      withConfig(config => ({
        ...config,
        polling: { ...config.polling, ...polling },
      })),
    )
    expect(Option.getOrThrow(problem)).toContain(expected)
  })

  test('rejects flash steps faster than bulbs can apply', () => {
    const problem = configProblem(
      withConfig(config => ({
        ...config,
        flash: { ...config.flash, onMs: 100 },
      })),
    )
    expect(Option.getOrThrow(problem)).toContain('On time')
  })

  test('rejects an unknown time zone', () => {
    const problem = configProblem(
      withConfig(config => ({
        ...config,
        schedule: { ...config.schedule, timeZone: 'Mars/Olympus' },
      })),
    )
    expect(Option.isSome(problem)).toBe(true)
  })

  test('rejects a day that ends before it starts', () => {
    const problem = configProblem(
      withConfig(config => ({
        ...config,
        schedule: {
          ...config.schedule,
          days: config.schedule.days.map(window =>
            window.day === 'Monday'
              ? { ...window, start: '18:00', end: '09:00' }
              : window,
          ),
        },
      })),
    )
    expect(Option.getOrThrow(problem)).toContain('Monday')
  })

  test('requires an account', () => {
    expect(
      Option.isSome(
        configProblem(
          normalizeConfig(
            withConfig(config => ({ ...config, accounts: [' '] })),
          ),
        ),
      ),
    ).toBe(true)
  })
})

describe('hexToHueSaturation', () => {
  test('keeps the original purple', () => {
    expect(hexToHueSaturation('#AA00FF')).toEqual({
      hue: 280,
      saturation: 100,
    })
  })
})
