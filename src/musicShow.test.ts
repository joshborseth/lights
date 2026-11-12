import { Array } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  MAX_COMMANDS_PER_SECOND,
  MIN_BULB_GAP_SECONDS,
  type MusicAnalysis,
  type MusicSection,
  type ShowCommand,
  levelsAt,
  planShow,
  sectionMood,
  toBrightness,
} from './musicShow'

const LIGHTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

const section = (
  kind: string,
  startSeconds: number,
  endSeconds: number,
  energy: number,
): MusicSection => ({ kind, startSeconds, endSeconds, energy })

/** A steady song at `tempo`, four beats to the bar. */
const song = (
  tempo: number,
  durationSeconds: number,
  sections: ReadonlyArray<MusicSection>,
  drops: ReadonlyArray<number> = [],
): MusicAnalysis => {
  const step = 60 / tempo
  const beats = Array.makeBy(Math.floor(durationSeconds / step), index =>
    Number((index * step).toFixed(3)),
  )
  return {
    videoId: 'song',
    durationSeconds,
    tempo,
    beats,
    downbeats: beats.filter((_, index) => index % 4 === 0),
    sections,
    drops,
  }
}

const sentTo = (commands: ReadonlyArray<ShowCommand>, light: string) =>
  commands.filter(command => command.light === light)

describe('sectionMood', () => {
  const sections = [
    section('Intro', 0, 10, 0.6),
    section('Verse', 10, 30, 0.8),
    section('Chorus', 30, 50, 1),
    section('Verse', 50, 70, 0.95),
  ]

  test('ranks sections within the song, not against an absolute scale', () => {
    expect(sections.map(each => sectionMood(each, sections))).toEqual([
      'Calm',
      'Groove',
      'Peak',
      'Peak',
    ])
  })

  test('a song whose sections are all alike grooves', () => {
    const flat = [section('Verse', 0, 10, 0.9), section('Verse', 10, 20, 0.9)]
    expect(sectionMood(flat[0] ?? section('Verse', 0, 0, 0), flat)).toBe(
      'Groove',
    )
  })
})

describe('planShow', () => {
  const analysis = song(
    128,
    90,
    [
      section('Intro', 0, 15, 0.5),
      section('Verse', 15, 45, 0.75),
      section('Chorus', 45, 90, 1),
    ],
    [45],
  )
  const commands = planShow(analysis, LIGHTS)

  test('never sends one light two commands within the gap bulbs need', () => {
    LIGHTS.forEach(light => {
      const times = sentTo(commands, light).map(({ at }) => at)
      times.slice(1).forEach((at, index) => {
        expect(at - (times[index] ?? 0)).toBeGreaterThanOrEqual(
          MIN_BULB_GAP_SECONDS - 1e-6,
        )
      })
    })
  })

  test('stays within the command budget, allowing one burst per accent', () => {
    commands.forEach((command, index) => {
      const window = commands.filter(
        other => other.at <= command.at && other.at > command.at - 1,
      )
      expect(window.length, `at ${command.at} (${index})`).toBeLessThanOrEqual(
        MAX_COMMANDS_PER_SECOND + LIGHTS.length,
      )
    })
  })

  test('sends brightness only, in time order, never the same level twice in a row', () => {
    commands.slice(1).forEach((command, index) => {
      expect(command.at).toBeGreaterThanOrEqual(commands[index]?.at ?? 0)
    })
    LIGHTS.forEach(light => {
      const levels = sentTo(commands, light).map(({ brightness }) => brightness)
      levels.slice(1).forEach((level, index) => {
        expect(level).not.toBe(levels[index])
      })
    })
  })

  test('every light hits full the moment the drop lands', () => {
    const atDrop = commands.filter(({ at }) => at === 45)
    expect(atDrop.map(({ light }) => light).sort()).toEqual(LIGHTS)
    expect(atDrop.every(({ brightness }) => brightness === 254)).toBe(true)
  })

  test('the bars before a drop dim step by step', () => {
    const before = levelsAt(commands, 44.9)
    const earlier = levelsAt(commands, 38)
    const dimmest = Math.min(...before.values())
    expect(dimmest).toBeLessThanOrEqual(toBrightness(0.15))
    expect(Math.min(...earlier.values())).toBeGreaterThan(dimmest)
  })

  test('a quiet intro stays low with one light lifted', () => {
    const levels = [...levelsAt(commands, 10).values()]
    expect(levels.filter(level => level === toBrightness(0.3))).toHaveLength(7)
    expect(levels.filter(level => level === toBrightness(0.5))).toHaveLength(1)
  })

  test('a verse chases one light round on the beat', () => {
    const lit = (seconds: number) =>
      [...levelsAt(commands, seconds)].filter(([, level]) => level === 254)
    const beat = 60 / 128
    const first = lit(20)
    const next = lit(20 + beat)
    expect(first).toHaveLength(1)
    expect(next).toHaveLength(1)
    expect(next[0]?.[0]).not.toBe(first[0]?.[0])
  })

  test('a chorus pumps every light on the bar', () => {
    const bar = (4 * 60) / 128
    const downbeat = analysis.downbeats.find(at => at > 60) ?? 0
    expect([...levelsAt(commands, downbeat).values()]).toEqual(
      Array.makeBy(LIGHTS.length, () => 254),
    )
    expect(
      [...levelsAt(commands, downbeat + bar * 0.6).values()].every(
        level => level < 254,
      ),
    ).toBe(true)
  })

  test('plans nothing for no lights or no beats', () => {
    expect(planShow(analysis, [])).toEqual([])
    expect(planShow({ ...analysis, beats: [], downbeats: [] }, LIGHTS)).toEqual(
      [],
    )
  })
})
