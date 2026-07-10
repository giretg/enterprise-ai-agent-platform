import { Prisma } from '@prisma/client'
import type { AuditLog, ModelBudget, ModelCall, ModelRoutingPolicy, TicketType } from '@prisma/client'
import { prisma } from '@/lib/db'
import { budgetPeriodSince } from '@/lib/budget-period'
import type {
  AuditRepository,
  ModelBudgetRepository,
  ModelBudgetScope,
  ModelCallRepository,
  ModelBudgetPeriod,
  ModelRoutingPolicyRepository,
  ModelRoutingScope,
} from '../interfaces'
import { computeAuditHashV2, GENESIS_HASH } from '@/lib/crypto/hash-chain'
import { assertAuditMetadataSafe } from '@/lib/audit/payload-guard'
import { assertAuditActionRegistered } from '@/lib/audit/event-catalog'
import { deriveAuditAttribution } from '@/lib/audit/attribution'

const AUDIT_CHAIN_LOCK_KEY = 424242

export class PostgresAuditRepository implements AuditRepository {
  /**
   * Egyetlen belépési pont az audit_log-ba (spec-invariáns #1). A hash-t INSERT ELŐTT
   * számítjuk (nextval a seq-sequence-ről az advisory lock alatt), így a sor egy darab
   * atomi INSERT-tel jön létre — nincs utólagos UPDATE. Ez teszi lehetővé a DB-szintű
   * append-only kényszert (BEFORE UPDATE/DELETE trigger, lásd migrations/), mert az
   * alkalmazás-kódnak soha nem kell UPDATE-elnie ezt a táblát.
   */
  async append(
    data: Omit<
      AuditLog,
      'id' | 'seq' | 'createdAt' | 'hash' | 'prevHash' | 'tenantId' | 'ticketId' | 'conversationId'
    > & {
      tenantId?: string | null
      ticketId?: string | null
      conversationId?: string | null
    },
  ): Promise<AuditLog> {
    assertAuditActionRegistered(data.action)
    assertAuditMetadataSafe(data.metadata)

    return prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`

        const [{ nextval: seq }] = await tx.$queryRaw<{ nextval: bigint }[]>`
          SELECT nextval('audit_log_seq_seq') AS nextval
        `
        const last = await tx.auditLog.findFirst({ orderBy: { seq: 'desc' } })
        const prevHash = last?.hash ?? GENESIS_HASH
        const createdAt = new Date()

        // A hash-t a származtatott attribúcióval EGYÜTT számítjuk, hogy a tenant/ticket/
        // conversation kötés is a lánc-fedett mezők közé kerüljön (v2 — teljes soronkénti
        // fedés a governance-döntéssel és a payload-mutatókkal együtt).
        const attribution = deriveAuditAttribution(data)

        const hash = computeAuditHashV2({
          seq,
          prevHash,
          actorType: data.actorType,
          actorId: data.actorId,
          agentVersion: data.agentVersion,
          action: data.action,
          targetType: data.targetType,
          targetId: data.targetId,
          modelUsed: data.modelUsed,
          inputRef: data.inputRef,
          outputRef: data.outputRef,
          policyDecision: data.policyDecision,
          metadata: data.metadata,
          tenantId: attribution.tenantId,
          ticketId: attribution.ticketId,
          conversationId: attribution.conversationId,
          createdAt,
        })

        return tx.auditLog.create({
          data: { ...data, ...attribution, seq, prevHash, hash, createdAt } as Prisma.AuditLogCreateInput,
        })
      },
      { timeout: 60_000 },
    )
  }

  async findMany(filter?: {
    action?: string | string[]
    actorType?: AuditLog['actorType']
    actorId?: string
    targetType?: string
    targetId?: string
    tenantId?: string
    ticketId?: string
    conversationId?: string
    since?: Date
    limit?: number
  }): Promise<AuditLog[]> {
    return prisma.auditLog.findMany({
      where: {
        ...(filter?.action
          ? { action: Array.isArray(filter.action) ? { in: filter.action } : filter.action }
          : {}),
        ...(filter?.actorType ? { actorType: filter.actorType } : {}),
        ...(filter?.actorId ? { actorId: filter.actorId } : {}),
        ...(filter?.targetType ? { targetType: filter.targetType } : {}),
        ...(filter?.targetId ? { targetId: filter.targetId } : {}),
        ...(filter?.tenantId ? { tenantId: filter.tenantId } : {}),
        ...(filter?.ticketId ? { ticketId: filter.ticketId } : {}),
        ...(filter?.conversationId ? { conversationId: filter.conversationId } : {}),
        ...(filter?.since ? { createdAt: { gte: filter.since } } : {}),
      },
      orderBy: { seq: 'desc' },
      take: filter?.limit ?? 100,
    })
  }

  async findAll(range?: { fromSeq?: bigint; toSeq?: bigint }): Promise<AuditLog[]> {
    const seqFilter: Prisma.BigIntFilter = {}
    if (range?.fromSeq !== undefined) seqFilter.gte = range.fromSeq
    if (range?.toSeq !== undefined) seqFilter.lte = range.toSeq

    return prisma.auditLog.findMany({
      where: Object.keys(seqFilter).length > 0 ? { seq: seqFilter } : undefined,
      orderBy: { seq: 'asc' },
    })
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

  /**
   * A budget-kapuk közös aggregátuma. `_count._all` a hívásszám, a token két oszlop
   * összege — DB-oldali aggregáció, hogy egy nagy forgalmú bucket se töltsön be
   * több tízezer sort minden dispatch-döntéshez.
   */
  private async sumUsage(where: Prisma.ModelCallWhereInput) {
    const agg = await prisma.modelCall.aggregate({
      where,
      _count: { _all: true },
      _sum: { promptTokens: true, completionTokens: true },
    })
    return {
      calls: agg._count._all,
      tokens: (agg._sum.promptTokens ?? 0) + (agg._sum.completionTokens ?? 0),
    }
  }

  async getUsageForAgent(agentId: string, period: ModelBudgetPeriod) {
    return this.sumUsage({ agentId, createdAt: { gte: budgetPeriodSince(period) } })
  }

  async getUsageForTenant(tenantId: string | null, period: ModelBudgetPeriod) {
    // `agent.tenantId` a bucket-kulcs: a `model_calls` táblán nincs tenant oszlop, és nem is
    // kell — a `null` ág pontosan a megosztott (platform) agenteket fogja meg.
    return this.sumUsage({
      createdAt: { gte: budgetPeriodSince(period) },
      agent: { tenantId },
    })
  }

  async getUsageForTicketType(
    tenantId: string | null,
    ticketType: TicketType,
    period: ModelBudgetPeriod,
  ) {
    return this.sumUsage({
      createdAt: { gte: budgetPeriodSince(period) },
      agent: { tenantId },
      ticket: { type: ticketType },
    })
  }

  async getUsageByAgent(tenantId: string | null, period: ModelBudgetPeriod) {
    const rows = await prisma.modelCall.groupBy({
      by: ['agentId'],
      where: { createdAt: { gte: budgetPeriodSince(period) }, agent: { tenantId } },
      _count: { _all: true },
      _sum: { promptTokens: true, completionTokens: true },
    })
    return rows.map((row) => ({
      agentId: row.agentId,
      calls: row._count._all,
      tokens: (row._sum.promptTokens ?? 0) + (row._sum.completionTokens ?? 0),
    }))
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

export class PostgresModelRoutingPolicyRepository implements ModelRoutingPolicyRepository {
  async list(filter?: { tenantId?: string; scope?: ModelRoutingScope }): Promise<ModelRoutingPolicy[]> {
    return prisma.modelRoutingPolicy.findMany({
      where: {
        ...(filter?.tenantId !== undefined ? { tenantId: filter.tenantId } : {}),
        ...(filter?.scope ? { scope: filter.scope } : {}),
      },
      orderBy: { priority: 'asc' },
    })
  }

  async findById(id: string): Promise<ModelRoutingPolicy | null> {
    return prisma.modelRoutingPolicy.findUnique({ where: { id } })
  }

  async create(data: Omit<ModelRoutingPolicy, 'id' | 'createdAt' | 'updatedAt'>): Promise<ModelRoutingPolicy> {
    return prisma.modelRoutingPolicy.create({
      data: { ...data, conditions: data.conditions ?? Prisma.JsonNull },
    })
  }

  async update(id: string, data: Partial<Omit<ModelRoutingPolicy, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ModelRoutingPolicy> {
    const { conditions, ...rest } = data
    return prisma.modelRoutingPolicy.update({
      where: { id },
      data: {
        ...rest,
        ...(conditions !== undefined ? { conditions: conditions ?? Prisma.JsonNull } : {}),
      },
    })
  }

  async delete(id: string): Promise<void> {
    await prisma.modelRoutingPolicy.delete({ where: { id } })
  }

  async findForRouting(filter: { tenantId?: string; agentId?: string; ticketType?: string }): Promise<ModelRoutingPolicy[]> {
    const scopeRefs: string[] = []
    const scopes: ModelRoutingScope[] = ['global']
    if (filter.agentId) {
      scopeRefs.push(filter.agentId)
      scopes.push('agent')
    }
    if (filter.ticketType) {
      scopeRefs.push(filter.ticketType)
      scopes.push('ticket_type')
    }

    return prisma.modelRoutingPolicy.findMany({
      where: {
        AND: [
          { scope: { in: scopes } },
          {
            OR: [
              { scope: 'global' },
              { scopeRef: { in: scopeRefs } },
            ],
          },
          ...(filter.tenantId !== undefined
            ? [{ OR: [{ tenantId: null }, { tenantId: filter.tenantId }] }]
            : []),
        ],
      },
      orderBy: { priority: 'asc' },
    })
  }
}

export class PostgresModelBudgetRepository implements ModelBudgetRepository {
  async list(filter?: { tenantId?: string; scope?: ModelBudgetScope }): Promise<ModelBudget[]> {
    return prisma.modelBudget.findMany({
      where: {
        ...(filter?.tenantId !== undefined ? { tenantId: filter.tenantId } : {}),
        ...(filter?.scope ? { scope: filter.scope } : {}),
      },
    })
  }

  async findById(id: string): Promise<ModelBudget | null> {
    return prisma.modelBudget.findUnique({ where: { id } })
  }

  async create(data: Omit<ModelBudget, 'id' | 'createdAt' | 'updatedAt'>): Promise<ModelBudget> {
    return prisma.modelBudget.create({ data })
  }

  async update(id: string, data: Partial<Omit<ModelBudget, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ModelBudget> {
    return prisma.modelBudget.update({ where: { id }, data })
  }

  async delete(id: string): Promise<void> {
    await prisma.modelBudget.delete({ where: { id } })
  }

  async findApplicable(filter: {
    tenantId?: string | null
    agentId?: string
    ticketType?: string
  }): Promise<ModelBudget[]> {
    const scopes: ModelBudgetScope[] = ['tenant']
    const scopeRefs: string[] = []
    if (filter.agentId) {
      scopes.push('agent')
      scopeRefs.push(filter.agentId)
    }
    if (filter.ticketType) {
      scopes.push('ticket_type')
      scopeRefs.push(filter.ticketType)
    }

    const rows = await prisma.modelBudget.findMany({
      where: {
        AND: [
          { scope: { in: scopes } },
          {
            OR: [
              { scope: 'tenant' },
              // `scope=agent` + `scopeRef=null` = a bucket MINDEN agentjére külön-külön érvényes
              // per-agent alapértelmezés (ez a `DISPATCH_MAX_*` env-változók DB-beli megfelelője).
              // Nélküle csak név szerint felsorolt agentekre lehetne per-agent keretet adni.
              { scope: 'agent', scopeRef: null },
              { scopeRef: { in: scopeRefs } },
            ],
          },
          ...(filter.tenantId !== undefined
            ? [{ OR: [{ tenantId: null }, { tenantId: filter.tenantId }] }]
            : []),
        ],
      },
    })

    // Most-specific first: ticket_type > agent > tenant
    const scopeOrder: Record<ModelBudgetScope, number> = { ticket_type: 0, agent: 1, tenant: 2 }
    return rows.sort((a, b) => scopeOrder[a.scope] - scopeOrder[b.scope])
  }
}
