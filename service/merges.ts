import { Array, Option, Schema, pipe } from 'effect'

export type Merge = Readonly<{
  key: string
  actor: string
  repo: string
  maybeMergedAt: Option.Option<number>
}>

const parseTimestamp = (value: string): Option.Option<number> => {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? Option.none() : Option.some(parsed)
}

const mergeOf = (
  repo: string,
  number: number,
  actor: string,
  timestamp: string,
): Merge => ({
  key: `${repo}#${number}`,
  actor,
  repo,
  maybeMergedAt: parseTimestamp(timestamp),
})

// GITHUB PAYLOADS

const NamedRepo = Schema.Struct({ name: Schema.String })
const Login = Schema.Struct({ login: Schema.String })

const PullRequestEvent = Schema.Struct({
  type: Schema.Literal('PullRequestEvent'),
  actor: Login,
  repo: NamedRepo,
  created_at: Schema.String,
  payload: Schema.Struct({
    action: Schema.String,
    number: Schema.Number,
  }),
})

const decodeEvent = Schema.decodeUnknownOption(PullRequestEvent)

export const mergesFromEvents = (
  events: ReadonlyArray<unknown>,
  accounts: ReadonlyArray<string>,
): ReadonlyArray<Merge> =>
  pipe(
    events,
    Array.map(event => decodeEvent(event)),
    Array.getSomes,
    Array.filter(
      event =>
        event.payload.action === 'merged' &&
        Array.contains(accounts, event.actor.login),
    ),
    Array.map(event =>
      mergeOf(
        event.repo.name,
        event.payload.number,
        event.actor.login,
        event.created_at,
      ),
    ),
  )

const SearchNode = Schema.Struct({
  number: Schema.Number,
  mergedAt: Schema.NullOr(Schema.String),
  mergedBy: Schema.NullOr(Login),
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
})

const decodeSearchNode = Schema.decodeUnknownOption(SearchNode)

export const mergesFromSearch = (
  nodes: ReadonlyArray<unknown>,
  accounts: ReadonlyArray<string>,
): ReadonlyArray<Merge> =>
  pipe(
    nodes,
    Array.map(node => decodeSearchNode(node)),
    Array.getSomes,
    Array.map(node =>
      node.mergedBy !== null && Array.contains(accounts, node.mergedBy.login)
        ? Option.some(
            mergeOf(
              node.repository.nameWithOwner,
              node.number,
              node.mergedBy.login,
              node.mergedAt ?? '',
            ),
          )
        : Option.none(),
    ),
    Array.getSomes,
  )

// CLASSIFICATION

export type MergeBatch = Readonly<{
  toCelebrate: ReadonlyArray<Merge>
  toRecordSilently: ReadonlyArray<string>
}>

export const classifyMerges = (
  merges: ReadonlyArray<Merge>,
  seen: ReadonlySet<string>,
  ignoredRepos: ReadonlyArray<string>,
  cutoffMs: number,
): MergeBatch => {
  const fresh = pipe(
    merges,
    Array.dedupeWith((first, second) => first.key === second.key),
    Array.filter(merge => !seen.has(merge.key)),
  )
  const isCelebrated = (merge: Merge): boolean =>
    !Array.contains(ignoredRepos, merge.repo) &&
    Option.exists(merge.maybeMergedAt, mergedAt => mergedAt >= cutoffMs)
  return {
    toCelebrate: Array.filter(fresh, isCelebrated),
    toRecordSilently: pipe(
      fresh,
      Array.filter(merge => !isCelebrated(merge)),
      Array.map(merge => merge.key),
    ),
  }
}

export const searchDayFloor = (nowMs: number, lookbackHours: number): string =>
  new Date(nowMs - lookbackHours * 3_600_000).toISOString().slice(0, 10)
