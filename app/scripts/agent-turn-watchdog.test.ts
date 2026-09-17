/**
 * chat-agent-turn-resilience-spec.md §7 / D10 — watchdog (issue #64 / E6).
 *
 * Élő DB nélkül: fake AgentTurn + conversation tár mellett igazolja, hogy
 * az elöregedett heartbeatű aktív forduló a következő ciklusban lezárul,
 * a beszélgetésbe hétköznapi lezáró üzenet kerül, a részszöveg megmarad,
 * és a friss heartbeatű fordulóhoz a watchdog nem nyúl.
 *
 * Futtatás: npm run test:agent-turn-watchdog
 */
import assert from 'node:assert/strict'
import type { AgentTurn, Message } from '@prisma/client'
import type {
  AgentTurnRepository,
  FinalizeAgentTurnInput,
} from '../src/repositories/interfaces'
import {
  DEFAULT_STALE_TURN_MS,
  buildWatchdogClosingMessage,
  reclaimStaleAgentTurns,
  resolveStaleTurnMs,
} from '../src/domain/agent/agent-turn-watchdog'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  OK ${name}`))
    .catch((e) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

function makeTurn(overrides: Partial<AgentTurn> & Pick<AgentTurn, 'id' | 'conversationId'>): AgentTurn {
  const now = new Date()
  return {
    id: overrides.id,
    conversationId: overrides.conversationId,
    tenantId: overrides.tenantId ?? null,
    agentId: overrides.agentId ?? 'agent-1',
    agentVersion: overrides.agentVersion ?? 1,
    createdById: overrides.createdById ?? 'user-1',
    status: overrides.status ?? 'running',
    userMessageId: overrides.userMessageId ?? null,
    assistantMessageId: overrides.assistantMessageId ?? null,
    partialText: overrides.partialText ?? '',
    activities: overrides.activities ?? [],
    turnCount: overrides.turnCount ?? 0,
    toolCallCount: overrides.toolCallCount ?? 0,
    deniedCount: overrides.deniedCount ?? 0,
    cancelRequested: overrides.cancelRequested ?? false,
    cancelRequestedById: overrides.cancelRequestedById ?? null,
    cancelRequestedAt: overrides.cancelRequestedAt ?? null,
    lockToken: overrides.lockToken ?? 'lock-1',
    lockedAt: overrides.lockedAt ?? now,
    heartbeatAt: overrides.heartbeatAt ?? now,
    startedAt: overrides.startedAt ?? now,
    finishedAt: overrides.finishedAt ?? null,
    reason: overrides.reason ?? null,
    error: overrides.error ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  } as AgentTurn
}

function fakeTurns(initial: AgentTurn[]) {
  const rows = new Map(initial.map((t) => [t.id, { ...t }]))
  const finalized: Array<{ id: string } & FinalizeAgentTurnInput> = []

  const repo: Pick<AgentTurnRepository, 'findStale' | 'findOwnedStartedBefore' | 'finalize' | 'findById'> = {
    async findStale(cutoff, limit) {
      return [...rows.values()]
        .filter(
          (t) =>
            (t.status === 'running' || t.status === 'streaming') &&
            t.heartbeatAt.getTime() <= cutoff.getTime(),
        )
        .sort((a, b) => a.heartbeatAt.getTime() - b.heartbeatAt.getTime())
        .slice(0, limit)
    },
    async findOwnedStartedBefore(cutoff, limit) {
      return [...rows.values()]
        .filter(
          (t) =>
            (t.status === 'running' || t.status === 'streaming') &&
            t.startedAt.getTime() <= cutoff.getTime(),
        )
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
        .slice(0, limit)
    },
    async finalize(id, data) {
      const row = rows.get(id)
      if (!row) return null
      if (row.status !== 'queued' && row.status !== 'running' && row.status !== 'streaming') {
        return null
      }
      finalized.push({ id, ...data })
      Object.assign(row, {
        status: data.status,
        reason: data.reason ?? null,
        error: data.error ?? null,
        finishedAt: data.finishedAt ?? new Date(),
        assistantMessageId: data.assistantMessageId ?? null,
        partialText: data.partialText ?? row.partialText,
        lockToken: null,
        lockedAt: null,
      })
      return row
    },
    async findById(id) {
      return rows.get(id) ?? null
    },
  }

  return { repo, rows, finalized }
}

function fakeConversations() {
  const messages: Array<{ conversationId: string; role: string; content: string }> = []
  return {
    messages,
    async appendMessage(params: {
      conversationId: string
      role: Message['role']
      content: string
      actingUserId?: string | null
      agentVersion?: number | null
      actorType?: string
      actorId?: string | null
    }) {
      messages.push({
        conversationId: params.conversationId,
        role: params.role,
        content: params.content,
      })
      return { id: `msg-${messages.length}` } as Message
    },
  }
}

async function main() {
  console.log('=== Agent-forduló watchdog (#64 / E6) ===')

  await check('dokumentált alapérték: ~120 mp', () => {
    assert.equal(DEFAULT_STALE_TURN_MS, 120_000)
  })

  await check('resolveStaleTurnMs: env felülírja a defaultot', () => {
    const prev = process.env.AGENT_TURN_STALE_MS
    process.env.AGENT_TURN_STALE_MS = '90000'
    try {
      assert.equal(resolveStaleTurnMs(), 90_000)
    } finally {
      if (prev === undefined) delete process.env.AGENT_TURN_STALE_MS
      else process.env.AGENT_TURN_STALE_MS = prev
    }
  })

  await check('lezáró üzenet: részszöveg megőrződik + újrapróbálás útmutató', () => {
    const msg = buildWatchdogClosingMessage('Eddig eljutottam ide.')
    assert.match(msg, /megszakadt|leállt|összeomlott/i)
    assert.match(msg, /újra|próbáld|küldd/i)
    assert.match(msg, /Eddig eljutottam ide/)
  })

  await check('E6: elöregített heartbeatű forduló lezárul failed/watchdog-ként', async () => {
    const staleAt = new Date(Date.now() - 10 * 60_000)
    const turns = fakeTurns([
      makeTurn({
        id: 'turn-stale',
        conversationId: 'conv-1',
        status: 'running',
        heartbeatAt: staleAt,
        partialText: 'Részleges válasz a crash előtt.',
        activities: [{ id: 't1', kind: 'tool', title: 'file_read', status: 'done' }],
        lockToken: 'lock-stale',
      }),
    ])
    const conversations = fakeConversations()

    const results = await reclaimStaleAgentTurns({
      turns: turns.repo as AgentTurnRepository,
      conversations,
      staleAfterMs: 120_000,
      now: new Date(),
    })

    assert.equal(results.length, 1)
    assert.equal(results[0]?.status, 'reclaimed')
    assert.equal(turns.finalized.length, 1)
    assert.equal(turns.finalized[0]?.status, 'failed')
    assert.equal(turns.finalized[0]?.reason, 'watchdog')
    assert.ok(turns.finalized[0]?.finishedAt, 'finishedAt beírva')
    assert.equal(turns.rows.get('turn-stale')?.lockToken, null, 'lock elengedve')
    assert.equal(turns.rows.get('turn-stale')?.status, 'failed')

    assert.equal(conversations.messages.length, 1)
    assert.equal(conversations.messages[0]?.conversationId, 'conv-1')
    assert.equal(conversations.messages[0]?.role, 'agent')
    assert.match(conversations.messages[0]?.content ?? '', /Részleges válasz a crash előtt/)
    assert.equal(
      turns.finalized[0]?.partialText,
      'Részleges válasz a crash előtt.',
      'részszöveg megőrződik a rekordon',
    )
    assert.deepEqual(turns.rows.get('turn-stale')?.activities, [
      { id: 't1', kind: 'tool', title: 'file_read', status: 'done' },
    ])
  })

  await check('friss heartbeatű fordulóhoz a watchdog NEM nyúl', async () => {
    const turns = fakeTurns([
      makeTurn({
        id: 'turn-fresh',
        conversationId: 'conv-2',
        status: 'running',
        heartbeatAt: new Date(),
        lockToken: 'lock-fresh',
      }),
    ])
    const conversations = fakeConversations()

    const results = await reclaimStaleAgentTurns({
      turns: turns.repo as AgentTurnRepository,
      conversations,
      staleAfterMs: 120_000,
      now: new Date(),
    })

    assert.equal(results.length, 0)
    assert.equal(turns.finalized.length, 0)
    assert.equal(conversations.messages.length, 0)
    assert.equal(turns.rows.get('turn-fresh')?.status, 'running')
    assert.equal(turns.rows.get('turn-fresh')?.lockToken, 'lock-fresh')
  })

  await check('#519: 30 perces szakaszkeret — friss heartbeatű, de túl hosszú futás lezárul', async () => {
    const startedAt = new Date(Date.now() - 31 * 60_000)
    const turns = fakeTurns([
      makeTurn({
        id: 'turn-long',
        conversationId: 'conv-phase',
        status: 'running',
        heartbeatAt: new Date(),
        startedAt,
        partialText: 'Még dolgoztam, amikor lejárt a keret.',
        activities: [{ id: 't2', kind: 'tool', title: 'web_search', status: 'running' }],
        lockToken: 'lock-long',
      }),
      makeTurn({
        id: 'turn-queued',
        conversationId: 'conv-queue',
        status: 'queued',
        startedAt: new Date(Date.now() - 2 * 60 * 60_000),
        heartbeatAt: new Date(Date.now() - 2 * 60 * 60_000),
        lockToken: null,
      }),
    ])
    const conversations = fakeConversations()
    const results = await reclaimStaleAgentTurns({
      turns: turns.repo as AgentTurnRepository,
      conversations,
      now: new Date(),
    })

    const long = results.find((r) => r.turnId === 'turn-long')
    assert.equal(long?.status, 'reclaimed')
    assert.equal(turns.rows.get('turn-long')?.status, 'exhausted')
    assert.equal(turns.rows.get('turn-long')?.reason, 'wallclock_timeout')
    assert.match(conversations.messages[0]?.content ?? '', /Még dolgoztam/)
    assert.match(conversations.messages[0]?.content ?? '', /30 perc/)
    assert.deepEqual(turns.rows.get('turn-long')?.activities, [
      { id: 't2', kind: 'tool', title: 'web_search', status: 'running' },
    ])
    assert.equal(turns.rows.get('turn-queued')?.status, 'queued', 'a sorban állás nem a 30 perces keret')
  })

  await check('már lezárt fordulót (verseny) skipped-ként jelöl', async () => {
    const staleAt = new Date(Date.now() - 10 * 60_000)
    const turns = fakeTurns([
      makeTurn({
        id: 'turn-race',
        conversationId: 'conv-3',
        status: 'running',
        heartbeatAt: staleAt,
      }),
    ])
    // Verseny: a findStale még aktívnak látja, de a finalize null-t ad.
    turns.repo.finalize = async () => null

    const conversations = fakeConversations()
    const results = await reclaimStaleAgentTurns({
      turns: turns.repo as AgentTurnRepository,
      conversations,
      staleAfterMs: 120_000,
    })

    assert.equal(results[0]?.status, 'skipped')
    assert.equal(conversations.messages.length, 0, 'skippednél nincs lezáró üzenet')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\nMinden watchdog-teszt zöld.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
