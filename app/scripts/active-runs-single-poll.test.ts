/**
 * A vezérlőpult-héjon a bal munkatárs-sáv és a fejléc „Futások” panelje
 * ugyanazt a tenant+user élő-futás adatot mutatta, de KÉT külön ~5 mp-es
 * pollúton (`/api/agents/rail-state` + `/api/v1/active-runs`). Ez a teljes
 * HTTP-forgalom felét adta, dupla Clerk-autentikációval és dupla Cloud Run
 * meghívással, miközben a DB-kör (a #406 összevonás óta) már közös volt.
 *
 * A javítás: a `rail-state` válasza MÁR tartalmazza a `runs` listát, a panel
 * pedig egy folyamaton belüli store-ból (`active-runs-feed-store`) olvassa,
 * amit a sáv poll-ja tölt. Így a `/api/v1/active-runs` pollút a héjon megszűnik
 * (a különálló dashboard-lista végpontja marad).
 *
 * Futtatás: npx tsx scripts/active-runs-single-poll.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  getActiveRunsFeed,
  publishActiveRunsFeed,
  publishActiveRunsFeedError,
  requestActiveRunsRefresh,
  resetActiveRunsFeed,
  subscribeActiveRunsFeed,
  subscribeActiveRunsRefresh,
} from '../src/components/active-runs/active-runs-feed-store'
import type { ActiveRun } from '../src/lib/active-runs'

const root = resolve(import.meta.dirname, '..')
const readSrc = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

function fakeRun(id: string, phase: ActiveRun['phase'] = 'active'): ActiveRun {
  return {
    kind: 'ticket',
    id,
    title: `Run ${id}`,
    href: `/x/${id}`,
    status: phase === 'active' ? 'in_progress' : 'done',
    phase,
    latestActivity: null,
    startedAt: new Date().toISOString(),
    finishedAt: phase === 'active' ? null : new Date().toISOString(),
    canStop: phase === 'active',
    canStart: false,
    targetId: id,
    agentId: 'agent-1',
  }
}

test('a store a legutóbbi sikeres futáslistát adja vissza, és értesíti a feliratkozókat', () => {
  resetActiveRunsFeed()
  let notified = 0
  const unsub = subscribeActiveRunsFeed(() => {
    notified++
  })

  assert.deepEqual(getActiveRunsFeed().runs, [])
  assert.equal(getActiveRunsFeed().receivedAt, null, 'induláskor „még nincs adat”')

  publishActiveRunsFeed([fakeRun('a')])
  assert.equal(notified, 1)
  assert.equal(getActiveRunsFeed().runs.length, 1)
  assert.equal(getActiveRunsFeed().error, null)
  assert.ok(typeof getActiveRunsFeed().receivedAt === 'number', 'sikeres poll időbélyeget ad')

  unsub()
  publishActiveRunsFeed([fakeRun('a'), fakeRun('b')])
  assert.equal(notified, 1, 'leiratkozás után nincs értesítés')
  assert.equal(getActiveRunsFeed().runs.length, 2, 'de az érték frissül')
})

test('poll-hiba a legutóbbi listát megtartja (a panel nem ürül ki egy hibától)', () => {
  resetActiveRunsFeed()
  publishActiveRunsFeed([fakeRun('a'), fakeRun('b')])
  const before = getActiveRunsFeed().receivedAt

  publishActiveRunsFeedError('A futások most nem frissíthetők.')
  const feed = getActiveRunsFeed()
  assert.equal(feed.runs.length, 2, 'a lista megmarad')
  assert.equal(feed.error, 'A futások most nem frissíthetők.')
  assert.equal(feed.receivedAt, before, 'a hiba nem számít sikeres frissítésnek')

  publishActiveRunsFeed([fakeRun('a')])
  assert.equal(getActiveRunsFeed().error, null, 'a következő siker törli a hibát')
})

test('az azonnali frissítés-kérés eljut a sáv feliratkozójához', () => {
  resetActiveRunsFeed()
  let refreshes = 0
  const unsub = subscribeActiveRunsRefresh(() => {
    refreshes++
  })
  requestActiveRunsRefresh()
  requestActiveRunsRefresh()
  assert.equal(refreshes, 2, 'a panel Stop/Start/megnyitás után kikényszerítheti a sáv-poll-t')
  unsub()
  requestActiveRunsRefresh()
  assert.equal(refreshes, 2)
})

test('a `rail-state` végpont válasza tartalmazza a `runs` listát', () => {
  const route = readSrc('src/app/api/agents/rail-state/route.ts')
  assert.match(route, /loadActiveRuns\(/, 'a futáslistát amúgy is betölti')
  assert.match(route, /\bruns,\s*$/m, 'és bele is teszi a válaszba')

  const types = readSrc('src/lib/agent-rail-types.ts')
  assert.match(types, /runs:\s*ActiveRun\[\]/, 'a válasz-típusban is szerepel')
})

test('a sáv poll-ja tölti a megosztott hírcsatornát; a panel onnan olvas', () => {
  const rail = readSrc('src/components/agents/agent-rail.tsx')
  assert.match(rail, /publishActiveRunsFeed\(data\.runs/, 'sikeres poll → közzététel')
  assert.match(rail, /publishActiveRunsFeedError\(/, 'poll-hiba → a panel is jelzést kap')
  assert.match(rail, /subscribeActiveRunsRefresh\(/, 'a panel kérésére azonnal újrapollozik')

  const panel = readSrc('src/components/active-runs/active-runs-panel.tsx')
  assert.doesNotMatch(
    panel,
    /fetch\(\s*['"]\/api\/v1\/active-runs['"]/,
    'a panelnek nincs saját active-runs pollútja',
  )
  assert.match(panel, /useActiveRunsFeed\(\)/)
})

test('a különálló dashboard-lista végpontja megmarad (nem a héj-panel)', () => {
  const dash = readSrc('src/components/active-runs/dashboard-runs-list.tsx')
  assert.match(
    dash,
    /fetch\(\s*['"]\/api\/v1\/active-runs['"]/,
    'a dashboard kártya továbbra is közvetlenül kérdezi az endpointot',
  )
})
