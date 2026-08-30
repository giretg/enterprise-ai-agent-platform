/**
 * RA-04 / RA-05 — `run_trace`: lapozott idővonal (chat/ticket) és folyamat-nézet.
 *
 * Alapból fejléc-összefoglaló; részletek lapozással és szűréssel. Nyers DB-olvasás
 * (nem debug-log-export vetület); tenant-szűrés és önelemzés-kizárás RA-03 szerint.
 *
 * MÉRET-KEZELÉS (spec: „Lapozás, nem plafon”):
 * - az összefoglaló DB-oldali aggregáció (groupBy / count / korlátos minta), ezért
 *   nagy futáson is kicsi marad, és MÉRETTŐL SOSEM HIBÁZIK EL — szükség esetén
 *   szűkítve, `degradedFields`-szel jelezve tér vissza;
 * - a részletes idővonal forrásonként `take`-kel korlátozott, a szűrők a DB
 *   `where`-be mennek (docs/perf/github-issues/003-paginate-unbounded-lists.md).
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuditRepository } from '@/repositories/interfaces'
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '@/lib/list-pagination'
import { RUN_ANALYST_SYSTEM_ROLE } from '@/lib/platform-agent-registry'
import { RunIndexNotFoundError } from './run-index-service'
import { appendRunAnalysisAudit, type RunAnalysisRequester } from './run-scope'
import {
  buildProcessTraceView,
  mapDelegationEdge,
  mapProcessInstance,
  mapProcessStep,
  projectPlaybookSpecForTrace,
} from './run-trace-process'
import type {
  RunTraceArgs,
  RunTraceDetailResult,
  RunTraceFilters,
  RunTraceProcessResult,
  RunTraceResult,
  RunTraceSummary,
  RunTraceSummaryResult,
  RunTraceTimelineArgs,
  RunTraceTimelineEntry,
  RunTraceToolAgg,
  RunTraceTokenPoint,
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
/** Összefoglalóban max. (eszköz × kimenetel) pár. */
export const MAX_TRACE_SUMMARY_TOOL_GROUPS = 100
/** Token-görbe max. pontszáma; hosszabb futásnál eleje+vége minta. */
export const MAX_TRACE_TOKEN_CURVE_POINTS = 200
/** Egyetlen `summary` válasz felső karakter-korlátja (DoD: 150 hívás mellett is belefér). */
export const RUN_TRACE_MAX_OUTPUT_CHARS = 64_000
/** Az idővonal audit-szeletének felső korlátja. */
export const MAX_TRACE_AUDIT_ROWS = 200
/** Aktivitásokért betöltött forduló-sorok felső korlátja (ticket ág). */
export const MAX_TRACE_ACTIVITY_TURNS = 200

const MODEL_CALL_TIMELINE_SELECT = {
  id: true,
  agentTurnId: true,
  provider: true,
  model: true,
  promptTokens: true,
  completionTokens: true,
  cachedPromptTokens: true,
  latencyMs: true,
  status: true,
  createdAt: true,
} satisfies Prisma.ModelCallSelect

const TOOL_CALL_TIMELINE_SELECT = {
  id: true,
  agentTurnId: true,
  toolName: true,
  status: true,
  outcome: true,
  policyDecision: true,
  trustClass: true,
  argsMeta: true,
  resultMeta: true,
  effectSummary: true,
  latencyMs: true,
  createdAt: true,
} satisfies Prisma.ToolCallSelect

/**
 * „Nem rendben” eszközhívás: nem-`ok` státusz VAGY kitöltött, nem-`ok` kimenetel.
 * Egy helyen, SQL-ben — az összefoglaló és a szűrő ugyanezt használja.
 */
const NON_OK_TOOL_CALL_WHERE: Prisma.ToolCallWhereInput = {
  OR: [
    { status: { not: 'ok' } },
    { AND: [{ outcome: { not: null } }, { outcome: { not: 'ok' } }] },
  ],
}

/** Egy futás forrás-soraiból épülő idővonal bemenete. */
export type TraceTimelineSources = {
  grain: 'turn' | 'ticket'
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
  transitions?: Array<{
    id: string
    fromState: string
    toState: string
    actorType: string
    note: string | null
    ts: Date
  }>
  comments?: Array<{
    id: string
    kind: string
    authorType: string
    body: string
    seq: number
    createdAt: Date
  }>
  audit: Array<{
    action: string
    targetType: string
    targetId: string
    policyDecision: string | null
    createdAt: Date
  }>
}

/** A futás fejléce — szemcsétől függetlenül ugyanaz a mezőkészlet. */
export type TraceRunHeader = {
  runId: string
  grain: 'turn' | 'ticket'
  agentId: string
  agentName: string
  conversationId: string | null
  ticketId: string | null
  startedAt: Date
  finishedAt: Date | null
  status: string
  turnCount: number
  deniedCount: number
}

/**
 * Egy futás lekérdezési szkópja: a fejléc + azok a `where`-ek, amikkel a futás
 * sorai szűkíthetők. A service ezen keresztül aggregál és lapoz — sosem tölti be
 * előbb az egészet.
 */
/**
 * Ticket-szkóp audit-szűrője. A broker `tool.call` sorai `targetType=ticket`
 * mellett tipikusan `conversationId = null`-lal íródnak; a chat-események
 * viszont conversation-horgonnyal. AND-elés → üres audit-idővonal.
 * Ezért ticket + conversation esetén OR (két lekérdezés, összefésülve).
 */
export type TraceAuditFilter = {
  ticketId?: string
  conversationId?: string
  /** `or` = ticket VAGY conversation (chat-kötött ticket); `single` = egy horgony. */
  mode: 'single' | 'or'
  since: Date
  until?: Date
}

type TraceRunScope = TraceRunHeader & {
  callWhere: { agentTurnId: string } | { ticketId: string }
  messageWhere: Prisma.MessageWhereInput
  auditFilter: TraceAuditFilter
  activityTurnWhere: Prisma.AgentTurnWhereInput
  hasTicketSources: boolean
}

/** Ticket-grain audit-szűrő — chat-kötött ticketnél OR, különben ticket-only. */
export function buildTicketTraceAuditFilter(input: {
  ticketId: string
  conversationId: string | null
  since: Date
  until: Date
}): TraceAuditFilter {
  if (input.conversationId) {
    return {
      ticketId: input.ticketId,
      conversationId: input.conversationId,
      mode: 'or',
      since: input.since,
      until: input.until,
    }
  }
  return {
    ticketId: input.ticketId,
    mode: 'single',
    since: input.since,
    until: input.until,
  }
}

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

/**
 * Egy szűrő-terv, KÉT fogyasztóval: a DB `where`-ek és a csak JS-ben szűrhető
 * aktivitás-lépéstartomány. Így a szűrés szemantikája egy helyen él.
 */
export type TraceFilterPlan = {
  filters: RunTraceFilters
  /** A tool-szűrők a nem-eszköz forrásokat kizárják (a `run_trace` régi szemantikája). */
  sources: {
    modelCalls: boolean
    toolCalls: boolean
    messages: boolean
    activities: boolean
    ticketRows: boolean
    audit: boolean
  }
  timeWhere: { gte?: Date; lte?: Date } | undefined
  /** Nyers, még nem Prisma-enumra szűkített eszköz-szűrő (a kérő szabad szöveget ad). */
  toolWhere: { toolName?: string; status?: string; outcome?: string }
  stepRange: { from: number | null; to: number | null }
}

export function planTraceFilters(args: RunTraceTimelineArgs): TraceFilterPlan {
  const since = parseIsoDate(args.since, 'since')
  const until = parseIsoDate(args.until, 'until')
  const toolName = args.toolName?.trim() || null
  const status = args.status?.trim() || null
  const outcome = args.outcome?.trim() || null
  const toolScoped = Boolean(toolName || status || outcome)

  const timeWhere =
    since || until
      ? { ...(since ? { gte: since } : {}), ...(until ? { lte: until } : {}) }
      : undefined

  return {
    filters: {
      since: since?.toISOString() ?? null,
      until: until?.toISOString() ?? null,
      stepFrom: args.stepFrom ?? null,
      stepTo: args.stepTo ?? null,
      toolName,
      status,
      outcome,
    },
    sources: {
      modelCalls: !toolScoped,
      toolCalls: true,
      messages: !toolScoped,
      activities: true,
      ticketRows: !toolScoped,
      audit: !toolScoped,
    },
    timeWhere,
    toolWhere: {
      ...(toolName ? { toolName } : {}),
      ...(status ? { status } : {}),
      ...(outcome ? { outcome } : {}),
    },
    stepRange: { from: args.stepFrom ?? null, to: args.stepTo ?? null },
  }
}

/** Aktivitás lépés-tartomány — az `AgentTurn.activities` JSON miatt csak JS-ben szűrhető. */
export function inStepRange(stepIndex: number, plan: TraceFilterPlan): boolean {
  const { from, to } = plan.stepRange
  if (from != null && stepIndex < from) return false
  if (to != null && stepIndex > to) return false
  return true
}

export function applyActivityStepRange(
  entries: RunTraceTimelineEntry[],
  plan: TraceFilterPlan,
): RunTraceTimelineEntry[] {
  if (plan.stepRange.from == null && plan.stepRange.to == null) return entries
  return entries.filter((entry) => entry.kind !== 'activity' || inStepRange(entry.stepIndex, plan))
}

export function buildTraceFilters(args: RunTraceTimelineArgs): RunTraceFilters {
  return planTraceFilters(args).filters
}

/** (eszköz × kimenetel) csoportok kanonikus sorrendje: gyakoriság, majd név. */
export function sortToolOutcomeGroups(groups: RunTraceToolAgg[]): RunTraceToolAgg[] {
  return [...groups].sort(
    (a, b) => b.count - a.count || a.toolName.localeCompare(b.toolName),
  )
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

export function buildTimeline(sources: TraceTimelineSources): RunTraceTimelineEntry[] {
  const entries: RunTraceTimelineEntry[] = []
  let seq = 0

  for (const row of sources.modelCalls) {
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

  for (const row of sources.toolCalls) {
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

  for (const row of sources.messages) {
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

  for (const row of sources.activities) {
    entries.push({
      kind: 'activity',
      seq: seq++,
      at: row.at.toISOString(),
      turnId: row.turnId,
      stepIndex: row.stepIndex,
      activity: row.activity,
    })
  }

  for (const row of sources.transitions ?? []) {
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

  for (const row of sources.comments ?? []) {
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

  for (const row of sources.audit) {
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

/** Már aggregált bemenetből épülő összefoglaló — a service DB-oldali számokat ad. */
export function buildTraceSummary(input: {
  header: TraceRunHeader
  toolCallCount: number
  modelCallCount: number
  toolOutcomeGroups: RunTraceToolAgg[]
  toolOutcomeGroupsTruncated: boolean
  tokenCurveSample: Array<{
    createdAt: Date
    promptTokens: number
    completionTokens: number
    cachedPromptTokens: number | null
  }>
  tokenCurveTruncated: boolean
  nonOkToolCalls: Array<{
    id: string
    toolName: string
    status: string
    outcome: string | null
    createdAt: Date
  }>
  nonOkToolCallCount: number
}): RunTraceSummary {
  const { header } = input
  return {
    runId: header.runId,
    grain: header.grain,
    agentId: header.agentId,
    agentName: header.agentName,
    conversationId: header.conversationId,
    ticketId: header.ticketId,
    startedAt: header.startedAt.toISOString(),
    finishedAt: header.finishedAt?.toISOString() ?? null,
    status: header.status,
    turnCount: header.turnCount,
    deniedCount: header.deniedCount,
    toolCallCount: input.toolCallCount,
    modelCallCount: input.modelCallCount,
    toolCallsByToolAndOutcome: sortToolOutcomeGroups(input.toolOutcomeGroups),
    toolCallsByToolAndOutcomeTruncated: input.toolOutcomeGroupsTruncated,
    tokenCurve: buildTokenCurve(input.tokenCurveSample),
    tokenCurveTruncated: input.tokenCurveTruncated,
    tokenCurveTotalPoints: input.modelCallCount,
    nonOkToolCalls: input.nonOkToolCalls
      .slice(0, MAX_TRACE_SUMMARY_NON_OK)
      .map((row) => ({
        id: row.id,
        toolName: row.toolName,
        status: row.status,
        outcome: row.outcome,
        createdAt: row.createdAt.toISOString(),
      })),
    nonOkToolCallsTruncated: input.nonOkToolCallCount > MAX_TRACE_SUMMARY_NON_OK,
    degradedFields: [],
  }
}

export function estimateTraceOutputChars(result: RunTraceResult): number {
  try {
    return JSON.stringify(result).length
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

/**
 * Méret-garancia az összefoglalóra: ha a válasz a korlát fölé nőne, a legnagyobb
 * mezőket sorra elhagyjuk, és a `degradedFields` megmondja, melyiket. Az
 * összefoglaló SOSEM hibázik el mérettől — az alapnézetnek mindig elérhetőnek
 * kell lennie, különben a nagy futás elemezhetetlen.
 */
export function enforceSummaryBudget(
  summary: RunTraceSummary,
  maxChars = RUN_TRACE_MAX_OUTPUT_CHARS,
): RunTraceSummary {
  const sizeOf = (candidate: RunTraceSummary) =>
    estimateTraceOutputChars({
      view: 'summary',
      runId: candidate.runId,
      grain: candidate.grain,
      summary: candidate,
    })

  const degradations: Array<{ field: string; apply: (s: RunTraceSummary) => RunTraceSummary }> = [
    {
      field: 'tokenCurve',
      apply: (s) => ({ ...s, tokenCurve: [], tokenCurveTruncated: true }),
    },
    {
      field: 'nonOkToolCalls',
      apply: (s) => ({ ...s, nonOkToolCalls: [], nonOkToolCallsTruncated: true }),
    },
    {
      field: 'toolCallsByToolAndOutcome',
      apply: (s) => ({
        ...s,
        toolCallsByToolAndOutcome: [],
        toolCallsByToolAndOutcomeTruncated: true,
      }),
    },
  ]

  let current = summary
  for (const step of degradations) {
    if (sizeOf(current) <= maxChars) break
    current = { ...step.apply(current), degradedFields: [...current.degradedFields, step.field] }
  }
  return current
}

function parseActivities(
  turnId: string,
  startedAt: Date,
  activitiesJson: unknown,
): TraceTimelineSources['activities'] {
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

  async query(
    input: RunAnalysisRequester & { args: RunTraceArgs },
  ): Promise<RunTraceResult> {
    const { tenantId, args } = input
    const runAnalystIds = await this.runAnalystAgentIds(tenantId)

    if (args.grain === 'process') {
      const result = await this.loadProcessRun(tenantId, args, runAnalystIds)
      await appendRunAnalysisAudit(this.audit, input, {
        action: 'analysis.run_trace',
        inputRef: `process:${args.runId}`,
        outputRef: String(result.returnedStepCount),
        metadata: {
          grain: 'process',
          runId: args.runId,
          view: result.detail,
          stepCount: result.stepCount,
          returnedStepCount: result.returnedStepCount,
          delegationCount: result.delegationCount,
          slotGapCount: result.slotGaps.length,
          limit: result.limit,
          offset: result.offset,
          truncated: result.truncated,
        },
      })
      return result
    }

    const view: RunTraceView = args.view ?? 'summary'
    const scope = await this.resolveTimelineScope(tenantId, args, runAnalystIds)

    const result =
      view === 'summary' ? await this.loadSummary(scope) : await this.loadDetail(scope, args)

    await appendRunAnalysisAudit(this.audit, input, {
      action: 'analysis.run_trace',
      inputRef: `${args.grain}:${args.runId}`,
      outputRef:
        result.view === 'detail' ? String(result.returnedCount) : String(result.summary.toolCallCount),
      metadata:
        result.view === 'detail'
          ? {
              grain: args.grain,
              runId: args.runId,
              view,
              returnedCount: result.returnedCount,
              totalCount: result.totalCount,
              totalCountExact: result.totalCountExact,
              truncated: result.truncated,
              limit: result.limit,
              offset: result.offset,
              filters: result.filters,
            }
          : {
              grain: args.grain,
              runId: args.runId,
              view,
              toolCallCount: result.summary.toolCallCount,
              modelCallCount: result.summary.modelCallCount,
              degradedFields: result.summary.degradedFields,
            },
    })

    return result
  }

  /** Szkóp-feloldás: tenant-határ, önelemzés-kizárás és a futás `where`-jei. */
  private async resolveTimelineScope(
    tenantId: string,
    args: Extract<RunTraceArgs, { grain: 'turn' | 'ticket' }>,
    runAnalystIds: string[],
  ): Promise<TraceRunScope> {
    return args.grain === 'turn'
      ? this.resolveTurnScope(tenantId, args.runId, runAnalystIds)
      : this.resolveTicketScope(tenantId, args.runId, runAnalystIds)
  }

  private async resolveTurnScope(
    tenantId: string,
    runId: string,
    runAnalystIds: string[],
  ): Promise<TraceRunScope> {
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
      callWhere: { agentTurnId: turn.id },
      messageWhere: messageIds.length ? { id: { in: messageIds } } : { id: { in: [] } },
      auditFilter: {
        conversationId: turn.conversationId,
        mode: 'single',
        since: turn.startedAt,
        ...(turn.finishedAt ? { until: turn.finishedAt } : {}),
      },
      activityTurnWhere: { id: turn.id },
      hasTicketSources: false,
    }
  }

  private async resolveTicketScope(
    tenantId: string,
    runId: string,
    runAnalystIds: string[],
  ): Promise<TraceRunScope> {
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

    const activityTurnWhere: Prisma.AgentTurnWhereInput = ticket.conversationId
      ? {
          conversationId: ticket.conversationId,
          tenantId,
          startedAt: { gte: windowStart, lte: windowEnd },
        }
      : { id: { in: [] } }

    // Körök és megtagadások DB-oldali összege — nem töltjük be a forduló-sorokat.
    const turnTotals = ticket.conversationId
      ? await this.prisma.agentTurn.aggregate({
          where: activityTurnWhere,
          _sum: { turnCount: true, deniedCount: true },
        })
      : { _sum: { turnCount: null, deniedCount: null } }

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
      turnCount: turnTotals._sum.turnCount ?? 0,
      deniedCount: turnTotals._sum.deniedCount ?? 0,
      callWhere: { ticketId: ticket.id },
      messageWhere: ticket.conversationId
        ? {
            OR: [
              { ticketRefId: ticket.id },
              {
                conversationId: ticket.conversationId,
                createdAt: { gte: windowStart, lte: windowEnd },
              },
            ],
          }
        : { ticketRefId: ticket.id },
      auditFilter: buildTicketTraceAuditFilter({
        ticketId: ticket.id,
        conversationId: ticket.conversationId,
        since: windowStart,
        until: windowEnd,
      }),
      activityTurnWhere,
      hasTicketSources: true,
    }
  }

  /** Összefoglaló — végig DB-oldali aggregáció, korlátos mintákkal. */
  private async loadSummary(scope: TraceRunScope): Promise<RunTraceSummaryResult> {
    const { callWhere } = scope

    const [toolCallCount, modelCallCount, toolGroups, nonOkRows, nonOkCount] = await Promise.all([
      this.prisma.toolCall.count({ where: callWhere }),
      this.prisma.modelCall.count({ where: callWhere }),
      this.prisma.toolCall.groupBy({
        by: ['toolName', 'outcome'],
        where: callWhere,
        _count: { _all: true },
        orderBy: { _count: { toolName: 'desc' } },
        take: MAX_TRACE_SUMMARY_TOOL_GROUPS + 1,
      }),
      this.prisma.toolCall.findMany({
        where: { ...callWhere, ...NON_OK_TOOL_CALL_WHERE },
        select: { id: true, toolName: true, status: true, outcome: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: MAX_TRACE_SUMMARY_NON_OK,
      }),
      this.prisma.toolCall.count({ where: { ...callWhere, ...NON_OK_TOOL_CALL_WHERE } }),
    ])

    const toolGroupsTruncated = toolGroups.length > MAX_TRACE_SUMMARY_TOOL_GROUPS
    const tokenCurve = await this.loadTokenCurveSample(callWhere, modelCallCount)

    const summary = enforceSummaryBudget(
      buildTraceSummary({
        header: scope,
        toolCallCount,
        modelCallCount,
        toolOutcomeGroups: (toolGroupsTruncated
          ? toolGroups.slice(0, MAX_TRACE_SUMMARY_TOOL_GROUPS)
          : toolGroups
        ).map((row) => ({
          toolName: row.toolName,
          outcome: row.outcome,
          count: row._count._all,
        })),
        toolOutcomeGroupsTruncated: toolGroupsTruncated,
        tokenCurveSample: tokenCurve.sample,
        tokenCurveTruncated: tokenCurve.truncated,
        nonOkToolCalls: nonOkRows,
        nonOkToolCallCount: nonOkCount,
      }),
    )

    return { view: 'summary', runId: scope.runId, grain: scope.grain, summary }
  }

  /**
   * Token-görbe minta: rövid futáson a teljes görbe, hosszún az ELEJE ÉS A VÉGE —
   * a kontextus-hízás iránya így akkor is látszik, ha a görbe nem fér bele.
   */
  private async loadTokenCurveSample(
    callWhere: TraceRunScope['callWhere'],
    modelCallCount: number,
  ): Promise<{
    sample: Array<{
      createdAt: Date
      promptTokens: number
      completionTokens: number
      cachedPromptTokens: number | null
    }>
    truncated: boolean
  }> {
    const select = {
      createdAt: true,
      promptTokens: true,
      completionTokens: true,
      cachedPromptTokens: true,
    } satisfies Prisma.ModelCallSelect

    if (modelCallCount <= MAX_TRACE_TOKEN_CURVE_POINTS) {
      const sample = await this.prisma.modelCall.findMany({
        where: callWhere,
        select,
        orderBy: { createdAt: 'asc' },
        take: MAX_TRACE_TOKEN_CURVE_POINTS,
      })
      return { sample, truncated: false }
    }

    const half = Math.floor(MAX_TRACE_TOKEN_CURVE_POINTS / 2)
    const [head, tail] = await Promise.all([
      this.prisma.modelCall.findMany({
        where: callWhere,
        select,
        orderBy: { createdAt: 'asc' },
        take: half,
      }),
      this.prisma.modelCall.findMany({
        where: callWhere,
        select,
        orderBy: { createdAt: 'desc' },
        take: half,
      }),
    ])
    return { sample: [...head, ...tail.reverse()], truncated: true }
  }

  /**
   * Lapozott idővonal. A szűrők a DB `where`-be mennek, és forrásonként
   * `offset + limit + 1` sort kérünk időrendben — ennyi bizonyíthatóan elég az
   * összefésült lap előállításához, így egyetlen forrást sem töltünk be teljesen.
   */
  private async loadDetail(
    scope: TraceRunScope,
    args: RunTraceTimelineArgs,
  ): Promise<RunTraceDetailResult> {
    const plan = planTraceFilters(args)
    const limit = resolvePageLimit(args.limit)
    const offset = Math.max(0, args.offset ?? 0)
    const budget = offset + limit + 1

    const { callWhere, messageWhere } = scope
    const timeWhere = plan.timeWhere
    const timeOn = (field: 'createdAt' | 'ts') => (timeWhere ? { [field]: timeWhere } : {})

    const toolWhere = {
      ...callWhere,
      ...plan.toolWhere,
      ...timeOn('createdAt'),
    } as Prisma.ToolCallWhereInput
    const modelWhere: Prisma.ModelCallWhereInput = { ...callWhere, ...timeOn('createdAt') }
    const msgWhere: Prisma.MessageWhereInput = timeWhere
      ? { AND: [messageWhere, { createdAt: timeWhere }] }
      : messageWhere
    const ticketRowWhere = scope.ticketId ? { ticketId: scope.ticketId } : { ticketId: '' }

    const useTicketRows = plan.sources.ticketRows && scope.hasTicketSources
    const auditCap = Math.min(budget, MAX_TRACE_AUDIT_ROWS)

    const [modelCalls, toolCalls, messages, transitions, comments, auditRows, activityTurns] =
      await Promise.all([
        plan.sources.modelCalls
          ? this.prisma.modelCall.findMany({
              where: modelWhere,
              select: MODEL_CALL_TIMELINE_SELECT,
              orderBy: { createdAt: 'asc' },
              take: budget,
            })
          : Promise.resolve([]),
        this.prisma.toolCall.findMany({
          where: toolWhere,
          select: TOOL_CALL_TIMELINE_SELECT,
          orderBy: { createdAt: 'asc' },
          take: budget,
        }),
        plan.sources.messages
          ? this.prisma.message.findMany({
              where: msgWhere,
              select: { id: true, role: true, seq: true, contentRef: true, createdAt: true },
              orderBy: { createdAt: 'asc' },
              take: budget,
            })
          : Promise.resolve([]),
        useTicketRows
          ? this.prisma.ticketTransition.findMany({
              where: { ...ticketRowWhere, ...timeOn('ts') },
              select: {
                id: true,
                fromState: true,
                toState: true,
                actorType: true,
                note: true,
                ts: true,
              },
              orderBy: { ts: 'asc' },
              take: budget,
            })
          : Promise.resolve([]),
        useTicketRows
          ? this.prisma.ticketComment.findMany({
              where: { ...ticketRowWhere, ...timeOn('createdAt') },
              select: {
                id: true,
                kind: true,
                authorType: true,
                body: true,
                seq: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'asc' },
              take: budget,
            })
          : Promise.resolve([]),
        plan.sources.audit
          ? this.loadAuditRows(scope.auditFilter, timeWhere, auditCap)
          : Promise.resolve([]),
        plan.sources.activities
          ? this.prisma.agentTurn.findMany({
              where: scope.activityTurnWhere,
              select: { id: true, startedAt: true, activities: true },
              orderBy: { startedAt: 'asc' },
              take: MAX_TRACE_ACTIVITY_TURNS,
            })
          : Promise.resolve([]),
      ])

    const [modelCount, toolCount, messageCount, transitionCount, commentCount] = await Promise.all([
      plan.sources.modelCalls
        ? this.prisma.modelCall.count({ where: modelWhere })
        : Promise.resolve(0),
      this.prisma.toolCall.count({ where: toolWhere }),
      plan.sources.messages ? this.prisma.message.count({ where: msgWhere }) : Promise.resolve(0),
      useTicketRows
        ? this.prisma.ticketTransition.count({ where: { ...ticketRowWhere, ...timeOn('ts') } })
        : Promise.resolve(0),
      useTicketRows
        ? this.prisma.ticketComment.count({ where: { ...ticketRowWhere, ...timeOn('createdAt') } })
        : Promise.resolve(0),
    ])

    const activities = activityTurns
      .flatMap((turn) => parseActivities(turn.id, turn.startedAt, turn.activities))
      .filter((row) => inStepRange(row.stepIndex, plan))

    const sources: TraceTimelineSources = {
      grain: scope.grain,
      modelCalls,
      toolCalls,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        seq: message.seq,
        content: decodeInlineContent(message.contentRef),
        createdAt: message.createdAt,
      })),
      activities,
      transitions,
      comments,
      audit: auditRows.map((row) => ({
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId ?? '',
        policyDecision: row.policyDecision,
        createdAt: row.createdAt,
      })),
    }

    // A `sources` az `offset + limit + 1` méretű, forrásonként korlátos szuperhalmaz;
    // a globális lapot ebből explicit ablakkal vágjuk ki. (A `toListPage` NEM
    // offsetel — az egy take+1 ablakra való, nem egy összefésült idővonalra.)
    const timeline = applyActivityStepRange(buildTimeline(sources), plan)
    const items = timeline.slice(offset, offset + limit)

    // A forrásonkénti `count` pontos; az audit-szelet és az aktivitás-források
    // felső korlátosak, ilyenkor a teljes szám alsó becslés.
    const totalCount =
      modelCount +
      toolCount +
      messageCount +
      transitionCount +
      commentCount +
      activities.length +
      sources.audit.length
    const totalCountExact =
      sources.audit.length < auditCap && activityTurns.length < MAX_TRACE_ACTIVITY_TURNS

    return {
      view: 'detail',
      runId: scope.runId,
      grain: scope.grain,
      entries: items,
      returnedCount: items.length,
      limit,
      offset,
      totalCount,
      totalCountExact,
      truncated: offset + items.length < totalCount,
      filters: plan.filters,
    }
  }

  /**
   * Audit-sorok a szkóp szerint. Chat-kötött ticketnél a broker ticket-horgonnyal
   * (`conversationId` null) és a chat conversation-horgonnyal is ír — AND helyett
   * két lekérdezés, id szerint deduplikálva, időrendben vágva.
   */
  private async loadAuditRows(
    filter: TraceAuditFilter,
    timeWhere: { gte?: Date; lte?: Date } | undefined,
    limit: number,
  ) {
    const since = timeWhere?.gte ?? filter.since
    const until = timeWhere?.lte ?? filter.until
    const base = {
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      order: 'asc' as const,
      limit,
    }

    if (filter.mode === 'or' && filter.ticketId && filter.conversationId) {
      const [byTicket, byConversation] = await Promise.all([
        this.audit.findMany({ ...base, ticketId: filter.ticketId }),
        this.audit.findMany({ ...base, conversationId: filter.conversationId }),
      ])
      const byId = new Map<string, (typeof byTicket)[number]>()
      for (const row of [...byTicket, ...byConversation]) {
        byId.set(row.id, row)
      }
      return [...byId.values()]
        .sort((a, b) => {
          const at = a.createdAt.getTime() - b.createdAt.getTime()
          if (at !== 0) return at
          return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0
        })
        .slice(0, limit)
    }

    return this.audit.findMany({
      ...base,
      ...(filter.ticketId ? { ticketId: filter.ticketId } : {}),
      ...(filter.conversationId ? { conversationId: filter.conversationId } : {}),
    })
  }

  private async loadProcessRun(
    tenantId: string,
    args: Extract<RunTraceArgs, { grain: 'process' }>,
    runAnalystIds: string[],
  ): Promise<RunTraceProcessResult> {
    const process = await this.prisma.processInstance.findFirst({
      where: { id: args.runId, tenantId },
      include: {
        steps: { orderBy: { startedAt: 'asc' } },
        delegations: { orderBy: { createdAt: 'asc' } },
        playbookVersion: { select: { id: true, contentHash: true, spec: true } },
      },
    })
    if (!process) throw new RunIndexNotFoundError()
    if (process.startedByAgentId && runAnalystIds.includes(process.startedByAgentId)) {
      throw new RunIndexNotFoundError()
    }

    const spec = projectPlaybookSpecForTrace({
      playbookVersionId: process.playbookVersion.id,
      contentHash: process.playbookContentHash,
      spec: process.playbookVersion.spec,
    })

    const parsedSpec = process.playbookVersion.spec as {
      entryStepId?: string
      transitions?: Array<{ fromStepId: string; toStepId: string }>
    }

    const processInput =
      process.inputPayload && typeof process.inputPayload === 'object' && !Array.isArray(process.inputPayload)
        ? (process.inputPayload as Record<string, unknown>)
        : {}

    return buildProcessTraceView({
      process: mapProcessInstance(process),
      steps: process.steps.map(mapProcessStep),
      delegations: process.delegations.map(mapDelegationEdge),
      playbookSpec: spec,
      entryStepId: parsedSpec.entryStepId ?? spec.steps[0]?.id ?? '',
      transitions: parsedSpec.transitions ?? [],
      processInput,
      view: args.view,
      limit: args.limit,
      offset: args.offset,
    })
  }
}
