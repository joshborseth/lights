import { Array, Effect, Option, Schema, String, pipe } from 'effect'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  ActivityEntry,
  DEFAULT_CONFIG,
  PrMergeConfig,
  configProblem,
} from '../src/automation'
import { type ControlState, type EngineInitial, type StorePort } from './engine'
import { type MqttOptions } from './mqtt'

export type StorePaths = Readonly<{
  config: string
  control: string
  seen: string
  activity: string
  mqttEnv: string
  presence: string
}>

export const defaultPaths = (home: string): StorePaths => ({
  config: join(home, '.config/pr-merge-lights/config.json'),
  control: join(home, '.local/state/pr-merge-lights/control.json'),
  seen: join(home, '.local/state/pr-merge-lights/seen.json'),
  activity: join(home, '.local/state/pr-merge-lights/activity.json'),
  mqttEnv: join(home, '.config/pr-merge-lights/mqtt.env'),
  presence: join(home, '.config/pr-merge-lights/presence.json'),
})

const StoredControl = Schema.Struct({
  isEnabled: Schema.Boolean,
  pausedUntil: Schema.NullOr(Schema.Number),
  heldMerges: Schema.Array(Schema.String),
})

const SeenFile = Schema.Struct({
  seen_merges: Schema.optionalKey(Schema.Array(Schema.String)),
})

const readText = (path: string): Effect.Effect<Option.Option<string>> =>
  Effect.promise(() =>
    readFile(path, 'utf8').then(Option.some, (): Option.Option<string> =>
      Option.none(),
    ),
  )

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const writeJsonAtomic = (
  path: string,
  value: unknown,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
    await rename(temporary, path)
  })

const defaultControl: ControlState = {
  isEnabled: true,
  maybePausedUntil: Option.none(),
  heldMerges: [],
}

const readConfig = (
  paths: StorePaths,
): Effect.Effect<
  Readonly<{
    config: PrMergeConfig
    maybeConfigFileError: Option.Option<string>
  }>
> =>
  Effect.gen(function* () {
    const maybeText = yield* readText(paths.config)
    if (Option.isNone(maybeText)) {
      yield* writeJsonAtomic(paths.config, DEFAULT_CONFIG)
      return { config: DEFAULT_CONFIG, maybeConfigFileError: Option.none() }
    }
    const decoded = Schema.decodeUnknownOption(PrMergeConfig)(
      parseJson(maybeText.value),
    )
    return Option.match(decoded, {
      onNone: () => ({
        config: DEFAULT_CONFIG,
        maybeConfigFileError: Option.some(`${paths.config} could not be read.`),
      }),
      onSome: config =>
        Option.match(configProblem(config), {
          onNone: () => ({ config, maybeConfigFileError: Option.none() }),
          onSome: problem => ({
            config: DEFAULT_CONFIG,
            maybeConfigFileError: Option.some(problem),
          }),
        }),
    })
  })

const readControl = (paths: StorePaths): Effect.Effect<ControlState> =>
  Effect.gen(function* () {
    const maybeText = yield* readText(paths.control)
    return pipe(
      maybeText,
      Option.flatMap(text =>
        Schema.decodeUnknownOption(StoredControl)(parseJson(text)),
      ),
      Option.match({
        onNone: () => defaultControl,
        onSome: stored => ({
          isEnabled: stored.isEnabled,
          maybePausedUntil: Option.fromNullOr(stored.pausedUntil),
          heldMerges: stored.heldMerges,
        }),
      }),
    )
  })

const readSeen = (paths: StorePaths): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const maybeText = yield* readText(paths.seen)
    return pipe(
      maybeText,
      Option.flatMap(text =>
        Schema.decodeUnknownOption(SeenFile)(parseJson(text)),
      ),
      Option.match({
        onNone: () => [],
        onSome: file => file.seen_merges ?? [],
      }),
    )
  })

const readActivity = (
  paths: StorePaths,
): Effect.Effect<ReadonlyArray<ActivityEntry>> =>
  Effect.gen(function* () {
    const maybeText = yield* readText(paths.activity)
    return pipe(
      maybeText,
      Option.flatMap(text =>
        Schema.decodeUnknownOption(Schema.Array(ActivityEntry))(
          parseJson(text),
        ),
      ),
      Option.getOrElse((): ReadonlyArray<ActivityEntry> => []),
    )
  })

export const loadInitial = (paths: StorePaths): Effect.Effect<EngineInitial> =>
  Effect.gen(function* () {
    const { config, maybeConfigFileError } = yield* readConfig(paths)
    return {
      config,
      maybeConfigFileError,
      control: yield* readControl(paths),
      seen: yield* readSeen(paths),
      activity: yield* readActivity(paths),
    }
  })

export const makeStore = (paths: StorePaths): StorePort => {
  const writeSafely = (path: string, value: unknown) =>
    writeJsonAtomic(path, value).pipe(
      Effect.catchDefect(defect =>
        Effect.logError(`Could not write ${path}: ${defect}`),
      ),
    )

  const mergeSeenFile = (seen: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const maybeText = yield* readText(paths.seen)
      const existing = pipe(
        maybeText,
        Option.map(parseJson),
        Option.filter(
          (value): value is Record<string, unknown> =>
            typeof value === 'object' && value !== null,
        ),
        Option.getOrElse((): Record<string, unknown> => ({})),
      )
      yield* writeSafely(paths.seen, { ...existing, seen_merges: seen })
    })

  return {
    saveConfig: config => writeSafely(paths.config, config),
    saveControl: control =>
      writeSafely(paths.control, {
        isEnabled: control.isEnabled,
        pausedUntil: Option.getOrNull(control.maybePausedUntil),
        heldMerges: control.heldMerges,
      }),
    saveSeen: mergeSeenFile,
    saveActivity: activity => writeSafely(paths.activity, activity),
  }
}

export const readMqttOptions = (
  paths: StorePaths,
): Effect.Effect<Option.Option<MqttOptions>> =>
  Effect.gen(function* () {
    const maybeText = yield* readText(paths.mqttEnv)
    return Option.flatMap(maybeText, text => {
      const entries = pipe(
        text,
        String.split('\n'),
        Array.filter(line => line.includes('=') && !line.startsWith('#')),
        Array.map(line => {
          const index = line.indexOf('=')
          return [line.slice(0, index), line.slice(index + 1)] as const
        }),
      )
      const values = new Map(entries)
      const username = values.get('MQTT_USERNAME')
      const password = values.get('MQTT_PASSWORD')
      return username === undefined || password === undefined
        ? Option.none()
        : Option.some({
            host: values.get('MQTT_HOST') ?? '127.0.0.1',
            port: Number(values.get('MQTT_PORT') ?? '1883'),
            username,
            password,
          })
    })
  })
