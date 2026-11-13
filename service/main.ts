import { Clock, Effect, Fiber, Option } from 'effect'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { makeAccountHealth, makeEngine } from './engine'
import { MissingTokenError, makeGitHub } from './github'
import { makeHandler } from './http'
import { type LightsError, connectLights } from './mqtt'
import { connectFeed } from './paint'
import { makeScreenSync } from './screen'
import {
  defaultPaths,
  loadInitial,
  makeStore,
  readMqttOptions,
  readScreenConfig,
  saveScreenConfig,
} from './store'

const DEFAULT_PORT = 8093
// NOTE: The Joshflix relay on this machine (~/.t3/projects/joshflix).
const DEFAULT_SCREEN_FEED_URL = 'ws://127.0.0.1:8788/api/v1/screen/feed'
const TOKEN_TIMEOUT_MS = 20_000
const RESTART_DELAY_MS = 200

// NOTE: systemd's journal timestamps each line, so these stay plain.
const log = (text: string): void => {
  console.log(text)
}

const readGhToken = (home: string) => (account: string) =>
  Effect.callback<string, MissingTokenError>(resume => {
    const { GH_TOKEN: _token, GITHUB_TOKEN: _github, ...env } = process.env
    execFile(
      'gh',
      ['auth', 'token', '--user', account],
      {
        timeout: TOKEN_TIMEOUT_MS,
        env: { ...env, GH_CONFIG_DIR: join(home, '.config/gh') },
      },
      (error, stdout, stderr) => {
        const token = stdout.trim()
        resume(
          error !== null || token === ''
            ? Effect.fail(
                new MissingTokenError({
                  account,
                  reason: stderr.trim() || `no gh login for ${account}`,
                }),
              )
            : Effect.succeed(token),
        )
      },
    )
  })

const program = Effect.gen(function* () {
  const home = process.env['HOME'] ?? homedir()
  const paths = defaultPaths(home)
  const initial = yield* loadInitial(paths)
  const maybeMqtt = yield* readMqttOptions(paths)
  if (Option.isNone(maybeMqtt)) {
    return yield* Effect.die(
      new Error(`${paths.mqttEnv} is missing MQTT login`),
    )
  }

  const lights = yield* connectLights(maybeMqtt.value, log)
  const { health, observer } = makeAccountHealth()
  let requestTimeoutMs = initial.config.polling.requestTimeoutSeconds * 1000

  const engine = yield* makeEngine(
    {
      github: makeGitHub({
        fetch: (url, init) => fetch(url, init),
        readToken: readGhToken(home),
        timeoutMs: () => requestTimeoutMs,
        observer,
      }),
      lights,
      store: makeStore(paths),
      now: Clock.currentTimeMillis,
      errorText: (error: LightsError) => error.reason,
    },
    initial,
    health,
  )

  const screen = yield* makeScreenSync(
    {
      lights,
      withLightsLock: engine.withLightsLock,
      saveConfig: saveScreenConfig(paths),
      feed: connectFeed(
        process.env['SCREEN_FEED_URL'] ?? DEFAULT_SCREEN_FEED_URL,
        'Joshflix screen feed',
        log,
      ),
      now: Clock.currentTimeMillis,
      errorText: (error: LightsError) => error.reason,
    },
    yield* readScreenConfig(paths),
  )

  const stopRequested = yield* Effect.callback<void>(resume => {
    const finish = () => resume(Effect.void)
    process.once('SIGTERM', finish)
    process.once('SIGINT', finish)
  }).pipe(Effect.forkChild)

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: Number(process.env['AUTOMATIONS_PORT'] ?? DEFAULT_PORT),
    fetch: makeHandler({
      engine: {
        ...engine,
        saveConfig: config => {
          requestTimeoutMs = config.polling.requestTimeoutSeconds * 1000
          return engine.saveConfig(config)
        },
      },
      screen,
      requestRestart: () => {
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), RESTART_DELAY_MS)
      },
      run: Effect.runPromise,
    }),
  })
  log(`automations service listening on 127.0.0.1:${server.port}`)

  const watcher = yield* Effect.forkChild(engine.run)
  const screenWatcher = yield* Effect.forkChild(screen.run)
  yield* Fiber.join(stopRequested)
  log('stopping')
  yield* Fiber.interrupt(watcher)
  yield* Fiber.interrupt(screenWatcher)
  yield* engine.waitForFlashToFinish
  yield* lights.close
  yield* Effect.promise(() => server.stop())
})

Effect.runPromise(program).then(
  () => process.exit(0),
  error => {
    console.error(error)
    process.exit(1)
  },
)
