/**
 * RA-04 — `run_trace`: lapozott idővonal (chat / ticket ág) a Futás-elemzőnek.
 *
 * Alapból fejléc-összefoglaló; részletek lapozással és szűréssel. Nyers DB-olvasás
 * (nem debug-log-export vetület); tenant-szűrés és önelemzés-kizárás RA-03 szerint.
 */
import type { PrismaClient } from '@prisma/client'
import type { AuditRepository } from '@/repositories/interfaces'
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, toListPage } from '@/lib/list-pagination'
import { RUN_ANALYST_SYSTEM_ROLE } from '@/lib/platform-agent-registry'
import {
  RUN_INDEX_NOT_FOUND,
  RunIndexNotFoundError,
} from './run-index-service'
import type {
  RunTraceArgs,
  RunTraceDetailResult,
  RunTraceFilters,
  RunTraceGrain,
  RunTraceNonOkCall,
  RunTraceResult,
  RunTraceSummary,
  RunTraceSummaryResult,
  RunTraceTimelineEntry,
  RunTraceTokenPoint,
  RunTraceToolAgg,
  RunTraceView,
} from './run-trace-types'

export {
  RUN_INDEX_NOT_FOUND as RUN_TRACE_NOT_FOUND,
  RunIndexNotFoundError as RunTraceNotFoundError,
} from './run-index-service'

/** Lapozott részlet max. mérete egy válaszban. */
export const DEFAULT_TRACE_PAGE_LIMIT = DEFAULT_LIST_LIMIT
export const MAX_TRACE_PAGE_LIMIT = MAX_LIST_LIMIT
/** Összefoglalóban max. nem-ok eszközhívás-sor. */
export const MAX_TRACE_SUMMARY_NON_OK = 50
/** Egyetlen `summary` válasz felső karakter-korlátja (DoD: 150 hívás mellett is belefér). */
export const RUN_TRACE_MAX_OUTPUT_CHARS = 64_000
const MAX_TRACE_AUDIT_ROWS = 200

type LoadedTurnRun = {
  grain: 'turn'
  runId: string
  agentId: string
  agentName: string
  conversationId: string
  ticketId: string | null
  startedAt: Date
  finishedAt: Date | null
  status: string
  turnCount: number
  deniedCount: number
  modelCalls: Array<{
    id: string
    agentTurnId: string | null
    provider: string
    model: string
    promptTokens: number
    completionTokens: number
    cachedPromptTokens: number | null
    latencyMs: number
    status: string
    createdAt: Date
  }>
  toolCalls: Array<{
    id: string
    agentTurnId: string | null
    toolName: string
    status: string
    outcome: string | null
    policyDecision: string | null
    trustClass: string | null
    argsMeta: unknown
    resultMeta: unknown
    effectSummary: unknown
    latencyMs: number
    createdAt: Date
  }>
  messages: Array<{
    id: string
    role: string
    seq: number
    content: string | null
    createdAt: Date
  }>
  activities: Array<{ turnId: string; stepIndex: number; activity: unknown; at: Date }>
  audit: Array<{
    action: string
    targetType: string
    targetId: string
    policyDecision: string | null
    createdAt: Date
  }>
}

type LoadedTicketRun = {
  grain: 'ticket'
  runId: string
  agentId: string
  agentName: string
  conversationId: string | null
  ticketId: string
  startedAt: Date
  finishedAt: Date
  status: string
  turnCount: number
  deniedCount: number
  modelCalls: LoadedTurnRun['modelCalls']
  toolCalls: LoadedTurnRun['toolCalls']
  messages: LoadedTurnRun['messages']
  activities: LoadedTurnRun['activities']
  transitions: Array<{
    id: string
    fromState: string
    toState: string
    actorType: string
    note: string | null
    ts: Date
  }>
  comments: Array<{
    id: string
    kind: string
    authorType: string
    body: string
    seq: number
    createdAt: Date
  }>
  audit: LoadedTurnRun['audit']
}

type LoadedRun = LoadedTurnRun | LoadedTicketRun

function parseIsoDate(value: string | undefined, label: string): Date | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new Error(`invalid_${label}`)
  return new Date(parsed)
}

function resolvePageLimit(raw: number | undefined): number {
  const n = raw ?? DEFAULT_TRACE_PAGE_LIMIT
  return Math.min(Math.max(1, n), MAX_TRACE_PAGE_LIMIT)
}

function decodeInlineContent(contentRef: string | null | undefined): string | null {
  if (!contentRef) return null
  if (contentRef.startsWith('inline:')) return contentRef.slice('inline:'.length)
  return null
}

function isNonOkToolCall(row: { status: string; outcome: string | null }): boolean {
  if (row.outcome && row.outcome !== 'ok') return true
  return row.status !== 'ok'
}

export function aggregateToolCallsByToolAndOutcome(
  toolCalls: Array<{ toolName: string; outcome: string | null }>,
): RunTraceToolAgg[] {
  const counts = new Map<string, RunTraceToolAgg>()
  for (const row of toolCalls) {
    const key = `${row.toolName}\0${row.outcome ?? ''}`
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
    } else {
      counts.set(key, {
        toolName: row.toolName,
        outcome: row.outcome,
        count: 1,
      })
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.toolName.localeCompare(b.toolName))
}

export function buildTokenCurve(
  modelCalls: Array<{
    createdAt: Date
    promptTokens: number
    completionTokens: number
    cachedPromptTokens: number | null
  }>,
): RunTraceTokenPoint[] {
  return [...modelCalls]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => ({
      at: row.createdAt.toISOString(),
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      cachedPromptTokens: row.cachedPromptTokens,
    }))
}

export function buildTimeline(run: LoadedRun): RunTraceTimelineEntry[] {
  const entries: RunTraceTimelineEntry[] = []
  let seq = 0

  for (const row of run.modelCalls) {
    entries.push({
      kind: 'model_call',
      seq: seq++,
      at: row.createdAt.toISOString(),
      id: row.id,
      agentTurnId: row.agentTurnId,
      provider: row.provider,
      model: row.model,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      cachedPromptTokens: row.cachedPromptTokens,
      latencyMs: row.latencyMs,
      status: row.status,
    })
  }

  for (const row of run.toolCalls) {
    entries.push({
      kind: 'tool_call',
      seq: seq++,
      at: row.createdAt.toISOString(),
      id: row.id,
      agentTurnId: row.agentTurnId,
      toolName: row.toolName,
      status: row.status,
      outcome: row.outcome,
      policyDecision: row.policyDecision,
      trustClass: row.trustClass,
      argsMeta: row.argsMeta,
      resultMeta: row.resultMeta ?? null,
      effectSummary: row.effectSummary ?? null,
      latencyMs: row.latencyMs,
    })
  }

  for (const row of run.messages) {
    entries.push({
      kind: 'message',
      seq: seq++,
      at: row.createdAt.toISOString(),
      id: row.id,
      role: row.role,
      messageSeq: row.seq,
      content: row.content,
    })
  }

  for (const row of run.activities) {
    entries.push({
      kind: 'activity',
      seq: seq++,
      at: row.at.toISOString(),
      turnId: row.turnId,
      stepIndex: row.stepIndex,
      activity: row.activity,
    })
  }

  if (run.grain === 'ticket') {
    for (const row of run.transitions) {
      entries.push({
        kind: 'ticket_transition',
        seq: seq++,
        at: row.ts.toISOString(),
        id: row.id,
        fromState: row.fromState,
        toState: row.toState,
        actorType: row.actorType,
        note: row.note,
      })
    }
    for (const row of run.comments) {
      entries.push({
        kind: 'ticket_comment',
        seq: seq++,
        at: row.createdAt.toISOString(),
        id: row.id,
        commentKind: row.kind,
        authorType: row.authorType,
        body: row.body,
        commentSeq: row.seq,
      })
    }
  }

  for (const row of run.audit) {
    entries.push({
      kind: 'audit',
      seq: seq++,
      at: row.createdAt.toISOString(),
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      policyDecision: row.policyDecision,
    })
  }

  entries.sort((a, b) => {
    const atDiff = a.at.localeCompare(b.at)
    if (atDiff !== 0) return atDiff
    return a.seq - b.seq
  })

  return entries.map((entry, index) => ({ ...entry, seq: index }))
}

export function applyTraceFilters(
  entries: RunTraceTimelineEntry[],
  args: RunTraceArgs,
): RunTraceTimelineEntry[] {
  const since = parseIsoDate(args.since, 'since')
  const until = parseIsoDate(args.until, 'until')
  const toolName = args.toolName?.trim() || null
  const status = args.status?.trim() || null
  const outcome = args.outcome?.trim() || null
  const stepFrom = args.stepFrom
  const stepTo = args.stepTo

  return entries.filter((entry) => {
    const at = Date.parse(entry.at)
    if (since && at < since.getTime()) return false
    if (until && at > until.getTime()) return false

    if (entry.kind === 'tool_call') {
      if (toolName && entry.toolName !== toolName) return false
      if (status && entry.status !== status) return false
      if (outcome && (entry.outcome ?? '') !== outcome) return false
      return true
    }

    if (toolName || status || outcome) {
      if (entry.kind !== 'activity') return false
    }

    if (entry.kind === 'activity') {
      if (stepFrom != null && entry.stepIndex < stepFrom) return false
      if (stepTo != null && entry.stepIndex > stepTo) return false
    }

    return true
  })
}

export function buildTraceSummary(run: LoadedRun): RunTraceSummary {
  const nonOkAll: RunTraceNonOkCall[] = run.toolCalls
    .filter(isNonOkToolCall)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((row) => ({
      id: row.id,
      toolName: row.toolName,
      status: row.status,
      outcome: row.outcome,
      createdAt: row.createdAt.toISOString(),
    }))

  const nonOkToolCallsTruncated = nonOkAll.length > MAX_TRACE_SUMMARY_NON_OK
  const nonOkToolCalls = nonOkAll.slice(0, MAX_TRACE_SUMMARY_NON_OK)

  return {
    runId: run.runId,
    grain: run.grain,
    agentId: run.agentId,
    agentName: run.agentName,
    conversationId: run.conversationId,
    ticketId: run.ticketId,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    status: run.status,
    turnCount: run.turnCount,
    deniedCount: run.deniedCount,
    toolCallCount: run.toolCalls.length,
    toolCallsByToolAndOutcome: aggregateToolCallsByToolAndOutcome(run.toolCalls),
    tokenCurve: buildTokenCurve(run.modelCalls),
    nonOkToolCalls,
    nonOkToolCallsTruncated,
  }
}

export function estimateTraceOutputChars(result: RunTraceResult): number {
  try {
    return JSON.stringify(result).length
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

export function buildTraceFilters(args: RunTraceArgs): RunTraceFilters {
  const since = parseIsoDate(args.since, 'since')
  const until = parseIsoDate(args.until, 'until')
  return {
    since: since?.toISOString() ?? null,
    until: until?.toISOString() ?? null,
    stepFrom: args.stepFrom ?? null,
    stepTo: args.stepTo ?? null,
    toolName: args.toolName?.trim() || null,
    status: args.status?.trim() || null,
    outcome: args.outcome?.trim() || null,
  }
}

function parseActivities(
  turnId: string,
  startedAt: Date,
  activitiesJson: unknown,
): LoadedTurnRun['activities'] {
  if (!Array.isArray(activitiesJson)) return []
  return activitiesJson.map((activity, stepIndex) => ({
    turnId,
    stepIndex,
    activity,
    at: startedAt,
  }))
}

export class RunTraceService {
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
    args: RunTraceArgs
  }): Promise<RunTraceResult> {
    const { tenantId, args } = input
    const view: RunTraceView = args.view ?? 'summary'
    const limit = resolvePageLimit(args.limit)
    const offset = Math.max(0, args.offset ?? 0)
    const runAnalystIds = await this.runAnalystAgentIds(tenantId)

    const run =
      args.grain === 'turn'
        ? await this.loadTurnRun(tenantId, args.runId, runAnalystIds)
        : await this.loadTicketRun(tenantId, args.runId, runAnalystIds)

    const timeline = applyTraceFilters(buildTimeline(run), args)
    const filters = buildTraceFilters(args)

    let result: RunTraceResult
    if (view === 'summary') {
      const summary = buildTraceSummary(run)
      result = { view: 'summary', runId: run.runId, grain: run.grain, summary }
      if (estimateTraceOutputChars(result) > RUN_TRACE_MAX_OUTPUT_CHARS) {
        throw new Error('run_trace_output_too_large')
      }
    } else {
      const page = toListPage(timeline, limit, offset)
      result = {
        view: 'detail',
        runId: run.runId,
        grain: run.grain,
        entries: page.items,
        returnedCount: page.items.length,
        limit,
        offset,
        totalCount: timeline.length,
        truncated: page.hasMore,
        filters,
      } satisfies RunTraceDetailResult
    }

    await this.audit.append({
      actorType: 'agent',
      actorId: input.requesterAgentId,
      agentVersion: input.requesterAgentVersion,
      action: 'analysis.run_trace',
      targetType: 'tenant',
      targetId: tenantId,
      tenantId,
      modelUsed: null,
      inputRef: `${args.grain}:${args.runId}`,
      outputRef: view === 'summary' ? 'summary' : String((result as RunTraceDetailResult).returnedCount),
      policyDecision: 'allowed',
      metadata: {
        grain: args.grain,
        runId: args.runId,
        view,
        returnedCount: view === 'detail' ? (result as RunTraceDetailResult).returnedCount : 1,
        truncated: view === 'detail' ? (result as RunTraceDetailResult).truncated : false,
        limit: view === 'detail' ? limit : null,
        offset: view === 'detail' ? offset : null,
        filters,
      },
    })

    return result
  }

  private async loadTurnRun(
    tenantId: string,
    runId: string,
    runAnalystIds: string[],
  ): Promise<LoadedTurnRun> {
    const turn = await this.prisma.agentTurn.findUnique({ where: { id: runId } })
    if (!turn || turn.tenantId !== tenantId) throw new RunIndexNotFoundError()
    if (runAnalystIds.includes(turn.agentId)) throw new RunIndexNotFoundError()

    const agent = await this.prisma.agent.findUnique({
      where: { id: turn.agentId },
      select: { name: true },
    })

    const messageIds = [turn.userMessageId, turn.assistantMessageId].filter(
      (id): id is string => Boolean(id),
    )
    const [modelCalls, toolCalls, messages, auditRows] = await Promise.all([
      this.prisma.modelCall.findMany({
        where: { agentTurnId: turn.id },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.toolCall.findMany({
        where: { agentTurnId: turn.id },
        orderBy: { createdAt: 'asc' },
      }),
      messageIds.length
        ? this.prisma.message.findMany({
            where: { id: { in: messageIds } },
            orderBy: { seq: 'asc' },
          })
        : Promise.resolve([]),
      this.audit.findMany({
        conversationId: turn.conversationId,
        since: turn.startedAt,
        limit: MAX_TRACE_AUDIT_ROWS,
      }),
    ])

    const audit = auditRows
      .filter(
        (row) =>
          row.createdAt >= turn.startedAt &&
          (turn.finishedAt == null || row.createdAt <= turn.finishedAt),
      )
      .map((row) => ({
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId ?? '',
        policyDecision: row.policyDecision,
        createdAt: row.createdAt,
      }))

    return {
      grain: 'turn',
      runId: turn.id,
      agentId: turn.agentId,
      agentName: agent?.name ?? '',
      conversationId: turn.conversationId,
      ticketId: null,
      startedAt: turn.startedAt,
      finishedAt: turn.finishedAt,
      status: turn.status,
      turnCount: turn.turnCount,
      deniedCount: turn.deniedCount,
      modelCalls: modelCalls.map(mapModelCall),
      toolCalls: toolCalls.map(mapToolCall),
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        seq: message.seq,
        content: decodeInlineContent(message.contentRef),
        createdAt: message.createdAt,
      })),
      activities: parseActivities(turn.id, turn.startedAt, turn.activities),
      audit,
    }
  }

  private async loadTicketRun(
    tenantId: string,
    runId: string,
    runAnalystIds: string[],
  ): Promise<LoadedTicketRun> {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: runId } })
    if (!ticket || ticket.tenantId !== tenantId) throw new RunIndexNotFoundError()
    if (ticket.agentId && runAnalystIds.includes(ticket.agentId)) {
      throw new RunIndexNotFoundError()
    }

    const agent =
      ticket.agentId != null
        ? await this.prisma.agent.findUnique({
            where: { id: ticket.agentId },
            select: { name: true },
          })
        : null

    const windowStart = ticket.createdAt
    const windowEnd = ticket.updatedAt

    const [modelCalls, toolCalls, transitions, comments, turns, auditRows] = await Promise.all([
      this.prisma.modelCall.findMany({
        where: { ticketId: ticket.id },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.toolCall.findMany({
        where: { ticketId: ticket.id },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.ticketTransition.findMany({
        where: { ticketId: ticket.id },
        orderBy: { ts: 'asc' },
      }),
      this.prisma.ticketComment.findMany({
        where: { ticketId: ticket.id },
        orderBy: { createdAt: 'asc' },
      }),
      ticket.conversationId
        ? this.prisma.agentTurn.findMany({
            where: {
              conversationId: ticket.conversationId,
              tenantId,
              startedAt: { gte: windowStart, lte: windowEnd },
            },
            orderBy: { startedAt: 'asc' },
          })
        : Promise.resolve([]),
      this.audit.findMany({
        ticketId: ticket.id,
        conversationId: ticket.conversationId ?? undefined,
        since: windowStart,
        limit: MAX_TRACE_AUDIT_ROWS,
      }),
    ])

    const messageWhere = ticket.conversationId
      ? {
          OR: [
            { ticketRefId: ticket.id },
            {
              conversationId: ticket.conversationId,
              createdAt: { gte: windowStart, lte: windowEnd },
            },
          ],
        }
      : { ticketRefId: ticket.id }

    const messages = await this.prisma.message.findMany({
      where: messageWhere,
      orderBy: { createdAt: 'asc' },
    })

    const audit = auditRows
      .filter((row) => row.createdAt <= windowEnd)
      .map((row) => ({
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId ?? '',
        policyDecision: row.policyDecision,
        createdAt: row.createdAt,
      }))

    const activities = turns.flatMap((turn) =>
      parseActivities(turn.id, turn.startedAt, turn.activities),
    )

    const deniedCount = turns.reduce((sum, turn) => sum + turn.deniedCount, 0)
    const turnCount = turns.reduce((sum, turn) => sum + turn.turnCount, 0)

    return {
      grain: 'ticket',
      runId: ticket.id,
      agentId: ticket.agentId ?? '',
      agentName: agent?.name ?? '',
      conversationId: ticket.conversationId,
      ticketId: ticket.id,
      startedAt: windowStart,
      finishedAt: windowEnd,
      status: ticket.state,
      turnCount,
      deniedCount,
      modelCalls: modelCalls.map(mapModelCall),
      toolCalls: toolCalls.map(mapToolCall),
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        seq: message.seq,
        content: decodeInlineContent(message.contentRef),
        createdAt: message.createdAt,
      })),
      activities,
      transitions: transitions.map((row) => ({
        id: row.id,
        fromState: row.fromState,
        toState: row.toState,
        actorType: row.actorType,
        note: row.note,
        ts: row.ts,
      })),
      comments: comments.map((row) => ({
        id: row.id,
        kind: row.kind,
        authorType: row.authorType,
        body: row.body,
        seq: row.seq,
        createdAt: row.createdAt,
      })),
      audit,
    }
  }
}

function mapModelCall(row: {
  id: string
  agentTurnId: string | null
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  cachedPromptTokens: number | null
  latencyMs: number
  status: string
  createdAt: Date
}) {
  return {
    id: row.id,
    agentTurnId: row.agentTurnId,
    provider: row.provider,
    model: row.model,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    cachedPromptTokens: row.cachedPromptTokens,
    latencyMs: row.latencyMs,
    status: row.status,
    createdAt: row.createdAt,
  }
}

function mapToolCall(row: {
  id: string
  agentTurnId: string | null
  toolName: string
  status: string
  outcome: string | null
  policyDecision: string | null
  trustClass: string | null
  argsMeta: unknown
  resultMeta: unknown
  effectSummary: unknown
  latencyMs: number
  createdAt: Date
}) {
  return {
    id: row.id,
    agentTurnId: row.agentTurnId,
    toolName: row.toolName,
    status: row.status,
    outcome: row.outcome,
    policyDecision: row.policyDecision,
    trustClass: row.trustClass,
    argsMeta: row.argsMeta,
    resultMeta: row.resultMeta,
    effectSummary: row.effectSummary,
    latencyMs: row.latencyMs,
    createdAt: row.createdAt,
  }
}

export type { RunTraceGrain, RunTraceView, RunTraceResult, RunTraceSummaryResult, RunTraceDetailResult }
