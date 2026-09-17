/**
 * #517 — elveszett / bizonytalan chat-forduló indítások egyeztetése.
 *
 *  - fogadás utáni processzhalál: a ciklus megtalálja és elindítja a queued sort;
 *  - elveszett launch-válasz: nem végleges hiba, nincs dupla launch;
 *  - dupla launch: reconcile/running után nincs második indítás;
 *  - végleges elutasítás: failed + foglalás felszabadul;
 *  - stale running loopot a recover NEM játssza újra.
 *
 * Futtatás: npm run test:chat-turn-launch
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AgentTurn } from '@prisma/client'
import type { AgentTurnRepository } from '../src/repositories/interfaces'
import {
  ChatTurnLaunchRejectedError,
  type ChatTurnLauncher,
} from '../src/domain/agent/chat-turn-launcher'
import {
  CHAT_TURN_LAUNCH_MAX_ATTEMPTS,
  LAUNCH_FAILED_REASON,
  classifyChatTurnLaunchError,
  launchAcceptedChatTurn,
  recoverQueuedChatTurns,
} from '../src/domain/agent/chat-turn-dispatch'

const BIG = { global: 100, perTenant: 100 }

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK ${name}`)
  } catch (e) {
    failures += 1
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function queuedTurn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  const now = new Date()
  return {
    id: 'turn-1',
    conversationId: 'conv-1',
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    agentVersion: 1,
    createdById: 'user-1',
    status: 'queued',
    userMessageId: 'msg-1',
    assistantMessageId: null,
    input: { v: 1, content: 'Szia', attachmentDocumentIds: [] },
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
    heartbeatAt: now,
    startedAt: now,
    finishedAt: null,
    reason: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as AgentTurn
}

const OCCUPYING = (row: AgentTurn) =>
  row.status === 'running' || row.status === 'streaming' || (row.status === 'queued' && row.launchId)

function fakeTurns(...initial: AgentTurn[]) {
  const rows = new Map<string, AgentTurn>(initial.map((row) => [row.id, { ...row }]))
  const finalized: Array<{ id: string; status: string; reason?: string | null }> = []
  const repo: Pick<
    AgentTurnRepository,
    'findById' | 'findQueuedForLaunch' | 'recordLaunchAttempt' | 'reserveLaunchCapacity' | 'finalize'
  > = {
    async findById(id) {
      return rows.get(id) ?? null
    },
    async findQueuedForLaunch(now, limit) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.status === 'queued' &&
            row.userMessageId &&
            (row.launchNextRetryAt == null || row.launchNextRetryAt <= now),
        )
        .slice(0, limit)
    },
    async reserveLaunchCapacity(id, data, now) {
      const row = rows.get(id)
      if (!row || row.status !== 'queued' || row.launchId) return 'not_waiting'
      const all = [...rows.values()].filter(OCCUPYING)
      if (all.length >= data.limits.global) return 'global_full'
      if (all.filter((r) => r.tenantId === row.tenantId).length >= data.limits.perTenant) {
        return 'tenant_full'
      }
      rows.set(id, {
        ...row,
        launchId: data.launchId,
        launchReservedAt: now,
        launchNextRetryAt: data.nextRetryAt,
        launchAttemptCount: row.launchAttemptCount + 1,
      })
      return 'reserved'
    },
    async recordLaunchAttempt(id, data) {
      const row = rows.get(id)
      if (!row || row.status !== 'queued') return null
      const next = {
        ...row,
        launchId: data.launchId,
        launchNextRetryAt: data.nextRetryAt,
        launchAttemptCount: data.incrementAttempt
          ? row.launchAttemptCount + 1
          : row.launchAttemptCount,
        ...(data.providerRef !== undefined ? { launchProviderRef: data.providerRef } : {}),
      }
      rows.set(id, next)
      return next
    },
    async finalize(id, data, lockToken) {
      const row = rows.get(id)
      if (!row || (row.status !== 'queued' && row.status !== 'running' && row.status !== 'streaming')) {
        return null
      }
      if (lockToken !== undefined && row.lockToken !== lockToken) return null
      finalized.push({ id, status: data.status, reason: data.reason })
      const next = {
        ...row,
        status: data.status,
        reason: data.reason ?? null,
        error: data.error ?? null,
        finishedAt: data.finishedAt ?? new Date(),
        lockToken: null,
      }
      rows.set(id, next)
      return next
    },
  }
  return { repo, rows, finalized }
}

async function main() {
  console.log('=== #517 chat-forduló indítás-egyeztetés ===')

  await test('átmeneti hiba retryable, ChatTurnLaunchRejectedError végleges', () => {
    assert.equal(classifyChatTurnLaunchError(new Error('timeout')), 'transient')
    assert.equal(
      classifyChatTurnLaunchError(new ChatTurnLaunchRejectedError('quota')),
      'permanent',
    )
  })

  await test('fogadás utáni processzhalál: a ciklus megtalálja és elindítja a queued sort', async () => {
    const { repo, rows } = fakeTurns(queuedTurn())
    const launched: string[] = []
    const launcher: ChatTurnLauncher = {
      async launch({ turnId, launchId }) {
        launched.push(turnId)
        return { launchId, outcome: 'accepted', providerRef: `op-${launchId}` }
      },
      async reconcile() {
        return { state: 'not_found' }
      },
    }
    const summary = await recoverQueuedChatTurns({ turns: repo, launcher, capacity: BIG })
    assert.equal(summary.scanned, 1)
    assert.equal(summary.launched, 1)
    assert.equal(launched.length, 1)
    const row = rows.get('turn-1')!
    assert.ok(row.launchId)
    assert.equal(row.launchAttemptCount, 1)
    assert.equal(row.launchProviderRef, `op-${row.launchId}`)
    assert.equal(row.status, 'queued', 'a claim a futtatómagé, a ciklus csak indít')
  })

  await test('elveszett launch-válasz: nem végleges hiba, a következő kör nem indít másodszor', async () => {
    const { repo, rows, finalized } = fakeTurns(queuedTurn())
    const launched: string[] = []
    const running = new Set<string>()
    const launcher: ChatTurnLauncher = {
      async launch({ turnId, launchId }) {
        launched.push(launchId)
        running.add(turnId)
        throw new Error('upstream timeout')
      },
      async reconcile({ turnId }) {
        return running.has(turnId) ? { state: 'running' } : { state: 'not_found' }
      },
    }
    const first = await launchAcceptedChatTurn({ turns: repo, launcher, capacity: BIG }, rows.get('turn-1')!)
    assert.equal(first.kind, 'pending')
    assert.equal(rows.get('turn-1')!.status, 'queued')
    assert.equal(finalized.length, 0, 'elveszett válasz nem hamis végleges hiba')

    const second = await launchAcceptedChatTurn({ turns: repo, launcher, capacity: BIG }, rows.get('turn-1')!)
    assert.equal(second.kind, 'already_running')
    assert.equal(launched.length, 1, 'nincs dupla launch')
    assert.equal(rows.get('turn-1')!.status, 'queued')
  })

  await test('dupla launch: a második hívás reconcile=running miatt nem indít újat', async () => {
    const { repo, rows } = fakeTurns(queuedTurn())
    const launched: string[] = []
    const launcher: ChatTurnLauncher = {
      async launch({ launchId }) {
        launched.push(launchId)
        return { launchId, outcome: 'accepted', providerRef: launchId }
      },
      async reconcile({ turnId }) {
        return launched.length > 0 && turnId === 'turn-1'
          ? { state: 'running', providerRef: launched[0] }
          : { state: 'not_found' }
      },
    }
    assert.equal((await launchAcceptedChatTurn({ turns: repo, launcher, capacity: BIG }, rows.get('turn-1')!)).kind, 'launched')
    const again = await launchAcceptedChatTurn({ turns: repo, launcher, capacity: BIG }, rows.get('turn-1')!)
    assert.equal(again.kind, 'already_running')
    assert.equal(launched.length, 1)
  })

  await test('végleges elutasítás: látható failed + a queued foglalás felszabadul', async () => {
    const { repo, rows, finalized } = fakeTurns(queuedTurn())
    const launcher: ChatTurnLauncher = {
      async launch() {
        throw new ChatTurnLaunchRejectedError('A futtató elutasította az indítást.')
      },
      async reconcile() {
        return { state: 'not_found' }
      },
    }
    const result = await launchAcceptedChatTurn({ turns: repo, launcher, capacity: BIG }, rows.get('turn-1')!)
    assert.equal(result.kind, 'failed')
    assert.equal(rows.get('turn-1')!.status, 'failed')
    assert.equal(finalized[0]?.reason, LAUNCH_FAILED_REASON)
  })

  await test('max attempt után végleges hiba, running sort a recover nem játssza újra', async () => {
    const { repo, rows, finalized } = fakeTurns(
      queuedTurn({
        launchId: randomUUID(),
        launchAttemptCount: CHAT_TURN_LAUNCH_MAX_ATTEMPTS,
        launchNextRetryAt: new Date(0),
      }),
    )
    const launched: string[] = []
    const launcher: ChatTurnLauncher = {
      async launch({ launchId }) {
        launched.push(launchId)
        return { launchId, outcome: 'accepted' }
      },
      async reconcile() {
        return { state: 'not_found' }
      },
    }
    const failed = await recoverQueuedChatTurns({ turns: repo, launcher, capacity: BIG })
    assert.equal(failed.failed, 1)
    assert.equal(launched.length, 0)
    assert.equal(rows.get('turn-1')!.status, 'failed')
    assert.equal(finalized[0]?.reason, LAUNCH_FAILED_REASON)

    const runningStore = fakeTurns(queuedTurn({ status: 'running', lockToken: 'owner-1' }))
    const replay = await recoverQueuedChatTurns({
      turns: runningStore.repo,
      capacity: BIG,
      launcher: {
        async launch() {
          throw new Error('nem szabad running loopot újraindítani')
        },
        async reconcile() {
          return { state: 'running' }
        },
      },
    })
    assert.equal(replay.scanned, 0)
    assert.equal(replay.launched, 0)
  })

  await test('#518: telített globális kapacitásnál a sor vár — nincs attempt, nincs hiba, nincs launchId', async () => {
    const { repo, rows, finalized } = fakeTurns(
      queuedTurn({ id: 'busy', conversationId: 'c-busy', status: 'running', lockToken: 'o' }),
      queuedTurn({ id: 'wait', conversationId: 'c-wait' }),
    )
    const launcher: ChatTurnLauncher = {
      async launch() {
        throw new Error('telített kapacitásnál nem szabad indítani')
      },
      async reconcile() {
        return { state: 'not_found' }
      },
    }
    const summary = await recoverQueuedChatTurns({
      turns: repo,
      launcher,
      capacity: { global: 1, perTenant: 1 },
    })
    assert.equal(summary.waiting, 1)
    assert.equal(summary.launched, 0)
    const row = rows.get('wait')!
    assert.equal(row.status, 'queued')
    assert.equal(row.launchId, null, 'várakozás nem foglal — nem éri a 10 perces indítási határ')
    assert.equal(row.launchAttemptCount, 0)
    assert.equal(finalized.length, 0)
  })

  await test('#518: telített tenant nem blokkol más tenantot; felszabadulás után a várakozó indul', async () => {
    const { repo, rows } = fakeTurns(
      queuedTurn({ id: 'a-run', conversationId: 'c1', tenantId: 'A', status: 'running', lockToken: 'o' }),
      queuedTurn({ id: 'a-wait', conversationId: 'c2', tenantId: 'A' }),
      queuedTurn({ id: 'b-wait', conversationId: 'c3', tenantId: 'B' }),
    )
    const launched: string[] = []
    const launcher: ChatTurnLauncher = {
      async launch({ turnId, launchId }) {
        launched.push(turnId)
        return { launchId, outcome: 'accepted', providerRef: launchId }
      },
      async reconcile() {
        return { state: 'running' }
      },
    }
    const capacity = { global: 4, perTenant: 1 }
    const first = await recoverQueuedChatTurns({ turns: repo, launcher, capacity })
    assert.deepEqual(launched, ['b-wait'], 'A telített, B indul')
    assert.equal(first.waiting, 1)
    assert.ok(rows.get('b-wait')!.launchReservedAt, 'a foglalás ideje mérhető')

    await repo.finalize('a-run', { status: 'completed' })
    await recoverQueuedChatTurns({ turns: repo, launcher, capacity })
    assert.deepEqual(launched, ['b-wait', 'a-wait'], 'a felszabadult hely a várakozóé')
  })

  await test('#518: queued Stop lezárja a sort tulajdonos nélkül; claimelt sort nem üt el', async () => {
    const { repo, rows, finalized } = fakeTurns(
      queuedTurn({ id: 'stop', conversationId: 'c1', cancelRequested: true }),
      queuedTurn({ id: 'claimed', conversationId: 'c2', cancelRequested: true, lockToken: 'owner' }),
    )
    const launcher: ChatTurnLauncher = {
      async launch() {
        throw new Error('Stop-olt sort nem indítunk')
      },
      async reconcile() {
        return { state: 'not_found' }
      },
    }
    await recoverQueuedChatTurns({ turns: repo, launcher, capacity: { global: 9, perTenant: 9 } })
    assert.equal(rows.get('stop')!.status, 'cancelled')
    assert.equal(finalized[0]?.reason, 'stop')
    assert.equal(rows.get('claimed')!.status, 'queued', 'tokenes sort a null-token nem zár')
  })

  if (failures > 0) {
    console.log(`\n${failures} teszt bukott.`)
    process.exit(1)
  }
  console.log('\n#517 chat-forduló indítás-egyeztetés kész.')
}

void main()
