import type { Prisma } from '@prisma/client'

export const SELF_UPDATE_AUTO_APPROVE_SETTING = 'selfUpdatingConnectorsAutoApproveEnabled'

function settingsRecord(value: unknown): Record<string, Prisma.JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : {}
}

export function tenantSelfUpdateAutoApproveEnabled(settings: unknown): boolean {
  return settingsRecord(settings)[SELF_UPDATE_AUTO_APPROVE_SETTING] === true
}

export function withTenantSelfUpdateAutoApprove(settings: unknown, enabled: boolean): Prisma.InputJsonValue {
  return { ...settingsRecord(settings), [SELF_UPDATE_AUTO_APPROVE_SETTING]: enabled }
}
