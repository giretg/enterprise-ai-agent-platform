import type { AgentTurn, Ticket } from '@prisma/client'
import type { ActiveRun, ActiveRunPhase } from '@/lib/active-runs'
import { readTicketRuntimeProgress } from '@/domain/agent/ticket-runtime-progress'

/** Sync a repository ACTIVE_AGENT_TURN_STATUSES listájával. */
const ACTIVE_CHAT_STATUSES = new Set(['queued', 'running', 'streaming'])

function summarizeActivities(activities: unknown): string | null {
  if (!Array.isArray(activities) || activities.length === 0) return null
  const last = activities[activities.length - 1] as { title?: unknown; kind?: unknown; status?: unknown }
  const title = typeof last.title === 'string' ? last.title : null
  const kind = typeof last.kind === 'string' ? last.kind : null
  const status = typeof last.status === 'string' ? last.status : null
  if (title) return status ? `${title} (${status})` : title
  if (kind) return status ? `${kind} (${status})` : kind
  return null
}

export type ActiveRunViewer = {
  userId: string
}

function chatPhase(status: string): ActiveRunPhase {
  return ACTIVE_CHAT_STATUSES.has(status) ? 'active' : 'completed'
}

function ticketPhase(state: string): ActiveRunPhase {
  return state === 'in_progress' || state === 'awaiting_human' || state === 'needs_info'
    ? 'active'
    : 'completed'
}

/**
 * E9: chat-forduló Stop csak a létrehozónak (tenant+createdById).
 * Ticket Stop: bármely tenant-operator (a cancel route tenant-szintű).
 */
export function activeRunFromChatTurn(
  turn: AgentTurn,
  viewer: ActiveRunViewer,
  agentName?: string | null,
): ActiveRun {
  const phase = chatPhase(turn.status)
  const name = agentName?.trim() || `Agent ${turn.agentId.slice(0, 8)}…`
  return {
    kind: 'chat_turn',
    id: turn.id,
    title: name,
    href: `/control-plane/agents/${turn.agentId}?conversation=${turn.conversationId}&openChat=1`,
    status: turn.cancelRequested && phase === 'active' ? 'cancelling' : turn.status,
    phase,
    latestActivity:
      turn.cancelRequested && phase === 'active'
        ? 'Leállítás folyamatban…'
        : summarizeActivities(turn.activities),
    startedAt: turn.startedAt.toISOString(),
    finishedAt: turn.finishedAt ? turn.finishedAt.toISOString() : null,
    canStop: phase === 'active' && turn.createdById === viewer.userId,
    targetId: turn.conversationId,
    agentId: turn.agentId,
  }
}

export function activeRunFromTicket(ticket: Ticket): ActiveRun {
  const progress = readTicketRuntimeProgress(ticket.payload)
  const phase = ticketPhase(ticket.state)
  return {
    kind: 'ticket',
    id: ticket.id,
    title: ticket.title || `Ticket ${ticket.id.slice(0, 8)}…`,
    href: `/control-plane/tickets/${ticket.id}`,
    status: ticket.state,
    phase,
    latestActivity: progress ? summarizeActivities(progress.activities) : null,
    startedAt: (ticket.lockedAt ?? ticket.updatedAt).toISOString(),
    finishedAt: phase === 'completed' ? ticket.updatedAt.toISOString() : null,
    canStop: ticket.state === 'in_progress',
    targetId: ticket.id,
    agentId: ticket.agentId,
  }
}
