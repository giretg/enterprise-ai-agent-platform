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
