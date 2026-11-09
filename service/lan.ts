import { Option } from 'effect'
import { resolve, sep } from 'node:path'

const AUTOMATIONS_PATH = '/automations'
const SOCKET_PATH = '/api'

const failure = (status: number, error: string): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

export type LanDeps = Readonly<{
  distDir: string
  automationsOrigin: string
  readFile: (path: string) => Promise<Option.Option<Blob>>
  fetchUpstream: (url: string, init: RequestInit) => Promise<Response>
}>

// NOTE: OPTIONS passes through unanswered by CORS, which keeps the automations
// service's rule that other sites cannot send commands.
export const makeLanHandler = ({
  distDir,
  automationsOrigin,
  readFile,
  fetchUpstream,
}: LanDeps) => {
  const forwardToAutomations = async (
    request: Request,
    url: URL,
  ): Promise<Response> => {
    try {
      return await fetchUpstream(
        `${automationsOrigin}${url.pathname}${url.search}`,
        {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: 'manual',
        },
      )
    } catch {
      return failure(502, 'The automations service is not responding.')
    }
  }

  const serveFile = async (
    request: Request,
    pathname: string,
  ): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return failure(405, 'Method not allowed.')
    }
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
    const path = resolve(distDir, relative)
    if (!path.startsWith(`${distDir}${sep}`)) {
      return failure(404, 'Not found.')
    }
    return Option.match(await readFile(path), {
      onNone: () => failure(404, 'Not found.'),
      // NOTE: Plain HTTP gets no service worker, so a deploy reaches the phone
      // only if the browser revalidates every file.
      onSome: file =>
        new Response(file, { headers: { 'cache-control': 'no-cache' } }),
    })
  }

  return async (
    request: Request,
    upgradeToSocket: () => boolean,
  ): Promise<Response | undefined> => {
    const url = new URL(request.url)
    if (url.pathname === SOCKET_PATH) {
      return upgradeToSocket()
        ? undefined
        : failure(426, 'Connect with a WebSocket.')
    }
    if (
      url.pathname === AUTOMATIONS_PATH ||
      url.pathname.startsWith(`${AUTOMATIONS_PATH}/`)
    ) {
      return forwardToAutomations(request, url)
    }
    return serveFile(request, url.pathname)
  }
}

export type UpstreamSocket = Readonly<{
  addEventListener: {
    (type: 'open' | 'close' | 'error', listener: () => void): void
    (
      type: 'message',
      listener: (event: Readonly<{ data: unknown }>) => void,
    ): void
  }
  send: (frame: string) => void
  close: () => void
}>

export type ClientSocket = Readonly<{
  send: (frame: string) => unknown
  close: () => void
}>

export type SocketBridge = Readonly<{
  sendToUpstream: (frame: string) => void
  closeUpstream: () => void
}>

// NOTE: Zigbee2MQTT's socket carries only JSON text frames. A frame can arrive
// from the app before the loopback connection opens, so those wait, in order,
// and are dropped with the connection if it never opens.
export const bridgeSockets = (
  upstream: UpstreamSocket,
  client: ClientSocket,
): SocketBridge => {
  const waiting: Array<string> = []
  let isUpstreamOpen = false

  upstream.addEventListener('open', () => {
    isUpstreamOpen = true
    waiting.splice(0).forEach(frame => upstream.send(frame))
  })
  upstream.addEventListener('message', ({ data }) => {
    if (typeof data === 'string') {
      client.send(data)
    }
  })
  upstream.addEventListener('close', () => client.close())
  upstream.addEventListener('error', () => client.close())

  return {
    sendToUpstream: frame => {
      if (isUpstreamOpen) {
        upstream.send(frame)
      } else {
        waiting.push(frame)
      }
    },
    closeUpstream: () => upstream.close(),
  }
}
