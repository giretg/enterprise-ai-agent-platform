/**
 * Unit tesztek: ticket progress flusher + active-run mapping.
 * Futtatás: npx tsx scripts/active-runs.test.ts
 */
import assert from 'node:assert/strict'
import {
  TicketProgressFlusher,
  mergeRuntimeProgressIntoPayload,
  TICKET_PROGRESS_FLUSH_INTERVAL_MS,
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
  assert.equal(
    flusher.pushActivity({ id: 'a1', kind: 'tool', title: 'tool', status: 'done' }),
    false,
  )
  now += TICKET_PROGRESS_FLUSH_INTERVAL_MS + 1
  assert.equal(
    flusher.pushActivity({ id: 'a2', kind: 'reasoning', title: 'gondolkodik', status: 'running' }),
    true,
  )
  const snap = flusher.takeSnapshot()
  assert.ok(snap)
  assert.equal(snap!.activities.length, 2)
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

if (failures > 0) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nAll passed')
