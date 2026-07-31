/**
 * Unit tesztek: ticket progress flusher + active-run mapping.
 * Futtatás: npx tsx scripts/active-runs.test.ts
 */
import assert from 'node:assert/strict'
import {
  TicketProgressFlusher,
  assessTicketRunLiveness,
  formatTicketProgressAge,
  mergeRuntimeProgressIntoPayload,
  readTicketRuntimeProgress,
  TICKET_PROGRESS_ACTIVE_MS,
  TICKET_PROGRESS_FLUSH_INTERVAL_MS,
  TICKET_PROGRESS_STALL_MS,
} from '../src/domain/agent/ticket-runtime-progress'
import { activeRunFromChatTurn, activeRunFromTicket } from '../src/lib/active-runs-map'
import type { AgentTurn, Ticket } from '@prisma/client'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

console.log('active-runs / ticket-progress')

check('progress flusher throttles by interval', () => {
  let now = 0
  const flusher = new TicketProgressFlusher(() => now, TICKET_PROGRESS_FLUSH_INTERVAL_MS)
  assert.equal(
    flusher.pushActivity({ id: 'a1', kind: 'tool', title: 'tool', status: 'running' }),
    true,
  )
  // Runtime szerződés: due=true után snapshotIfDue NEM null (regresszió: dirty
  // flaget a pushActivity fogyasztotta el → soha nem íródott runtimeProgress).
  const firstSnap = flusher.snapshotIfDue()
  assert.ok(firstSnap)
  assert.equal(firstSnap!.activities.length, 1)
  assert.equal(firstSnap!.activities[0]?.status, 'running')

  assert.equal(
    flusher.pushActivity({ id: 'a1', kind: 'tool', title: 'tool', status: 'done' }),
    false,
  )
  assert.equal(flusher.snapshotIfDue(), null)

  now += TICKET_PROGRESS_FLUSH_INTERVAL_MS + 1
  assert.equal(
    flusher.pushActivity({ id: 'a2', kind: 'reasoning', title: 'gondolkodik', status: 'running' }),
    true,
  )
  const snap = flusher.snapshotIfDue()
  assert.ok(snap)
  assert.equal(snap!.activities.length, 2)
  assert.equal(snap!.activities[0]?.status, 'done')
})

check('progress flusher mirrors general-task onActivity persist path', () => {
  let now = 1_000
  const flusher = new TicketProgressFlusher(() => now, TICKET_PROGRESS_FLUSH_INTERVAL_MS)
  const persisted: string[] = []

  const onActivity = (activity: {
    id: string
    kind: 'tool' | 'reasoning'
    title: string
    status: 'running' | 'done' | 'error' | 'skipped'
  }) => {
    if (flusher.pushActivity(activity)) {
      const snap = flusher.snapshotIfDue()
      if (snap) persisted.push(snap.activities.map((a) => `${a.title}:${a.status}`).join(','))
    }
  }

  onActivity({ id: 't1', kind: 'tool', title: 'kb_search', status: 'running' })
  assert.deepEqual(persisted, ['kb_search:running'])

  onActivity({ id: 't1', kind: 'tool', title: 'kb_search', status: 'done' })
  assert.deepEqual(persisted, ['kb_search:running'])

  now += TICKET_PROGRESS_FLUSH_INTERVAL_MS + 1
  onActivity({ id: 't2', kind: 'tool', title: 'file_write', status: 'running' })
  assert.deepEqual(persisted, ['kb_search:running', 'kb_search:done,file_write:running'])
})

check('mergeRuntimeProgressIntoPayload preserves other fields', () => {
  const merged = mergeRuntimeProgressIntoPayload(
    { question: 'hello', answer: null },
    { updatedAt: '2026-01-01T00:00:00.000Z', activities: [] },
  )
  assert.equal(merged.question, 'hello')
  assert.ok(merged.runtimeProgress)
})

check('activeRunFromChatTurn builds href; canStop only for creator (E9)', () => {
  const turn = {
    id: 'turn-1',
    conversationId: 'conv-1',
    agentId: 'agent-1',
    createdById: 'user-owner',
    status: 'running',
    activities: [{ id: 'x', kind: 'tool', title: 'file_read', status: 'done' }],
    startedAt: new Date('2026-07-19T10:00:00.000Z'),
    cancelRequested: false,
  } as unknown as AgentTurn
  const own = activeRunFromChatTurn(turn, { userId: 'user-owner' })
  assert.equal(own.kind, 'chat_turn')
  assert.equal(own.canStop, true)
  assert.ok(own.href.includes('/control-plane/agents/agent-1'))
  assert.ok(own.href.includes('conversation=conv-1'))
  assert.ok(own.latestActivity?.includes('file_read'))

  const other = activeRunFromChatTurn(turn, { userId: 'user-other' })
  assert.equal(other.canStop, false)
})

check('activeRunFromTicket reads runtimeProgress', () => {
  const ticket = {
    id: 'ticket-1',
    title: 'Teszt ticket',
    state: 'in_progress',
    agentId: 'agent-2',
    payload: {
      runtimeProgress: {
        updatedAt: '2026-07-19T10:00:00.000Z',
        activities: [{ id: 't1', kind: 'tool', title: 'kb_search', status: 'running' }],
      },
    },
    lockedAt: new Date('2026-07-19T10:00:00.000Z'),
    updatedAt: new Date('2026-07-19T10:00:00.000Z'),
  } as unknown as Ticket
  const run = activeRunFromTicket(ticket)
  assert.equal(run.kind, 'ticket')
  assert.equal(run.href, '/control-plane/tickets/ticket-1')
  assert.ok(run.latestActivity?.includes('kb_search'))
})

check('assessTicketRunLiveness: active vs stalled vs cancelling', () => {
  const base = Date.parse('2026-07-31T09:10:00.000Z')
  const progress = readTicketRuntimeProgress({
    runtimeProgress: {
      updatedAt: new Date(base).toISOString(),
      activities: [{ id: 't1', kind: 'tool', title: 'file_read', status: 'running' }],
    },
  })
  assert.ok(progress)

  assert.equal(
    assessTicketRunLiveness({
      ticketState: 'in_progress',
      progress,
      nowMs: base + 10_000,
    }).kind,
    'active',
  )
  assert.equal(
    assessTicketRunLiveness({
      ticketState: 'in_progress',
      progress,
      nowMs: base + TICKET_PROGRESS_ACTIVE_MS + 1,
    }).kind,
    'quiet',
  )
  assert.equal(
    assessTicketRunLiveness({
      ticketState: 'in_progress',
      progress,
      nowMs: base + TICKET_PROGRESS_STALL_MS + 1,
    }).kind,
    'stalled',
  )
  assert.equal(
    assessTicketRunLiveness({
      ticketState: 'in_progress',
      cancelRequested: true,
      progress,
      nowMs: base + TICKET_PROGRESS_STALL_MS + 1,
    }).kind,
    'cancelling',
  )
  assert.equal(
    assessTicketRunLiveness({
      ticketState: 'done',
      progress,
      nowMs: base,
    }).kind,
    'idle',
  )
})

check('formatTicketProgressAge is Hungarian relative', () => {
  assert.equal(formatTicketProgressAge(12_000), '12 másodperce')
  assert.equal(formatTicketProgressAge(125_000), '2 perce')
})

if (failures > 0) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nAll passed')
