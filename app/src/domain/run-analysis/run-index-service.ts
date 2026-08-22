/**
 * RA-03 — `run_index`: szkóp-feloldás és futás-fejlécek a Futás-elemzőnek.
 *
 * Tenant-szűrés kötelező; idegen azonosítóra ugyanaz a „nem található" hiba, mint
 * a nem létezőre (debug-trace-service mintája). A `run_analyst` agent saját futásai
 * kizártak. Felső korlát: docs/perf/github-issues/003-paginate-unbounded-lists.md.
 */
import type { PrismaClient } from '@prisma/client'
import type { AuditRepository } from '@/repositories/interfaces'
import { scoreAgentForCatalogQuery } from '@/lib/agent-catalog'
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, toListPage } from '@/lib/list-pagination'
import { RUN_ANALYST_SYSTEM_ROLE } from '@/lib/platform-agent-registry'
import type {
  RunIndexArgs,
  RunIndexCandidate,
  RunIndexGrain,
  RunIndexHeader,
  RunIndexResult,
  RunIndexScopeSummary,
} from './run-index-types'

export const RUN_INDEX_NOT_FOUND = 'run_not_found' as const

export class RunIndexNotFoundError extends Error {
  constructor() {
    super(RUN_INDEX_NOT_FOUND)
    this.name = 'RunIndexNotFoundError'
  }
}

/** Futás-jelöltek egyesítése idő szerint, felső korláttal (take+1 minta). */
export function selectRunIndexCandidates(
  candidates: RunIndexCandidate[],
  limit: number,
): { selected: RunIndexCandidate[]; truncated: boolean } {
  const byKey = new Map<string, RunIndexCandidate>()
  for (const candidate of candidates) {
    const key = `${candidate.grain}:${candidate.id}`
    const existing = byKey.get(key)
    if (!existing || candidate.startedAt > existing.startedAt) {
      byKey.set(key, candidate)
    }
  }
  const sorted = [...byKey.values()].sort(
    (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
  )
  const page = toListPage(sorted, limit, 0)
  return { selected: page.items, truncated: page.hasMore }
}

function parseIsoDate(value: string | undefined, label: string): Date | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new Error(`invalid_${label}`)
  return new Date(parsed)
}

function resolveLimit(raw: number | undefined): number {
  const n = raw ?? DEFAULT_LIST_LIMIT
  return Math.min(Math.max(1, n), MAX_LIST_LIMIT)
}

function runAnalystExclusionAgentIds(runAnalystIds: string[]) {
  if (runAnalystIds.length === 0) return {}
  return { agentId: { notIn: runAnalystIds } }
}

type TokenAgg = {
  promptTokens: number
  completionTokens: number
  cachedPromptTokens: number
  costEstimate: number
}

export class RunIndexService {
  constructor(
    private prisma: PrismaClient,
    private audit: AuditRepository,
  ) {}

  private async runAnalystAgentIds(tenantId: string): Promise<string[]> {
    const rows = await this.prisma.agent.findMany({
      where: { tenantId, systemRole: RUN_ANALYST_SYSTEM_ROLE },
      select: { id: true },
    })
    return rows.map((row) => row.id)
  }

  async query(input: {
    tenantId: string
    requesterAgentId: string
    requesterAgentVersion: number
    actingUserId: string | null
    args: RunIndexArgs
  }): Promise<RunIndexResult> {
    const tenantId = input.tenantId
    const args = input.args
    const limit = resolveLimit(args.limit)
    const since = parseIsoDate(args.since, 'since')
    const until = parseIsoDate(args.until, 'until')

    const scope: RunIndexScopeSummary = {
      agentId: args.agentId ?? null,
      agentQuery: args.agentQuery?.trim() || null,
      conversationId: args.conversationId ?? null,
      ticketId: args.ticketId ?? null,
      processInstanceId: args.processInstanceId ?? null,
      playbookVersionId: args.playbookVersionId ?? null,
      since: since?.toISOString() ?? null,
      until: until?.toISOString() ?? null,
    }

    const runAnalystIds = await this.runAnalystAgentIds(tenantId)

    const agentId = await this.resolveAgentId(tenantId, args, runAnalystIds)
    if (agentId) scope.agentId = agentId

    await this.validateScopeAnchors(tenantId, args)

    const explicit =
      (args.agentTurnIds?.length ?? 0) > 0 ||
      (args.ticketIds?.length ?? 0) > 0 ||
      (args.processInstanceIds?.length ?? 0) > 0

    let selected: RunIndexCandidate[]
    let truncated: boolean

    if (explicit) {
      const candidates = await this.loadExplicitCandidates(tenantId, args, runAnalystIds)
      const page = selectRunIndexCandidates(candidates, limit)
      selected = page.selected
      truncated = page.truncated
    } else {
      const candidates = await this.discoverCandidates(tenantId, runAnalystIds, {
        agentId,
        conversationId: args.conversationId,
        ticketId: args.ticketId,
        processInstanceId: args.processInstanceId,
        playbookVersionId: args.playbookVersionId,
        since,
        until,
        fetchLimit: limit + 1,
      })
      const page = selectRunIndexCandidates(candidates, limit)
      selected = page.selected
      truncated = page.truncated
    }

    const runs = await this.buildHeaders(tenantId, selected)

    const result: RunIndexResult = {
      runs,
      returnedCount: runs.length,
      limit,
      truncated,
      scope,
    }

    await this.audit.append({
      actorType: 'agent',
      actorId: input.requesterAgentId,
      agentVersion: input.requesterAgentVersion,
      action: 'analysis.run_index',
      targetType: 'tenant',
      targetId: tenantId,
      tenantId,
      modelUsed: null,
      inputRef: null,
      outputRef: String(result.returnedCount),
      policyDecision: 'allowed',
      metadata: {
        scope,
        returnedCount: result.returnedCount,
        truncated: result.truncated,
        limit: result.limit,
      },
    })

    return result
  }

  private async resolveAgentId(
    tenantId: string,
    args: RunIndexArgs,
    runAnalystIds: string[],
  ): Promise<string | undefined> {
    if (args.agentId) {
      const agent = await this.prisma.agent.findUnique({
        where: { id: args.agentId },
        select: { id: true, tenantId: true },
      })
      if (!agent || agent.tenantId !== tenantId) throw new RunIndexNotFoundError()
      if (runAnalystIds.includes(agent.id)) throw new RunIndexNotFoundError()
      return agent.id
    }
    const query = args.agentQuery?.trim()
    if (!query) return undefined

    const agents = await this.prisma.agent.findMany({
      where: {
        tenantId,
        id: runAnalystIds.length ? { notIn: runAnalystIds } : undefined,
      },
      select: {
        id: true,
        name: true,
        roleInstruction: true,
        status: true,
        personaNickname: true,
        personaGreeting: true,
        personaTrait: true,
      },
    })
    const scored = agents
      .map((agent) => ({ agent, score: scoreAgentForCatalogQuery(agent, query) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
    if (scored.length === 0) throw new RunIndexNotFoundError()
    return scored[0]!.agent.id
  }

  private async validateScopeAnchors(tenantId: string, args: RunIndexArgs): Promise<void> {
    const checks: Promise<unknown>[] = []
    if (args.conversationId) {
      checks.push(
        this.prisma.conversation.findUnique({
          where: { id: args.conversationId },
          select: { tenantId: true },
        }).then((row) => {
          if (!row || row.tenantId !== tenantId) throw new RunIndexNotFoundError()
        }),
      )
    }
    if (args.ticketId) {
      checks.push(
        this.prisma.ticket.findUnique({
          where: { id: args.ticketId },
          select: { tenantId: true },
        }).then((row) => {
          if (!row || row.tenantId !== tenantId) throw new RunIndexNotFoundError()
        }),
      )
    }
    if (args.processInstanceId) {
      checks.push(
        this.prisma.processInstance.findUnique({
          where: { id: args.processInstanceId },
          select: { tenantId: true },
        }).then((row) => {
          if (!row || row.tenantId !== tenantId) throw new RunIndexNotFoundError()
        }),
      )
    }
    if (args.playbookVersionId) {
      checks.push(
        this.prisma.playbookVersionV2.findUnique({
          where: { id: args.playbookVersionId },
          select: { tenantId: true },
        }).then((row) => {
          if (!row || row.tenantId !== tenantId) throw new RunIndexNotFoundError()
        }),
      )
    }
    await Promise.all(checks)
  }

  private async loadExplicitCandidates(
    tenantId: string,
    args: RunIndexArgs,
    runAnalystIds: string[],
  ): Promise<RunIndexCandidate[]> {
    const candidates: RunIndexCandidate[] = []
    const analystFilter = runAnalystExclusionAgentIds(runAnalystIds)

    if (args.agentTurnIds?.length) {
      const turns = await this.prisma.agentTurn.findMany({
        where: {
          id: { in: args.agentTurnIds },
          tenantId,
          ...analystFilter,
        },
        select: { id: true, startedAt: true },
      })
      if (turns.length !== args.agentTurnIds.length) throw new RunIndexNotFoundError()
      for (const turn of turns) {
        candidates.push({ grain: 'turn', id: turn.id, startedAt: turn.startedAt })
      }
    }

    if (args.ticketIds?.length) {
      const tickets = await this.prisma.ticket.findMany({
        where: {
          id: { in: args.ticketIds },
          tenantId,
          ...analystFilter,
        },
        select: { id: true, createdAt: true, updatedAt: true },
      })
      if (tickets.length !== args.ticketIds.length) throw new RunIndexNotFoundError()
      for (const ticket of tickets) {
        candidates.push({
          grain: 'ticket',
          id: ticket.id,
          startedAt: ticket.createdAt,
        })
      }
    }

    if (args.processInstanceIds?.length) {
      const processes = await this.prisma.processInstance.findMany({
        where: { id: { in: args.processInstanceIds }, tenantId },
        select: { id: true, startedAt: true },
      })
      if (processes.length !== args.processInstanceIds.length) throw new RunIndexNotFoundError()
      for (const process of processes) {
        candidates.push({ grain: 'process', id: process.id, startedAt: process.startedAt })
      }
    }

    return candidates
  }

  private async discoverCandidates(
    tenantId: string,
    runAnalystIds: string[],
    filters: {
      agentId?: string
      conversationId?: string
      ticketId?: string
      processInstanceId?: string
      playbookVersionId?: string
      since?: Date
      until?: Date
      fetchLimit: number
    },
  ): Promise<RunIndexCandidate[]> {
    const timeFilter =
      filters.since || filters.until
        ? {
            ...(filters.since ? { gte: filters.since } : {}),
            ...(filters.until ? { lte: filters.until } : {}),
          }
        : undefined

    const analystFilter = runAnalystExclusionAgentIds(runAnalystIds)

    const turnWhere = {
      tenantId,
      ...analystFilter,
      ...(filters.agentId ? { agentId: filters.agentId } : {}),
      ...(filters.conversationId ? { conversationId: filters.conversationId } : {}),
      ...(timeFilter ? { startedAt: timeFilter } : {}),
    }

    const ticketWhere = {
      tenantId,
      ...analystFilter,
      ...(filters.agentId ? { agentId: filters.agentId } : {}),
      ...(filters.conversationId ? { conversationId: filters.conversationId } : {}),
      ...(filters.ticketId ? { id: filters.ticketId } : {}),
      ...(timeFilter ? { createdAt: timeFilter } : {}),
    }

    const processWhere = {
      tenantId,
      ...(filters.processInstanceId ? { id: filters.processInstanceId } : {}),
      ...(filters.playbookVersionId ? { playbookVersionId: filters.playbookVersionId } : {}),
      ...(timeFilter ? { startedAt: timeFilter } : {}),
    }

    const take = filters.fetchLimit

    const processOnlyScope =
      Boolean(filters.processInstanceId || filters.playbookVersionId) &&
      !filters.agentId &&
      !filters.conversationId &&
      !filters.ticketId

    const [turns, tickets, processes] = await Promise.all([
      processOnlyScope
        ? Promise.resolve([])
        : this.prisma.agentTurn.findMany({
            where: turnWhere,
            select: { id: true, startedAt: true },
            orderBy: { startedAt: 'desc' },
            take,
          }),
      filters.ticketId || filters.agentId || filters.conversationId
        ? this.prisma.ticket.findMany({
            where: ticketWhere,
            select: { id: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take,
          })
        : Promise.resolve([]),
      filters.processInstanceId || filters.playbookVersionId
        ? this.prisma.processInstance.findMany({
            where: processWhere,
            select: { id: true, startedAt: true },
            orderBy: { startedAt: 'desc' },
            take,
          })
        : Promise.resolve([]),
    ])

    const candidates: RunIndexCandidate[] = []
    for (const turn of turns) {
      candidates.push({ grain: 'turn', id: turn.id, startedAt: turn.startedAt })
    }
    for (const ticket of tickets) {
      candidates.push({ grain: 'ticket', id: ticket.id, startedAt: ticket.createdAt })
    }
    for (const process of processes) {
      candidates.push({ grain: 'process', id: process.id, startedAt: process.startedAt })
    }
    return candidates
  }

  private async buildHeaders(
    tenantId: string,
    selected: RunIndexCandidate[],
  ): Promise<RunIndexHeader[]> {
    const turnIds = selected.filter((s) => s.grain === 'turn').map((s) => s.id)
    const ticketIds = selected.filter((s) => s.grain === 'ticket').map((s) => s.id)
    const processIds = selected.filter((s) => s.grain === 'process').map((s) => s.id)

    const [turns, tickets, processes] = await Promise.all([
      turnIds.length
        ? this.prisma.agentTurn.findMany({
            where: { id: { in: turnIds }, tenantId },
          })
        : Promise.resolve([]),
      ticketIds.length
        ? this.prisma.ticket.findMany({
            where: { id: { in: ticketIds }, tenantId },
          })
        : Promise.resolve([]),
      processIds.length
        ? this.prisma.processInstance.findMany({
            where: { id: { in: processIds }, tenantId },
            include: {
              steps: { select: { status: true } },
            },
          })
        : Promise.resolve([]),
    ])

    const agentIds = [
      ...turns.map((t) => t.agentId),
      ...tickets.map((t) => t.agentId).filter((id): id is string => Boolean(id)),
      ...processes.map((p) => p.startedByAgentId).filter((id): id is string => Boolean(id)),
    ]
    const agentRows =
      agentIds.length > 0
        ? await this.prisma.agent.findMany({
            where: { id: { in: [...new Set(agentIds)] } },
            select: { id: true, name: true },
          })
        : []
    const agentNameById = new Map(agentRows.map((a) => [a.id, a.name]))

    const turnMap = new Map(turns.map((t) => [t.id, t]))
    const ticketMap = new Map(tickets.map((t) => [t.id, t]))
    const processMap = new Map(processes.map((p) => [p.id, p]))

    const [turnTokens, ticketTokens, processTokens] = await Promise.all([
      turnIds.length
        ? this.prisma.modelCall.findMany({
            where: { agentTurnId: { in: turnIds } },
            select: {
              agentTurnId: true,
              promptTokens: true,
              completionTokens: true,
              cachedPromptTokens: true,
              costEstimate: true,
            },
          })
        : Promise.resolve([]),
      ticketIds.length
        ? this.prisma.modelCall.findMany({
            where: { ticketId: { in: ticketIds } },
            select: {
              ticketId: true,
              promptTokens: true,
              completionTokens: true,
              cachedPromptTokens: true,
              costEstimate: true,
            },
          })
        : Promise.resolve([]),
      processIds.length
        ? this.prisma.ticket.findMany({
            where: { processInstanceId: { in: processIds } },
            select: { processInstanceId: true, id: true },
          }).then(async (procTickets) => {
            const ids = procTickets.map((t) => t.id)
            if (!ids.length) return []
            return this.prisma.modelCall.findMany({
              where: { ticketId: { in: ids } },
              select: {
                ticketId: true,
                promptTokens: true,
                completionTokens: true,
                cachedPromptTokens: true,
                costEstimate: true,
              },
            })
          })
        : Promise.resolve([]),
    ])

    const tokensByTurn = new Map<string, TokenAgg>()
    for (const row of turnTokens) {
      if (!row.agentTurnId) continue
      const prev = tokensByTurn.get(row.agentTurnId) ?? {
        promptTokens: 0,
        completionTokens: 0,
        cachedPromptTokens: 0,
        costEstimate: 0,
      }
      tokensByTurn.set(row.agentTurnId, {
        promptTokens: prev.promptTokens + row.promptTokens,
        completionTokens: prev.completionTokens + row.completionTokens,
        cachedPromptTokens: prev.cachedPromptTokens + (row.cachedPromptTokens ?? 0),
        costEstimate: prev.costEstimate + Number(row.costEstimate),
      })
    }

    const tokensByTicket = new Map<string, TokenAgg>()
    for (const row of ticketTokens) {
      if (!row.ticketId) continue
      const prev = tokensByTicket.get(row.ticketId) ?? {
        promptTokens: 0,
        completionTokens: 0,
        cachedPromptTokens: 0,
        costEstimate: 0,
      }
      tokensByTicket.set(row.ticketId, {
        promptTokens: prev.promptTokens + row.promptTokens,
        completionTokens: prev.completionTokens + row.completionTokens,
        cachedPromptTokens: prev.cachedPromptTokens + (row.cachedPromptTokens ?? 0),
        costEstimate: prev.costEstimate + Number(row.costEstimate),
      })
    }

    const processTicketIds = processIds.length
      ? (
          await this.prisma.ticket.findMany({
            where: { processInstanceId: { in: processIds } },
            select: { id: true, processInstanceId: true },
          })
        ).reduce<Map<string, string[]>>((acc, row) => {
          if (!row.processInstanceId) return acc
          const list = acc.get(row.processInstanceId) ?? []
          list.push(row.id)
          acc.set(row.processInstanceId, list)
          return acc
        }, new Map())
      : new Map<string, string[]>()

    const tokensByProcess = new Map<string, TokenAgg>()
    for (const row of processTokens) {
      if (!row.ticketId) continue
      for (const [processId, tids] of processTicketIds) {
        if (!tids.includes(row.ticketId)) continue
        const prev = tokensByProcess.get(processId) ?? {
          promptTokens: 0,
          completionTokens: 0,
          cachedPromptTokens: 0,
          costEstimate: 0,
        }
        tokensByProcess.set(processId, {
          promptTokens: prev.promptTokens + row.promptTokens,
          completionTokens: prev.completionTokens + row.completionTokens,
          cachedPromptTokens: prev.cachedPromptTokens + (row.cachedPromptTokens ?? 0),
          costEstimate: prev.costEstimate + Number(row.costEstimate),
        })
      }
    }

    const toolCountsByTurn = turnIds.length
      ? await this.prisma.toolCall.groupBy({
          by: ['agentTurnId'],
          where: { agentTurnId: { in: turnIds } },
          _count: { _all: true },
        })
      : []
    const toolCountsByTicket = ticketIds.length
      ? await this.prisma.toolCall.groupBy({
          by: ['ticketId'],
          where: { ticketId: { in: ticketIds } },
          _count: { _all: true },
        })
      : []

    const toolCountTurnMap = new Map(
      toolCountsByTurn.map((r) => [r.agentTurnId, r._count._all]),
    )
    const toolCountTicketMap = new Map(
      toolCountsByTicket.map((r) => [r.ticketId, r._count._all]),
    )

    const headers: RunIndexHeader[] = []
    for (const candidate of selected) {
      if (candidate.grain === 'turn') {
        const turn = turnMap.get(candidate.id)
        if (!turn) continue
        headers.push(
          this.headerForTurn(
            turn,
            agentNameById.get(turn.agentId) ?? '',
            tokensByTurn.get(candidate.id),
            toolCountTurnMap.get(candidate.id) ?? 0,
          ),
        )
        continue
      }
      if (candidate.grain === 'ticket') {
        const ticket = ticketMap.get(candidate.id)
        if (!ticket) continue
        headers.push(
          this.headerForTicket(
            ticket,
            ticket.agentId ? agentNameById.get(ticket.agentId) ?? '' : '',
            tokensByTicket.get(candidate.id),
            toolCountTicketMap.get(candidate.id) ?? 0,
          ),
        )
        continue
      }
      const process = processMap.get(candidate.id)
      if (!process) continue
      headers.push(
        this.headerForProcess(
          process,
          process.startedByAgentId
            ? agentNameById.get(process.startedByAgentId) ?? ''
            : '',
          tokensByProcess.get(candidate.id),
          toolCountTicketMap,
          processTicketIds.get(candidate.id) ?? [],
        ),
      )
    }
    return headers
  }

  private headerForTurn(
    turn: {
      id: string
      agentId: string
      conversationId: string
      status: string
      startedAt: Date
      finishedAt: Date | null
      turnCount: number
      toolCallCount: number
      deniedCount: number
      reason: string | null
      error: string | null
    },
    agentName: string,
    tokens: TokenAgg | undefined,
    toolCallCountFromDb: number,
  ): RunIndexHeader {
    return {
      runId: turn.id,
      grain: 'turn',
      agentId: turn.agentId,
      agentName,
      startedAt: turn.startedAt.toISOString(),
      finishedAt: turn.finishedAt?.toISOString() ?? null,
      conversationId: turn.conversationId,
      ticketId: null,
      processInstanceId: null,
      turnCount: turn.turnCount,
      toolCallCount: Math.max(turn.toolCallCount, toolCallCountFromDb),
      deniedCount: turn.deniedCount,
      promptTokens: tokens?.promptTokens ?? 0,
      completionTokens: tokens?.completionTokens ?? 0,
      cachedPromptTokens: tokens?.cachedPromptTokens ?? 0,
      costEstimate: tokens?.costEstimate ?? 0,
      status: turn.status,
      stopReason: turn.error ?? turn.reason ?? null,
    }
  }

  private headerForTicket(
    ticket: {
      id: string
      agentId: string | null
      conversationId: string | null
      processInstanceId: string | null
      state: string
      createdAt: Date
      updatedAt: Date
    },
    agentName: string,
    tokens: TokenAgg | undefined,
    toolCallCountFromDb: number,
  ): RunIndexHeader {
    return {
      runId: ticket.id,
      grain: 'ticket',
      agentId: ticket.agentId ?? '',
      agentName,
      startedAt: ticket.createdAt.toISOString(),
      finishedAt: ticket.updatedAt.toISOString(),
      conversationId: ticket.conversationId,
      ticketId: ticket.id,
      processInstanceId: ticket.processInstanceId,
      turnCount: 0,
      toolCallCount: toolCallCountFromDb,
      deniedCount: 0,
      promptTokens: tokens?.promptTokens ?? 0,
      completionTokens: tokens?.completionTokens ?? 0,
      cachedPromptTokens: tokens?.cachedPromptTokens ?? 0,
      costEstimate: tokens?.costEstimate ?? 0,
      status: ticket.state,
      stopReason: ticket.state,
    }
  }

  private headerForProcess(
    process: {
      id: string
      status: string
      startedAt: Date
      completedAt: Date | null
      failedAt: Date | null
      startedByAgentId: string | null
      steps: Array<{ status: string }>
    },
    agentName: string,
    tokens: TokenAgg | undefined,
    toolCountTicketMap: Map<string | null, number>,
    ticketIds: string[],
  ): RunIndexHeader {
    let toolCallCount = 0
    for (const tid of ticketIds) {
      toolCallCount += toolCountTicketMap.get(tid) ?? 0
    }
    const finishedAt = process.completedAt ?? process.failedAt
    return {
      runId: process.id,
      grain: 'process',
      agentId: process.startedByAgentId ?? '',
      agentName,
      startedAt: process.startedAt.toISOString(),
      finishedAt: finishedAt?.toISOString() ?? null,
      conversationId: null,
      ticketId: null,
      processInstanceId: process.id,
      turnCount: process.steps.length,
      toolCallCount,
      deniedCount: 0,
      promptTokens: tokens?.promptTokens ?? 0,
      completionTokens: tokens?.completionTokens ?? 0,
      cachedPromptTokens: tokens?.cachedPromptTokens ?? 0,
      costEstimate: tokens?.costEstimate ?? 0,
      status: process.status,
      stopReason: process.status,
    }
  }
}

export type { RunIndexGrain }
