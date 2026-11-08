import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const file = join(
  mkdtempSync(join(tmpdir(), 'lights-presets-')),
  'presets.json',
)
process.env.LIGHTS_PRESETS_FILE = file
const { default: LightPresets } = await import('./presets.mjs')

const seed = {
  'Full red': {
    state: 'ON',
    brightness: 254,
    color: { hex: '#FF0000' },
    scene_id: 1,
  },
  Rainbow: {
    state: 'ON',
    brightness: 254,
    scene_id: 2,
    loop: { type: 'rainbow', interval_ms: 600, hue_step: 20 },
  },
  'Nice lighting': {
    state: 'ON',
    brightness: 254,
    color_temp: 370,
    scene_id: 3,
  },
}

const device = (name, type = 'light') => ({
  name,
  definition: {},
  isDevice: () => true,
  isGroup: () => false,
  exposes: () => [{ type }],
})
const group = (name, members) => ({
  name,
  isDevice: () => false,
  isGroup: () => true,
  membersDevices: () => members,
  hasMember: candidate => members.includes(candidate),
})

const orb = device('Orb')
const ufo = device('Bedroom UFO')
const plug = device('Plug', 'switch')
const groups = [
  group('All Lights', [orb, ufo]),
  group('Rest of the House', [orb]),
  group('Bedroom', [ufo]),
]
const entities = [orb, ufo, plug, ...groups]
const zigbee = {
  resolveEntity: name => entities.find(entity => entity.name === name),
  groupsIterator: () => groups.values(),
}

const make = () => {
  const mqtt = { publish: vi.fn(async () => undefined) }
  const eventBus = { onMQTTMessage: vi.fn(), removeListeners: vi.fn() }
  const logger = { info: vi.fn(), error: vi.fn() }
  const settings = { get: () => ({ mqtt: { base_topic: 'zigbee2mqtt' } }) }
  const extension = new LightPresets(
    zigbee,
    mqtt,
    null,
    null,
    eventBus,
    null,
    null,
    null,
    settings,
    logger,
  )
  return { extension, mqtt, logger }
}

const send = (extension, topic, body) =>
  extension.onMessage({
    topic: `zigbee2mqtt/${topic}`,
    message: JSON.stringify(body),
  })
const onDisk = () => JSON.parse(readFileSync(file, 'utf8'))
const lastList = mqtt => {
  const call = mqtt.publish.mock.calls
    .filter(([topic]) => topic === 'preset/list')
    .at(-1)
  return { list: JSON.parse(call[1]), options: call[2] }
}

beforeEach(() => {
  writeFileSync(file, JSON.stringify(seed))
})

describe('publishing the list', () => {
  test('start publishes a retained list', async () => {
    const { extension, mqtt } = make()
    await extension.start()
    const { list, options } = lastList(mqtt)
    expect(options).toEqual({ clientOptions: { retain: true } })
    expect(list.map(preset => preset.name)).toEqual([
      'Full red',
      'Rainbow',
      'Nice lighting',
    ])
    expect(list[0].color).toEqual({ hex: '#FF0000' })
    expect(list[1].loop).toBeDefined()
  })
})

describe('applying', () => {
  test('uses the requested group', async () => {
    const { extension, mqtt } = make()
    await send(extension, 'preset/set', {
      name: 'Full red',
      group: 'Rest of the House',
    })
    expect(mqtt.publish.mock.calls[0][0]).toBe('Rest of the House/set')
  })

  test('defaults to All Lights so existing callers keep working', async () => {
    const { extension, mqtt } = make()
    await send(extension, 'preset/set', { name: 'Full red' })
    expect(mqtt.publish.mock.calls[0][0]).toBe('All Lights/set')
  })

  test('refuses Bedroom', async () => {
    const { extension, mqtt, logger } = make()
    await send(extension, 'preset/set', { name: 'Full red', group: 'Bedroom' })
    expect(mqtt.publish).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('applying to one bulb', () => {
  test('sends the preset to that bulb', async () => {
    const { extension, mqtt } = make()
    await send(extension, 'preset/set', { name: 'Full red', light: 'Orb' })
    expect(mqtt.publish.mock.calls).toEqual([
      [
        'Orb/set',
        JSON.stringify({
          state: 'ON',
          brightness: 254,
          color: { hex: '#FF0000' },
        }),
        { skipReceive: false },
      ],
    ])
  })

  test('accepts a bulb in the Bedroom group', async () => {
    const { extension, mqtt } = make()
    await send(extension, 'preset/set', {
      name: 'Full red',
      light: 'Bedroom UFO',
    })
    expect(mqtt.publish.mock.calls[0][0]).toBe('Bedroom UFO/set')
  })

  test.each([
    ['a group name', { light: 'Bedroom' }],
    ['an unknown name', { light: 'bridge/request/permit_join' }],
    ['a device that is not a light', { light: 'Plug' }],
    ['a non-string name', { light: 7 }],
    ['both a light and a group', { light: 'Orb', group: 'All Lights' }],
  ])('refuses %s', async (_label, target) => {
    const { extension, mqtt, logger } = make()
    await send(extension, 'preset/set', { name: 'Full red', ...target })
    expect(mqtt.publish).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('rainbow loops', () => {
  const start = async (extension, target) => {
    await send(extension, 'preset/set', { name: 'Rainbow', ...target })
    return extension
  }
  const isLooping = (extension, name) =>
    extension.loopState(name).active != null

  test('a bulb can run its own loop', async () => {
    const { extension, mqtt } = make()
    await start(extension, { light: 'Orb' })
    expect(mqtt.publish.mock.calls[0][0]).toBe('Orb/set')
    expect(isLooping(extension, 'Orb')).toBe(true)
    extension.stop()
  })

  test('its own frames do not stop a bulb loop', async () => {
    const { extension } = make()
    await start(extension, { light: 'Orb' })
    await send(extension, 'Orb/set', { color: { hex: '#FF0000' } })
    expect(isLooping(extension, 'Orb')).toBe(true)
    extension.stop()
  })

  test('another command to the bulb stops its loop', async () => {
    const { extension } = make()
    await start(extension, { light: 'Orb' })
    await send(extension, 'Orb/set', { state: 'OFF' })
    expect(isLooping(extension, 'Orb')).toBe(false)
  })

  test('a command to any group stops loops on its bulbs', async () => {
    const { extension } = make()
    await start(extension, { light: 'Bedroom UFO' })
    await send(extension, 'Bedroom/set', { state: 'OFF' })
    expect(isLooping(extension, 'Bedroom UFO')).toBe(false)
  })

  test('a group preset stops loops on its bulbs', async () => {
    const { extension } = make()
    await start(extension, { light: 'Orb' })
    await send(extension, 'preset/set', {
      name: 'Full red',
      group: 'All Lights',
    })
    expect(isLooping(extension, 'Orb')).toBe(false)
  })

  test('a bulb preset stops loops on groups that contain it', async () => {
    const { extension } = make()
    await start(extension, { group: 'Rest of the House' })
    await send(extension, 'preset/set', { name: 'Full red', light: 'Orb' })
    expect(isLooping(extension, 'Rest of the House')).toBe(false)
  })

  test('a bulb preset leaves other loops running', async () => {
    const { extension } = make()
    await start(extension, { light: 'Orb' })
    await send(extension, 'preset/set', {
      name: 'Full red',
      light: 'Bedroom UFO',
    })
    expect(isLooping(extension, 'Orb')).toBe(true)
    extension.stop()
  })

  test('a loop stops when its bulb disappears', async () => {
    vi.useFakeTimers()
    const { extension, mqtt, logger } = make()
    const removed = device('Removed')
    entities.push(removed)
    await start(extension, { light: 'Removed' })
    entities.pop()
    mqtt.publish.mockClear()
    await vi.advanceTimersByTimeAsync(5000)
    vi.useRealTimers()
    expect(mqtt.publish).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
    expect(isLooping(extension, 'Removed')).toBe(false)
  })
})

describe('saving', () => {
  test('adds a color preset with the next scene id and publishes', async () => {
    const { extension, mqtt } = make()
    await send(extension, 'preset/save', {
      name: 'Movie',
      brightness: 90,
      color: { hex: '#112233' },
    })
    expect(onDisk().Movie).toEqual({
      state: 'ON',
      brightness: 90,
      color: { hex: '#112233' },
      scene_id: 4,
    })
    expect(lastList(mqtt).list.map(preset => preset.name)).toContain('Movie')
  })

  test('renames in place and keeps the scene id', async () => {
    const { extension } = make()
    await send(extension, 'preset/save', {
      name: 'Red',
      previous_name: 'Full red',
      brightness: 100,
      color_temp: 200,
    })
    expect(Object.keys(onDisk())).toEqual(['Red', 'Rainbow', 'Nice lighting'])
    expect(onDisk().Red).toEqual({
      state: 'ON',
      brightness: 100,
      color_temp: 200,
      scene_id: 1,
    })
  })

  test.each([
    ['blank name', { name: '  ', brightness: 10, color_temp: 200 }],
    ['prototype key', { name: '__proto__', brightness: 10, color_temp: 200 }],
    ['brightness 0', { name: 'A', brightness: 0, color_temp: 200 }],
    ['bad hex', { name: 'A', brightness: 10, color: { hex: 'red' } }],
    [
      'both looks',
      { name: 'A', brightness: 10, color: { hex: '#112233' }, color_temp: 200 },
    ],
    ['no look', { name: 'A', brightness: 10 }],
    ['temp out of range', { name: 'A', brightness: 10, color_temp: 9000 }],
    ['duplicate name', { name: 'Full red', brightness: 10, color_temp: 200 }],
    [
      'unknown previous',
      { name: 'A', previous_name: 'Nope', brightness: 10, color_temp: 200 },
    ],
    [
      'overwriting Rainbow',
      { name: 'A', previous_name: 'Rainbow', brightness: 10, color_temp: 200 },
    ],
  ])('refuses %s', async (_label, body) => {
    const { extension, mqtt } = make()
    await send(extension, 'preset/save', body)
    expect(onDisk()).toEqual(seed)
    expect(mqtt.publish).not.toHaveBeenCalled()
  })
})

describe('deleting', () => {
  test('removes a preset and publishes', async () => {
    const { extension, mqtt } = make()
    await send(extension, 'preset/delete', { name: 'Full red' })
    expect(Object.keys(onDisk())).toEqual(['Rainbow', 'Nice lighting'])
    expect(lastList(mqtt).list).toHaveLength(2)
  })

  test('refuses Rainbow', async () => {
    const { extension } = make()
    await send(extension, 'preset/delete', { name: 'Rainbow' })
    expect(onDisk()).toEqual(seed)
  })
})
