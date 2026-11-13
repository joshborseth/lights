import { Array, Data, Duration, Effect, Option, pipe } from 'effect'
import mqtt, { type MqttClient } from 'mqtt'

import { type BulbCapabilities } from '../src/bulbColor'
import { type LightsPort } from './engine'
import { type JsonObject, type LightStates, isJsonObject } from './flash'

const BASE_TOPIC = 'zigbee2mqtt'
const RECONNECT_MS = 2000
const STATE_REQUEST_WAIT_MS = 5000
const STATE_REQUEST_POLL_MS = 200
// NOTE: Long enough to catch at least two frames of a slow Rainbow loop.
const RAINBOW_WINDOW_MS = 5000

export class LightsError extends Data.TaggedError('LightsError')<{
  readonly reason: string
}> {}

export type MqttOptions = Readonly<{
  host: string
  port: number
  username: string
  password: string
}>

type RecentHex = Readonly<{ at: number; hex: string }>

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const asObject = (value: unknown): JsonObject | undefined =>
  isJsonObject(value) ? value : undefined

const asArray = (value: unknown): ReadonlyArray<unknown> =>
  globalThis.Array.isArray(value) ? value : []

const stringField = (
  object: JsonObject | undefined,
  key: string,
): string | undefined => {
  const value = object?.[key]
  return typeof value === 'string' ? value : undefined
}

const NO_CAPABILITIES: BulbCapabilities = {
  supportsColor: false,
  supportsColorTemp: false,
}

// NOTE: The same reading of a device's exposes as the app's `toLight`.
const lightCapabilities = (
  device: JsonObject | undefined,
): BulbCapabilities => {
  const light = asArray(asObject(device?.['definition'])?.['exposes'])
    .map(asObject)
    .find(expose => stringField(expose, 'type') === 'light')
  const names = asArray(light?.['features']).map(feature =>
    stringField(asObject(feature), 'name'),
  )
  return light === undefined
    ? NO_CAPABILITIES
    : {
        supportsColor: names.includes('color_xy') || names.includes('color_hs'),
        supportsColorTemp: names.includes('color_temp'),
      }
}

export type LightsConnection = LightsPort<LightsError> &
  Readonly<{
    close: Effect.Effect<void>
    capabilitiesOf: (name: string) => BulbCapabilities
  }>

export const connectLights = (
  options: MqttOptions,
  log: (text: string) => void,
  stateWaitMs: number = STATE_REQUEST_WAIT_MS,
): Effect.Effect<LightsConnection> =>
  Effect.sync(() => {
    const client: MqttClient = mqtt.connect({
      protocol: 'mqtt',
      host: options.host,
      port: options.port,
      username: options.username,
      password: options.password,
      reconnectPeriod: RECONNECT_MS,
      // NOTE: Never buffer commands while offline. A flash replayed on reconnect
      // would hit the bulbs long after the merge.
      queueQoSZero: false,
    })

    const states = new Map<string, JsonObject>()
    const groupAddresses = new Map<string, ReadonlyArray<string>>()
    const addressNames = new Map<string, string>()
    const capabilities = new Map<string, BulbCapabilities>()
    const rainbowFrames = new Map<string, ReadonlyArray<RecentHex>>()
    let maybeBridgeOnline: Option.Option<boolean> = Option.none()

    const handleGroups = (payload: unknown): void => {
      groupAddresses.clear()
      asArray(payload).forEach(item => {
        const group = asObject(item)
        const name = stringField(group, 'friendly_name')
        if (name !== undefined) {
          groupAddresses.set(
            name,
            pipe(
              asArray(group?.['members']),
              Array.map(member =>
                Option.fromUndefinedOr(
                  stringField(asObject(member), 'ieee_address'),
                ),
              ),
              Array.getSomes,
            ),
          )
        }
      })
    }

    const handleDevices = (payload: unknown): void => {
      addressNames.clear()
      capabilities.clear()
      asArray(payload).forEach(item => {
        const device = asObject(item)
        const address = stringField(device, 'ieee_address')
        const name = stringField(device, 'friendly_name')
        if (address !== undefined && name !== undefined) {
          addressNames.set(address, name)
          capabilities.set(name, lightCapabilities(device))
        }
      })
    }

    const handleBridgeState = (text: string, payload: unknown): void => {
      const reported = stringField(asObject(payload), 'state') ?? text
      maybeBridgeOnline = Option.some(reported === 'online')
    }

    const handleGroupCommand = (group: string, payload: unknown): void => {
      const hex = stringField(asObject(asObject(payload)?.['color']), 'hex')
      if (hex === undefined) {
        return
      }
      const now = Date.now()
      rainbowFrames.set(group, [
        ...Array.filter(
          rainbowFrames.get(group) ?? [],
          frame => now - frame.at < RAINBOW_WINDOW_MS,
        ),
        { at: now, hex: hex.toUpperCase() },
      ])
    }

    client.on('connect', () => {
      log('connected to the MQTT broker')
      client.subscribe([
        `${BASE_TOPIC}/bridge/state`,
        `${BASE_TOPIC}/bridge/groups`,
        `${BASE_TOPIC}/bridge/devices`,
        `${BASE_TOPIC}/+`,
        `${BASE_TOPIC}/+/set`,
      ])
    })
    client.on('error', error => {
      log(`MQTT error: ${error.message}`)
    })
    client.on('message', (topic, buffer) => {
      const relative = topic.slice(BASE_TOPIC.length + 1)
      const text = buffer.toString()
      const payload = parseJson(text)
      if (relative === 'bridge/state') {
        handleBridgeState(text, payload)
      } else if (relative === 'bridge/groups') {
        handleGroups(payload)
      } else if (relative === 'bridge/devices') {
        handleDevices(payload)
      } else if (relative.endsWith('/set')) {
        const group = relative.slice(0, -'/set'.length)
        if (groupAddresses.has(group)) {
          handleGroupCommand(group, payload)
        }
      } else if (!relative.includes('/')) {
        const state = asObject(payload)
        if (state !== undefined) {
          states.set(relative, state)
        }
      }
    })

    const publish = (
      topic: string,
      payload: JsonObject,
    ): Effect.Effect<void, LightsError> =>
      client.connected
        ? Effect.tryPromise({
            try: () =>
              client.publishAsync(
                `${BASE_TOPIC}/${topic}`,
                JSON.stringify(payload),
              ),
            catch: error =>
              new LightsError({
                reason:
                  error instanceof Error ? error.message : 'publish failed',
              }),
          }).pipe(Effect.asVoid)
        : Effect.fail(new LightsError({ reason: 'not connected to MQTT' }))

    const groupMembers = (group: string): ReadonlyArray<string> =>
      pipe(
        groupAddresses.get(group) ?? [],
        Array.map(address => Option.fromUndefinedOr(addressNames.get(address))),
        Array.getSomes,
      )

    const knownStates = (names: ReadonlyArray<string>): LightStates =>
      Object.fromEntries(
        Array.getSomes(
          Array.map(names, name =>
            Option.map(
              Option.fromUndefinedOr(states.get(name)),
              state => [name, state] as const,
            ),
          ),
        ),
      )

    const missingFrom = (names: ReadonlyArray<string>) =>
      Array.filter(names, name => !states.has(name))

    const waitForStates = (
      names: ReadonlyArray<string>,
      remainingMs: number,
    ): Effect.Effect<void> =>
      Array.isReadonlyArrayEmpty(missingFrom(names)) || remainingMs <= 0
        ? Effect.void
        : Effect.sleep(Duration.millis(STATE_REQUEST_POLL_MS)).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                waitForStates(names, remainingMs - STATE_REQUEST_POLL_MS),
              ),
            ),
          )

    return {
      close: Effect.promise(() => client.endAsync()),
      isBrokerConnected: () => client.connected,
      maybeIsBridgeOnline: () => maybeBridgeOnline,
      groupMembers,
      capabilitiesOf: name => capabilities.get(name) ?? NO_CAPABILITIES,
      activeRainbowGroups: () => {
        const now = Date.now()
        return Array.filter(
          Array.fromIterable(groupAddresses.keys()),
          group => {
            const recent = Array.filter(
              rainbowFrames.get(group) ?? [],
              frame => now - frame.at < RAINBOW_WINDOW_MS,
            )
            return new Set(Array.map(recent, frame => frame.hex)).size >= 2
          },
        )
      },
      markRainbowStopped: group => {
        rainbowFrames.delete(group)
      },
      readStates: (names, { shouldAskBulbs }) =>
        Effect.gen(function* () {
          if (shouldAskBulbs) {
            names.forEach(name => {
              states.delete(name)
            })
            // NOTE: Only on or off. Zigbee2MQTT answers with everything else it
            // knows, which is the last brightness and color the bulb was given.
            // A brightness read straight from a bulb can be its minimum after a
            // quick off and on, and the flash would then restore it almost dark.
            yield* Effect.forEach(
              names,
              name => publish(`${name}/get`, { state: '' }),
              { discard: true },
            )
            yield* waitForStates(names, stateWaitMs)
          }
          return knownStates(names)
        }),
      publishLight: (name, payload) => publish(`${name}/set`, payload),
      publishGroup: (group, payload) => publish(`${group}/set`, payload),
      applyPreset: (group, name) => publish('preset/set', { name, group }),
      sleep: ms => Effect.sleep(Duration.millis(ms)),
      log: text => Effect.sync(() => log(text)),
    }
  })
