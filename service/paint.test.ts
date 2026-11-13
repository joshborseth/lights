import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'

import { type JsonObject, type LightStates } from './flash'
import { type PaintLightsPort, applyColor } from './paint'

type Sent =
  | Readonly<{ kind: 'light'; name: string; payload: JsonObject }>
  | Readonly<{ kind: 'group'; group: string; payload: JsonObject }>

const ON: JsonObject = {
  state: 'ON',
  brightness: 120,
  color: { x: 0.3, y: 0.3 },
}
const OFF: JsonObject = { state: 'OFF' }
const COLOR = '#1281b6'

const makePort = (
  options: Readonly<{
    states: LightStates
    rainbow?: ReadonlyArray<string>
    groups?: Readonly<Record<string, ReadonlyArray<string>>>
  }>,
) => {
  const sent: Array<Sent> = []
  const asked: Array<ReadonlyArray<string>> = []
  const stopped: Array<string> = []
  const groups = options.groups ?? { 'All Lights': ['Orb', 'Shroom'] }
  const port: PaintLightsPort<string> = {
    groupMembers: group => groups[group] ?? [],
    activeRainbowGroups: () => options.rainbow ?? [],
    markRainbowStopped: group => {
      stopped.push(group)
    },
    readStates: (names, { shouldAskBulbs }) =>
      Effect.sync(() => {
        if (shouldAskBulbs) asked.push(names)
        return Object.fromEntries(
          names.flatMap(name => {
            const state = options.states[name]
            return state === undefined ? [] : [[name, state]]
          }),
        )
      }),
    capabilitiesOf: () => ({ supportsColor: true, supportsColorTemp: true }),
    publishLight: (name, payload) =>
      Effect.sync(() => {
        sent.push({ kind: 'light', name, payload })
      }),
    publishGroup: (group, payload) =>
      Effect.sync(() => {
        sent.push({ kind: 'group', group, payload })
      }),
    sleep: () => Effect.void,
    log: () => Effect.void,
  }
  return { port, sent, asked, stopped }
}

describe('applyColor', () => {
  test('colors only the lights that are on, as x and y', async () => {
    const { port, sent } = makePort({ states: { Orb: ON, Shroom: OFF } })
    const result = await Effect.runPromise(
      applyColor(port, COLOR, 'All Lights'),
    )
    expect(result._tag).toBe('Applied')
    expect(sent.map(entry => entry.kind === 'light' && entry.name)).toEqual([
      'Orb',
    ])
    const text = JSON.stringify(sent)
    expect(text).toContain('"x":')
    for (const banned of ['hex', 'hue', 'transition', 'state', 'brightness']) {
      expect(text).not.toContain(banned)
    }
  })

  test('skips when every light in the group is off', async () => {
    const { port, sent } = makePort({ states: { Orb: OFF, Shroom: OFF } })
    const result = await Effect.runPromise(
      applyColor(port, COLOR, 'All Lights'),
    )
    expect(result).toEqual({
      _tag: 'Skipped',
      reason: 'No lights in All Lights were on.',
    })
    expect(sent).toEqual([])
  })

  test('asks only the bulbs it has not heard from', async () => {
    const { port, asked } = makePort({ states: { Orb: ON } })
    await Effect.runPromise(applyColor(port, COLOR, 'All Lights'))
    expect(asked).toEqual([['Shroom']])
  })

  test('stops an overlapping Rainbow with a group x and y command, twice', async () => {
    const { port, sent, stopped } = makePort({
      states: { Orb: ON, Shroom: ON },
      rainbow: ['All Lights', 'Elsewhere'],
      groups: { 'All Lights': ['Orb', 'Shroom'], Elsewhere: ['Lamp'] },
    })
    await Effect.runPromise(applyColor(port, COLOR, 'All Lights'))
    const groupSends = sent.filter(entry => entry.kind === 'group')
    expect(groupSends).toHaveLength(2)
    expect(
      groupSends.every(
        entry => entry.kind === 'group' && entry.group === 'All Lights',
      ),
    ).toBe(true)
    expect(JSON.stringify(groupSends)).not.toContain('hex')
    expect(stopped).toEqual(['All Lights'])
    expect(sent.slice(0, 2)).toEqual(groupSends)
  })
})
