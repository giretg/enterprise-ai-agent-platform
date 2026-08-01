import type { AssigneeType, ProcessStatus, Ticket } from '@prisma/client'
import { agentDisplayName } from '@/lib/agent-persona'

export type TicketProcessBadgeInfo = {
  id: string
  processType: string
  status: ProcessStatus
}

export type AgentLabelInfo = {
  name: string
  personaNickname?: string | null
}

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

export function formatAgentAssignee(
  agentName: string,
  personaNickname?: string | null,
): AssigneeDisplay {
  return {
    type: 'agent',
    label: agentDisplayName(agentName, { personaNickname }),
    detail: null,
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
  assigneeAgentNickname?: string | null
  assigneeUserName?: string | null
  responsibleAgentName?: string | null
  responsibleAgentNickname?: string | null
}): AssigneeDisplay {
  if (input.assigneeType === 'agent' && input.assigneeId && input.assigneeAgentName) {
    return formatAgentAssignee(input.assigneeAgentName, input.assigneeAgentNickname)
  }

  if (input.assigneeType === 'agent' && input.assigneeId) {
    return {
      type: 'agent',
      label: 'AI munkatárs',
      detail: null,
    }
  }

  if (input.assigneeType === 'human') {
    return formatHumanAssignee(input.assigneeUserName)
  }

  if (input.agentId && input.responsibleAgentName) {
    return formatAgentAssignee(input.responsibleAgentName, input.responsibleAgentNickname)
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
    assigneeAgentNickname?: string | null
    assigneeUserName?: string | null
    responsibleAgentName?: string | null
    responsibleAgentNickname?: string | null
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
  type?: 'agent' | 'human'
}

/** Agent által létrehozott ticketeknél a payload tartalmazza a valódi létrehozót. */
export function extractCreatorAgentId(payload: unknown): string | null {
  const record = readTicketPayload(payload)
  if (!record) return null

  for (const key of ['createdByAgentId', 'requesterAgentId'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  return null
}

export function formatTicketCreator(input: {
  createdById: string
  payload: unknown
  agents: Map<string, AgentLabelInfo>
  userNames: Map<string, string>
}): TicketCreatorDisplay {
  const creatorAgentId = extractCreatorAgentId(input.payload)
  if (creatorAgentId) {
    const agent = input.agents.get(creatorAgentId)
    if (agent) {
      return {
        id: creatorAgentId,
        label: agentDisplayName(agent.name, agent),
        type: 'agent',
      }
    }
    return {
      id: creatorAgentId,
      label: 'AI munkatárs',
      type: 'agent',
    }
  }

  return {
    id: input.createdById,
    label: input.userNames.get(input.createdById) ?? 'Ismeretlen',
    type: 'human',
  }
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
  | 'processInstanceId'
> &
  TicketDisplayExtras & {
    creator: TicketCreatorDisplay
    process: TicketProcessBadgeInfo | null
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
    agents: Map<string, AgentLabelInfo>
    users: Map<string, string>
    processes?: Map<string, { processType: string; status: ProcessStatus }>
  },
): EnrichedBoardTicket[] {
  return tickets.map((ticket) => {
    const assigneeAgent =
      ticket.assigneeType === 'agent' && ticket.assigneeId
        ? names.agents.get(ticket.assigneeId)
        : undefined
    const responsibleAgent = ticket.agentId ? names.agents.get(ticket.agentId) : undefined

    const display = buildTicketDisplayExtras(ticket, {
      assigneeAgentName: assigneeAgent?.name ?? null,
      assigneeAgentNickname: assigneeAgent?.personaNickname ?? null,
      assigneeUserName:
        ticket.assigneeType === 'human' && ticket.assigneeId
          ? (names.users.get(ticket.assigneeId) ?? null)
          : null,
      responsibleAgentName: responsibleAgent?.name ?? null,
      responsibleAgentNickname: responsibleAgent?.personaNickname ?? null,
    })

    const process = ticket.processInstanceId
      ? (() => {
          const info = names.processes?.get(ticket.processInstanceId as string)
          return info
            ? { id: ticket.processInstanceId as string, processType: info.processType, status: info.status }
            : null
        })()
      : null

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
      processInstanceId: ticket.processInstanceId,
      ...display,
      creator: formatTicketCreator({
        createdById: ticket.createdById,
        payload: ticket.payload,
        agents: names.agents,
        userNames: names.users,
      }),
      process,
    }
  })
}
