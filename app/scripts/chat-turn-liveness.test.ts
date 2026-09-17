/**
 * Chat-forduló élőség — unit tesztek.
 * Futtatás: npx tsx scripts/chat-turn-liveness.test.ts
 */
import assert from 'node:assert/strict'
import {
  assessChatTurnLiveness,
  describeChatTurnLiveness,
  isChatTurnLive,
} from '../src/domain/agent/chat-turn-liveness'
import { DEFAULT_STALE_TURN_MS } from '../src/domain/agent/agent-turn-watchdog'
import { activeRunFromChatTurn } from '../src/lib/active-runs-map'
import type { AgentTurn } from '@prisma/client'

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

console.log('chat-turn-liveness')

check('friss heartbeat: élő futás', () => {
  const now = Date.parse('2026-08-24T09:31:00.000Z')
  const liveness = assessChatTurnLiveness({
    status: 'running',
    heartbeatAt: '2026-08-24T09:31:00.000Z',
    activities: [{ id: 't1', kind: 'tool', title: 'file_read', status: 'running' }],
    nowMs: now + 10_000,
  })
  assert.equal(liveness.kind, 'active')
  assert.equal(isChatTurnLive(liveness), true)
})

check('régi heartbeat + running lépés: stalled', () => {
  const base = Date.parse('2026-08-24T09:31:39.000Z')
  const liveness = assessChatTurnLiveness({
    status: 'running',
    heartbeatAt: new Date(base).toISOString(),
    activities: [
      {
        id: 'r1',
        kind: 'reasoning',
        title: 'Tool eredmények kiértékelése',
        status: 'running',
      },
    ],
    nowMs: base + DEFAULT_STALE_TURN_MS + 1,
  })
  assert.equal(liveness.kind, 'stalled')
  assert.equal(isChatTurnLive(liveness), false)
  const copy = describeChatTurnLiveness(liveness)
  assert.match(copy.label, /megállt/)
  assert.match(copy.detail, /Tool eredmények/)
})

check('activeRunFromChatTurn: stale heartbeat → stalled státusz', () => {
  const base = Date.parse('2026-08-24T09:31:39.000Z')
  const turn = {
    id: 'turn-1',
    conversationId: 'conv-1',
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    agentVersion: 1,
    createdById: 'user-1',
    status: 'running',
    userMessageId: null,
    assistantMessageId: null,
    input: null,
    partialText: '',
    activities: [
      {
        id: 'r1',
        kind: 'reasoning',
        title: 'Tool eredmények kiértékelése',
        status: 'running',
      },
    ],
    turnCount: 7,
    toolCallCount: 17,
    deniedCount: 0,
    cancelRequested: false,
    cancelRequestedById: null,
    cancelRequestedAt: null,
    lockToken: 'lock',
    lockedAt: new Date(base - 60_000),
    heartbeatAt: new Date(base),
    startedAt: new Date(base - 90_000),
    finishedAt: null,
    reason: null,
    error: null,
    createdAt: new Date(base - 90_000),
    updatedAt: new Date(base),
  } satisfies AgentTurn

  const run = activeRunFromChatTurn(turn, { userId: 'user-1' }, 'Réka', {
    nowMs: base + DEFAULT_STALE_TURN_MS + 1,
  })
  assert.equal(run.status, 'stalled')
  assert.equal(run.phase, 'active')
  assert.match(run.latestActivity ?? '', /nincs friss jelzés/)
})

if (failures > 0) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nAll chat-turn-liveness tests passed.')
