import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  type Merge,
  classifyMerges,
  mergesFromEvents,
  mergesFromSearch,
  searchDayFloor,
} from './merges'

const ACCOUNTS = ['me', 'work-me']
const NOW = Date.UTC(2026, 10, 9, 18)
const CUTOFF = NOW - 45 * 60_000

const merge = (key: string, ageMinutes: number): Merge => ({
  key,
  actor: 'me',
  repo: key.split('#')[0] ?? '',
  maybeMergedAt: Option.some(NOW - ageMinutes * 60_000),
})

describe('mergesFromEvents', () => {
  const event = (action: string, login: string) => ({
    type: 'PullRequestEvent',
    actor: { login },
    repo: { name: 'me/app' },
    created_at: '2026-11-09T18:00:00Z',
    payload: { action, number: 7 },
  })

  test('keeps merges by watched accounts', () => {
    expect(
      mergesFromEvents([event('merged', 'me')], ACCOUNTS).map(item => item.key),
    ).toEqual(['me/app#7'])
  })

  test('ignores other actions, other people, and other event shapes', () => {
    expect(
      mergesFromEvents(
        [event('opened', 'me'), event('merged', 'stranger'), { type: 'Push' }],
        ACCOUNTS,
      ),
    ).toEqual([])
  })
})

describe('mergesFromSearch', () => {
  const node = (login: string | null) => ({
    number: 3,
    mergedAt: '2026-11-09T18:00:00Z',
    mergedBy: login === null ? null : { login },
    repository: { nameWithOwner: 'org/app' },
  })

  test('counts a merge when mergedBy is a watched account', () => {
    expect(
      mergesFromSearch([node('work-me')], ACCOUNTS).map(item => item.actor),
    ).toEqual(['work-me'])
  })

  test('skips merges by others and empty search nodes', () => {
    expect(mergesFromSearch([node('bot'), node(null), {}], ACCOUNTS)).toEqual(
      [],
    )
  })
})

describe('classifyMerges', () => {
  test('celebrates recent unseen merges once, even from two sources', () => {
    const batch = classifyMerges(
      [merge('a/b#1', 1), merge('a/b#1', 1)],
      new Set(),
      [],
      CUTOFF,
    )
    expect(batch.toCelebrate.map(item => item.key)).toEqual(['a/b#1'])
  })

  test('skips merges already seen', () => {
    const batch = classifyMerges(
      [merge('a/b#1', 1)],
      new Set(['a/b#1']),
      [],
      CUTOFF,
    )
    expect(batch).toEqual({ toCelebrate: [], toRecordSilently: [] })
  })

  test('records merges past the catch-up window without celebrating', () => {
    const batch = classifyMerges([merge('a/b#1', 60)], new Set(), [], CUTOFF)
    expect(batch).toEqual({ toCelebrate: [], toRecordSilently: ['a/b#1'] })
  })

  test('records ignored repositories without celebrating', () => {
    const batch = classifyMerges(
      [merge('a/b#1', 1)],
      new Set(),
      ['a/b'],
      CUTOFF,
    )
    expect(batch).toEqual({ toCelebrate: [], toRecordSilently: ['a/b#1'] })
  })

  test('treats a merge with no timestamp as old', () => {
    const batch = classifyMerges(
      [{ ...merge('a/b#1', 1), maybeMergedAt: Option.none() }],
      new Set(),
      [],
      CUTOFF,
    )
    expect(batch.toRecordSilently).toEqual(['a/b#1'])
  })
})

test('searchDayFloor goes back the lookback hours', () => {
  expect(searchDayFloor(NOW, 36)).toBe('2026-11-08')
})
