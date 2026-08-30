/**
 * A vezérlőpult élő-állapot pollere ne terhelje a szervert/DB-t feleslegesen:
 *  - háttérbe tett fül ne pollozzon (visibility-ellenőrzés),
 *  - nyugalmi állapotban ritkább ütem,
 *  - egy közös hook, ne szórt `setInterval`-ok.
 *
 * Futtatás: npx tsx scripts/adaptive-poll.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const readSrc = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

const POLLERS = [
  'src/components/agents/agent-rail.tsx',
  'src/components/active-runs/active-runs-panel.tsx',
  'src/components/active-runs/dashboard-runs-list.tsx',
] as const

test('a közös hook rejtett fül alatt kihagyja a lekérdezést, és visszatéréskor frissít', () => {
  const src = readSrc('src/lib/use-adaptive-poll.ts')
  assert.match(src, /visibilityState !== 'hidden'/, 'háttér-fül alatt nincs poll')
  assert.match(src, /addEventListener\('visibilitychange'/, 'visszatéréskor azonnali frissítés')
  assert.match(src, /visibilityState === 'visible'/)
})

test('a hook külön élő és nyugalmi időközt kezel, és nem építi újra a ciklust idle-váltáskor', () => {
  const src = readSrc('src/lib/use-adaptive-poll.ts')
  assert.match(src, /activeMs/)
  assert.match(src, /idleMs/)
  // A futó időzítő referencián át olvassa a késleltetést → csak `enabled` építi újra.
  assert.match(src, /delayRef\.current/)
  assert.match(src, /\}, \[enabled\]\)/)
})

for (const file of POLLERS) {
  test(`${file}: a közös adaptív hookon pollozik, nincs nyers setInterval`, () => {
    const src = readSrc(file)
    assert.match(src, /useAdaptivePoll\(/, 'a közös hookot használja')
    assert.doesNotMatch(src, /setInterval\(/, 'nincs kézi poll-ciklus')
    // Az élő ütem legfeljebb 5 mp; a korábbi 2,5 mp-es active-runs poll megszűnt.
    assert.doesNotMatch(src, /activeMs:\s*2500\b/)
  })
}

test('active-runs panel: nyugalmi ütem lassabb, mint az élő', () => {
  const src = readSrc('src/components/active-runs/active-runs-panel.tsx')
  const active = Number(/POLL_ACTIVE_MS\s*=\s*(\d+)/.exec(src)?.[1])
  const idle = Number(/POLL_IDLE_MS\s*=\s*(\d+)/.exec(src)?.[1])
  assert.ok(Number.isFinite(active) && Number.isFinite(idle), 'mindkét időköz definiált')
  assert.ok(idle > active, 'a nyugalmi ütem ritkább')
})
