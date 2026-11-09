import { Array, Effect, Option, pipe } from 'effect'

import { type FlashConfig, hexToXy } from '../src/automation'

export const RAINBOW_PRESET = 'Rainbow'

const STOP_LOOP_REPEAT_MS = 400
const RESTORE_GAP_MS = 250
const REPAINT_SETTLE_MS = 1200
const REPAINT_PASSES = 2

export type JsonObject = Readonly<Record<string, unknown>>
export type LightStates = Readonly<Record<string, JsonObject>>

export type FlashPort<E> = Readonly<{
  groupMembers: (group: string) => ReadonlyArray<string>
  activeRainbowGroups: () => ReadonlyArray<string>
  markRainbowStopped: (group: string) => void
  readStates: (
    names: ReadonlyArray<string>,
    options: Readonly<{ shouldAskBulbs: boolean }>,
  ) => Effect.Effect<LightStates, E>
  publishLight: (name: string, payload: JsonObject) => Effect.Effect<void, E>
  publishGroup: (group: string, payload: JsonObject) => Effect.Effect<void, E>
  applyPreset: (group: string, preset: string) => Effect.Effect<void, E>
  sleep: (ms: number) => Effect.Effect<void>
  log: (text: string) => Effect.Effect<void>
}>

// FRAMES

// NOTE: No payload here may contain `transition`. Off must be exactly {"state":"OFF"},
// and a fade on a color command freezes IKEA bulbs.
export const OFF_FRAME: JsonObject = { state: 'OFF' }

// NOTE: Always x and y. The kitchen's KAJPLATS bulbs have no hue and saturation
// mode: after one such command they stay on that color while acknowledging x and
// y commands. Hex is also out, because the presets extension treats a group
// command with a recent Rainbow hex as its own echo and would keep looping.
export const flashOnFrame = (flash: FlashConfig): JsonObject => ({
  state: 'ON',
  brightness: flash.brightness,
  color: hexToXy(flash.hex),
})

export const stopLoopFrame = (flash: FlashConfig): JsonObject => ({
  color: hexToXy(flash.hex),
})

const colorFields = (state: JsonObject): JsonObject => {
  const color = readRecord(state['color'])
  return state['color_mode'] === 'color_temp' &&
    state['color_temp'] !== undefined &&
    state['color_temp'] !== null
    ? { color_temp: state['color_temp'] }
    : color !== undefined && color['x'] != null && color['y'] != null
      ? { color: { x: color['x'], y: color['y'] } }
      : color !== undefined && color['hue'] != null
        ? {
            color: {
              hue: color['hue'],
              saturation: color['saturation'] ?? 100,
            },
          }
        : {}
}

export const restoreFrame = (state: JsonObject): JsonObject => {
  if (`${state['state'] ?? 'OFF'}`.toUpperCase() !== 'ON') {
    return OFF_FRAME
  }
  const brightness =
    state['brightness'] === undefined || state['brightness'] === null
      ? {}
      : { brightness: state['brightness'] }
  return { state: 'ON', ...brightness, ...colorFields(state) }
}

// NOTE: IKEA bulbs can drop a color that arrives while they fade back on, and
// Zigbee2MQTT still reports the color it sent. Color only, because a bulb that
// is already on applies it right away.
export const repaintFrame = (state: JsonObject): Option.Option<JsonObject> => {
  const fields = colorFields(state)
  return isLightOn(state) && Object.keys(fields).length > 0
    ? Option.some(fields)
    : Option.none()
}

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' &&
  value !== null &&
  !globalThis.Array.isArray(value)

const readRecord = (value: unknown): JsonObject | undefined =>
  isJsonObject(value) ? value : undefined

export const isLightOn = (state: JsonObject): boolean =>
  `${state['state'] ?? ''}`.toUpperCase() === 'ON'

// FLASH

export type FlashResult = Readonly<{
  flashed: ReadonlyArray<string>
  leftOff: ReadonlyArray<string>
  unresponsive: ReadonlyArray<string>
  skippedReason: Option.Option<string>
}>

const overlapsAny = (
  members: ReadonlyArray<string>,
  others: ReadonlyArray<string>,
): boolean => Array.some(members, member => Array.contains(others, member))

export const runFlash = <E>(
  port: FlashPort<E>,
  flash: FlashConfig,
): Effect.Effect<FlashResult, E> =>
  Effect.gen(function* () {
    const members = port.groupMembers(flash.group)
    if (Array.isReadonlyArrayEmpty(members)) {
      return {
        flashed: [],
        leftOff: [],
        unresponsive: [],
        skippedReason: Option.some(`${flash.group} has no lights.`),
      }
    }

    const loopsToStop = pipe(
      port.activeRainbowGroups(),
      Array.filter(group => overlapsAny(port.groupMembers(group), members)),
    )
    const shouldListenOnly = Array.isReadonlyArrayNonEmpty(loopsToStop)
    const before = yield* port.readStates(members, {
      shouldAskBulbs: !shouldListenOnly,
    })

    const hasAnswered = (name: string): boolean => before[name] !== undefined
    const isOn = (name: string): boolean => {
      const state = before[name]
      return state !== undefined && isLightOn(state)
    }
    const unresponsive = Array.filter(members, name => !hasAnswered(name))
    const answered = Array.filter(members, hasAnswered)
    const lightsOn = Array.filter(answered, isOn)
    const lightsOff = Array.filter(answered, name => !isOn(name))
    const targets = flash.onlyLightsAlreadyOn ? lightsOn : answered
    const leftOff = flash.onlyLightsAlreadyOn ? lightsOff : []

    if (Array.isReadonlyArrayEmpty(targets)) {
      return {
        flashed: [],
        leftOff,
        unresponsive,
        skippedReason: Option.some(
          Array.isReadonlyArrayEmpty(unresponsive)
            ? 'No lights were on.'
            : `No lights were on. No answer from ${unresponsive.join(', ')}.`,
        ),
      }
    }

    const resumedLoops = flash.shouldResumeRainbow ? loopsToStop : []
    const restoredElsewhere = Array.flatMap(resumedLoops, port.groupMembers)

    const stopLoops = Effect.forEach(
      loopsToStop,
      group =>
        Effect.gen(function* () {
          yield* port.log(
            `stopping ${RAINBOW_PRESET} on ${group} for the flash`,
          )
          yield* port.publishGroup(group, stopLoopFrame(flash))
          yield* port.sleep(STOP_LOOP_REPEAT_MS)
          yield* port.publishGroup(group, stopLoopFrame(flash))
          port.markRainbowStopped(group)
        }),
      { discard: true },
    )

    const flashOnce = Effect.gen(function* () {
      yield* Effect.forEach(
        targets,
        name => port.publishLight(name, flashOnFrame(flash)),
        { discard: true },
      )
      yield* port.sleep(flash.onMs)
      yield* Effect.forEach(
        targets,
        name => port.publishLight(name, OFF_FRAME),
        { discard: true },
      )
      yield* port.sleep(flash.offMs)
    })

    const restore = Effect.gen(function* () {
      yield* Effect.forEach(
        resumedLoops,
        group => port.applyPreset(group, RAINBOW_PRESET),
        { discard: true },
      )
      if (!flash.shouldRestore) {
        return
      }
      const lightsToRestore = pipe(
        targets,
        Array.filter(name => !Array.contains(restoredElsewhere, name)),
      )
      yield* Effect.forEach(
        lightsToRestore,
        name =>
          Effect.gen(function* () {
            yield* port.publishLight(
              name,
              restoreFrame(before[name] ?? OFF_FRAME),
            )
            yield* port.sleep(RESTORE_GAP_MS)
          }),
        { discard: true },
      )
      const repaints = Array.getSomes(
        Array.map(lightsToRestore, name =>
          Option.map(
            repaintFrame(before[name] ?? OFF_FRAME),
            frame => [name, frame] as const,
          ),
        ),
      )
      if (Array.isReadonlyArrayEmpty(repaints)) {
        return
      }
      const repaintOnce = port
        .sleep(REPAINT_SETTLE_MS)
        .pipe(
          Effect.andThen(
            Effect.forEach(
              repaints,
              ([name, frame]) =>
                port
                  .publishLight(name, frame)
                  .pipe(Effect.andThen(port.sleep(RESTORE_GAP_MS))),
              { discard: true },
            ),
          ),
        )
      yield* Effect.repeat(repaintOnce, { times: REPAINT_PASSES - 1 })
    })

    yield* stopLoops.pipe(
      Effect.andThen(Effect.repeat(flashOnce, { times: flash.count - 1 })),
      Effect.ensuring(Effect.ignore(restore)),
    )

    return {
      flashed: targets,
      leftOff,
      unresponsive,
      skippedReason: Option.none(),
    }
  })
