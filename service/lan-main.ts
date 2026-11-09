import { Option } from 'effect'

import { type SocketBridge, bridgeSockets, makeLanHandler } from './lan'

const DEFAULT_PORT = 8445
const DEFAULT_DIST_DIR = '/srv/lights/dist'
const DEFAULT_ZIGBEE_SOCKET = 'ws://127.0.0.1:8080/api'
const DEFAULT_AUTOMATIONS_ORIGIN = 'http://127.0.0.1:8093'

// NOTE: A test flash can hold a request open for several seconds, longer than
// Bun's default of 10.
const REQUEST_IDLE_TIMEOUT_SECONDS = 60

type SocketData = { maybeBridge: Option.Option<SocketBridge> }

const zigbeeSocket =
  process.env['LIGHTS_ZIGBEE_SOCKET'] ?? DEFAULT_ZIGBEE_SOCKET

const handle = makeLanHandler({
  distDir: process.env['LIGHTS_DIST_DIR'] ?? DEFAULT_DIST_DIR,
  automationsOrigin:
    process.env['LIGHTS_AUTOMATIONS_ORIGIN'] ?? DEFAULT_AUTOMATIONS_ORIGIN,
  readFile: async path => {
    const file = Bun.file(path)
    return (await file.exists()) ? Option.some(file) : Option.none()
  },
  fetchUpstream: (url, init) => fetch(url, init),
})

const server = Bun.serve<SocketData>({
  hostname: '0.0.0.0',
  port: Number(process.env['LIGHTS_LAN_PORT'] ?? DEFAULT_PORT),
  idleTimeout: REQUEST_IDLE_TIMEOUT_SECONDS,
  fetch: (request, bunServer) =>
    handle(request, () =>
      bunServer.upgrade(request, { data: { maybeBridge: Option.none() } }),
    ),
  websocket: {
    // NOTE: A client too slow to keep up would silently miss state frames.
    // Closing it makes the app reconnect and receive the full state again.
    closeOnBackpressureLimit: true,
    open: client => {
      client.data.maybeBridge = Option.some(
        bridgeSockets(new WebSocket(zigbeeSocket), client),
      )
    },
    message: (client, frame) => {
      if (typeof frame === 'string') {
        Option.map(client.data.maybeBridge, bridge =>
          bridge.sendToUpstream(frame),
        )
      }
    },
    close: client => {
      Option.map(client.data.maybeBridge, bridge => bridge.closeUpstream())
    },
  },
})

console.log(`lights LAN site listening on 0.0.0.0:${server.port}`)
