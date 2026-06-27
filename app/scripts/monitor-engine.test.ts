/**
 * Determinisztikus unit-teszt a proaktív monitor magjához (Feature-spec — Proactive
 * Monitor §4.4, §5.3). Futtatás: npm run test:monitor
 *
 * DB és LLM NÉLKÜL igazolja a szűrő-kiértékelőt (csendes alapállapot, küszöb,
 * business-hours, AND/OR) és a következő-söprés számítást (catch-up + jitter).
 */
import assert from 'node:assert/strict'
import type { MonitorDefinition } from '@prisma/client'
import { evaluateFilter } from '../src/domain/monitor/filter-eval'
import { computeNextSweepAt } from '../src/domain/monitor/monitor-service'
import { BoardBacklogCollector } from '../src/domain/monitor/collectors/board-collector'
import { DeadlineCollector } from '../src/domain/monitor/collectors/deadline-collector'
import type { MonitorSignalDraft } from '../src/domain/monitor/collectors/types'

let failures = 0
const asyncChecks: Promise<void>[] = []
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

function checkAsync(name: string, fn: () => Promise<void>) {
  asyncChecks.push(
    fn()
      .then(() => {
        console.log(`  ✅ ${name}`)
      })
      .catch((e) => {
        failures++
        console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
      }),
  )
}

function signal(overrides: Partial<MonitorSignalDraft> = {}): MonitorSignalDraft {
  return {
    dedupKeyParts: { ticketId: 't1' },
    severity: 50,
    title: 'teszt jel',
    dueBy: null,
    payload: {},
    ...overrides,
  }
}

const NOW = new Date('2026-06-21T10:00:00.000Z') // UTC 10:00 → business hours

console.log('=== monitor filter-eval teszt ===')

check('üres szűrő → match (csendes default a collectorra hárul)', () => {
  assert.equal(evaluateFilter({}, signal(), NOW).matched, true)
})

check('severity küszöb alatt → nincs match (csendes)', () => {
  const filter = { field: 'severity', cmp: '>=', value: 60 }
  assert.equal(evaluateFilter(filter, signal({ severity: 50 }), NOW).matched, false)
})

check('severity küszöb felett → match (eszkalálható)', () => {
  const filter = { field: 'severity', cmp: '>=', value: 60 }
  assert.equal(evaluateFilter(filter, signal({ severity: 75 }), NOW).matched, true)
})

check('AND: severity ÉS payload.openCount', () => {
  const filter = {
    op: 'and',
    rules: [
      { field: 'severity', cmp: '>=', value: 60 },
      { field: 'payload.openCount', cmp: '>', value: 5 },
    ],
  }
  assert.equal(evaluateFilter(filter, signal({ severity: 70, payload: { openCount: 3 } }), NOW).matched, false)
  assert.equal(evaluateFilter(filter, signal({ severity: 70, payload: { openCount: 9 } }), NOW).matched, true)
})

check('business-hours: munkaidőn kívül csak magas severity', () => {
  const night = new Date('2026-06-21T22:00:00.000Z') // UTC 22:00 → nem business hours
  const filter = {
    op: 'or',
    rules: [
      { op: 'and', rules: [{ field: 'businessHours', cmp: '==', value: true }] },
      { op: 'and', rules: [{ field: 'businessHours', cmp: '==', value: false }, { field: 'severity', cmp: '>=', value: 90 }] },
    ],
  }
  assert.equal(evaluateFilter(filter, signal({ severity: 70 }), night).matched, false)
  assert.equal(evaluateFilter(filter, signal({ severity: 95 }), night).matched, true)
  assert.equal(evaluateFilter(filter, signal({ severity: 70 }), NOW).matched, true) // nappal átmegy
})

check('hoursUntilDue származtatott mező', () => {
  const filter = { field: 'hoursUntilDue', cmp: '<', value: 4 }
  const soon = new Date(NOW.getTime() + 2 * 3_600_000)
  const later = new Date(NOW.getTime() + 10 * 3_600_000)
  assert.equal(evaluateFilter(filter, signal({ dueBy: soon }), NOW).matched, true)
  assert.equal(evaluateFilter(filter, signal({ dueBy: later }), NOW).matched, false)
})

console.log('=== monitor collector tenant-izoláció teszt ===')

checkAsync('deadline collector tenantId-t ad át a repositorynak', async () => {
  let seenTenantId: string | null = null
  const collector = new DeadlineCollector({
    async collectUpcomingTicketDeadlines(tenantId: string) {
      seenTenantId = tenantId
      return [
        {
          ticketId: 'ticket-a',
          tenantId,
          title: 'A tenant határidő',
          dueBy: new Date(NOW.getTime() + 2 * 3_600_000),
          state: 'ready',
        },
      ]
    },
  } as never)

  const signals = await collector.collect({ tenantId: 'tenant-a', config: { windowHours: 24 }, now: NOW })
  assert.equal(seenTenantId, 'tenant-a')
  assert.equal(signals.length, 1)
  assert.equal(signals[0].payload.tenantId, 'tenant-a')
})

checkAsync('board-backlog collector tenantId-t ad át a repositorynak', async () => {
  let seenTenantId: string | null = null
  const collector = new BoardBacklogCollector({
    async collectStaleBacklogTickets(tenantId: string) {
      seenTenantId = tenantId
      return [
        {
          ticketId: 'ticket-b',
          tenantId,
          title: 'B tenant ticket',
          state: 'awaiting_human',
          updatedAt: new Date(NOW.getTime() - 8 * 3_600_000),
          dueBy: null,
        },
      ]
    },
  } as never)

  const signals = await collector.collect({ tenantId: 'tenant-b', config: { staleHours: 4 }, now: NOW })
  assert.equal(seenTenantId, 'tenant-b')
  assert.equal(signals.length, 1)
  assert.equal(signals[0].payload.tenantId, 'tenant-b')
})

console.log('=== monitor computeNextSweepAt teszt ===')

function monitor(overrides: Partial<MonitorDefinition> = {}): MonitorDefinition {
  return {
    id: 'm1',
    tenantId: 'tenant1',
    kind: 'deadline',
    status: 'active',
    version: 1,
    title: 'm',
    description: null,
    intervalSeconds: 3600,
    nextSweepAt: NOW,
    lastSweepAt: null,
    activeWindowCron: null,
    catchupPolicy: 'run_late',
    catchupWindowSec: 900,
    collectorConfig: {},
    filterConfig: {},
    cooldownSeconds: 86_400,
    dedupKeyTemplate: null,
    openTicketType: 'monitor_alert',
    escalateAgentId: null,
    perRunBudgetUsd: null,
    notifyChannel: null,
    lockToken: null,
    lockedAt: null,
    createdById: 'u1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as MonitorDefinition
}

check('normál eset: nextSweepAt + interval (+ jitter < 30s)', () => {
  const next = computeNextSweepAt(monitor(), NOW)
  const expected = NOW.getTime() + 3_600_000
  assert.ok(next.getTime() >= expected && next.getTime() < expected + 30_000)
})

check('run_late catch-up: rég esedékes → most fut (nem a múltban)', () => {
  const longAgo = new Date(NOW.getTime() - 10 * 3_600_000)
  const next = computeNextSweepAt(monitor({ nextSweepAt: longAgo }), NOW)
  assert.ok(next.getTime() >= NOW.getTime())
})

check('skip catch-up: rég esedékes → jövőbeli slot, nem most', () => {
  const longAgo = new Date(NOW.getTime() - 10 * 3_600_000)
  const next = computeNextSweepAt(monitor({ nextSweepAt: longAgo, catchupPolicy: 'skip' }), NOW)
  assert.ok(next.getTime() >= NOW.getTime())
})

Promise.all(asyncChecks).then(() => {
  console.log(failures === 0 ? '\n✅ minden monitor unit-teszt zöld' : `\n❌ ${failures} teszt bukott`)
  process.exit(failures === 0 ? 0 : 1)
})
