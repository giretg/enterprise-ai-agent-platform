import type { AssigneeType, Ticket } from '@prisma/client'
import { personaFor } from '@/lib/agent-persona'

export function readTicketPayload(payload: unknown): Record<string, unknown> | null {
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    return payload as Record<string, unknown>
  }
  return null
}

/** Feladat leírás a payloadból (chat ticket_create, wiki question, stb.). */
export function extractTaskDescription(payload: unknown): string | null {
  const record = readTicketPayload(payload)
  if (!record) return null

  const keys = ['task', 'question', 'description', 'reason'] as const
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  return null
}

export type AssigneeDisplay = {
  type: AssigneeType | null
  label: string
  detail: string | null
}

export function formatAgentAssignee(agentName: string): AssigneeDisplay {
  const persona = personaFor(agentName)
  return {
    type: 'agent',
    label: persona.nickname,
    detail: agentName,
  }
}

export function formatHumanAssignee(userName?: string | null): AssigneeDisplay {
  return {
    type: 'human',
    label: userName?.trim() || 'Emberi review',
    detail: userName ? 'Operátor / approver döntésre vár' : 'Nincs konkrét személy — a boardon kezelhető',
  }
}

export function formatTicketAssignee(input: {
  assigneeType: AssigneeType | null
  assigneeId: string | null
  agentId: string | null
  assigneeAgentName?: string | null
  assigneeUserName?: string | null
  responsibleAgentName?: string | null
}): AssigneeDisplay {
  if (input.assigneeType === 'agent' && input.assigneeId && input.assigneeAgentName) {
    return formatAgentAssignee(input.assigneeAgentName)
  }

  if (input.assigneeType === 'agent' && input.assigneeId) {
    return {
      type: 'agent',
      label: 'AI agent',
      detail: `Agent ID: ${input.assigneeId}`,
    }
  }

  if (input.assigneeType === 'human') {
    return formatHumanAssignee(input.assigneeUserName)
  }

  if (input.agentId && input.responsibleAgentName) {
    const persona = formatAgentAssignee(input.responsibleAgentName)
    return {
      ...persona,
      detail: `${input.responsibleAgentName} (felelős agent)`,
    }
  }

  return {
    type: null,
    label: 'Nincs hozzárendelve',
    detail: null,
  }
}

export type TicketDisplayExtras = {
  taskDescription: string | null
  assignee: AssigneeDisplay
}

export function buildTicketDisplayExtras(
  ticket: Pick<Ticket, 'payload' | 'assigneeType' | 'assigneeId' | 'agentId'>,
  names: {
    assigneeAgentName?: string | null
    assigneeUserName?: string | null
    responsibleAgentName?: string | null
  } = {},
): TicketDisplayExtras {
  return {
    taskDescription: extractTaskDescription(ticket.payload),
    assignee: formatTicketAssignee({
      assigneeType: ticket.assigneeType,
      assigneeId: ticket.assigneeId,
      agentId: ticket.agentId,
      ...names,
    }),
  }
}

export type TicketCreatorDisplay = {
  id: string
  label: string
}

export type EnrichedBoardTicket = Pick<
  Ticket,
  | 'id'
  | 'title'
  | 'type'
  | 'state'
  | 'assigneeType'
  | 'assigneeId'
  | 'agentId'
  | 'createdAt'
  | 'updatedAt'
  | 'createdById'
> &
  TicketDisplayExtras & {
    creator: TicketCreatorDisplay
  }

export function formatTicketDateTime(value: Date | string): string {
  return new Date(value).toLocaleString('hu-HU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function getAssigneeFilterKey(
  ticket: Pick<Ticket, 'assigneeType' | 'assigneeId' | 'agentId'>,
): string {
  if (ticket.assigneeType === 'agent' && ticket.assigneeId) return `agent:${ticket.assigneeId}`
  if (ticket.assigneeType === 'human' && ticket.assigneeId) return `human:${ticket.assigneeId}`
  if (ticket.agentId) return `agent:${ticket.agentId}`
  return 'unassigned'
}

export function matchesAssigneeFilter(
  ticket: Pick<Ticket, 'assigneeType' | 'assigneeId' | 'agentId'>,
  filterKey: string,
): boolean {
  if (filterKey === 'all') return true
  return getAssigneeFilterKey(ticket) === filterKey
}

export function enrichTicketsForBoard(
  tickets: Ticket[],
  names: {
    agents: Map<string, string>
    users: Map<string, string>
  },
): EnrichedBoardTicket[] {
  return tickets.map((ticket) => {
    const display = buildTicketDisplayExtras(ticket, {
      assigneeAgentName:
        ticket.assigneeType === 'agent' && ticket.assigneeId
          ? (names.agents.get(ticket.assigneeId) ?? null)
          : null,
      assigneeUserName:
        ticket.assigneeType === 'human' && ticket.assigneeId
          ? (names.users.get(ticket.assigneeId) ?? null)
          : null,
      responsibleAgentName: ticket.agentId ? (names.agents.get(ticket.agentId) ?? null) : null,
    })

    return {
      id: ticket.id,
      title: ticket.title,
      type: ticket.type,
      state: ticket.state,
      assigneeType: ticket.assigneeType,
      assigneeId: ticket.assigneeId,
      agentId: ticket.agentId,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      createdById: ticket.createdById,
      ...display,
      creator: {
        id: ticket.createdById,
        label: names.users.get(ticket.createdById) ?? 'Ismeretlen',
      },
    }
  })
}
