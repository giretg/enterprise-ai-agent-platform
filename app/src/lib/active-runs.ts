/**
 * Egyesített „futások” DTO — chat-forduló + ticket (aktív és lefutott).
 */
export type ActiveRunKind = 'chat_turn' | 'ticket'

export type ActiveRunPhase = 'active' | 'completed'

export type ActiveRun = {
  kind: ActiveRunKind
  id: string
  title: string
  href: string
  status: string
  phase: ActiveRunPhase
  latestActivity: string | null
  startedAt: string
  /** Terminális futásoknál a befejezés ideje; aktívnál null. */
  finishedAt: string | null
  canStop: boolean
  /** Chat: conversationId; Ticket: ticketId (ugyanaz mint id). */
  targetId: string
  agentId: string | null
}

export type ActiveRunsResponse = {
  runs: ActiveRun[]
}

export function activeRunKey(run: Pick<ActiveRun, 'kind' | 'id'>): string {
  return `${run.kind}:${run.id}`
}
