import { Clock, Duration, Effect, Fiber, Option } from 'effect'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { makeAccountHealth, makeEngine } from './engine'
import { MissingTokenError, makeGitHub } from './github'
import { makeHandler } from './http'
import { type LightsError, connectLights } from './mqtt'
import { nudgeAddresses, observeNetwork } from './network'
import {
  PresenceConfigFile,
  makePresenceWatcher,
  readPresenceConfig,
  turnOffAllLights,
} from './presence'
import { defaultPaths, loadInitial, makeStore, readMqttOptions } from './store'

const DEFAULT_PORT = 8093
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
      requestRestart: () => {
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), RESTART_DELAY_MS)
      },
      run: Effect.runPromise,
    }),
  })
  log(`automations service listening on 127.0.0.1:${server.port}`)

  const presenceFile = yield* readPresenceConfig(paths.presence)
  const runPresence = PresenceConfigFile.match(presenceFile, {
    Missing: () => Effect.sync(() => log('presence watching is not set up')),
    Invalid: ({ problem }) =>
      engine.reportProblem(`${paths.presence}: ${problem}`),
    Ready: ({ config }) =>
      makePresenceWatcher(config, {
        nudge: nudgeAddresses,
        observe: observeNetwork,
        turnOffLights: engine.withExclusiveLights(turnOffAllLights(lights)),
        now: Clock.currentTimeMillis,
        sleep: ms => Effect.sleep(Duration.millis(ms)),
        log: text => Effect.sync(() => log(text)),
        recordInfo: engine.recordInfo,
        reportProblem: engine.reportProblem,
        errorText: (error: LightsError) => error.reason,
      }).pipe(Effect.flatMap(presence => presence.run)),
  })

  const watcher = yield* Effect.forkChild(engine.run)
  const presenceWatcher = yield* Effect.forkChild(runPresence)
  yield* Fiber.join(stopRequested)
  log('stopping')
  yield* Fiber.interrupt(presenceWatcher)
  yield* Fiber.interrupt(watcher)
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
