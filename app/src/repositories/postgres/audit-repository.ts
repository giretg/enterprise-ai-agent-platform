import type { AuditLog, ModelCall, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { AuditRepository, ModelCallRepository } from '../interfaces'
import { computeAuditHash, GENESIS_HASH } from '@/lib/crypto/hash-chain'
import { chainHasGaps, reconcileAuditChain } from '@/lib/crypto/audit-backfill'

const AUDIT_CHAIN_LOCK_KEY = 424242

export class PostgresAuditRepository implements AuditRepository {
  async append(
    data: Omit<AuditLog, 'id' | 'seq' | 'createdAt' | 'hash' | 'prevHash'>,
  ): Promise<AuditLog> {
    return prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`

        let prevHash = GENESIS_HASH
        if (await chainHasGaps(tx)) {
          prevHash = await reconcileAuditChain(tx)
        } else {
          const last = await tx.auditLog.findFirst({ orderBy: { seq: 'desc' } })
          prevHash = last?.hash ?? GENESIS_HASH
        }

        const row = await tx.auditLog.create({
          data: { ...data, prevHash, hash: '' } as Prisma.AuditLogCreateInput,
        })

        const hash = computeAuditHash({
          seq: row.seq,
          prevHash,
          actorType: row.actorType,
          actorId: row.actorId,
          action: row.action,
          targetType: row.targetType,
          targetId: row.targetId,
          createdAt: row.createdAt,
        })

        return tx.auditLog.update({ where: { id: row.id }, data: { hash } })
      },
      { timeout: 60_000 },
    )
  }

  async findMany(filter?: { action?: string; limit?: number }): Promise<AuditLog[]> {
    return prisma.auditLog.findMany({
      where: filter?.action ? { action: filter.action } : undefined,
      orderBy: { seq: 'desc' },
      take: filter?.limit ?? 100,
    })
  }

  async findAll(): Promise<AuditLog[]> {
    return prisma.auditLog.findMany({ orderBy: { seq: 'asc' } })
  }

  async getActionCounts(filter?: {
    actions?: string[]
    since?: Date
  }): Promise<Record<string, number>> {
    const grouped = await prisma.auditLog.groupBy({
      by: ['action'],
      where: {
        ...(filter?.actions ? { action: { in: filter.actions } } : {}),
        ...(filter?.since ? { createdAt: { gte: filter.since } } : {}),
      },
      _count: { _all: true },
    })

    const counts: Record<string, number> = {}
    if (filter?.actions) {
      for (const action of filter.actions) counts[action] = 0
    }
    for (const row of grouped) counts[row.action] = row._count._all
    return counts
  }
}

export class PostgresModelCallRepository implements ModelCallRepository {
  async create(data: Omit<ModelCall, 'id' | 'createdAt'>): Promise<ModelCall> {
    return prisma.modelCall.create({ data })
  }

  async getCostSummary(since?: Date) {
    const rows = await prisma.modelCall.findMany({
      where: since ? { createdAt: { gte: since } } : undefined,
      select: {
        promptTokens: true,
        completionTokens: true,
        costEstimate: true,
      },
    })

    return rows.reduce(
      (acc, row) => ({
        tokens: acc.tokens + row.promptTokens + row.completionTokens,
        cost: acc.cost + Number(row.costEstimate),
      }),
      { tokens: 0, cost: 0 },
    )
  }

  async getUsageForAgentSince(agentId: string, since: Date) {
    const rows = await prisma.modelCall.findMany({
      where: { agentId, createdAt: { gte: since } },
      select: {
        promptTokens: true,
        completionTokens: true,
      },
    })

    return rows.reduce(
      (acc, row) => ({
        calls: acc.calls + 1,
        tokens: acc.tokens + row.promptTokens + row.completionTokens,
      }),
      { calls: 0, tokens: 0 },
    )
  }

  async getUsageForTicket(ticketId: string) {
    const rows = await prisma.modelCall.findMany({
      where: { ticketId },
      select: {
        promptTokens: true,
        completionTokens: true,
      },
    })

    return rows.reduce(
      (acc, row) => ({
        calls: acc.calls + 1,
        tokens: acc.tokens + row.promptTokens + row.completionTokens,
      }),
      { calls: 0, tokens: 0 },
    )
  }

  async getGovernanceSummary(since?: Date) {
    const rows = await prisma.modelCall.findMany({
      where: since ? { createdAt: { gte: since } } : undefined,
      select: {
        promptTokens: true,
        completionTokens: true,
        costEstimate: true,
        latencyMs: true,
        status: true,
      },
    })

    const acc = rows.reduce(
      (a, row) => {
        a.tokens += row.promptTokens + row.completionTokens
        a.cost += Number(row.costEstimate)
        a.latencyTotal += row.latencyMs
        if (row.status === 'ok') a.okCalls += 1
        else if (row.status === 'error') a.errorCalls += 1
        else if (row.status === 'rate_limited') a.rateLimitedCalls += 1
        return a
      },
      { tokens: 0, cost: 0, latencyTotal: 0, okCalls: 0, errorCalls: 0, rateLimitedCalls: 0 },
    )

    const calls = rows.length
    return {
      calls,
      tokens: acc.tokens,
      cost: acc.cost,
      avgLatencyMs: calls > 0 ? Math.round(acc.latencyTotal / calls) : 0,
      okCalls: acc.okCalls,
      errorCalls: acc.errorCalls,
      rateLimitedCalls: acc.rateLimitedCalls,
    }
  }

  async getPerTicketBreakdown(since?: Date, limit = 50) {
    const rows = await prisma.modelCall.findMany({
      where: {
        ticketId: { not: null },
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      select: {
        ticketId: true,
        promptTokens: true,
        completionTokens: true,
        costEstimate: true,
        latencyMs: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    const byTicket = new Map<
      string,
      { calls: number; tokens: number; cost: number; latencyTotal: number; lastSeen: Date }
    >()
    for (const row of rows) {
      const id = row.ticketId as string
      const entry = byTicket.get(id) ?? {
        calls: 0,
        tokens: 0,
        cost: 0,
        latencyTotal: 0,
        lastSeen: row.createdAt,
      }
      entry.calls += 1
      entry.tokens += row.promptTokens + row.completionTokens
      entry.cost += Number(row.costEstimate)
      entry.latencyTotal += row.latencyMs
      if (row.createdAt > entry.lastSeen) entry.lastSeen = row.createdAt
      byTicket.set(id, entry)
    }

    return Array.from(byTicket.entries())
      .sort((a, b) => b[1].lastSeen.getTime() - a[1].lastSeen.getTime())
      .slice(0, limit)
      .map(([ticketId, e]) => ({
        ticketId,
        calls: e.calls,
        tokens: e.tokens,
        cost: e.cost,
        avgLatencyMs: e.calls > 0 ? Math.round(e.latencyTotal / e.calls) : 0,
      }))
  }
}
