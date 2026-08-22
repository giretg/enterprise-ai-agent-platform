/** RA-04 / RA-05 — `run_trace` tool bemenet/kimenet típusai. */

import type { RunIndexGrain } from './run-index-types'

export type RunTraceGrain = RunIndexGrain

export type RunTraceView = 'summary' | 'detail'

/** Chat/ticket ág — lapozott idővonal. */
export type RunTraceTimelineArgs = {
  grain: Extract<RunTraceGrain, 'turn' | 'ticket'>
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

/** Folyamat ág (RA-05) — lépés be-/kimenet, átadási élek, playbook-spec. */
export type RunTraceProcessArgs = {
  grain: 'process'
  runId: string
}

export type RunTraceArgs = RunTraceTimelineArgs | RunTraceProcessArgs

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
  grain: Extract<RunTraceGrain, 'turn' | 'ticket'>
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
  grain: Extract<RunTraceGrain, 'turn' | 'ticket'>
  summary: RunTraceSummary
}

export type RunTraceDetailResult = {
  view: 'detail'
  runId: string
  grain: Extract<RunTraceGrain, 'turn' | 'ticket'>
  entries: RunTraceTimelineEntry[]
  returnedCount: number
  limit: number
  offset: number
  totalCount: number
  truncated: boolean
  filters: RunTraceFilters
}

/** RA-05 — playbook-verzió spec vetülete a folyamat-nézethez. */
export type RunTracePlaybookInputSlot = {
  name: string
  type: string
  required: boolean
  source: 'config' | 'trigger' | 'step'
  description?: string
}

export type RunTracePlaybookStepSpec = {
  id: string
  name: string
  instructionTemplate?: string
  inputSlots?: RunTracePlaybookInputSlot[]
}

export type RunTracePlaybookGateSpec = {
  id: string
  type: string
  criticality?: string
  blocking: boolean
}

export type RunTracePlaybookSpec = {
  playbookVersionId: string
  contentHash: string
  criticality?: string
  steps: RunTracePlaybookStepSpec[]
  gates: RunTracePlaybookGateSpec[]
}

export type RunTraceProcessInstance = {
  id: string
  processType: string
  status: string
  triggerType: string | null
  startedByType: string
  startedByUserId: string | null
  startedByAgentId: string | null
  inputPayload: unknown
  outputPayload: unknown
  rootTicketId: string | null
  conversationId: string | null
  startedAt: string
  completedAt: string | null
  failedAt: string | null
}

export type RunTraceProcessStep = {
  stepId: string
  stepName: string
  status: string
  assignedRole: string
  assignedAgentId: string | null
  assignedUserId: string | null
  ticketId: string | null
  resultPayload: unknown
  startedAt: string | null
  completedAt: string | null
  failedAt: string | null
}

export type RunTraceDelegationEdge = {
  id: string
  fromStepId: string
  toStepId: string
  fromActorType: string
  fromAgentId: string | null
  fromUserId: string | null
  toActorType: string
  toAgentId: string | null
  toUserId: string | null
  status: string
  createdAt: string
  deliveredAt: string | null
  acceptedAt: string | null
  doneAt: string | null
  failedAt: string | null
  metadata: unknown
}

/** Lépés-szintű hiányzó kötelező input-slot (playbook vs. tényleges átadás). */
export type RunTraceStepSlotGap = {
  stepId: string
  missingRequiredSlots: string[]
}

export type RunTraceProcessResult = {
  view: 'process'
  runId: string
  grain: 'process'
  process: RunTraceProcessInstance
  steps: RunTraceProcessStep[]
  delegations: RunTraceDelegationEdge[]
  playbookSpec: RunTracePlaybookSpec
  slotGaps: RunTraceStepSlotGap[]
}

export type RunTraceResult = RunTraceSummaryResult | RunTraceDetailResult | RunTraceProcessResult
