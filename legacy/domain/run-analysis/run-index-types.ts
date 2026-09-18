/** RA-03 — `run_index` tool bemenet/kimenet típusai. */

export type RunIndexGrain = 'turn' | 'ticket' | 'process'

export type RunIndexArgs = {
  /** Agent UUID — közvetlen feloldás. */
  agentId?: string
  /** Emberi hivatkozás (név, becenév) — a legjobb egyezésre oldódik fel. */
  agentQuery?: string
  conversationId?: string
  ticketId?: string
  processInstanceId?: string
  playbookVersionId?: string
  /** ISO 8601 — időablak alsó határa (inkluzív). */
  since?: string
  /** ISO 8601 — időablak felső határa (inkluzív). */
  until?: string
  /** Visszaadott futások max. száma (alap: 50, plafon: 200). */
  limit?: number
  /** Explicit futás-azonosítók — több futás egyszerre is kérhető. */
  agentTurnIds?: string[]
  ticketIds?: string[]
  processInstanceIds?: string[]
}

export type RunIndexHeader = {
  runId: string
  grain: RunIndexGrain
  agentId: string
  agentName: string
  startedAt: string
  finishedAt: string | null
  conversationId: string | null
  ticketId: string | null
  processInstanceId: string | null
  turnCount: number
  toolCallCount: number
  deniedCount: number
  promptTokens: number
  completionTokens: number
  cachedPromptTokens: number
  costEstimate: number
  status: string
  /** Leállás oka: AgentTurn.reason/error, ticket állapot, vagy folyamat-státusz. */
  stopReason: string | null
}

export type RunIndexScopeSummary = {
  agentId: string | null
  agentQuery: string | null
  conversationId: string | null
  ticketId: string | null
  processInstanceId: string | null
  playbookVersionId: string | null
  since: string | null
  until: string | null
}

export type RunIndexResult = {
  runs: RunIndexHeader[]
  returnedCount: number
  limit: number
  /** True, ha a szkóp több futást adott volna, mint a limit — a lista vágott. */
  truncated: boolean
  scope: RunIndexScopeSummary
}

export type RunIndexCandidate = {
  grain: RunIndexGrain
  id: string
  startedAt: Date
}
