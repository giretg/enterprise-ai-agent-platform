import type { AgentTurn, Ticket } from '@prisma/client'
import type { ActiveRun } from '@/lib/active-runs'

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

function summarizeTicketProgress(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const progress = (payload as Record<string, unknown>).runtimeProgress
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return null
  const activities = (progress as Record<string, unknown>).activities
  return summarizeActivities(activities)
}

export function activeRunFromChatTurn(turn: AgentTurn): ActiveRun {
  return {
    kind: 'chat_turn',
    id: turn.id,
    title: `Chat válasz · ${turn.agentId.slice(0, 8)}…`,
    href: `/control-plane/agents/${turn.agentId}?conversation=${turn.conversationId}&openChat=1`,
    status: turn.status,
    latestActivity: summarizeActivities(turn.activities),
    startedAt: turn.startedAt.toISOString(),
    canStop: true,
    targetId: turn.conversationId,
    agentId: turn.agentId,
  }
}

export function activeRunFromTicket(ticket: Ticket): ActiveRun {
  return {
    kind: 'ticket',
    id: ticket.id,
    title: ticket.title || `Ticket ${ticket.id.slice(0, 8)}…`,
    href: `/control-plane/tickets/${ticket.id}`,
    status: ticket.state,
    latestActivity: summarizeTicketProgress(ticket.payload),
    startedAt: (ticket.lockedAt ?? ticket.updatedAt).toISOString(),
    canStop: true,
    targetId: ticket.id,
    agentId: ticket.agentId,
  }
}
