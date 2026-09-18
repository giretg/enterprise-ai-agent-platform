/**
 * Tenant-scoped MCP resource URL.
 *
 * TODO(phase-A): official MCP SDK v2 `createMcpHandler`, stateless.
 * Phase 0 only establishes the route boundary.
 */
export const dynamic = 'force-dynamic'

function notImplemented(): Response {
  return Response.json(
    { error: 'TODO(phase-A): MCP transport is not implemented' },
    { status: 501 },
  )
}

export function GET(): Response {
  return notImplemented()
}

export function POST(): Response {
  return notImplemented()
}
