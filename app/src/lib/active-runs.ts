/**
 * Egyesített „aktív futások” DTO — chat-forduló + in_progress ticket.
 */
export type ActiveRunKind = 'chat_turn' | 'ticket'

export type ActiveRun = {
  kind: ActiveRunKind
  id: string
  title: string
  href: string
  status: string
  latestActivity: string | null
  startedAt: string
  canStop: boolean
  /** Chat: conversationId; Ticket: ticketId (ugyanaz mint id). */
  targetId: string
  agentId: string | null
}

export type ActiveRunsResponse = {
  runs: ActiveRun[]
}
