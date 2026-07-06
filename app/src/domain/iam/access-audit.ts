import type { AuditRepository } from '@/repositories/interfaces'

export const ACCESS_AUDIT_ACTIONS = [
  'user.invite.issue',
  'user.invite.redeem',
  'user.invite.revoke',
  'user.selfregister',
  'user.role.assign',
  'user.role.change',
  'user.suspend',
  'user.reactivate',
  'user.permission.update',
  'user.authz.deny',
] as const

export function buildTenantAccessAuditFilter(params: {
  tenantId: string
  limit?: number
}): NonNullable<Parameters<AuditRepository['findMany']>[0]> {
  return {
    action: [...ACCESS_AUDIT_ACTIONS],
    tenantId: params.tenantId,
    limit: params.limit ?? 200,
  }
}
