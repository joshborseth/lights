import { Effect, Exit, Fiber, Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { DEFAULT_CONFIG, type FlashConfig } from '../src/automation'
import {
  type FlashPort,
  type JsonObject,
  type LightStates,
  OFF_FRAME,
  repaintFrame,
  restoreFrame,
  runFlash,
} from './flash'

type Sent =
  | Readonly<{ kind: 'light'; name: string; payload: JsonObject }>
  | Readonly<{ kind: 'group'; group: string; payload: JsonObject }>
  | Readonly<{ kind: 'preset'; group: string; preset: string }>

const FLASH: FlashConfig = { ...DEFAULT_CONFIG.flash, count: 2 }
const ON_STATE: JsonObject = {
  state: 'ON',
  brightness: 120,
  color_mode: 'color_temp',
  color_temp: 370,
}
const OFF_STATE: JsonObject = { state: 'OFF' }

const makePort = (
  options: Readonly<{
    states: LightStates
    groups?: Readonly<Record<string, ReadonlyArray<string>>>
    rainbow?: ReadonlyArray<string>
    failOn?: (sent: Sent) => boolean
  }>,
) => {
  const sent: Array<Sent> = []
  const stopped: Array<string> = []
  const groups = options.groups ?? { 'All Lights': ['Orb', 'Shroom'] }
  const record = (entry: Sent) =>
    Effect.suspend(() => {
      sent.push(entry)
      return options.failOn?.(entry) === true
        ? Effect.fail('publish failed')
        : Effect.void
    })
  const port: FlashPort<string> = {
    groupMembers: group => groups[group] ?? [],
    activeRainbowGroups: () => options.rainbow ?? [],
    markRainbowStopped: group => {
      stopped.push(group)
    },
    readStates: () => Effect.succeed(options.states),
    publishLight: (name, payload) => record({ kind: 'light', name, payload }),
    publishGroup: (group, payload) => record({ kind: 'group', group, payload }),
    applyPreset: (group, preset) => record({ kind: 'preset', group, preset }),
    sleep: () => Effect.void,
    log: () => Effect.void,
  }
  return { port, sent, stopped }
}

const payloadsFor = (sent: ReadonlyArray<Sent>, name: string) =>
  sent.flatMap(entry =>
    entry.kind === 'light' && entry.name === name ? [entry.payload] : [],
  )

describe('runFlash', () => {
  test('sends every flash color as x and y, even to a Rainbow group', async () => {
    const { port, sent } = makePort({
      states: { Orb: ON_STATE, Shroom: ON_STATE },
      rainbow: ['All Lights'],
    })
    await Effect.runPromise(runFlash(port, FLASH))
    const text = JSON.stringify(sent)
    expect(text).toContain('"x":0.331')
    expect(text).not.toContain('hue')
    expect(text).not.toContain('saturation')
    expect(text).not.toContain('hex')
  })

  test('never sends a transition, and off is exactly state OFF', async () => {
    const { port, sent } = makePort({
      states: { Orb: ON_STATE, Shroom: ON_STATE },
    })
    await Effect.runPromise(runFlash(port, FLASH))
    expect(JSON.stringify(sent)).not.toContain('transition')
    expect(payloadsFor(sent, 'Orb').filter(p => p['state'] === 'OFF')).toEqual([
      OFF_FRAME,
      OFF_FRAME,
    ])
  })

  test('leaves lights that are off alone', async () => {
    const { port, sent } = makePort({
      states: { Orb: ON_STATE, Shroom: OFF_STATE },
    })
    const result = await Effect.runPromise(runFlash(port, FLASH))
    expect(result.flashed).toEqual(['Orb'])
    expect(payloadsFor(sent, 'Shroom')).toEqual([])
  })

  test('skips when no lights are on', async () => {
    const { port, sent } = makePort({
      states: { Orb: OFF_STATE, Shroom: OFF_STATE },
    })
    const result = await Effect.runPromise(runFlash(port, FLASH))
    expect(result.skippedReason).toEqual(Option.some('No lights were on.'))
    expect(sent).toEqual([])
  })

  test('skips a light that does not answer, and the rest still flash', async () => {
    const { port, sent } = makePort({ states: { Orb: ON_STATE } })
    const result = await Effect.runPromise(runFlash(port, FLASH))
    expect(result.flashed).toEqual(['Orb'])
    expect(result.unresponsive).toEqual(['Shroom'])
    expect(payloadsFor(sent, 'Shroom')).toEqual([])
  })

  test('skips a silent light even when flashing every light', async () => {
    const { port, sent } = makePort({ states: { Orb: OFF_STATE } })
    await Effect.runPromise(
      runFlash(port, { ...FLASH, onlyLightsAlreadyOn: false }),
    )
    expect(payloadsFor(sent, 'Shroom')).toEqual([])
  })

  test('says who did not answer when nothing could flash', async () => {
    const { port } = makePort({ states: { Orb: OFF_STATE } })
    const result = await Effect.runPromise(runFlash(port, FLASH))
    expect(result.skippedReason).toEqual(
      Option.some('No lights were on. No answer from Shroom.'),
    )
    expect(result.leftOff).toEqual(['Orb'])
  })

  test('flashes every light when told not to check, and restores off lights to off', async () => {
    const { port, sent } = makePort({
      states: { Orb: ON_STATE, Shroom: OFF_STATE },
    })
    await Effect.runPromise(
      runFlash(port, { ...FLASH, onlyLightsAlreadyOn: false, count: 1 }),
    )
    expect(payloadsFor(sent, 'Shroom').at(-1)).toEqual(OFF_FRAME)
  })

  test('puts lights back the way they were', async () => {
    const { port, sent } = makePort({ states: { Orb: ON_STATE } })
    await Effect.runPromise(runFlash(port, { ...FLASH, count: 1 }))
    expect(payloadsFor(sent, 'Orb').slice(2)).toEqual([
      { state: 'ON', brightness: 120, color_temp: 370 },
      { color_temp: 370 },
      { color_temp: 370 },
    ])
  })

  test('sends the repeated color only after the bulbs have had time to wake', async () => {
    const steps: Array<string> = []
    const { port } = makePort({ states: { Orb: ON_STATE } })
    const tracingPort: FlashPort<string> = {
      ...port,
      publishLight: (name, payload) =>
        port
          .publishLight(name, payload)
          .pipe(Effect.tap(() => Effect.sync(() => steps.push('send')))),
      sleep: ms => Effect.sync(() => steps.push(`wait ${ms}`)),
    }
    await Effect.runPromise(runFlash(tracingPort, { ...FLASH, count: 1 }))
    expect(steps.slice(-7)).toEqual([
      'wait 250',
      'wait 1200',
      'send',
      'wait 250',
      'wait 1200',
      'send',
      'wait 250',
    ])
  })

  test('does not repeat a color for a light that was off', async () => {
    const { port, sent } = makePort({
      states: { Orb: ON_STATE, Shroom: OFF_STATE },
    })
    await Effect.runPromise(
      runFlash(port, { ...FLASH, onlyLightsAlreadyOn: false, count: 1 }),
    )
    expect(
      payloadsFor(sent, 'Shroom').filter(p => p['state'] === undefined),
    ).toEqual([])
  })

  test('a bulb that drops the color sent with its power-on still ends up on its own color', async () => {
    const before: JsonObject = {
      state: 'ON',
      brightness: 120,
      color_mode: 'xy',
      color: { x: 0.56, y: 0.4 },
    }
    const { port, sent } = makePort({ states: { Orb: before } })
    await Effect.runPromise(runFlash(port, { ...FLASH, count: 1 }))

    const [flashFrame, ...laterFrames] = payloadsFor(sent, 'Orb')
    const shownColor = laterFrames.reduce<unknown>(
      (color, payload) =>
        payload['state'] === undefined && payload['color'] !== undefined
          ? payload['color']
          : color,
      flashFrame?.['color'],
    )
    expect(shownColor).toEqual({ x: 0.56, y: 0.4 })
  })

  test('does not restore when turned off in settings', async () => {
    const { port, sent } = makePort({ states: { Orb: ON_STATE } })
    await Effect.runPromise(
      runFlash(port, { ...FLASH, count: 1, shouldRestore: false }),
    )
    expect(payloadsFor(sent, 'Orb').at(-1)).toEqual(OFF_FRAME)
  })

  test('stops Rainbow with a frame its echo filter will not swallow, then resumes it', async () => {
    const { port, sent, stopped } = makePort({
      states: { Orb: ON_STATE, Shroom: ON_STATE },
      groups: { 'All Lights': ['Orb', 'Shroom'] },
      rainbow: ['All Lights'],
    })
    await Effect.runPromise(runFlash(port, { ...FLASH, count: 1 }))
    const stopFrames = sent.filter(entry => entry.kind === 'group')
    expect(stopFrames).toHaveLength(2)
    expect(JSON.stringify(stopFrames)).not.toContain('hex')
    expect(JSON.stringify(stopFrames)).not.toContain('state')
    expect(stopped).toEqual(['All Lights'])
    expect(sent.at(-1)).toEqual({
      kind: 'preset',
      group: 'All Lights',
      preset: 'Rainbow',
    })
  })

  test('restores lights a resumed Rainbow does not cover', async () => {
    const { port, sent } = makePort({
      states: { Orb: ON_STATE, Bed: ON_STATE },
      groups: {
        'All Lights': ['Orb', 'Bed'],
        'Rest of the House': ['Orb'],
      },
      rainbow: ['Rest of the House'],
    })
    await Effect.runPromise(runFlash(port, { ...FLASH, count: 1 }))
    expect(payloadsFor(sent, 'Bed')).toContainEqual({
      state: 'ON',
      brightness: 120,
      color_temp: 370,
    })
    expect(payloadsFor(sent, 'Bed').at(-1)).toEqual({ color_temp: 370 })
    expect(payloadsFor(sent, 'Orb').at(-1)).toEqual(OFF_FRAME)
  })

  test('still restores when a flash command fails', async () => {
    const { port, sent } = makePort({
      states: { Orb: ON_STATE },
      failOn: entry =>
        entry.kind === 'light' && entry.payload['state'] === 'OFF',
    })
    const exit = await Effect.runPromiseExit(runFlash(port, FLASH))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(payloadsFor(sent, 'Orb')).toContainEqual({
      state: 'ON',
      brightness: 120,
      color_temp: 370,
    })
  })

  test('restores when interrupted mid-flash', async () => {
    const { port, sent } = makePort({ states: { Orb: ON_STATE } })
    const slowPort: FlashPort<string> = {
      ...port,
      sleep: ms => (ms === FLASH.onMs ? Effect.never : Effect.void),
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(runFlash(slowPort, FLASH))
        yield* Effect.sleep('10 millis')
        yield* Fiber.interrupt(fiber)
      }),
    )
    expect(payloadsFor(sent, 'Orb')).toContainEqual({
      state: 'ON',
      brightness: 120,
      color_temp: 370,
    })
    expect(payloadsFor(sent, 'Orb').at(-1)).toEqual({ color_temp: 370 })
  })
})

describe('repaintFrame', () => {
  test('carries only the color, with no power or brightness', () => {
    expect(
      repaintFrame({
        state: 'ON',
        brightness: 10,
        color_mode: 'xy',
        color: { x: 0.3, y: 0.4 },
      }),
    ).toEqual(Option.some({ color: { x: 0.3, y: 0.4 } }))
  })

  test('sends nothing for a light that was off or reported no color', () => {
    expect(repaintFrame({ state: 'OFF', color: { x: 0.3, y: 0.4 } })).toEqual(
      Option.none(),
    )
    expect(repaintFrame({ state: 'ON', brightness: 10 })).toEqual(Option.none())
  })
})

describe('restoreFrame', () => {
  test('sends color by xy when the bulb reported it', () => {
    expect(
      restoreFrame({
        state: 'ON',
        brightness: 10,
        color_mode: 'xy',
        color: { x: 0.3, y: 0.4 },
      }),
    ).toEqual({ state: 'ON', brightness: 10, color: { x: 0.3, y: 0.4 } })
  })

  test('off is exactly state OFF even with other reported fields', () => {
    expect(restoreFrame({ state: 'OFF', brightness: 5 })).toEqual({
      state: 'OFF',
    })
  })
})
