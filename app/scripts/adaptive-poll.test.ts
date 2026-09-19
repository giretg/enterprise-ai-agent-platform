/**
 * A vezérlőpult élő-állapot pollere ne terhelje a szervert/DB-t feleslegesen:
 *  - háttérbe tett fül ne pollozzon (visibility-ellenőrzés),
 *  - nyugalmi állapotban ritkább ütem,
 *  - egy közös hook, ne szórt `setInterval`-ok.
 *
 * Futtatás: npx tsx scripts/adaptive-poll.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const readSrc = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

const DELETED_POLLERS = [
  'src/components/agents/agent-rail.tsx',
  'src/components/agents/use-agent-chat-turn-liveness.ts',
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

test('a következő poll csak az előző befejezése után ütemeződik', () => {
  const src = readSrc('src/lib/use-adaptive-poll.ts')
  assert.match(src, /await refreshRef\.current\(\)/)
  assert.match(src, /finally\s*\{[\s\S]*setTimeout\(tick, delayRef\.current\)/)
})

test('legacy rail/active-runs pollerek nincsenek a live app-ban', () => {
  for (const file of DELETED_POLLERS) {
    assert.equal(existsSync(resolve(root, file)), false, file)
  }
})
