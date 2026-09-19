/** Filter shape for tenant-scoped access-audit queries. */
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
