import { prisma } from '@/lib/db'
import {
  isRunAsAuthorized,
  payloadRecord,
  readTicketConversationId,
  resolveTicketActingUserId,
  SCHEDULED_TASK_ID,
  type TicketActingUserTicket,
} from '@/lib/run-as-payload'

const AGENT_FILED_SOURCES = new Set(['agent_tool', 'agent_ask'])

function isHumanUserId(userId: string | null | undefined): userId is string {
  return Boolean(userId && userId !== '00000000-0000-0000-0000-000000000000')
}

function isAgentFiledPayload(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false
  if (typeof payload.createdByAgentId === 'string') return true
  if (typeof payload.source === 'string' && AGENT_FILED_SOURCES.has(payload.source)) return true
  if (payload.delegation === true) return true
  return false
}

function needsConversationLookup(ticket: TicketActingUserTicket): boolean {
  const payload = payloadRecord(ticket.payload)
  if (isAgentFiledPayload(payload)) return Boolean(readTicketConversationId(ticket))
  return !isHumanUserId(ticket.createdById) && Boolean(readTicketConversationId(ticket))
}

function needsScheduledTaskValidation(ticket: TicketActingUserTicket): boolean {
  const payload = payloadRecord(ticket.payload)
  return typeof payload?.[SCHEDULED_TASK_ID] === 'string' && isRunAsAuthorized(payload)
}

/** Ticket acting user feloldása DB-kontextussal (beszélgetés, scheduled task run-as). */
export async function resolveTicketActingUserIdWithContext(input: {
  callerAgentId: string
  ticket: TicketActingUserTicket
  conversationIdHint?: string | null
}): Promise<string | null> {
  const validateScheduledTask = needsScheduledTaskValidation(input.ticket)
  const payload = payloadRecord(input.ticket.payload)
  const scheduledTaskId =
    typeof payload?.[SCHEDULED_TASK_ID] === 'string' ? payload[SCHEDULED_TASK_ID] : null
  const scheduledTask =
    validateScheduledTask && scheduledTaskId
      ? await prisma.scheduledTask.findUnique({ where: { id: scheduledTaskId } })
      : undefined

  const conversationId =
    input.conversationIdHint?.trim() || readTicketConversationId(input.ticket)
  const conversation =
    conversationId && needsConversationLookup(input.ticket)
      ? await prisma.conversation.findUnique({
          where: { id: conversationId },
          select: { agentId: true, createdById: true },
        })
      : null

  return resolveTicketActingUserId({
    callerAgentId: input.callerAgentId,
    ticket: input.ticket,
    conversation,
    ...(validateScheduledTask ? { scheduledTask: scheduledTask ?? null } : {}),
  })
}
