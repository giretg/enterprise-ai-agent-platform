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
