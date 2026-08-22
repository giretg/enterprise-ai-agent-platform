/**
 * issue #237 / EFF-09–EFF-10 — a hatékonysági detektor korlátos, tenant-szűrt adatútja.
 *
 * A detektor tiszta; ide tartozik a futás-lista DB-oldali groupBy/aggregációja,
 * a részletes sorok indexelt, felső korlátos lekérdezése, és a normalizált
 * bemenet (`EfficiencyRun[]`) előállítása.
 *
 * Ablak: a választott időtartam **vagy** a legutóbbi 20 futás, amelyik szűkebb.
 * Grain: chat → AgentTurn; task → Ticket; agentTurnId nélküli régebbi sorok →
 * Conversation (durvább bontás, a kimenet jelzi).
 *
 * Spec: docs/specs/AI-Agent-Platform-Feature-Spec-Efficiency-Advisor.md
 * Perf: docs/perf/github-issues/003-paginate-unbounded-lists.md
 */
import {
  EFFICIENCY_ADVISOR_DEFAULT_RANGE,
  evaluateEfficiencyAdvisor,
  efficiencyAdvisorRangeToSince,
  parseEfficiencyAdvisorRange,
  type EfficiencyAdvisorRange,
  type EfficiencyAdvisorView,
  type EfficiencyPatternKind,
  type EfficiencyRun,
  type EfficiencyRunKind,
  type EfficiencyRunModelCall,
  type EfficiencyRunToolCall,
} from '@/domain/agent/efficiency-advisor'
import { prisma } from '@/lib/db'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'

export const EFFICIENCY_ADVISOR_WINDOW_DAYS = 30
export const EFFICIENCY_ADVISOR_MAX_RUNS = 20
/** Részletes ModelCall sorok felső korlátja a kiválasztott futásokra. */
export const EFFICIENCY_ADVISOR_MAX_MODEL_ROWS = 2_000
/** Részletes ToolCall sorok felső korlátja a kiválasztott futásokra. */
export const EFFICIENCY_ADVISOR_MAX_TOOL_ROWS = 4_000

export const EFFICIENCY_ADVISOR_UNDO_KEY = 'efficiencyAdvisorUndo'

export {
  EFFICIENCY_ADVISOR_DEFAULT_RANGE,
  EFFICIENCY_ADVISOR_RANGE_LABELS,
  efficiencyAdvisorRangeToSince,
  parseEfficiencyAdvisorRange,
} from '@/domain/agent/efficiency-advisor'
export type { EfficiencyAdvisorRange }

export type EfficiencyRunKey = { kind: EfficiencyRunKind; id: string }

export type EfficiencyRunCandidate = EfficiencyRunKey & { latest: Date }

/**
 * EFF-09 kimenet: a detektor bemeneti típusa + a durvább (conversation) grain jelzése.
 */
export type EfficiencyRunsQueryResult = {
  runs: EfficiencyRun[]
  /** True, ha a kiválasztott futások között van beszélgetés-szintű (agentTurnId nélküli) grain. */
  coarseGranularity: boolean
  since: Date | undefined
  maxRuns: number
}

type ModelCallDetailRow = {
  agentTurnId: string | null
  ticketId: string | null
  conversationId: string | null
  promptTokens: number
  completionTokens: number
  cachedPromptTokens: number | null
  costEstimate: { toString(): string } | number
  createdAt: Date
  model: string
}

type ToolCallDetailRow = {
  agentTurnId: string | null
  ticketId: string | null
  conversationId: string | null
  toolName: string
  argsMeta: unknown
  resultMeta: unknown
}

export function runKeyString(key: EfficiencyRunKey): string {
  return `${key.kind}:${key.id}`
}

/** Egy ModelCall/ToolCall sor → futás-kulcs (turn > ticket > conversation). */
export function efficiencyRunKeyOf(row: {
  agentTurnId: string | null
  ticketId: string | null
  conversationId: string | null
}): EfficiencyRunKey | null {
  if (row.agentTurnId) return { kind: 'turn', id: row.agentTurnId }
  if (row.ticketId) return { kind: 'ticket', id: row.ticketId }
  if (row.conversationId) return { kind: 'conversation', id: row.conversationId }
  return null
}

/**
 * Három grain groupBy eredményéből a legutóbbi `maxRuns` futás — tiszta,
 * DB nélküli rangsorolás (tesztelhető).
 */
export function selectRecentRunCandidates(
  candidates: EfficiencyRunCandidate[],
  maxRuns: number = EFFICIENCY_ADVISOR_MAX_RUNS,
): EfficiencyRunCandidate[] {
  const byId = new Map<string, EfficiencyRunCandidate>()
  for (const candidate of candidates) {
    const id = runKeyString(candidate)
    const existing = byId.get(id)
    if (!existing || candidate.latest > existing.latest) {
      byId.set(id, candidate)
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.latest.getTime() - a.latest.getTime())
    .slice(0, Math.max(0, maxRuns))
}

/** Indexelt OR-szűrő a kiválasztott futásokra (turn / ticket / conversation). */
export function buildSelectedRunsOrFilter(
  selected: EfficiencyRunKey[],
): Array<{
  agentTurnId?: { in: string[] } | null
  ticketId?: { in: string[] } | null
  conversationId?: { in: string[] }
}> {
  const turnIds = selected.filter((g) => g.kind === 'turn').map((g) => g.id)
  const ticketIds = selected.filter((g) => g.kind === 'ticket').map((g) => g.id)
  const conversationIds = selected.filter((g) => g.kind === 'conversation').map((g) => g.id)

  const or: Array<{
    agentTurnId?: { in: string[] } | null
    ticketId?: { in: string[] } | null
    conversationId?: { in: string[] }
  }> = []
  if (turnIds.length) or.push({ agentTurnId: { in: turnIds } })
  if (ticketIds.length) or.push({ ticketId: { in: ticketIds }, agentTurnId: null })
  if (conversationIds.length) {
    or.push({ conversationId: { in: conversationIds }, agentTurnId: null, ticketId: null })
  }
  return or
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function appliedFromModelConfig(modelConfig: unknown): Partial<Record<EfficiencyPatternKind, boolean>> {
  const undo = asRecord(asRecord(modelConfig)[EFFICIENCY_ADVISOR_UNDO_KEY])
  const applied: Partial<Record<EfficiencyPatternKind, boolean>> = {}
  for (const kind of Object.keys(undo) as EfficiencyPatternKind[]) {
    applied[kind] = true
  }
  return applied
}

/** Részletes ModelCall + ToolCall sorok → normalizált detektor-bemenet. */
export function assembleEfficiencyRuns(input: {
  selected: EfficiencyRunCandidate[]
  modelRows: ModelCallDetailRow[]
  toolRows: ToolCallDetailRow[]
}): EfficiencyRun[] {
  const modelByRun = new Map<string, EfficiencyRunModelCall[]>()
  for (const row of input.modelRows) {
    const key = efficiencyRunKeyOf(row)
    if (!key) continue
    const id = runKeyString(key)
    const list = modelByRun.get(id) ?? []
    list.push({
      createdAt: row.createdAt,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      cachedPromptTokens: row.cachedPromptTokens,
      costEstimate: Number(row.costEstimate),
      model: row.model,
    })
    modelByRun.set(id, list)
  }

  const toolsByRun = new Map<string, EfficiencyRunToolCall[]>()
  for (const row of input.toolRows) {
    const key = efficiencyRunKeyOf(row)
    if (!key) continue
    const id = runKeyString(key)
    const list = toolsByRun.get(id) ?? []
    list.push({
      toolName: row.toolName,
      argsMeta: asRecord(row.argsMeta),
      resultMeta: row.resultMeta ? asRecord(row.resultMeta) : null,
    })
    toolsByRun.set(id, list)
  }

  return input.selected.map((candidate) => {
    const id = runKeyString(candidate)
    const modelCalls = [...(modelByRun.get(id) ?? [])].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
    return {
      id: candidate.id,
      kind: candidate.kind,
      modelCalls,
      toolCalls: toolsByRun.get(id) ?? [],
    }
  })
}

async function listRunCandidatesFromDb(
  agentId: string,
  since: Date | undefined,
): Promise<EfficiencyRunCandidate[]> {
  const baseWhere = since ? { agentId, createdAt: { gte: since } } : { agentId }

  // Három grain, mind DB-oldali groupBy + orderBy + take — nagy forgalomnál sem
  // töltünk be korlátlan csoportot. Per grain max MAX_RUNS, aztán összevonva újra vágunk.
  const [turnGroups, ticketGroups, conversationGroups] = await Promise.all([
    prisma.modelCall.groupBy({
      by: ['agentTurnId'],
      where: { ...baseWhere, agentTurnId: { not: null } },
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: 'desc' } },
      take: EFFICIENCY_ADVISOR_MAX_RUNS,
    }),
    prisma.modelCall.groupBy({
      by: ['ticketId'],
      where: { ...baseWhere, agentTurnId: null, ticketId: { not: null } },
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: 'desc' } },
      take: EFFICIENCY_ADVISOR_MAX_RUNS,
    }),
    prisma.modelCall.groupBy({
      by: ['conversationId'],
      where: {
        ...baseWhere,
        agentTurnId: null,
        ticketId: null,
        conversationId: { not: null },
      },
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: 'desc' } },
      take: EFFICIENCY_ADVISOR_MAX_RUNS,
    }),
  ])

  const candidates: EfficiencyRunCandidate[] = []
  for (const row of turnGroups) {
    if (!row.agentTurnId || !row._max.createdAt) continue
    candidates.push({ kind: 'turn', id: row.agentTurnId, latest: row._max.createdAt })
  }
  for (const row of ticketGroups) {
    if (!row.ticketId || !row._max.createdAt) continue
    candidates.push({ kind: 'ticket', id: row.ticketId, latest: row._max.createdAt })
  }
  for (const row of conversationGroups) {
    if (!row.conversationId || !row._max.createdAt) continue
    candidates.push({ kind: 'conversation', id: row.conversationId, latest: row._max.createdAt })
  }
  return candidates
}

async function loadRunsForAgent(
  agentId: string,
  options?: { now?: Date; range?: EfficiencyAdvisorRange },
): Promise<EfficiencyRunsQueryResult> {
  const now = options?.now ?? new Date()
  const range = options?.range ?? EFFICIENCY_ADVISOR_DEFAULT_RANGE
  const since = efficiencyAdvisorRangeToSince(range, now)
  const candidates = await listRunCandidatesFromDb(agentId, since)
  const selected = selectRecentRunCandidates(candidates, EFFICIENCY_ADVISOR_MAX_RUNS)

  if (selected.length === 0) {
    return {
      runs: [],
      coarseGranularity: false,
      since,
      maxRuns: EFFICIENCY_ADVISOR_MAX_RUNS,
    }
  }

  const orFilter = buildSelectedRunsOrFilter(selected)
  const detailWhere = since
    ? { agentId, createdAt: { gte: since }, OR: orFilter }
    : { agentId, OR: orFilter }

  // Részletes sorok CSAK a kiválasztott futásokra — indexelt OR + take felső korlát.
  const [modelRows, toolRows] = await Promise.all([
    prisma.modelCall.findMany({
      where: detailWhere,
      select: {
        agentTurnId: true,
        ticketId: true,
        conversationId: true,
        promptTokens: true,
        completionTokens: true,
        cachedPromptTokens: true,
        costEstimate: true,
        createdAt: true,
        model: true,
      },
      orderBy: { createdAt: 'asc' },
      take: EFFICIENCY_ADVISOR_MAX_MODEL_ROWS,
    }),
    prisma.toolCall.findMany({
      where: detailWhere,
      select: {
        agentTurnId: true,
        ticketId: true,
        conversationId: true,
        toolName: true,
        argsMeta: true,
        resultMeta: true,
      },
      orderBy: { createdAt: 'asc' },
      take: EFFICIENCY_ADVISOR_MAX_TOOL_ROWS,
    }),
  ])

  const runs = assembleEfficiencyRuns({ selected, modelRows, toolRows })
  return {
    runs,
    coarseGranularity: runs.some((run) => run.kind === 'conversation'),
    since,
    maxRuns: EFFICIENCY_ADVISOR_MAX_RUNS,
  }
}

/**
 * Detektor-bemenet előállítása: korlátos lekérdezések, tenant-szűrés,
 * futás-grain normalizálás. DoD: nincs unbounded findMany; a kimenet
 * `EfficiencyRun[]` (+ coarse jelzés).
 *
 * Lekérdezésszám: 1 agent + 3 groupBy (+ 0 vagy 2 detail findMany) — mind take-korlátos.
 */
export async function collectEfficiencyRuns(input: {
  agentId: string
  tenantId: string
  now?: Date
  range?: EfficiencyAdvisorRange
}): Promise<EfficiencyRunsQueryResult> {
  const agent = await prisma.agent.findUnique({
    where: { id: input.agentId },
    select: { id: true, tenantId: true },
  })
  if (!agent || !isAgentReachableFromTenant(agent.tenantId, input.tenantId)) {
    throw new Error('Agent not found')
  }
  return loadRunsForAgent(input.agentId, { now: input.now, range: input.range })
}

export async function loadEfficiencyAdvisorCard(input: {
  agentId: string
  tenantId: string
  range?: EfficiencyAdvisorRange
}): Promise<EfficiencyAdvisorView> {
  const range = parseEfficiencyAdvisorRange(input.range)
  const agent = await prisma.agent.findUnique({
    where: { id: input.agentId },
    select: { id: true, tenantId: true, modelConfig: true },
  })
  if (!agent || !isAgentReachableFromTenant(agent.tenantId, input.tenantId)) {
    throw new Error('Agent not found')
  }

  const { runs } = await loadRunsForAgent(input.agentId, { range })

  return {
    card: evaluateEfficiencyAdvisor(runs),
    applied: appliedFromModelConfig(agent.modelConfig),
    range,
  }
}
