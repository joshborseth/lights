import { Effect, Exit } from 'effect'
import { describe, expect, test } from 'vitest'

import { type TokenStatus } from '../src/automation'
import { MissingTokenError, makeGitHub } from './github'

const reply = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers,
  })

const setup = (
  responses: Array<Response>,
  tokens: ReadonlyArray<string> = ['t1', 't2'],
) => {
  const requests: Array<Readonly<{ url: string; init: RequestInit }>> = []
  const statuses: Array<TokenStatus> = []
  const rates: Array<number> = []
  const tokenQueue = [...tokens]
  const github = makeGitHub({
    fetch: (url, init) => {
      requests.push({ url, init })
      const next = responses.shift()
      return next === undefined
        ? Promise.reject(new Error('no response left'))
        : Promise.resolve(next)
    },
    readToken: account => {
      const token = tokenQueue.shift()
      return token === undefined
        ? Effect.fail(new MissingTokenError({ account, reason: 'no login' }))
        : Effect.succeed(token)
    },
    timeoutMs: () => 1000,
    observer: {
      onTokenStatus: (_account, status) => {
        statuses.push(status)
      },
      onRate: (_account, _resource, window) => {
        rates.push(window.remaining)
      },
    },
  })
  return { github, requests, statuses, rates }
}

const authHeader = (init: RequestInit | undefined): string | undefined =>
  new Headers(init?.headers).get('authorization') ?? undefined

describe('GitHub client', () => {
  test('reuses the last answer when GitHub says nothing changed', async () => {
    const event = {
      type: 'PullRequestEvent',
      actor: { login: 'me' },
      repo: { name: 'me/app' },
      created_at: '2026-11-09T18:00:00Z',
      payload: { action: 'merged', number: 1 },
    }
    const { github, requests } = setup([
      reply(200, [event], { etag: '"abc"' }),
      reply(304, null),
    ])
    await Effect.runPromise(github.fetchMergeEvents('me', ['me']))
    const second = await Effect.runPromise(
      github.fetchMergeEvents('me', ['me']),
    )
    expect(second.map(merge => merge.key)).toEqual(['me/app#1'])
    expect(new Headers(requests[1]?.init.headers).get('if-none-match')).toBe(
      '"abc"',
    )
  })

  test('re-reads the login once when GitHub rejects it', async () => {
    const { github, requests, statuses } = setup([
      reply(401, { message: 'Bad credentials' }),
      reply(200, [{ login: 'org' }]),
    ])
    const organizations = await Effect.runPromise(
      github.fetchOrganizations('me'),
    )
    expect(organizations).toEqual(['org'])
    expect(authHeader(requests[0]?.init)).toBe('Bearer t1')
    expect(authHeader(requests[1]?.init)).toBe('Bearer t2')
    expect(statuses.at(-1)).toBe('Ok')
  })

  test('reports a rejected login when the fresh token fails too', async () => {
    const { github, statuses } = setup([
      reply(401, { message: 'Bad credentials' }),
      reply(401, { message: 'Bad credentials' }),
    ])
    const exit = await Effect.runPromiseExit(github.fetchOrganizations('me'))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(statuses.at(-1)).toBe('Rejected')
  })

  test('reports a missing login', async () => {
    const { github, statuses } = setup([], [])
    const exit = await Effect.runPromiseExit(github.fetchOrganizations('me'))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(statuses).toEqual(['Missing'])
  })

  test('records the rate limit from response headers', async () => {
    const { github, rates } = setup([
      reply(200, [], {
        'x-ratelimit-resource': 'core',
        'x-ratelimit-remaining': '4321',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': '1794167805',
      }),
    ])
    await Effect.runPromise(github.fetchOrganizations('me'))
    expect(rates).toEqual([4321])
  })

  test('fails a search when GraphQL returns errors', async () => {
    const { github } = setup([
      reply(200, { errors: [{ message: 'rate limited' }] }),
    ])
    const exit = await Effect.runPromiseExit(
      github.fetchMergedPulls('me', 'user:me', '2026-11-08', ['me']),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test('sends the merged-PR search query', async () => {
    const { github, requests } = setup([
      reply(200, { data: { search: { nodes: [] } } }),
    ])
    await Effect.runPromise(
      github.fetchMergedPulls('me', 'org:acme', '2026-11-08', ['me']),
    )
    expect(requests[0]?.init.body).toContain(
      'is:pr is:merged sort:updated-desc merged:>=2026-11-08 org:acme',
    )
  })
})
