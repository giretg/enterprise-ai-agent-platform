export type WorkspaceBackedResource = {
  tenantId: string | null
}

export function resolveWorkspaceTenantKey(
  resource: WorkspaceBackedResource,
  activeTenantId: string,
): string {
  if (resource.tenantId !== activeTenantId) {
    throw new Error('Workspace resource not found')
  }
  return activeTenantId
}

/**
 * File/repo toolök workspace storage kulcsa.
 *
 * A board/chat feltöltés a ticket/conversation `tenantId` prefixe alá ír.
 * Task futásnál gyakran nincs acting user (nincs run-as) → `actingTenantId`
 * null; a shared workspace connector `tenantId`-je is null. Ilyenkor a
 * resource tenant az igazság — különben a toolök a `global/` prefixet
 * listázzák, miközben a fájlok a tenant alatt vannak.
 */
export function resolveToolWorkspaceTenantKey(input: {
  resourceTenantId?: string | null
  actingTenantId?: string | null
  connectorTenantId?: string | null
}): string {
  return (
    input.resourceTenantId ??
    input.actingTenantId ??
    input.connectorTenantId ??
    'global'
  )
}
