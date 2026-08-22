/** RA-04 — `run_trace` tool bemenet/kimenet típusai (chat / ticket ág). */

import type { RunIndexGrain } from './run-index-types'

/** Chat/ticket ág — a folyamat-nézet (RA-05) külön `grain: 'process'`. */
export type RunTraceGrain = Extract<RunIndexGrain, 'turn' | 'ticket'>

export type RunTraceView = 'summary' | 'detail'

export type RunTraceArgs = {
  grain: RunTraceGrain
  runId: string
  /** Alapértelmezés: `summary` — fejléc-összefoglaló; `detail` lapozott idővonal. */
  view?: RunTraceView
  /** Lapméret (alap: 50, plafon: 200). */
  limit?: number
  offset?: number
  /** ISO 8601 — időablak alsó határa (inkluzív). */
  since?: string
  /** ISO 8601 — időablak felső határa (inkluzív). */
  until?: string
  /** Aktivitás-lépés tartomány (0-alapú index, fordulónként). */
  stepFrom?: number
  stepTo?: number
  toolName?: string
  status?: string
  outcome?: string
}

export type RunTraceToolAgg = {
  toolName: string
  outcome: string | null
  count: number
}

export type RunTraceTokenPoint = {
  at: string
  promptTokens: number
  completionTokens: number
  cachedPromptTokens: number | null
}

export type RunTraceNonOkCall = {
  id: string
  toolName: string
  status: string
  outcome: string | null
  createdAt: string
}

export type RunTraceSummary = {
  runId: string
  grain: RunTraceGrain
  agentId: string
  agentName: string
  conversationId: string | null
  ticketId: string | null
  startedAt: string
  finishedAt: string | null
  status: string
  turnCount: number
  deniedCount: number
  toolCallCount: number
  toolCallsByToolAndOutcome: RunTraceToolAgg[]
  tokenCurve: RunTraceTokenPoint[]
  nonOkToolCalls: RunTraceNonOkCall[]
  /** True, ha több nem-ok hívás lenne, mint amennyit az összefoglaló visszaad. */
  nonOkToolCallsTruncated: boolean
}

export type RunTraceTimelineEntry =
  | {
      kind: 'model_call'
      seq: number
      at: string
      id: string
      agentTurnId: string | null
      provider: string
      model: string
      promptTokens: number
      completionTokens: number
      cachedPromptTokens: number | null
      latencyMs: number
      status: string
    }
  | {
      kind: 'tool_call'
      seq: number
      at: string
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
    }
  | {
      kind: 'message'
      seq: number
      at: string
      id: string
      role: string
      messageSeq: number
      content: string | null
    }
  | {
      kind: 'activity'
      seq: number
      at: string
      turnId: string
      stepIndex: number
      activity: unknown
    }
  | {
      kind: 'ticket_transition'
      seq: number
      at: string
      id: string
      fromState: string
      toState: string
      actorType: string
      note: string | null
    }
  | {
      kind: 'ticket_comment'
      seq: number
      at: string
      id: string
      commentKind: string
      authorType: string
      body: string
      commentSeq: number
    }
  | {
      kind: 'audit'
      seq: number
      at: string
      action: string
      targetType: string
      targetId: string
      policyDecision: string | null
    }

export type RunTraceFilters = {
  since: string | null
  until: string | null
  stepFrom: number | null
  stepTo: number | null
  toolName: string | null
  status: string | null
  outcome: string | null
}

export type RunTraceSummaryResult = {
  view: 'summary'
  runId: string
  grain: RunTraceGrain
  summary: RunTraceSummary
}

export type RunTraceDetailResult = {
  view: 'detail'
  runId: string
  grain: RunTraceGrain
  entries: RunTraceTimelineEntry[]
  returnedCount: number
  limit: number
  offset: number
  totalCount: number
  truncated: boolean
  filters: RunTraceFilters
}

export type RunTraceResult = RunTraceSummaryResult | RunTraceDetailResult
