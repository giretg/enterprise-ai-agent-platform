import type { AgentTurn, Ticket } from '@prisma/client'
import type { ActiveRun, ActiveRunPhase } from '@/lib/active-runs'
import { readTicketRuntimeProgress } from '@/domain/agent/ticket-runtime-progress'

/** Sync a repository ACTIVE_AGENT_TURN_STATUSES listájával. */
const ACTIVE_CHAT_STATUSES = new Set(['queued', 'running', 'streaming'])

/**
 * A lezárt lépés státusza nem hordoz információt („… (done)” minden során),
 * a folyamatban lévő vagy hibás viszont igen — csak azt írjuk ki, magyarul.
 */
function activityStatusSuffix(status: string | null): string | null {
  switch (status) {
    case null:
    case 'done':
    case 'completed':
    case 'ok':
    case 'success':
      return null
    case 'running':
    case 'in_progress':
      return 'folyamatban'
    case 'error':
    case 'failed':
      return 'hiba'
    case 'pending':
    case 'queued':
      return 'várakozik'
    default:
      return status
  }
}

function summarizeActivities(activities: unknown): string | null {
  if (!Array.isArray(activities) || activities.length === 0) return null
  const last = activities[activities.length - 1] as { title?: unknown; kind?: unknown; status?: unknown }
  const title = typeof last.title === 'string' ? last.title : null
  const kind = typeof last.kind === 'string' ? last.kind : null
  const status = typeof last.status === 'string' ? last.status : null
  const suffix = activityStatusSuffix(status)
  const text = title ?? kind
  if (!text) return null
  return suffix ? `${text} — ${suffix}` : text
}

export type ActiveRunViewer = {
  userId: string
}

function chatPhase(status: string): ActiveRunPhase {
  return ACTIVE_CHAT_STATUSES.has(status) ? 'active' : 'completed'
}

function ticketPhase(state: string): ActiveRunPhase {
  return state === 'ready' ||
    state === 'in_progress' ||
    state === 'awaiting_human' ||
    state === 'needs_info'
    ? 'active'
    : 'completed'
}

function ticketCanStart(ticket: Ticket): boolean {
  return (
    ticket.state === 'ready' &&
    ticket.assigneeType === 'agent' &&
    Boolean(ticket.assigneeId)
  )
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
    canStart: false,
    targetId: turn.conversationId,
    agentId: turn.agentId,
  }
}

export function activeRunFromTicket(ticket: Ticket): ActiveRun {
  const progress = readTicketRuntimeProgress(ticket.payload)
  const phase = ticketPhase(ticket.state)
  const canStart = ticketCanStart(ticket)
  return {
    kind: 'ticket',
    id: ticket.id,
    title: ticket.title || `Ticket ${ticket.id.slice(0, 8)}…`,
    href: `/control-plane/tickets/${ticket.id}`,
    status: ticket.state,
    phase,
    latestActivity:
      progress
        ? summarizeActivities(progress.activities)
        : canStart
          ? 'Indításra kész — kattints az Indítás gombra'
          : null,
    startedAt: (ticket.lockedAt ?? ticket.updatedAt).toISOString(),
    finishedAt: phase === 'completed' ? ticket.updatedAt.toISOString() : null,
    canStop: ticket.state === 'in_progress',
    canStart,
    targetId: ticket.id,
    agentId: ticket.agentId,
  }
}
