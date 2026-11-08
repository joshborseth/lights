import { Effect, Option, Schema } from 'effect'
import { describe, expect, test, vi } from 'vitest'

import {
  DEFAULT_CONFIG,
  type PrMergeConfig,
  Snapshot,
  WatcherMode,
} from '../src/automation'
import { type Engine } from './engine'
import { makeHandler } from './http'

const snapshot: Snapshot = {
  generatedAt: 1000,
  startedAt: 500,
  config: DEFAULT_CONFIG,
  mode: WatcherMode.Watching({ isScheduleOpen: true }),
  heldMerges: 0,
  poll: {
    maybeLastStartedAt: Option.some(900),
    maybeLastSucceededAt: Option.some(950),
    maybeLastDurationMs: Option.some(50),
    consecutiveFailures: 0,
    maybeLastError: Option.none(),
    maybePartialError: Option.none(),
    scopes: ['user:me'],
  },
  accounts: [],
  maybeLastMergeAt: Option.none(),
  maybeLastFlashAt: Option.none(),
  overall: 'Healthy',
  checks: [],
  activity: [],
}

const setup = () => {
  const saveConfig = vi.fn<(config: PrMergeConfig) => void>()
  const pause = vi.fn<(minutes: number) => void>()
  const requestRestart = vi.fn<() => void>()
  const engine: Engine = {
    snapshot: Effect.succeed(snapshot),
    saveConfig: config => Effect.sync(() => saveConfig(config)),
    setEnabled: () => Effect.void,
    pause: minutes => Effect.sync(() => pause(minutes)),
    resume: Effect.void,
    testFlash: Effect.succeed(Option.none()),
    checkNow: Effect.void,
    pollOnce: Effect.void,
    waitForFlashToFinish: Effect.void,
    run: Effect.void,
  }
  const handle = makeHandler({
    engine,
    requestRestart,
    run: Effect.runPromise,
  })
  return { handle, saveConfig, pause, requestRestart }
}

const send = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Request =>
  new Request(`http://127.0.0.1:8093${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

describe('automations API', () => {
  test('serves a snapshot the app can decode', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request('http://127.0.0.1:8093/automations/pr-merge'),
    )
    expect(response.status).toBe(200)
    const decoded = Schema.decodeUnknownSync(Snapshot)(await response.json())
    expect(decoded.poll.maybeLastSucceededAt).toEqual(Option.some(950))
  })

  test('refuses writes that are not JSON, so other sites cannot send them', async () => {
    const { handle, requestRestart } = setup()
    const response = await handle(
      send(
        'POST',
        '/automations/pr-merge/restart',
        {},
        {
          'content-type': 'text/plain',
        },
      ),
    )
    expect(response.status).toBe(415)
    expect(requestRestart).not.toHaveBeenCalled()
  })

  test('saves valid settings with names trimmed', async () => {
    const { handle, saveConfig } = setup()
    const response = await handle(
      send('PUT', '/automations/pr-merge/config', {
        ...DEFAULT_CONFIG,
        accounts: [' joshborseth '],
      }),
    )
    expect(response.status).toBe(200)
    expect(saveConfig.mock.calls[0]?.[0]?.accounts).toEqual(['joshborseth'])
  })

  test('rejects settings outside the bulb rules with a reason', async () => {
    const { handle, saveConfig } = setup()
    const response = await handle(
      send('PUT', '/automations/pr-merge/config', {
        ...DEFAULT_CONFIG,
        flash: { ...DEFAULT_CONFIG.flash, offMs: 50 },
      }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'Off time must be a whole number from 400 to 10000.',
    })
    expect(saveConfig).not.toHaveBeenCalled()
  })

  test('rejects malformed settings', async () => {
    const { handle, saveConfig } = setup()
    const response = await handle(
      send('PUT', '/automations/pr-merge/config', { accounts: 'nope' }),
    )
    expect(response.status).toBe(400)
    expect(saveConfig).not.toHaveBeenCalled()
  })

  test('limits pause length', async () => {
    const { handle, pause } = setup()
    const tooLong = await handle(
      send('POST', '/automations/pr-merge/pause', { minutes: 99_999 }),
    )
    expect(tooLong.status).toBe(400)
    const fine = await handle(
      send('POST', '/automations/pr-merge/pause', { minutes: 30 }),
    )
    expect(fine.status).toBe(200)
    expect(pause).toHaveBeenCalledWith(30)
  })

  test('restart answers before the service goes down', async () => {
    const { handle, requestRestart } = setup()
    const response = await handle(
      send('POST', '/automations/pr-merge/restart', {}),
    )
    expect(response.status).toBe(200)
    expect(requestRestart).toHaveBeenCalledOnce()
  })

  test('ignores unknown paths', async () => {
    const { handle } = setup()
    const response = await handle(new Request('http://127.0.0.1:8093/other'))
    expect(response.status).toBe(404)
  })
})
