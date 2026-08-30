/**
 * RA-06 — `run_stats`: eszköz × kimenetel mátrix és futás-aggregátumok.
 *
 * Tenant-szűrés és önelemzés-kizárás RA-03 szerint; DB-oldali aggregáció
 * felső korláttal (docs/perf/github-issues/003-paginate-unbounded-lists.md).
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuditRepository } from '@/repositories/interfaces'
import { toolCallSourceKey } from '@/domain/agent/loop-stop-decision'
import type { RunIndexCandidate } from './run-index-types'
import {
  appendRunAnalysisAudit,
  buildScopedCallFilter,
  loadProcessTicketIndex,
  type RunAnalysisRequester,
} from './run-scope'
import { RunIndexService } from './run-index-service'
import type {
  RunStatsArgs,
  RunStatsDenialReason,
  RunStatsLatencyRow,
  RunStatsOutcomeLabel,
  RunStatsPromptCache,
  RunStatsRepeatedSourceKey,
  RunStatsResult,
  RunStatsSkillLoad,
  RunStatsToolOutcomeRow,
} from './run-stats-types'

export {
  RUN_INDEX_NOT_FOUND as RUN_STATS_NOT_FOUND,
  RunIndexNotFoundError as RunStatsNotFoundError,
} from './run-index-service'

/** Forrás-kulcs mintavétel felső korlátja (ismétlődő olvasások). */
export const MAX_STATS_SOURCE_KEY_SAMPLE = 5_000
/** Latencia-mintavétel felső korlátja. */
export const MAX_STATS_LATENCY_SAMPLE = 10_000
/** Skill-audit sorok max. száma a szkópra. */
export const MAX_STATS_SKILL_AUDIT_ROWS = 500
/** Visszaadott ismétlődő forrás-kulcsok max. száma. */
export const MAX_STATS_REPEATED_KEYS = 100

const SKILL_AUDIT_ACTIONS = [
  'skill.loaded',
  'skill.attachment_loaded',
  'skill.run_snapshot',
] as const

type ToolCallAggRow = {
  toolName: string
  status: string
  outcome: string | null
}

type SourceKeyToolRow = {
  agentTurnId: string | null
  ticketId: string | null
  toolName: string
  argsMeta: unknown
  resultMeta: unknown
  createdAt: Date
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function boolField(record: Record<string, unknown> | null, key: string): boolean {
  return record?.[key] === true
}

/** Eszközhívás mátrix-címke: `denied` státusz külön kategória. */
export function matrixOutcomeLabel(status: string, outcome: string | null): RunStatsOutcomeLabel {
  if (status === 'denied') return 'denied'
  if (outcome === 'ok' || outcome === 'empty' || outcome === 'partial' || outcome === 'failed') {
    return outcome
  }
  return 'unknown'
}

export function buildToolOutcomeMatrix(rows: ToolCallAggRow[]): RunStatsToolOutcomeRow[] {
  const byTool = new Map<string, Map<RunStatsOutcomeLabel, number>>()
  for (const row of rows) {
    const label = matrixOutcomeLabel(row.status, row.outcome)
    const toolMap = byTool.get(row.toolName) ?? new Map<RunStatsOutcomeLabel, number>()
    toolMap.set(label, (toolMap.get(label) ?? 0) + 1)
    byTool.set(row.toolName, toolMap)
  }
  return finalizeToolOutcomeMatrix(byTool)
}

export function buildToolOutcomeMatrixFromGroups(
  groups: Array<{ toolName: string; status: string; outcome: string | null; count: number }>,
): RunStatsToolOutcomeRow[] {
  const byTool = new Map<string, Map<RunStatsOutcomeLabel, number>>()
  for (const row of groups) {
    const label = matrixOutcomeLabel(row.status, row.outcome)
    const toolMap = byTool.get(row.toolName) ?? new Map<RunStatsOutcomeLabel, number>()
    toolMap.set(label, (toolMap.get(label) ?? 0) + row.count)
    byTool.set(row.toolName, toolMap)
  }
  return finalizeToolOutcomeMatrix(byTool)
}

function finalizeToolOutcomeMatrix(
  byTool: Map<string, Map<RunStatsOutcomeLabel, number>>,
): RunStatsToolOutcomeRow[] {
  const result: RunStatsToolOutcomeRow[] = []
  for (const [toolName, outcomes] of byTool) {
    const totalCalls = [...outcomes.values()].reduce((sum, n) => sum + n, 0)
    const cells = [...outcomes.entries()]
      .map(([outcome, count]) => ({
        outcome,
        count,
        ratio: totalCalls > 0 ? count / totalCalls : 0,
      }))
      .sort((a, b) => b.count - a.count || a.outcome.localeCompare(b.outcome))
    result.push({ toolName, totalCalls, outcomes: cells })
  }
  return result.sort((a, b) => b.totalCalls - a.totalCalls || a.toolName.localeCompare(b.toolName))
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]!
  const idx = (sorted.length - 1) * p
  const lower = Math.floor(idx)
  const upper = Math.ceil(idx)
  if (lower === upper) return sorted[lower]!
  const weight = idx - lower
  return Math.round(sorted[lower]! * (1 - weight) + sorted[upper]! * weight)
}

export function buildLatencyByTool(
  rows: Array<{ toolName: string; latencyMs: number }>,
): RunStatsLatencyRow[] {
  const byTool = new Map<string, number[]>()
  for (const row of rows) {
    const list = byTool.get(row.toolName) ?? []
    list.push(row.latencyMs)
    byTool.set(row.toolName, list)
  }

  const result: RunStatsLatencyRow[] = []
  for (const [toolName, values] of byTool) {
    const sorted = [...values].sort((a, b) => a - b)
    const count = sorted.length
    const sum = sorted.reduce((acc, n) => acc + n, 0)
    result.push({
      toolName,
      count,
      minMs: sorted[0] ?? 0,
      maxMs: sorted[count - 1] ?? 0,
      avgMs: count > 0 ? Math.round(sum / count) : 0,
      p50Ms: percentile(sorted, 0.5),
      p90Ms: percentile(sorted, 0.9),
    })
  }
  return result.sort((a, b) => b.count - a.count || a.toolName.localeCompare(b.toolName))
}

function sourceKeyOf(toolName: string, argsMeta: unknown): string | null {
  const args = asRecord(argsMeta)
  const tagged = args?.source_key
  if (typeof tagged === 'string' && tagged.trim()) return tagged.trim()
  return toolCallSourceKey(toolName, args ?? undefined)
}

function isReaderCall(toolName: string, argsMeta: unknown): boolean {
  if (toolName === 'tool_result_read') return true
  return sourceKeyOf(toolName, argsMeta) !== null
}

function runBucketKey(row: { agentTurnId: string | null; ticketId: string | null }): string {
  if (row.agentTurnId) return `turn:${row.agentTurnId}`
  if (row.ticketId) return `ticket:${row.ticketId}`
  return 'unknown'
}

/** Futásonkénti forrás-kulcs újraolvasások, majd szkóp-szintű összesítés. */
export function computeRepeatedSourceKeys(rows: SourceKeyToolRow[]): {
  keys: RunStatsRepeatedSourceKey[]
  truncated: boolean
} {
  const byRun = new Map<string, SourceKeyToolRow[]>()
  for (const row of rows) {
    const key = runBucketKey(row)
    const list = byRun.get(key) ?? []
    list.push(row)
    byRun.set(key, list)
  }

  const aggregated = new Map<
    string,
    { toolName: string; sourceKey: string; readCount: number; rereadCount: number; runCount: number }
  >()

  for (const runRows of byRun.values()) {
    const sorted = [...runRows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    const seen = new Map<string, number>()
    const touchedInRun = new Set<string>()

    for (const row of sorted) {
      if (!isReaderCall(row.toolName, row.argsMeta)) continue
      const sourceKey = sourceKeyOf(row.toolName, row.argsMeta)
      if (!sourceKey) continue

      const aggKey = `${row.toolName}\0${sourceKey}`
      const existing = aggregated.get(aggKey) ?? {
        toolName: row.toolName,
        sourceKey,
        readCount: 0,
        rereadCount: 0,
        runCount: 0,
      }
      existing.readCount += 1

      const result = asRecord(row.resultMeta)
      const flagged =
        row.toolName === 'tool_result_read' &&
        (boolField(result, 'redundant') || boolField(result, 'blocked'))
      const prior = seen.get(sourceKey) ?? 0
      seen.set(sourceKey, prior + 1)
      if (flagged || prior >= 1) existing.rereadCount += 1

      if (!touchedInRun.has(aggKey)) {
        existing.runCount += 1
        touchedInRun.add(aggKey)
      }
      aggregated.set(aggKey, existing)
    }
  }

  const keys = [...aggregated.values()]
    .filter((row) => row.rereadCount > 0 || row.readCount > 1)
    .map((row) => ({
      sourceKey: row.sourceKey,
      toolName: row.toolName,
      readCount: row.readCount,
      rereadCount: row.rereadCount,
      runCount: row.runCount,
    }))
    .sort(
      (a, b) =>
        b.rereadCount - a.rereadCount ||
        b.readCount - a.readCount ||
        a.sourceKey.localeCompare(b.sourceKey),
    )

  const truncated = keys.length > MAX_STATS_REPEATED_KEYS
  return { keys: keys.slice(0, MAX_STATS_REPEATED_KEYS), truncated }
}

export const EMPTY_PROMPT_CACHE: RunStatsPromptCache = {
  measuredCalls: 0,
  unmeasuredCalls: 0,
  promptTokens: 0,
  cachedPromptTokens: 0,
  hitRatio: null,
}

/**
 * Cache-találati arány a MÉRT hívásokból. Csak összegekből dolgozik, hogy a
 * hívó DB-oldali aggregátumot adhasson át — a modellhívás-sorokat sosem töltjük be.
 */
export function buildPromptCacheStats(totals: {
  measuredCalls: number
  unmeasuredCalls: number
  promptTokens: number
  cachedPromptTokens: number
}): RunStatsPromptCache {
  const { measuredCalls, unmeasuredCalls, promptTokens, cachedPromptTokens } = totals
  return {
    measuredCalls,
    unmeasuredCalls,
    promptTokens,
    cachedPromptTokens,
    hitRatio:
      measuredCalls > 0 && promptTokens > 0 ? cachedPromptTokens / promptTokens : measuredCalls > 0 ? 0 : null,
  }
}

export class RunStatsService {
  constructor(
    private prisma: PrismaClient,
    private audit: AuditRepository,
    private runIndexService: RunIndexService,
  ) {}

  async query(input: RunAnalysisRequester & { args: RunStatsArgs }): Promise<RunStatsResult> {
    const { tenantId, args } = input
    const { scope, candidates, limit, truncated } = await this.runIndexService.resolveScope({
      tenantId,
      args,
    })

    const scopeIds = await this.resolveScopeIds(tenantId, candidates)
    const scopeFilter = buildScopedCallFilter(scopeIds)
    const toolWhere: Prisma.ToolCallWhereInput | null = scopeFilter
    const modelWhere: Prisma.ModelCallWhereInput | null = scopeFilter
    const truncatedResult = truncated || scopeIds.processTicketIndexTruncated

    const emptyResult = (): RunStatsResult => ({
      scope,
      runCount: candidates.length,
      limit,
      truncated: truncatedResult,
      toolOutcomeMatrix: [],
      latencyByTool: [],
      latencyByToolTruncated: false,
      promptCache: {
        measuredCalls: 0,
        unmeasuredCalls: 0,
        promptTokens: 0,
        cachedPromptTokens: 0,
        hitRatio: null,
      },
      repeatedSourceKeys: [],
      repeatedSourceKeysTruncated: false,
      denialReasons: [],
      skillLoads: [],
      totals: { toolCallCount: 0, modelCallCount: 0 },
    })

    if (!toolWhere && !modelWhere) {
      const result = emptyResult()
      await this.auditQuery(input, result)
      return result
    }

    const [
      matrixRows,
      latencySample,
      sourceKeySample,
      denialGroups,
      promptCache,
      toolCallTotal,
      modelCallTotal,
      skillAuditRows,
    ] = await Promise.all([
      toolWhere
        ? this.prisma.toolCall.groupBy({
            by: ['toolName', 'outcome', 'status'],
            where: { agent: { tenantId }, ...toolWhere },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      toolWhere
        ? this.prisma.toolCall.findMany({
            where: { agent: { tenantId }, ...toolWhere },
            select: { toolName: true, latencyMs: true },
            orderBy: { createdAt: 'asc' },
            take: MAX_STATS_LATENCY_SAMPLE + 1,
          })
        : Promise.resolve([]),
      toolWhere
        ? this.prisma.toolCall.findMany({
            where: { agent: { tenantId }, ...toolWhere },
            select: {
              agentTurnId: true,
              ticketId: true,
              toolName: true,
              argsMeta: true,
              resultMeta: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'asc' },
            take: MAX_STATS_SOURCE_KEY_SAMPLE + 1,
          })
        : Promise.resolve([]),
      toolWhere
        ? this.prisma.toolCall.groupBy({
            by: ['policyDecision'],
            where: { agent: { tenantId }, status: 'denied', ...toolWhere },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      modelWhere
        ? this.loadPromptCacheStats(tenantId, modelWhere)
        : Promise.resolve(EMPTY_PROMPT_CACHE),
      toolWhere
        ? this.prisma.toolCall.count({ where: { agent: { tenantId }, ...toolWhere } })
        : Promise.resolve(0),
      modelWhere
        ? this.prisma.modelCall.count({ where: { agent: { tenantId }, ...modelWhere } })
        : Promise.resolve(0),
      this.loadSkillAuditRows(tenantId, scopeIds),
    ])

    const toolOutcomeMatrix = buildToolOutcomeMatrixFromGroups(
      matrixRows.map((row) => ({
        toolName: row.toolName,
        status: row.status,
        outcome: row.outcome,
        count: row._count._all,
      })),
    )

    const latencyTruncated = latencySample.length > MAX_STATS_LATENCY_SAMPLE
    const latencyRows = latencyTruncated
      ? latencySample.slice(0, MAX_STATS_LATENCY_SAMPLE)
      : latencySample

    const sourceKeyTruncated = sourceKeySample.length > MAX_STATS_SOURCE_KEY_SAMPLE
    const sourceKeyRows = sourceKeyTruncated
      ? sourceKeySample.slice(0, MAX_STATS_SOURCE_KEY_SAMPLE)
      : sourceKeySample

    const { keys: repeatedSourceKeys, truncated: repeatedKeysTruncated } =
      computeRepeatedSourceKeys(sourceKeyRows)

    const denialReasons: RunStatsDenialReason[] = denialGroups
      .map((row) => ({
        policyDecision: row.policyDecision ?? 'unknown',
        count: row._count._all,
      }))
      .sort((a, b) => b.count - a.count || a.policyDecision.localeCompare(b.policyDecision))

    const skillLoads = this.aggregateSkillLoads(skillAuditRows)

    const result: RunStatsResult = {
      scope,
      runCount: candidates.length,
      limit,
      truncated: truncatedResult,
      toolOutcomeMatrix,
      latencyByTool: buildLatencyByTool(latencyRows),
      latencyByToolTruncated: latencyTruncated,
      promptCache,
      repeatedSourceKeys,
      repeatedSourceKeysTruncated: sourceKeyTruncated || repeatedKeysTruncated,
      denialReasons,
      skillLoads,
      totals: {
        toolCallCount: toolCallTotal,
        modelCallCount: modelCallTotal,
      },
    }

    await this.auditQuery(input, result)
    return result
  }

  /** Cache-arány DB-oldali aggregációval: mért hívások összegei + mérettelenek darabszáma. */
  private async loadPromptCacheStats(
    tenantId: string,
    modelWhere: Prisma.ModelCallWhereInput,
  ): Promise<RunStatsPromptCache> {
    const where = { agent: { tenantId }, ...modelWhere }
    const [measured, unmeasuredCalls] = await Promise.all([
      this.prisma.modelCall.aggregate({
        where: { ...where, cachedPromptTokens: { not: null } },
        _count: { _all: true },
        _sum: { promptTokens: true, cachedPromptTokens: true },
      }),
      this.prisma.modelCall.count({ where: { ...where, cachedPromptTokens: null } }),
    ])
    return buildPromptCacheStats({
      measuredCalls: measured._count._all,
      unmeasuredCalls,
      promptTokens: measured._sum.promptTokens ?? 0,
      cachedPromptTokens: measured._sum.cachedPromptTokens ?? 0,
    })
  }

  private async resolveScopeIds(
    tenantId: string,
    candidates: RunIndexCandidate[],
  ): Promise<{
    turnIds: string[]
    ticketIds: string[]
    conversationIds: string[]
    processTicketIndexTruncated: boolean
  }> {
    const turnIds = candidates.filter((c) => c.grain === 'turn').map((c) => c.id)
    const ticketIds = candidates.filter((c) => c.grain === 'ticket').map((c) => c.id)
    const processIds = candidates.filter((c) => c.grain === 'process').map((c) => c.id)

    const processTickets = await loadProcessTicketIndex(this.prisma, processIds)
    const processTicketIds = processIds.flatMap((id) => processTickets.byProcess.get(id) ?? [])
    const allTicketIds = [...new Set([...ticketIds, ...processTicketIds])]

    const [turnRows, ticketRows] = await Promise.all([
      turnIds.length
        ? this.prisma.agentTurn.findMany({
            where: { id: { in: turnIds }, tenantId },
            select: { id: true, conversationId: true },
          })
        : Promise.resolve([]),
      allTicketIds.length
        ? this.prisma.ticket.findMany({
            where: { id: { in: allTicketIds }, tenantId },
            select: { id: true, conversationId: true },
          })
        : Promise.resolve([]),
    ])

    const conversationIds = [
      ...new Set([
        ...turnRows.map((row) => row.conversationId),
        ...ticketRows.map((row) => row.conversationId).filter((id): id is string => Boolean(id)),
      ]),
    ]

    return {
      turnIds,
      ticketIds: allTicketIds,
      conversationIds,
      processTicketIndexTruncated: processTickets.truncated,
    }
  }

  private async loadSkillAuditRows(
    tenantId: string,
    scopeIds: { turnIds: string[]; ticketIds: string[]; conversationIds: string[] },
  ) {
    const filters: Prisma.AuditLogWhereInput[] = []
    if (scopeIds.ticketIds.length) filters.push({ ticketId: { in: scopeIds.ticketIds } })
    if (scopeIds.conversationIds.length) {
      filters.push({ conversationId: { in: scopeIds.conversationIds } })
    }
    if (filters.length === 0) return []

    return this.prisma.auditLog.findMany({
      where: {
        tenantId,
        action: { in: [...SKILL_AUDIT_ACTIONS] },
        OR: filters,
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_STATS_SKILL_AUDIT_ROWS,
      select: {
        action: true,
        targetId: true,
        metadata: true,
      },
    })
  }

  private aggregateSkillLoads(
    rows: Array<{
      action: string
      targetId: string | null
      metadata: unknown
    }>,
  ): RunStatsSkillLoad[] {
    const counts = new Map<string, RunStatsSkillLoad>()
    for (const row of rows) {
      if (
        row.action !== 'skill.loaded' &&
        row.action !== 'skill.attachment_loaded' &&
        row.action !== 'skill.run_snapshot'
      ) {
        continue
      }
      const meta = asRecord(row.metadata)
      const skillId =
        (typeof meta?.skillId === 'string' ? meta.skillId : null) ??
        (row.action !== 'skill.run_snapshot' ? row.targetId : null)
      const skillVersionId =
        typeof meta?.skillVersionId === 'string'
          ? meta.skillVersionId
          : typeof meta?.skillVersionIds === 'object' && Array.isArray(meta.skillVersionIds)
            ? (meta.skillVersionIds[0] as string | undefined) ?? null
            : null
      const key = `${row.action}\0${skillId ?? ''}\0${skillVersionId ?? ''}`
      const existing = counts.get(key)
      if (existing) {
        existing.count += 1
      } else {
        counts.set(key, {
          action: row.action,
          skillId,
          skillVersionId,
          count: 1,
        })
      }
    }
    return [...counts.values()].sort(
      (a, b) => b.count - a.count || a.action.localeCompare(b.action),
    )
  }

  private async auditQuery(
    requester: RunAnalysisRequester,
    result: RunStatsResult,
  ): Promise<void> {
    await appendRunAnalysisAudit(this.audit, requester, {
      action: 'analysis.run_stats',
      inputRef: null,
      outputRef: String(result.totals.toolCallCount),
      metadata: {
        scope: result.scope,
        runCount: result.runCount,
        truncated: result.truncated,
        limit: result.limit,
        toolCallCount: result.totals.toolCallCount,
        modelCallCount: result.totals.modelCallCount,
        repeatedSourceKeyCount: result.repeatedSourceKeys.length,
      },
    })
  }
}
