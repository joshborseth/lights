import { Effect, Option, Schema } from 'effect'

import {
  AUTOMATION_API_PATH,
  EnabledRequest,
  PauseRequest,
  PrMergeConfig,
  Snapshot,
  configProblem,
  normalizeConfig,
} from '../src/automation'
import {
  MUSIC_API_PATH,
  MusicConfig,
  MusicSnapshot,
  musicConfigProblem,
} from '../src/music'
import {
  SCREEN_API_PATH,
  ScreenConfig,
  ScreenSnapshot,
  screenConfigProblem,
} from '../src/screen'
import { type Engine } from './engine'
import { type MusicSync } from './music'
import { type ScreenSync } from './screen'

const MAX_BODY_BYTES = 64 * 1024
const MAX_PAUSE_MINUTES = 7 * 24 * 60

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const failure = (status: number, error: string): Response =>
  json(status, { error })

const encodeSnapshot = Schema.encodeSync(Snapshot)
const encodeMusicSnapshot = Schema.encodeSync(MusicSnapshot)
const encodeScreenSnapshot = Schema.encodeSync(ScreenSnapshot)

const parseBody = async (request: Request): Promise<unknown> => {
  try {
    return JSON.parse(await request.text())
  } catch {
    return undefined
  }
}

// NOTE: Requiring JSON makes browsers preflight cross-site writes, and this
// service answers no preflights, so other sites cannot send commands.
const isJsonRequest = (request: Request): boolean =>
  (request.headers.get('content-type') ?? '').startsWith('application/json')

const isOversized = (request: Request): boolean =>
  Number(request.headers.get('content-length') ?? '0') > MAX_BODY_BYTES

export type HttpDeps = Readonly<{
  engine: Engine
  music: MusicSync
  screen: ScreenSync
  requestRestart: () => void
  run: <A>(effect: Effect.Effect<A>) => Promise<A>
}>

export const makeHandler = ({
  engine,
  music,
  screen,
  requestRestart,
  run,
}: HttpDeps) => {
  /**
   * `GET` the automation's snapshot, or `PUT /config` its settings, which
   * apply at once. Music colors and Screen colors work the same way.
   */
  const handleColorAutomation =
    <Config extends Readonly<{ group: string }>, Snapshot>(
      automation: Readonly<{
        snapshot: Effect.Effect<Snapshot>
        saveConfig: (config: Config) => Effect.Effect<void>
      }>,
      decode: (body: unknown) => Option.Option<Config>,
      problem: (config: Config) => Option.Option<string>,
      encode: (snapshot: Snapshot) => unknown,
    ) =>
    async (path: string, request: Request): Promise<Response> => {
      const respond = async (): Promise<Response> =>
        json(200, encode(await run(automation.snapshot)))
      if (request.method === 'GET' && path === '') {
        return respond()
      }
      if (path !== '/config' || request.method !== 'PUT') {
        return failure(404, 'Not found.')
      }
      if (!isJsonRequest(request)) {
        return failure(415, 'Send JSON.')
      }
      if (isOversized(request)) {
        return failure(413, 'That request is too large.')
      }
      const body = await parseBody(request)
      return Option.match(decode(body), {
        onNone: async () => failure(400, 'Those settings could not be read.'),
        onSome: async config =>
          Option.match(problem(config), {
            onSome: async message => failure(400, message),
            onNone: async () => {
              await run(
                automation.saveConfig({
                  ...config,
                  group: config.group.trim(),
                }),
              )
              return respond()
            },
          }),
      })
    }

  const handleMusic = handleColorAutomation(
    music,
    Schema.decodeUnknownOption(MusicConfig),
    musicConfigProblem,
    encodeMusicSnapshot,
  )

  const handleScreen = handleColorAutomation(
    screen,
    Schema.decodeUnknownOption(ScreenConfig),
    screenConfigProblem,
    encodeScreenSnapshot,
  )

  const respondWithSnapshot = async (): Promise<Response> =>
    json(200, encodeSnapshot(await run(engine.snapshot)))

  const applyThenRespond = async (
    effect: Effect.Effect<void>,
  ): Promise<Response> => {
    await run(effect)
    return respondWithSnapshot()
  }

  const handleWrite = async (
    path: string,
    method: string,
    request: Request,
  ): Promise<Response> => {
    const body = await parseBody(request)

    if (path === '/config' && method === 'PUT') {
      return Option.match(Schema.decodeUnknownOption(PrMergeConfig)(body), {
        onNone: async () => failure(400, 'Those settings could not be read.'),
        onSome: async decoded => {
          const config = normalizeConfig(decoded)
          return Option.match(configProblem(config), {
            onSome: async problem => failure(400, problem),
            onNone: () => applyThenRespond(engine.saveConfig(config)),
          })
        },
      })
    }

    if (method !== 'POST') {
      return failure(405, 'Method not allowed.')
    }

    switch (path) {
      case '/enabled':
        return Option.match(Schema.decodeUnknownOption(EnabledRequest)(body), {
          onNone: async () => failure(400, 'Expected isEnabled.'),
          onSome: ({ isEnabled }) =>
            applyThenRespond(engine.setEnabled(isEnabled)),
        })
      case '/pause':
        return Option.match(Schema.decodeUnknownOption(PauseRequest)(body), {
          onNone: async () => failure(400, 'Expected minutes.'),
          onSome: ({ minutes }) =>
            Number.isInteger(minutes) &&
            minutes > 0 &&
            minutes <= MAX_PAUSE_MINUTES
              ? applyThenRespond(engine.pause(minutes))
              : Promise.resolve(failure(400, 'Pause must be up to one week.')),
        })
      case '/resume':
        return applyThenRespond(engine.resume)
      case '/test-flash': {
        const maybeError = await run(engine.testFlash)
        return Option.match(maybeError, {
          onSome: async error => failure(502, error),
          onNone: respondWithSnapshot,
        })
      }
      case '/check-now':
        return applyThenRespond(engine.checkNow)
      case '/restart': {
        const response = await respondWithSnapshot()
        requestRestart()
        return response
      }
      default:
        return failure(404, 'Not found.')
    }
  }

  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)
    if (
      pathname === MUSIC_API_PATH ||
      pathname.startsWith(`${MUSIC_API_PATH}/`)
    ) {
      return handleMusic(pathname.slice(MUSIC_API_PATH.length), request)
    }
    if (
      pathname === SCREEN_API_PATH ||
      pathname.startsWith(`${SCREEN_API_PATH}/`)
    ) {
      return handleScreen(pathname.slice(SCREEN_API_PATH.length), request)
    }
    if (
      pathname !== AUTOMATION_API_PATH &&
      !pathname.startsWith(`${AUTOMATION_API_PATH}/`)
    ) {
      return failure(404, 'Not found.')
    }
    const path = pathname.slice(AUTOMATION_API_PATH.length)
    if (request.method === 'GET' && path === '') {
      return respondWithSnapshot()
    }
    if (request.method === 'GET') {
      return failure(404, 'Not found.')
    }
    if (!isJsonRequest(request)) {
      return failure(415, 'Send JSON.')
    }
    if (isOversized(request)) {
      return failure(413, 'That request is too large.')
    }
    return handleWrite(path, request.method, request)
  }
}
