/**
 * Tenant-scoped MCP resource URL.
 *
 * TODO(phase-A): official MCP SDK v2 `createMcpHandler`, stateless.
 * Phase 0 only establishes the route boundary.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return Response.json(
    { error: 'TODO(phase-A): MCP transport is not implemented' },
    { status: 501 },
  )
}

export async function POST(): Promise<Response> {
  return Response.json(
    { error: 'TODO(phase-A): MCP transport is not implemented' },
    { status: 501 },
  )
}
