/** Filter shape for former access-audit queries. AuditLog was dropped in Phase B. */
export function buildTenantAccessAuditFilter(input: { tenantId: string; limit?: number }): {
  tenantId: string
  limit: number
  action: string[]
} {
  return {
    tenantId: input.tenantId,
    limit: input.limit ?? 50,
    action: ['user.authz.deny', 'user.permission.update'],
  }
}
