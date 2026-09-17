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
import { statusLabel } from '../src/lib/active-runs-labels'
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
    launchId: null,
    launchAttemptCount: 0,
    launchNextRetryAt: null,
    launchProviderRef: null,
    launchReservedAt: null,
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

check('#518 queued kapacitásra vár: nem starting, nem tool-copy', () => {
  const now = Date.parse('2026-08-24T09:32:00.000Z')
  const liveness = assessChatTurnLiveness({
    status: 'queued',
    createdAt: '2026-08-24T09:31:00.000Z',
    launchReservedAt: null,
    nowMs: now,
  })
  assert.equal(liveness.kind, 'queued')
  assert.equal(isChatTurnLive(liveness), true)
  const copy = describeChatTurnLiveness(liveness)
  assert.equal(copy.label, 'Sorban áll')
  assert.match(copy.detail, /futtatási hely/)
  assert.doesNotMatch(copy.detail, /tool-hívás/)
})

check('#518 queued indításra foglalva: launching, nem tool-copy', () => {
  const now = Date.parse('2026-08-24T09:32:00.000Z')
  const liveness = assessChatTurnLiveness({
    status: 'queued',
    createdAt: '2026-08-24T09:30:00.000Z',
    launchReservedAt: '2026-08-24T09:31:00.000Z',
    nowMs: now,
  })
  assert.equal(liveness.kind, 'launching')
  assert.equal(isChatTurnLive(liveness), true)
  const copy = describeChatTurnLiveness(liveness)
  assert.equal(copy.label, 'Indul…')
  assert.match(copy.detail, /lefoglalva/)
  assert.doesNotMatch(copy.detail, /tool-hívás/)
})

check('running, nincs activity: starting tool-copy megmarad', () => {
  const now = Date.parse('2026-08-24T09:32:00.000Z')
  const liveness = assessChatTurnLiveness({
    status: 'running',
    startedAt: '2026-08-24T09:31:00.000Z',
    heartbeatAt: '2026-08-24T09:31:00.000Z',
    activities: [],
    nowMs: now,
  })
  assert.equal(liveness.kind, 'starting')
  assert.match(describeChatTurnLiveness(liveness).detail, /tool-hívás/)
})

check('Futások: queued vs launching külön címke', () => {
  const base = Date.parse('2026-08-24T09:31:00.000Z')
  const waiting = {
    id: 'turn-wait',
    conversationId: 'conv-1',
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    agentVersion: 1,
    createdById: 'user-1',
    status: 'queued',
    userMessageId: null,
    assistantMessageId: null,
    input: null,
    launchId: null,
    launchAttemptCount: 0,
    launchNextRetryAt: null,
    launchProviderRef: null,
    launchReservedAt: null,
    partialText: '',
    activities: [],
    turnCount: 0,
    toolCallCount: 0,
    deniedCount: 0,
    cancelRequested: false,
    cancelRequestedById: null,
    cancelRequestedAt: null,
    lockToken: null,
    lockedAt: null,
    heartbeatAt: null,
    startedAt: new Date(base),
    finishedAt: null,
    reason: null,
    error: null,
    createdAt: new Date(base),
    updatedAt: new Date(base),
  } satisfies AgentTurn
  const reserved = {
    ...waiting,
    id: 'turn-launch',
    launchId: 'launch-1',
    launchReservedAt: new Date(base + 30_000),
  }

  const waitingRun = activeRunFromChatTurn(waiting, { userId: 'user-1' }, 'Réka', {
    nowMs: base + 60_000,
  })
  assert.equal(waitingRun.status, 'queued')
  assert.equal(statusLabel(waitingRun), 'Sorban áll')
  assert.match(waitingRun.latestActivity ?? '', /futtatási hely/)
  assert.doesNotMatch(waitingRun.latestActivity ?? '', /tool-hívás/)

  const launchingRun = activeRunFromChatTurn(reserved, { userId: 'user-1' }, 'Réka', {
    nowMs: base + 60_000,
  })
  assert.equal(launchingRun.status, 'starting')
  assert.equal(statusLabel(launchingRun), 'Indul…')
  assert.match(launchingRun.latestActivity ?? '', /lefoglalva/)
  assert.doesNotMatch(launchingRun.latestActivity ?? '', /tool-hívás/)
})

if (failures > 0) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nAll chat-turn-liveness tests passed.')
