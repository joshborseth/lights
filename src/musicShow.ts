import { Array, Option, Order, Schema, pipe } from 'effect'

/*
 * Light show: while a song plays, the lights in the Music colors group move
 * with it. The music server works out each song's beats, bars, sections, and
 * drops ahead of time (`/tv/analysis`, the same analysis the TV's visuals
 * use), and this plans the bulbs' brightness from it before the song plays.
 * The color stays the cover's one color; only brightness moves.
 *
 * - Quiet parts (an intro, a breakdown, the song's softest sections) sit low,
 *   and one light at a time drifts up on each bar.
 * - Middle parts sit at half, and a light chases round the room on the beat.
 * - The loudest parts (a chorus, a drop) pump: every light hits full on the
 *   bar and falls back halfway through it.
 * - The bars before a drop dim step by step while the chase keeps going, and
 *   every light hits full the moment the drop lands.
 *
 * Zigbee carries a limited number of commands, and bulbs drop updates that
 * come too fast, so the plan never sends one bulb two commands within
 * `MIN_BULB_GAP_SECONDS`, nor more than `MAX_COMMANDS_PER_SECOND` in all. A
 * level that has to wait goes out at the next moment that has room, unless a
 * newer level replaces it first. Every command is brightness only, with no
 * `transition` (see the rules in docs/migration-plan.md).
 */

// WHAT THE MUSIC SERVER SENDS

/** The parts of the music server's `TvAnalysis` that the show uses. */
export const MusicAnalysis = Schema.Struct({
  videoId: Schema.String,
  durationSeconds: Schema.Number,
  tempo: Schema.Number,
  beats: Schema.Array(Schema.Number),
  downbeats: Schema.Array(Schema.Number),
  sections: Schema.Array(
    Schema.Struct({
      startSeconds: Schema.Number,
      endSeconds: Schema.Number,
      kind: Schema.String,
      energy: Schema.Number,
    }),
  ),
  drops: Schema.Array(Schema.Number),
})
export type MusicAnalysis = typeof MusicAnalysis.Type
export type MusicSection = MusicAnalysis['sections'][number]

export const MusicAnalysisJson = Schema.fromJsonString(MusicAnalysis)

// LIMITS

/** The slider rule: one bulb takes at most one command per 400 ms. */
export const MIN_BULB_GAP_SECONDS = 0.4
/** Commands to all the bulbs together, in any one second. */
export const MAX_COMMANDS_PER_SECOND = 12
/** A beat closer than this to the last one the chase used is skipped. */
const MIN_CHASE_GAP_SECONDS = 0.35
/** Bars that build up before a drop. */
const BUILD_BARS = 4

// LEVELS

/** Brightness as a share of full, before it becomes Zigbee's 1 to 254. */
const Level = {
  calm: 0.3,
  calmLift: 0.5,
  groove: 0.5,
  peakRest: 0.6,
  full: 1,
  buildFloor: 0.12,
  buildChaseLift: 0.3,
} as const

const MAX_BRIGHTNESS = 254

export const toBrightness = (level: number): number =>
  Math.max(1, Math.min(MAX_BRIGHTNESS, Math.round(level * MAX_BRIGHTNESS)))

// MOODS

export type Mood = 'Calm' | 'Groove' | 'Peak'

const CALM_KINDS: ReadonlyArray<string> = [
  'Intro',
  'Outro',
  'Breakdown',
  'Bridge',
]
const PEAK_KINDS: ReadonlyArray<string> = ['Chorus', 'Drop']

/**
 * How a section should look. Section energy is measured against the song's
 * own loudest moment, so most sections of a loud song sit near 1; ranking
 * them within the song is what tells a verse from its chorus.
 */
export const sectionMood = (
  section: MusicSection,
  sections: ReadonlyArray<MusicSection>,
): Mood => {
  const energies = Array.map(sections, ({ energy }) => energy)
  const low = Math.min(...energies)
  const high = Math.max(...energies)
  const relative =
    high - low < 0.05 ? 0.5 : (section.energy - low) / (high - low)
  if (Array.contains(CALM_KINDS, section.kind) && relative < 0.8) {
    return 'Calm'
  }
  if (Array.contains(PEAK_KINDS, section.kind) && relative >= 0.4) {
    return 'Peak'
  }
  return relative < 0.3 ? 'Calm' : relative >= 0.85 ? 'Peak' : 'Groove'
}

const sectionAt = (
  sections: ReadonlyArray<MusicSection>,
  seconds: number,
): MusicSection | undefined =>
  Option.getOrUndefined(
    Array.findLast(
      sections,
      ({ startSeconds }) => startSeconds <= seconds + 1e-3,
    ),
  )

// MOMENTS

/** New levels for some bulbs, by index, at a time in the song. */
type Moment = Readonly<{
  at: number
  levels: ReadonlyMap<number, number>
  /** A drop or a section's first bar: sent ahead of everything else. */
  isAccent: boolean
}>

const allAt = (count: number, level: number): ReadonlyMap<number, number> =>
  new Map(Array.makeBy(count, index => [index, level] as const))

const withOne = (
  count: number,
  base: number,
  index: number,
  level: number,
): ReadonlyMap<number, number> => {
  const levels = new Map(allAt(count, base))
  levels.set(index % count, level)
  return levels
}

type Build = Readonly<{ start: number; drop: number; bars: number }>

/** The bars before each drop, from the downbeat that starts them. */
const buildsOf = (analysis: MusicAnalysis): ReadonlyArray<Build> =>
  pipe(
    analysis.drops,
    Array.flatMap(drop => {
      const before = Array.filter(
        analysis.downbeats,
        downbeat => downbeat < drop - 1e-3,
      )
      const start = before[Math.max(0, before.length - BUILD_BARS)]
      return start === undefined
        ? []
        : [{ start, drop, bars: Math.min(BUILD_BARS, before.length) }]
    }),
  )

/**
 * The levels each beat asks for, before the limits. `count` lights, in chase
 * order.
 */
export const showMoments = (
  analysis: MusicAnalysis,
  count: number,
): ReadonlyArray<Moment> => {
  if (count === 0 || Array.isReadonlyArrayEmpty(analysis.beats)) {
    return []
  }
  const builds = buildsOf(analysis)
  const isDownbeat = (beat: number) =>
    Array.some(analysis.downbeats, downbeat => Math.abs(downbeat - beat) < 0.02)
  const barIndexOf = (beat: number) =>
    Array.filter(analysis.downbeats, downbeat => downbeat <= beat + 0.02).length

  const moments: Array<Moment> = []
  let chaseIndex = 0
  let lastChaseAt = Number.NEGATIVE_INFINITY
  let lastSection: MusicSection | undefined
  let beatInBar = 0

  const chase = (at: number, base: number, lift: number): void => {
    if (at - lastChaseAt < MIN_CHASE_GAP_SECONDS) {
      return
    }
    lastChaseAt = at
    moments.push({
      at,
      levels: withOne(count, base, chaseIndex, lift),
      isAccent: false,
    })
    chaseIndex += 1
  }

  analysis.beats.forEach((beat, index) => {
    const nextBeat = analysis.beats[index + 1]
    beatInBar = isDownbeat(beat) ? 0 : beatInBar + 1
    const section = sectionAt(analysis.sections, beat)
    const isNewSection = section !== undefined && section !== lastSection
    lastSection = section
    const build = Array.findFirst(
      builds,
      ({ start, drop }) => beat >= start - 0.02 && beat < drop - 0.02,
    )
    if (build._tag === 'Some') {
      const { start, bars } = build.value
      const barsIn = Array.filter(
        analysis.downbeats,
        downbeat => downbeat >= start - 0.02 && downbeat <= beat + 0.02,
      ).length
      const level =
        Level.peakRest -
        ((Level.peakRest - Level.buildFloor) * barsIn) / Math.max(1, bars)
      if (beatInBar === 0) {
        moments.push({ at: beat, levels: allAt(count, level), isAccent: true })
      }
      chase(beat, level, level + Level.buildChaseLift)
      return
    }
    // NOTE: The drop itself is its own moment, added below.
    if (Array.some(analysis.drops, drop => Math.abs(drop - beat) < 0.06)) {
      return
    }
    const mood =
      section === undefined ? 'Groove' : sectionMood(section, analysis.sections)
    if (mood === 'Calm') {
      if (beatInBar === 0 || isNewSection) {
        moments.push({
          at: beat,
          levels: withOne(count, Level.calm, barIndexOf(beat), Level.calmLift),
          isAccent: isNewSection,
        })
      }
      return
    }
    if (mood === 'Groove') {
      if (isNewSection) {
        moments.push({
          at: beat,
          levels: allAt(count, Level.groove),
          isAccent: true,
        })
      }
      chase(beat, Level.groove, Level.full)
      return
    }
    // NOTE: Peak pumps on the bar: full on the downbeat, back to rest halfway.
    if (beatInBar === 0 || isNewSection) {
      moments.push({
        at: beat,
        levels: allAt(count, Level.full),
        isAccent: true,
      })
    } else if (beatInBar === 2 || nextBeat === undefined) {
      moments.push({
        at: beat,
        levels: allAt(count, Level.peakRest),
        isAccent: false,
      })
    }
  })
  analysis.drops.forEach(drop => {
    moments.push({ at: drop, levels: allAt(count, Level.full), isAccent: true })
  })
  return moments
}

// SCHEDULE

export type ShowCommand = Readonly<{
  /** Seconds into the song. */
  at: number
  light: string
  brightness: number
}>

const byAt = Order.mapInput(Order.Number, (moment: Moment) => moment.at)

/**
 * The commands to send, in time order, within the limits. `lights` are the
 * bulbs in chase order.
 */
export const planShow = (
  analysis: MusicAnalysis,
  lights: ReadonlyArray<string>,
): ReadonlyArray<ShowCommand> => {
  const moments = Array.sort(showMoments(analysis, lights.length), byAt)
  const sent: Array<ShowCommand> = []
  const lastSentAt = new Map<number, number>()
  const lastSentLevel = new Map<number, number>()
  const pending = new Map<number, number>()
  const recent: Array<number> = []

  moments.forEach(moment => {
    moment.levels.forEach((level, index) => {
      pending.set(index, toBrightness(level))
    })
    while (recent.length > 0 && (recent[0] ?? 0) <= moment.at - 1) {
      recent.shift()
    }
    // NOTE: This moment's own lights first, then any still waiting.
    const order = [
      ...moment.levels.keys(),
      ...Array.filter([...pending.keys()], index => !moment.levels.has(index)),
    ]
    order.forEach(index => {
      const brightness = pending.get(index)
      if (brightness === undefined) {
        return
      }
      if (lastSentLevel.get(index) === brightness) {
        pending.delete(index)
        return
      }
      const isBulbReady =
        moment.at - (lastSentAt.get(index) ?? Number.NEGATIVE_INFINITY) >=
        MIN_BULB_GAP_SECONDS - 1e-6
      const hasRoom =
        recent.length < MAX_COMMANDS_PER_SECOND ||
        (moment.isAccent &&
          recent.length < MAX_COMMANDS_PER_SECOND + lights.length)
      const light = lights[index]
      if (!isBulbReady || !hasRoom || light === undefined) {
        return
      }
      sent.push({ at: moment.at, light, brightness })
      lastSentAt.set(index, moment.at)
      lastSentLevel.set(index, brightness)
      recent.push(moment.at)
      pending.delete(index)
    })
  })
  return sent
}

/** What each light should show at `seconds` into the song, by name. */
export const levelsAt = (
  commands: ReadonlyArray<ShowCommand>,
  seconds: number,
): ReadonlyMap<string, number> => {
  const levels = new Map<string, number>()
  commands.forEach(command => {
    if (command.at <= seconds) {
      levels.set(command.light, command.brightness)
    }
  })
  return levels
}

/** The section playing at `seconds`, for the status line. */
export const sectionNameAt = (
  analysis: MusicAnalysis,
  seconds: number,
): string | undefined => sectionAt(analysis.sections, seconds)?.kind
