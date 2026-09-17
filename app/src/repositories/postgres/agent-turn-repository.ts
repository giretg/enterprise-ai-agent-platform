import { Prisma } from '@prisma/client'
import type { AgentTurn } from '@prisma/client'
import { prisma } from '@/lib/db'
import {
  ACTIVE_AGENT_TURN_STATUSES,
  OWNED_AGENT_TURN_STATUSES,
  ActiveAgentTurnExistsError,
  type AgentTurnRepository,
  type ChatTurnCapacityLimits,
  type CreateAgentTurnInput,
  type FinalizeAgentTurnInput,
  type RecordChatTurnLaunchAttemptInput,
  type ReserveChatTurnCapacityResult,
  type UpdateAgentTurnProgressInput,
} from '../interfaces'

/** #518 — a kapacitásba beszámító sorok: futó + indításra lefoglalt (queued, launchId-vel). */
const OCCUPYING_CAPACITY: Prisma.AgentTurnWhereInput = {
  OR: [
    { status: { in: [...OWNED_AGENT_TURN_STATUSES] } },
    { status: 'queued', launchId: { not: null } },
  ],
}

/**
 * A `0009_agent_turn` migráció részleges egyedi indexe — az `agent_turns` tábla
 * EGYETLEN egyedi kényszere, így minden P2002 innen jön. A `target` mező
 * driver-verziótól függően az index neve vagy az oszlop-lista, ezért csak a
 * hibakódra támaszkodunk; a felismerhető alakokat mégis ellenőrizzük, hogy egy
 * későbbi, új unique-kényszer ne csússzon bele némán.
 */
const ACTIVE_TURN_CONSTRAINT_TARGETS = new Set([
  'agent_turns_active_per_conversation_key',
  'conversation_id',
  'conversationId',
])

function isActiveTurnCollision(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false
  }
  const target = error.meta?.target
  if (typeof target === 'string') return ACTIVE_TURN_CONSTRAINT_TARGETS.has(target)
  if (Array.isArray(target)) return target.some((t) => ACTIVE_TURN_CONSTRAINT_TARGETS.has(String(t)))
  return true
}

export class PostgresAgentTurnRepository implements AgentTurnRepository {
  async create(data: CreateAgentTurnInput): Promise<AgentTurn> {
    try {
      return await prisma.agentTurn.create({
        data: {
          conversationId: data.conversationId,
          tenantId: data.tenantId,
          agentId: data.agentId,
          agentVersion: data.agentVersion,
          createdById: data.createdById,
          userMessageId: data.userMessageId ?? null,
          status: data.status ?? 'running',
          lockToken: data.lockToken ?? null,
          lockedAt: data.lockedAt ?? null,
          ...(data.input !== undefined ? { input: data.input } : {}),
          ...(data.launchId !== undefined ? { launchId: data.launchId } : {}),
        },
      })
    } catch (error) {
      if (isActiveTurnCollision(error)) {
        throw new ActiveAgentTurnExistsError(data.conversationId)
      }
      throw error
    }
  }

  async findById(id: string): Promise<AgentTurn | null> {
    return prisma.agentTurn.findUnique({ where: { id } })
  }

  async findActiveByConversation(conversationId: string): Promise<AgentTurn | null> {
    return prisma.agentTurn.findFirst({
      where: { conversationId, status: { in: [...ACTIVE_AGENT_TURN_STATUSES] } },
      orderBy: { startedAt: 'desc' },
    })
  }

  async listActiveByTenant(
    tenantId: string | null,
    options?: { createdById?: string; limit?: number },
  ): Promise<AgentTurn[]> {
    return prisma.agentTurn.findMany({
      where: {
        tenantId,
        status: { in: [...ACTIVE_AGENT_TURN_STATUSES] },
        ...(options?.createdById ? { createdById: options.createdById } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: options?.limit ?? 50,
    })
  }

  async listRecentTerminalByTenant(
    tenantId: string | null,
    options?: { createdById?: string; limit?: number },
  ): Promise<AgentTurn[]> {
    return prisma.agentTurn.findMany({
      where: {
        tenantId,
        status: { notIn: [...ACTIVE_AGENT_TURN_STATUSES] },
        ...(options?.createdById ? { createdById: options.createdById } : {}),
      },
      orderBy: [{ finishedAt: 'desc' }, { startedAt: 'desc' }],
      take: options?.limit ?? 30,
    })
  }

  async attachUserMessage(id: string, userMessageId: string): Promise<void> {
    await prisma.agentTurn.update({ where: { id }, data: { userMessageId } })
  }

  async acquireLock(id: string, lockToken: string, now: Date): Promise<AgentTurn | null> {
    const result = await prisma.agentTurn.updateMany({
      where: { id, status: { in: [...ACTIVE_AGENT_TURN_STATUSES] }, lockToken: null },
      data: { lockToken, lockedAt: now, heartbeatAt: now },
    })
    if (result.count !== 1) return null
    return this.findById(id)
  }

  async claim(id: string, ownerToken: string, now: Date, launchId: string): Promise<AgentTurn | null> {
    const result = await prisma.agentTurn.updateMany({
      where: { id, status: 'queued', lockToken: null, launchId, cancelRequested: false },
      data: { status: 'running', lockToken: ownerToken, lockedAt: now, heartbeatAt: now, startedAt: now },
    })
    if (result.count !== 1) return null
    return this.findById(id)
  }

  async recordLaunchAttempt(
    id: string,
    data: RecordChatTurnLaunchAttemptInput,
  ): Promise<AgentTurn | null> {
    const result = await prisma.agentTurn.updateMany({
      where: { id, status: 'queued' },
      data: {
        launchId: data.launchId,
        launchNextRetryAt: data.nextRetryAt,
        ...(data.incrementAttempt ? { launchAttemptCount: { increment: 1 } } : {}),
        ...(data.providerRef !== undefined ? { launchProviderRef: data.providerRef } : {}),
      },
    })
    if (result.count !== 1) return null
    return this.findById(id)
  }

  async reserveLaunchCapacity(
    id: string,
    data: { launchId: string; nextRetryAt: Date; limits: ChatTurnCapacityLimits },
    now: Date,
  ): Promise<ReserveChatTurnCapacityResult> {
    return prisma.$transaction(async (tx) => {
      // ponytail: egy globális advisory lock sorosítja a foglalást — a limitek
      // kicsik (tucatnyi), ez bőven elég; tenantonkénti lock, ha a foglalás
      // maga lenne a szűk keresztmetszet.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('agent_turn_capacity'))`
      const turn = await tx.agentTurn.findUnique({
        where: { id },
        select: { status: true, launchId: true, tenantId: true },
      })
      if (!turn || turn.status !== 'queued' || turn.launchId) return 'not_waiting'
      const globalCount = await tx.agentTurn.count({ where: OCCUPYING_CAPACITY })
      if (globalCount >= data.limits.global) return 'global_full'
      const tenantCount = await tx.agentTurn.count({
        where: { AND: [OCCUPYING_CAPACITY, { tenantId: turn.tenantId }] },
      })
      if (tenantCount >= data.limits.perTenant) return 'tenant_full'
      const result = await tx.agentTurn.updateMany({
        where: { id, status: 'queued', launchId: null },
        data: {
          launchId: data.launchId,
          launchReservedAt: now,
          launchNextRetryAt: data.nextRetryAt,
          launchAttemptCount: { increment: 1 },
        },
      })
      return result.count === 1 ? 'reserved' : 'not_waiting'
    })
  }

  async findQueuedForLaunch(now: Date, limit: number): Promise<AgentTurn[]> {
    // Tenantonként kiegyenlített sorrend (#518): minden tenant legrégebbi sora
    // előbb, mint bármely tenant másodikja — a telített tenant hosszú sora nem
    // tolja ki a többit a batchből.
    const ids = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM (
        SELECT id, created_at,
               row_number() OVER (PARTITION BY tenant_id ORDER BY created_at) AS rn
        FROM agent_turns
        WHERE status = 'queued'
          AND user_message_id IS NOT NULL
          AND (launch_next_retry_at IS NULL OR launch_next_retry_at <= ${now})
      ) q
      ORDER BY rn, created_at
      LIMIT ${limit}`
    if (ids.length === 0) return []
    const rows = await prisma.agentTurn.findMany({ where: { id: { in: ids.map((r) => r.id) } } })
    const byId = new Map(rows.map((row) => [row.id, row]))
    return ids.map((r) => byId.get(r.id)).filter((row): row is AgentTurn => Boolean(row))
  }

  async releaseLock(id: string, lockToken: string): Promise<void> {
    await prisma.agentTurn.updateMany({
      where: { id, lockToken },
      data: { lockToken: null, lockedAt: null },
    })
  }

  async heartbeat(id: string, lockToken: string, now: Date): Promise<AgentTurn | null> {
    const result = await prisma.agentTurn.updateMany({
      where: { id, lockToken, status: { in: [...ACTIVE_AGENT_TURN_STATUSES] } },
      data: { heartbeatAt: now },
    })
    if (result.count !== 1) return null
    return this.findById(id)
  }

  async updateProgress(
    id: string,
    lockToken: string,
    data: UpdateAgentTurnProgressInput,
  ): Promise<AgentTurn | null> {
    if (
      data.partialText === undefined &&
      data.activities === undefined &&
      data.turnCount === undefined &&
      data.toolCallCount === undefined &&
      data.deniedCount === undefined
    ) {
      return this.findById(id)
    }
    const result = await prisma.agentTurn.updateMany({
      where: { id, lockToken, status: { in: [...ACTIVE_AGENT_TURN_STATUSES] } },
      data: {
        ...(data.partialText !== undefined ? { partialText: data.partialText } : {}),
        ...(data.activities !== undefined ? { activities: data.activities } : {}),
        // issue #180 WP-1 — a számlálók a futó fordulón is látszanak.
        ...(data.turnCount !== undefined ? { turnCount: data.turnCount } : {}),
        ...(data.toolCallCount !== undefined ? { toolCallCount: data.toolCallCount } : {}),
        ...(data.deniedCount !== undefined ? { deniedCount: data.deniedCount } : {}),
      },
    })
    if (result.count !== 1) return null
    return this.findById(id)
  }

  async requestCancel(id: string, byUserId: string, now: Date = new Date()): Promise<AgentTurn | null> {
    const result = await prisma.agentTurn.updateMany({
      where: { id, status: { in: [...ACTIVE_AGENT_TURN_STATUSES] } },
      data: {
        cancelRequested: true,
        cancelRequestedById: byUserId,
        cancelRequestedAt: now,
      },
    })
    if (result.count !== 1) return null
    return this.findById(id)
  }

  async isCancelRequested(id: string): Promise<boolean> {
    const turn = await prisma.agentTurn.findUnique({
      where: { id },
      select: { cancelRequested: true, status: true },
    })
    if (!turn) return false
    if (!(ACTIVE_AGENT_TURN_STATUSES as readonly string[]).includes(turn.status)) return false
    return turn.cancelRequested
  }

  async finalize(
    id: string,
    data: FinalizeAgentTurnInput,
    lockToken?: string | null,
  ): Promise<AgentTurn | null> {
    // Csak aktív fordulót zárunk le: a második lezárás (pl. watchdog vs. runner
    // versenye) `null`-t ad, nem írja felül az első terminális állapotot.
    const result = await prisma.agentTurn.updateMany({
      where: {
        id,
        status: { in: [...ACTIVE_AGENT_TURN_STATUSES] },
        ...(lockToken !== undefined ? { lockToken } : {}),
      },
      data: {
        status: data.status,
        assistantMessageId: data.assistantMessageId ?? null,
        ...(data.partialText !== undefined ? { partialText: data.partialText } : {}),
        ...(data.activities !== undefined ? { activities: data.activities } : {}),
        ...(data.turnCount !== undefined ? { turnCount: data.turnCount } : {}),
        ...(data.toolCallCount !== undefined ? { toolCallCount: data.toolCallCount } : {}),
        ...(data.deniedCount !== undefined ? { deniedCount: data.deniedCount } : {}),
        reason: data.reason ?? null,
        error: data.error ?? null,
        finishedAt: data.finishedAt ?? new Date(),
        lockToken: null,
        lockedAt: null,
      },
    })
    if (result.count !== 1) return null
    return this.findById(id)
  }

  async findStale(cutoff: Date, limit: number): Promise<AgentTurn[]> {
    return prisma.agentTurn.findMany({
      where: {
        status: { in: [...OWNED_AGENT_TURN_STATUSES] },
        heartbeatAt: { lte: cutoff },
      },
      orderBy: { heartbeatAt: 'asc' },
      take: limit,
    })
  }

  async findOwnedStartedBefore(cutoff: Date, limit: number): Promise<AgentTurn[]> {
    return prisma.agentTurn.findMany({
      where: {
        status: { in: [...OWNED_AGENT_TURN_STATUSES] },
        startedAt: { lte: cutoff },
      },
      orderBy: { startedAt: 'asc' },
      take: limit,
    })
  }

  async findLatestTerminalByConversation(conversationId: string): Promise<AgentTurn | null> {
    return prisma.agentTurn.findFirst({
      where: {
        conversationId,
        status: { notIn: [...ACTIVE_AGENT_TURN_STATUSES] },
      },
      orderBy: [{ finishedAt: 'desc' }, { startedAt: 'desc' }],
    })
  }
}
