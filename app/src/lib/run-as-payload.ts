import type { ScheduledTaskStatus } from '@prisma/client'

export const RUN_AS_USER_ID = 'runAsUserId'
export const RUN_AS_AUTHORIZED_AT = 'runAsAuthorizedAt'
export const RUN_AS_AUTHORIZED_BY = 'runAsAuthorizedBy'
export const SCHEDULED_TASK_ID = 'scheduledTaskId'

export function readRunAsUserId(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null
  const userId = payload[RUN_AS_USER_ID]
  return typeof userId === 'string' && userId.trim() ? userId.trim() : null
}

export function readRunAsAuthorizedBy(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null
  const userId = payload[RUN_AS_AUTHORIZED_BY]
  return typeof userId === 'string' && userId.trim() ? userId.trim() : null
}

export function isRunAsAuthorized(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false
  const userId = readRunAsUserId(payload)
  if (!userId) return false
  const authorizedBy = readRunAsAuthorizedBy(payload)
  if (authorizedBy !== userId) return false
  const at = payload[RUN_AS_AUTHORIZED_AT]
  if (typeof at !== 'string' || !at.trim()) return false
  return !Number.isNaN(Date.parse(at))
}

export function buildRunAsAuthorization(params: {
  userId: string
  authorizedAt?: string
}): Record<string, unknown> {
  const authorizedAt = params.authorizedAt ?? new Date().toISOString()
  return {
    [RUN_AS_USER_ID]: params.userId,
    [RUN_AS_AUTHORIZED_AT]: authorizedAt,
    [RUN_AS_AUTHORIZED_BY]: params.userId,
  }
}

/** Egy materializált scheduled ticket kizárólag ehhez a tartós granthez kötődhet. */
export function isScheduledTaskRunAsAuthorized(params: {
  ticketId: string
  ticketTenantId: string | null
  payload: Record<string, unknown> | null
  scheduledTask: {
    id: string
    tenantId: string | null
    status: ScheduledTaskStatus
    materializedTicketId: string | null
    runAsUserId: string | null
    runAsAuthorizedAt: Date | null
    runAsAuthorizedById: string | null
  } | null
}): boolean {
  const taskId = params.payload?.[SCHEDULED_TASK_ID]
  const actingUserId = readRunAsUserId(params.payload)
  const task = params.scheduledTask
  if (typeof taskId !== 'string' || !task || !actingUserId) return false
  if (task.id !== taskId || task.tenantId !== params.ticketTenantId) return false
  if (task.materializedTicketId !== params.ticketId) return false
  if (task.status !== 'active' && task.status !== 'materialized') return false
  if (task.runAsUserId !== actingUserId || task.runAsAuthorizedById !== actingUserId) return false
  if (!task.runAsAuthorizedAt || !isRunAsAuthorized(params.payload)) return false
  return task.runAsAuthorizedAt.toISOString() === params.payload?.[RUN_AS_AUTHORIZED_AT]
}

export function removeRunAsAuthorization(payload: Record<string, unknown>): Record<string, unknown> {
  const next = { ...payload }
  delete next[RUN_AS_USER_ID]
  delete next[RUN_AS_AUTHORIZED_AT]
  delete next[RUN_AS_AUTHORIZED_BY]
  return next
}

const NIL_USER_ID = '00000000-0000-0000-0000-000000000000'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return isRecord(payload) ? payload : null
}

function isHumanUserId(userId: string | null | undefined): userId is string {
  return Boolean(userId && userId !== NIL_USER_ID)
}

/** Agent által indított kártya — a createdById itt system/admin, NEM acting user. */
const AGENT_FILED_SOURCES = new Set(['agent_tool', 'agent_ask'])

function isAgentFiledPayload(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false
  if (typeof payload.createdByAgentId === 'string') return true
  if (typeof payload.source === 'string' && AGENT_FILED_SOURCES.has(payload.source)) return true
  // agent_ask / ticket_create delegation jelölő — source nélkül se essünk adminra
  if (payload.delegation === true) return true
  return false
}

/**
 * Identitásmezők, amiket az agent payload-patchből nem írhat (board_write / ticket_create).
 * Run-as, beszélgetés-kötés és agent-forrás bizalmi adat — csak a broker állíthatja.
 */
export const TICKET_IDENTITY_PAYLOAD_KEYS = [
  SCHEDULED_TASK_ID,
  RUN_AS_USER_ID,
  RUN_AS_AUTHORIZED_AT,
  RUN_AS_AUTHORIZED_BY,
  'conversationId',
  'source',
  'createdByAgentId',
  'requesterAgentId',
  'delegation',
] as const

/** Agent-patch után: az eredeti identitásmezőket visszaírja / törli a hamisítottakat. */
export function freezeTicketIdentityPayload(
  merged: Record<string, unknown>,
  original: Record<string, unknown> | null,
): Record<string, unknown> {
  for (const key of TICKET_IDENTITY_PAYLOAD_KEYS) {
    if (original && Object.prototype.hasOwnProperty.call(original, key)) {
      merged[key] = original[key]
    } else {
      delete merged[key]
    }
  }
  return merged
}

/** Agent által megadott ticket_create payload: az identitásmezőket kidobjuk. */
export function stripTicketIdentityFromAgentPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...payload }
  for (const key of TICKET_IDENTITY_PAYLOAD_KEYS) {
    delete next[key]
  }
  return next
}

function conversationActingUserId(
  callerAgentId: string,
  conversation: { agentId: string; createdById: string } | null | undefined,
): string | null {
  if (!conversation || conversation.agentId !== callerAgentId) return null
  return isHumanUserId(conversation.createdById) ? conversation.createdById : null
}

export type TicketActingUserTicket = {
  id: string
  agentId: string | null
  createdById: string
  source?: string | null
  conversationId?: string | null
  tenantId?: string | null
  payload: unknown
}

/**
 * Ki a ticket acting userje?
 *
 * - Humán feladójú munka (board, egyszeri/ismétlődő scheduled, monitor): a feladó.
 * - Explicit, még érvényes run-as: felülírja a feladót (scheduled task sorral egyeztetve).
 * - Agent által felvett kártya: a beszélgetés beszélője, sosem a system user.
 */
export function resolveTicketActingUserId(input: {
  callerAgentId: string
  ticket: TicketActingUserTicket
  conversation?: { agentId: string; createdById: string } | null
  scheduledTask?: (Parameters<typeof isScheduledTaskRunAsAuthorized>[0]['scheduledTask'] & {
    recurrence?: string | null
  }) | null
}): string | null {
  if (!input.ticket.agentId || input.ticket.agentId !== input.callerAgentId) return null
  const payload = payloadRecord(input.ticket.payload)

  if (typeof payload?.[SCHEDULED_TASK_ID] === 'string') {
    const taskLoaded = 'scheduledTask' in input
    if (taskLoaded) {
      if (
        isScheduledTaskRunAsAuthorized({
          ticketId: input.ticket.id,
          ticketTenantId: input.ticket.tenantId ?? null,
          payload,
          scheduledTask: input.scheduledTask ?? null,
        })
      ) {
        return readRunAsUserId(payload)
      }
    } else if (isRunAsAuthorized(payload)) {
      return readRunAsUserId(payload)
    }
  } else if (isRunAsAuthorized(payload)) {
    return readRunAsUserId(payload)
  }

  if (isAgentFiledPayload(payload)) {
    return conversationActingUserId(input.callerAgentId, input.conversation)
  }
  if (isHumanUserId(input.ticket.createdById)) return input.ticket.createdById
  return conversationActingUserId(input.callerAgentId, input.conversation)
}

export function readTicketConversationId(ticket: {
  conversationId?: string | null
  payload: unknown
}): string | null {
  if (ticket.conversationId?.trim()) return ticket.conversationId.trim()
  const payload = payloadRecord(ticket.payload)
  const fromPayload = payload?.conversationId
  return typeof fromPayload === 'string' && fromPayload.trim() ? fromPayload.trim() : null
}
