import { Array, Data, Duration, Effect, Option, Schema, pipe } from 'effect'

import { type RateWindow, type TokenStatus } from '../src/automation'
import { type Merge, mergesFromEvents, mergesFromSearch } from './merges'

const API_ROOT = 'https://api.github.com'
const USER_AGENT = 'lights-automations'

const SEARCH_QUERY =
  'query($q:String!){search(query:$q,type:ISSUE,first:30){nodes{... on PullRequest{number mergedAt mergedBy{login} repository{nameWithOwner}}}}}'

export class GitHubError extends Data.TaggedError('GitHubError')<{
  readonly account: string
  readonly reason: string
}> {}

export class MissingTokenError extends Data.TaggedError('MissingTokenError')<{
  readonly account: string
  readonly reason: string
}> {}

export type RateResource = 'core' | 'graphql'

export type GitHubObserver = Readonly<{
  onTokenStatus: (account: string, status: TokenStatus) => void
  onRate: (account: string, resource: RateResource, window: RateWindow) => void
}>

export type GitHubDeps = Readonly<{
  fetch: (url: string, init: RequestInit) => Promise<Response>
  readToken: (account: string) => Effect.Effect<string, MissingTokenError>
  timeoutMs: () => number
  observer: GitHubObserver
}>

export type GitHubPort = Readonly<{
  fetchMergeEvents: (
    account: string,
    accounts: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<Merge>, GitHubError>
  fetchMergedPulls: (
    account: string,
    scope: string,
    sinceDay: string,
    accounts: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<Merge>, GitHubError>
  fetchOrganizations: (
    account: string,
  ) => Effect.Effect<ReadonlyArray<string>, GitHubError>
  checkAccount: (account: string) => Effect.Effect<void, GitHubError>
}>

const RateResources = Schema.Struct({
  resources: Schema.Struct({
    core: Schema.Struct({
      remaining: Schema.Number,
      limit: Schema.Number,
      reset: Schema.Number,
    }),
    graphql: Schema.Struct({
      remaining: Schema.Number,
      limit: Schema.Number,
      reset: Schema.Number,
    }),
  }),
})

const SearchPayload = Schema.Struct({
  data: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        search: Schema.Struct({ nodes: Schema.Array(Schema.Unknown) }),
      }),
    ),
  ),
  errors: Schema.optionalKey(
    Schema.Array(Schema.Struct({ message: Schema.String })),
  ),
})

const Organization = Schema.Struct({ login: Schema.String })

const rateFromHeaders = (headers: Headers): Option.Option<RateWindow> => {
  const remaining = headers.get('x-ratelimit-remaining')
  const limit = headers.get('x-ratelimit-limit')
  const reset = headers.get('x-ratelimit-reset')
  return remaining === null || limit === null || reset === null
    ? Option.none()
    : Option.some({
        remaining: Number(remaining),
        limit: Number(limit),
        resetsAt: Number(reset) * 1000,
      })
}

const resourceOf = (headers: Headers): Option.Option<RateResource> => {
  const resource = headers.get('x-ratelimit-resource')
  return resource === 'core' || resource === 'graphql'
    ? Option.some(resource)
    : Option.none()
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : globalThis.String(error)

type CachedResponse = Readonly<{ etag: string; body: unknown }>

export const makeGitHub = (deps: GitHubDeps): GitHubPort => {
  const tokens = new Map<string, string>()
  const conditionalCache = new Map<string, CachedResponse>()

  const fail = (account: string, reason: string) =>
    Effect.fail(new GitHubError({ account, reason }))

  const tokenFor = (account: string): Effect.Effect<string, GitHubError> => {
    const cached = tokens.get(account)
    if (cached !== undefined) {
      return Effect.succeed(cached)
    }
    return deps.readToken(account).pipe(
      Effect.tap(token =>
        Effect.sync(() => {
          tokens.set(account, token)
        }),
      ),
      Effect.catchTag('MissingTokenError', error => {
        deps.observer.onTokenStatus(account, 'Missing')
        return fail(account, error.reason)
      }),
    )
  }

  const observeRate = (account: string, headers: Headers): void => {
    Option.map(resourceOf(headers), resource =>
      Option.map(rateFromHeaders(headers), window =>
        deps.observer.onRate(account, resource, window),
      ),
    )
  }

  const send = (
    account: string,
    url: string,
    init: RequestInit,
  ): Effect.Effect<Response, GitHubError> =>
    Effect.tryPromise({
      try: signal => deps.fetch(url, { ...init, signal }),
      catch: error => new GitHubError({ account, reason: errorText(error) }),
    }).pipe(
      Effect.timeoutOption(Duration.millis(deps.timeoutMs())),
      Effect.flatMap(
        Option.match({
          onNone: () => fail(account, `${url} timed out`),
          onSome: Effect.succeed,
        }),
      ),
    )

  const requestWithToken = (
    account: string,
    url: string,
    init: RequestInit,
    shouldRetryAuth: boolean,
  ): Effect.Effect<Response, GitHubError> =>
    Effect.gen(function* () {
      const token = yield* tokenFor(account)
      const response = yield* send(account, url, {
        ...init,
        headers: {
          ...init.headers,
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': USER_AGENT,
        },
      })
      observeRate(account, response.headers)
      if (response.status === 401) {
        tokens.delete(account)
        if (shouldRetryAuth) {
          return yield* requestWithToken(account, url, init, false)
        }
        deps.observer.onTokenStatus(account, 'Rejected')
        return yield* fail(account, 'GitHub rejected the saved login')
      }
      deps.observer.onTokenStatus(account, 'Ok')
      return response
    })

  const readJson = (
    account: string,
    response: Response,
  ): Effect.Effect<unknown, GitHubError> =>
    Effect.tryPromise({
      try: () => response.json(),
      catch: error => new GitHubError({ account, reason: errorText(error) }),
    })

  const failUnlessOk = (
    account: string,
    response: Response,
  ): Effect.Effect<void, GitHubError> =>
    response.ok
      ? Effect.void
      : fail(account, `GitHub answered HTTP ${response.status}`)

  const getJson = (
    account: string,
    path: string,
  ): Effect.Effect<unknown, GitHubError> =>
    Effect.gen(function* () {
      const url = `${API_ROOT}${path}`
      const cached = conditionalCache.get(url)
      const response = yield* requestWithToken(
        account,
        url,
        cached === undefined
          ? {}
          : { headers: { 'If-None-Match': cached.etag } },
        true,
      )
      if (response.status === 304 && cached !== undefined) {
        return cached.body
      }
      yield* failUnlessOk(account, response)
      const body = yield* readJson(account, response)
      const etag = response.headers.get('etag')
      if (etag !== null) {
        conditionalCache.set(url, { etag, body })
      }
      return body
    })

  const decode = <A>(
    account: string,
    schema: Schema.Codec<A>,
    body: unknown,
  ): Effect.Effect<A, GitHubError> =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(
        () =>
          new GitHubError({
            account,
            reason: 'GitHub sent a response this service cannot read',
          }),
      ),
    )

  return {
    fetchMergeEvents: (account, accounts) =>
      Effect.gen(function* () {
        const body = yield* getJson(
          account,
          `/users/${encodeURIComponent(account)}/events?per_page=100`,
        )
        const events = yield* decode(
          account,
          Schema.Array(Schema.Unknown),
          body,
        )
        return mergesFromEvents(events, accounts)
      }),

    fetchMergedPulls: (account, scope, sinceDay, accounts) =>
      Effect.gen(function* () {
        const query = `is:pr is:merged sort:updated-desc merged:>=${sinceDay} ${scope}`
        const response = yield* requestWithToken(
          account,
          `${API_ROOT}/graphql`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: SEARCH_QUERY,
              variables: { q: query },
            }),
          },
          true,
        )
        yield* failUnlessOk(account, response)
        const payload = yield* decode(
          account,
          SearchPayload,
          yield* readJson(account, response),
        )
        if (payload.errors !== undefined && payload.errors[0] !== undefined) {
          return yield* fail(account, payload.errors[0].message)
        }
        const nodes = payload.data?.search.nodes ?? []
        return mergesFromSearch(nodes, accounts)
      }),

    fetchOrganizations: account =>
      Effect.gen(function* () {
        const body = yield* getJson(account, '/user/orgs?per_page=100')
        const organizations = yield* decode(
          account,
          Schema.Array(Organization),
          body,
        )
        return pipe(
          organizations,
          Array.map(organization => organization.login),
        )
      }),

    checkAccount: account =>
      Effect.gen(function* () {
        const response = yield* requestWithToken(
          account,
          `${API_ROOT}/rate_limit`,
          {},
          true,
        )
        yield* failUnlessOk(account, response)
        const payload = yield* decode(
          account,
          RateResources,
          yield* readJson(account, response),
        )
        const toWindow = (
          resource: typeof payload.resources.core,
        ): RateWindow => ({
          remaining: resource.remaining,
          limit: resource.limit,
          resetsAt: resource.reset * 1000,
        })
        deps.observer.onRate(account, 'core', toWindow(payload.resources.core))
        deps.observer.onRate(
          account,
          'graphql',
          toWindow(payload.resources.graphql),
        )
      }),
  }
}
