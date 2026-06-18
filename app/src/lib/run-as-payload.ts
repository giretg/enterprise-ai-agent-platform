export const RUN_AS_USER_ID = 'runAsUserId'
export const RUN_AS_AUTHORIZED_AT = 'runAsAuthorizedAt'
export const RUN_AS_AUTHORIZED_BY = 'runAsAuthorizedBy'

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

export function removeRunAsAuthorization(payload: Record<string, unknown>): Record<string, unknown> {
  const next = { ...payload }
  delete next[RUN_AS_USER_ID]
  delete next[RUN_AS_AUTHORIZED_AT]
  delete next[RUN_AS_AUTHORIZED_BY]
  return next
}
