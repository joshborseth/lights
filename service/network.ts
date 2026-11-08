import { Array, Effect, Option, Schema, pipe } from 'effect'
import { execFile } from 'node:child_process'
import { type Socket, createSocket } from 'node:dgram'

import { type Neighbour, Observation } from './presence'

// NOTE: The phone never has to accept this packet. Addressing it makes the
// kernel confirm the phone over ARP, and Wi-Fi chips answer ARP while the phone
// sleeps. The port is mDNS, which phones keep open.
const NUDGE_PORT = 5353
const NUDGE_PAYLOAD = Buffer.from([0])
const IP_TIMEOUT_MS = 5000

const IpNeighbour = Schema.Struct({
  dst: Schema.String,
  lladdr: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.Array(Schema.String)),
})

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const answeredNeighbour = (
  entry: typeof IpNeighbour.Type,
): Option.Option<Neighbour> =>
  entry.lladdr !== undefined &&
  !entry.dst.includes(':') &&
  (entry.state ?? []).includes('REACHABLE')
    ? Option.some({ mac: entry.lladdr.toLowerCase(), address: entry.dst })
    : Option.none()

export const observationFromNeighbourTable = (
  text: string,
  gateway: string,
): Observation =>
  pipe(
    Schema.decodeUnknownOption(Schema.Array(IpNeighbour))(parseJson(text)),
    Option.map(entries =>
      Array.getSomes(Array.map(entries, answeredNeighbour)),
    ),
    Option.filter(Array.some(neighbour => neighbour.address === gateway)),
    Option.match({
      onNone: () => Observation.NetworkUnknown(),
      onSome: neighbours => Observation.Answered({ neighbours }),
    }),
  )

const readNeighbourTable: Effect.Effect<Option.Option<string>> =
  Effect.callback(resume => {
    execFile(
      'ip',
      ['-j', 'neigh', 'show'],
      { timeout: IP_TIMEOUT_MS },
      (error, stdout) => {
        resume(
          Effect.succeed(error === null ? Option.some(stdout) : Option.none()),
        )
      },
    )
  })

export const observeNetwork = (gateway: string): Effect.Effect<Observation> =>
  Effect.map(readNeighbourTable, maybeText =>
    Option.match(maybeText, {
      onNone: () => Observation.NetworkUnknown(),
      onSome: text => observationFromNeighbourTable(text, gateway),
    }),
  )

const sendNudge = (socket: Socket, address: string): Effect.Effect<void> =>
  Effect.callback(resume => {
    socket.send(NUDGE_PAYLOAD, NUDGE_PORT, address, () => {
      resume(Effect.void)
    })
  })

export const nudgeAddresses = (
  addresses: ReadonlyArray<string>,
): Effect.Effect<void> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const socket = createSocket('udp4')
      socket.on('error', () => undefined)
      return socket
    }),
    socket =>
      Effect.forEach(addresses, address => sendNudge(socket, address), {
        discard: true,
      }),
    socket =>
      Effect.sync(() => {
        socket.close()
      }),
  )
