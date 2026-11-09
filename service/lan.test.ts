import { Option } from 'effect'
import { describe, expect, test, vi } from 'vitest'

import { type UpstreamSocket, bridgeSockets, makeLanHandler } from './lan'

const DIST_DIR = '/site/dist'
const AUTOMATIONS_ORIGIN = 'http://127.0.0.1:8093'

const setup = () => {
  const files = new Map([
    [`${DIST_DIR}/index.html`, new Blob(['<html>'], { type: 'text/html' })],
    [`${DIST_DIR}/assets/app.js`, new Blob(['code'])],
  ])
  const fetchUpstream = vi.fn<
    (url: string, init: RequestInit) => Promise<Response>
  >(async () => new Response('{"ok":true}', { status: 200 }))
  const handle = makeLanHandler({
    distDir: DIST_DIR,
    automationsOrigin: AUTOMATIONS_ORIGIN,
    readFile: async path => Option.fromNullishOr(files.get(path)),
    fetchUpstream,
  })
  return { handle, fetchUpstream }
}

const request = (path: string, init?: RequestInit): Request =>
  new Request(`http://192.168.1.67:8445${path}`, init)

const noUpgrade = () => false

describe('makeLanHandler', () => {
  test('serves the app at the root, revalidated on every load', async () => {
    const { handle } = setup()
    const response = await handle(request('/'), noUpgrade)
    expect(response?.status).toBe(200)
    expect(await response?.text()).toBe('<html>')
    expect(response?.headers.get('cache-control')).toBe('no-cache')
  })

  test('serves built files', async () => {
    const { handle } = setup()
    const response = await handle(request('/assets/app.js'), noUpgrade)
    expect(await response?.text()).toBe('code')
  })

  test('answers 404 for a missing file', async () => {
    const { handle } = setup()
    const response = await handle(request('/nope.js'), noUpgrade)
    expect(response?.status).toBe(404)
  })

  test('never reads outside the built site', async () => {
    const { handle } = setup()
    const response = await handle(
      request('/assets/%2e%2e/%2e%2e/%2e%2e/etc/passwd'),
      noUpgrade,
    )
    expect(response?.status).toBe(404)
  })

  test('refuses writes to static files', async () => {
    const { handle } = setup()
    const response = await handle(
      request('/index.html', { method: 'POST' }),
      noUpgrade,
    )
    expect(response?.status).toBe(405)
  })

  test('forwards automations requests with their path and query', async () => {
    const { handle, fetchUpstream } = setup()
    await handle(request('/automations/pr-merge/pause?x=1'), noUpgrade)
    expect(fetchUpstream.mock.calls[0]?.[0]).toBe(
      `${AUTOMATIONS_ORIGIN}/automations/pr-merge/pause?x=1`,
    )
  })

  test('forwards preflights so the service can leave them unanswered', async () => {
    const { handle, fetchUpstream } = setup()
    await handle(
      request('/automations/pr-merge/enabled', { method: 'OPTIONS' }),
      noUpgrade,
    )
    expect(fetchUpstream.mock.calls[0]?.[1].method).toBe('OPTIONS')
  })

  test('does not treat a similar path as automations', async () => {
    const { handle, fetchUpstream } = setup()
    const response = await handle(request('/automationsx'), noUpgrade)
    expect(fetchUpstream).not.toHaveBeenCalled()
    expect(response?.status).toBe(404)
  })

  test('answers 502 when the automations service is down', async () => {
    const { handle, fetchUpstream } = setup()
    fetchUpstream.mockRejectedValueOnce(new Error('refused'))
    const response = await handle(request('/automations/pr-merge'), noUpgrade)
    expect(response?.status).toBe(502)
  })

  test('upgrades the socket path', async () => {
    const { handle } = setup()
    const response = await handle(request('/api'), () => true)
    expect(response).toBeUndefined()
  })

  test('refuses a plain request to the socket path', async () => {
    const { handle } = setup()
    const response = await handle(request('/api'), noUpgrade)
    expect(response?.status).toBe(426)
  })
})

const makeUpstream = () => {
  type Listener = (event: Readonly<{ data: unknown }>) => void
  const listeners = new Map<string, Listener>()
  const send = vi.fn<(frame: string) => void>()
  const close = vi.fn<() => void>()
  const addEventListener = (type: string, listener: Listener): void => {
    listeners.set(type, listener)
  }
  const socket: UpstreamSocket = { addEventListener, send, close }
  const emit = (type: string, data?: unknown): void => {
    listeners.get(type)?.({ data })
  }
  return { socket, send, close, emit }
}

const makeClient = () => ({
  send: vi.fn<(frame: string) => void>(),
  close: vi.fn<() => void>(),
})

describe('bridgeSockets', () => {
  test('holds early frames and sends them in order once open', () => {
    const upstream = makeUpstream()
    const bridge = bridgeSockets(upstream.socket, makeClient())
    bridge.sendToUpstream('first')
    bridge.sendToUpstream('second')
    expect(upstream.send).not.toHaveBeenCalled()
    upstream.emit('open')
    bridge.sendToUpstream('third')
    expect(upstream.send.mock.calls.map(([frame]) => frame)).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  test('relays text frames to the app and ignores binary ones', () => {
    const upstream = makeUpstream()
    const client = makeClient()
    bridgeSockets(upstream.socket, client)
    upstream.emit('message', '{"topic":"bridge/state"}')
    upstream.emit('message', new ArrayBuffer(4))
    expect(client.send.mock.calls).toEqual([['{"topic":"bridge/state"}']])
  })

  test('closes the app socket when Zigbee2MQTT closes or fails', () => {
    const closed = makeUpstream()
    const closedClient = makeClient()
    bridgeSockets(closed.socket, closedClient)
    closed.emit('close')
    expect(closedClient.close).toHaveBeenCalledOnce()

    const failed = makeUpstream()
    const failedClient = makeClient()
    bridgeSockets(failed.socket, failedClient)
    failed.emit('error')
    expect(failedClient.close).toHaveBeenCalledOnce()
  })

  test('closes Zigbee2MQTT when the app leaves', () => {
    const upstream = makeUpstream()
    bridgeSockets(upstream.socket, makeClient()).closeUpstream()
    expect(upstream.close).toHaveBeenCalledOnce()
  })
})
