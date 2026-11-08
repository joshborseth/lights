import { Effect } from 'effect'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { connectLights } from './mqtt'

class FakeClient extends EventEmitter {
  connected = true
  published: Array<string> = []
  answering = new Set<string>()
  subscribe = vi.fn()
  endAsync = () => Promise.resolve()

  publishAsync = (topic: string): Promise<void> => {
    this.published.push(topic)
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
