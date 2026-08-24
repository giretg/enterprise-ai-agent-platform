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
  /** Ticket `ready` + agent assignee — a felhasználó indíthatja a feldolgozást. */
  canStart: boolean
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

/**
 * Az agent épp dolgozik ezen a futáson (számol / streamel) —
 * nem számít, ha emberi inputra vagy indításra vár.
 */
export function isAgentActivelyWorking(run: ActiveRun): boolean {
  if (run.phase !== 'active' || !run.agentId) return false
  if (
    run.status === 'awaiting_human' ||
    run.status === 'needs_info' ||
    run.status === 'ready' ||
    run.status === 'stalled'
  ) {
    return false
  }
  return true
}

/** Agent-id-k, amiknek van legalább egy aktívan futó saját ügyük. */
export function workingAgentIds(runs: readonly ActiveRun[]): Set<string> {
  const ids = new Set<string>()
  for (const run of runs) {
    if (isAgentActivelyWorking(run) && run.agentId) ids.add(run.agentId)
  }
  return ids
}
