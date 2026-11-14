import { Effect } from 'effect'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { connectLights } from './mqtt'

class FakeClient extends EventEmitter {
  connected = true
  published: Array<string> = []
  payloads: Array<string> = []
  answering = new Set<string>()
  subscribe = vi.fn()
  endAsync = () => Promise.resolve()

  publishAsync = (topic: string, payload: string): Promise<void> => {
    this.published.push(topic)
    this.payloads.push(payload)
    const name = topic.match(/^zigbee2mqtt\/(.+)\/get$/)?.[1]
    if (name !== undefined && this.answering.has(name)) {
      this.emit(
        'message',
        `zigbee2mqtt/${name}`,
        Buffer.from(JSON.stringify({ state: 'ON' })),
      )
    }
    return Promise.resolve()
  }
}

const { client } = vi.hoisted(() => {
  const holder: { current: unknown } = { current: undefined }
  return { client: holder }
})

vi.mock('mqtt', () => ({
  default: { connect: () => client.current },
}))

const OPTIONS = { host: 'h', port: 1, username: 'u', password: 'p' }
const NAMES = ['Orb', 'Shroom']

const setup = async () => {
  const fake = new FakeClient()
  client.current = fake
  const lights = await Effect.runPromise(
    connectLights(OPTIONS, () => undefined, 200),
  )
  return { fake, lights }
}

const getRequests = (fake: FakeClient) =>
  fake.published.filter(topic => topic.endsWith('/get'))

describe('reading bulb state', () => {
  beforeEach(() => {
    client.current = undefined
  })

  test('asks every bulb before each flash, even after hearing from it', async () => {
    const { fake, lights } = await setup()
    fake.answering = new Set(NAMES)
    const options = { shouldAskBulbs: true }
    await Effect.runPromise(lights.readStates(NAMES, options))
    await Effect.runPromise(lights.readStates(NAMES, options))
    expect(getRequests(fake)).toHaveLength(4)
  })

  test('asks only whether each bulb is on', async () => {
    const { fake, lights } = await setup()
    fake.answering = new Set(NAMES)
    await Effect.runPromise(lights.readStates(NAMES, { shouldAskBulbs: true }))
    expect(fake.payloads).toEqual(['{"state":""}', '{"state":""}'])
  })

  test('a bulb that stops answering no longer counts as on', async () => {
    const { fake, lights } = await setup()
    fake.answering = new Set(NAMES)
    const options = { shouldAskBulbs: true }
    await Effect.runPromise(lights.readStates(NAMES, options))
    fake.answering = new Set(['Orb'])
    const states = await Effect.runPromise(lights.readStates(NAMES, options))
    expect(Object.keys(states)).toEqual(['Orb'])
  })

  test('sends no requests while a Rainbow loop owns the radio', async () => {
    const { fake, lights } = await setup()
    await Effect.runPromise(lights.readStates(NAMES, { shouldAskBulbs: false }))
    expect(getRequests(fake)).toEqual([])
  })

  test('refuses to publish while disconnected instead of queueing', async () => {
    const { fake, lights } = await setup()
    fake.connected = false
    const exit = await Effect.runPromiseExit(
      lights.publishLight('Orb', { state: 'OFF' }),
    )
    expect(exit._tag).toBe('Failure')
    expect(fake.published).toEqual([])
  })
})

describe('spotting a Rainbow loop', () => {
  const emit = (fake: FakeClient, topic: string, payload: unknown) =>
    fake.emit(
      'message',
      `zigbee2mqtt/${topic}`,
      Buffer.from(JSON.stringify(payload)),
    )
  const frame = (hex: string) => ({ color: { hex } })

  test('finds a loop on any group, and ignores commands to a bulb', async () => {
    const { fake, lights } = await setup()
    emit(fake, 'bridge/groups', [{ friendly_name: 'Bedroom', members: [] }])
    emit(fake, 'Bedroom/set', frame('#FF0000'))
    emit(fake, 'Bedroom/set', frame('#FFAA00'))
    emit(fake, 'Orb/set', frame('#FF0000'))
    emit(fake, 'Orb/set', frame('#FFAA00'))
    expect(lights.activeRainbowGroups()).toEqual(['Bedroom'])
  })
})

describe('bulb capabilities', () => {
  test('reads color and color temperature support from the device list', async () => {
    const { fake, lights } = await setup()
    const light = (name: string, features: ReadonlyArray<string>) => ({
      ieee_address: `0x${name}`,
      friendly_name: name,
      definition: {
        exposes: [
          {
            type: 'light',
            features: features.map(feature => ({ name: feature })),
          },
        ],
      },
    })
    fake.emit(
      'message',
      'zigbee2mqtt/bridge/devices',
      Buffer.from(
        JSON.stringify([
          light('Orb', ['state', 'brightness', 'color_temp', 'color_xy']),
          light('Kajplats', ['state', 'brightness', 'color_hs']),
          light('Spot', ['state', 'brightness', 'color_temp']),
          {
            ieee_address: '0xremote',
            friendly_name: 'Remote',
            definition: { exposes: [] },
          },
        ]),
      ),
    )
    expect(lights.capabilitiesOf('Orb')).toEqual({
      supportsColor: true,
      supportsColorTemp: true,
    })
    expect(lights.capabilitiesOf('Kajplats').supportsColor).toBe(true)
    expect(lights.capabilitiesOf('Spot')).toEqual({
      supportsColor: false,
      supportsColorTemp: true,
    })
    expect(lights.capabilitiesOf('Remote')).toEqual({
      supportsColor: false,
      supportsColorTemp: false,
    })
    expect(lights.capabilitiesOf('Unknown').supportsColor).toBe(false)
  })
})

describe('group members', () => {
  test('leaves out the closet, so nothing whole-house repaints it', async () => {
    const { fake, lights } = await setup()
    const emit = (topic: string, payload: unknown) =>
      fake.emit(
        'message',
        `zigbee2mqtt/${topic}`,
        Buffer.from(JSON.stringify(payload)),
      )
    emit('bridge/devices', [
      { ieee_address: '0xa', friendly_name: 'Bedroom UFO' },
      { ieee_address: '0xb', friendly_name: 'Closet' },
    ])
    emit('bridge/groups', [
      {
        friendly_name: 'Bedroom',
        members: [{ ieee_address: '0xa' }, { ieee_address: '0xb' }],
      },
    ])
    expect(lights.groupMembers('Bedroom')).toEqual(['Bedroom UFO'])
  })
})
