/**
 * MCP resource-server principal.
 *
 * TODO(phase-A): Bearer → user → URL tenant → membership → McpPrincipal.
 * Phase 0 only establishes the module boundary.
 */
export type McpPrincipal = {
  userId: string
  tenantId: string
  tenantSlug: string
  role: string
}

export async function resolveMcpPrincipal(_input: {
  authorizationHeader: string | null
  tenantSlug: string
}): Promise<McpPrincipal> {
  throw new Error('TODO(phase-A): MCP principal resolution is not implemented')
}
