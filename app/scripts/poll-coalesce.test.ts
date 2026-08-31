/**
 * A vezérlőpult élő-állapot pollútjai (`rail-state`, `active-runs`) ne indítsanak
 * pollonként külön DB-kört: egy rövid időablakon belül a közel egyszerre érkező
 * kérések OSZTOZZANAK egy `loadActiveRuns` / `listAgents` híváson.
 *
 *  - egyidejű cache-miss → egyetlen loader-hívás (inflight-megosztás),
 *  - TTL-en belül → nincs újabb loader-hívás,
 *  - TTL lejárta után → új loader-hívás,
 *  - hibát (reject) SOSEM cache-elünk (átmeneti `PostgreSQL … Closed` nem ragad be),
 *  - `invalidatePrefix` / `invalidate` → a következő olvasás újratölt,
 *  - invalidálás közben futó loader → nem írja vissza a régi értéket,
 *  - a két végpont és a két `cancel` route tényleg ezen a modulon megy át.
 *
 * Futtatás: npx tsx scripts/poll-coalesce.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { createCoalescingCache } from '../src/lib/poll-coalesce'

const root = resolve(import.meta.dirname, '..')
const readSrc = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

test('egyidejű cache-miss kérések egyetlen loader-hívást osztanak meg', async () => {
  const clock = fakeClock()
  const cache = createCoalescingCache<number>(2_000, clock.now)
  let calls = 0
  const loader = () =>
    new Promise<number>((r) => setTimeout(() => r(++calls), 5))

  const [a, b, c] = await Promise.all([
    cache.get('k', loader),
    cache.get('k', loader),
    cache.get('k', loader),
  ])
  assert.equal(calls, 1, 'egy loader-hívás')
  assert.deepEqual([a, b, c], [1, 1, 1], 'mindenki ugyanazt az eredményt kapja')
})

test('TTL-en belül nincs újratöltés, utána van', async () => {
  const clock = fakeClock()
  const cache = createCoalescingCache<number>(2_000, clock.now)
  let calls = 0
  const loader = async () => ++calls

  assert.equal(await cache.get('k', loader), 1)
  clock.advance(1_999)
  assert.equal(await cache.get('k', loader), 1, 'TTL-en belül a cache-elt érték')
  clock.advance(2)
  assert.equal(await cache.get('k', loader), 2, 'TTL után új loader-hívás')
})

test('a hibát nem cache-eljük — a következő kérés újrapróbál', async () => {
  const clock = fakeClock()
  const cache = createCoalescingCache<number>(2_000, clock.now)
  let calls = 0
  const loader = async () => {
    calls += 1
    if (calls === 1) throw new Error('PostgreSQL connection Closed')
    return calls
  }

  await assert.rejects(cache.get('k', loader))
  assert.equal(await cache.get('k', loader), 2, 'a hiba nem ragadt be a TTL-re')
})

test('invalidálás közben futó loader nem írja vissza a régi értéket', async () => {
  const clock = fakeClock()
  const cache = createCoalescingCache<string>(10_000, clock.now)
  let resolveLoader!: (value: string) => void
  const loader = () =>
    new Promise<string>((resolve) => {
      resolveLoader = resolve
    })

  const pending = cache.get('t1|u1|active-runs|operator', loader)
  cache.invalidatePrefix('t1|u1|')
  resolveLoader('stale')
  await pending

  let calls = 0
  const freshLoader = async () => `fresh-${++calls}`
  assert.equal(await cache.get('t1|u1|active-runs|operator', freshLoader), 'fresh-1')
  assert.equal(calls, 1, 'a stale eredmény nem cache-elődött')
})

test('invalidate és invalidatePrefix a következő olvasásnál újratölt', async () => {
  const clock = fakeClock()
  const cache = createCoalescingCache<number>(10_000, clock.now)
  let calls = 0
  const loader = async () => ++calls

  await cache.get('t1|u1|active-runs|operator', loader)
  await cache.get('t1|u1|rail-agents|', loader)
  assert.equal(calls, 2)

  cache.invalidatePrefix('t1|u1|')
  await cache.get('t1|u1|active-runs|operator', loader)
  assert.equal(calls, 3, 'prefix-invalidálás után újratölt')

  cache.invalidate('t1|u1|active-runs|operator')
  await cache.get('t1|u1|active-runs|operator', loader)
  assert.equal(calls, 4, 'kulcs-invalidálás után újratölt')
})

test('a poll-végpontok és a cancel route-ok a poll-coalesce modulon mennek át', () => {
  const railState = readSrc('src/app/api/agents/rail-state/route.ts')
  assert.match(railState, /coalescePollRead\(/, 'rail-state: coalesced olvasás')
  assert.match(railState, /namespace: 'rail-agents'/)
  assert.match(railState, /namespace: 'active-runs'/)

  const activeRuns = readSrc('src/app/api/v1/active-runs/route.ts')
  assert.match(activeRuns, /coalescePollRead\(/, 'active-runs: coalesced olvasás')
  assert.match(activeRuns, /namespace: 'active-runs'/)

  for (const rel of [
    'src/app/api/v1/agent-chat/turns/[turnId]/cancel/route.ts',
    'src/app/api/v1/tickets/[id]/cancel/route.ts',
  ]) {
    assert.match(readSrc(rel), /invalidatePollScope\(/, `${rel}: leállítás után invalidál`)
  }
})
