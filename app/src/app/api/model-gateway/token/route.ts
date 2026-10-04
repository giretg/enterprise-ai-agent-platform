import { NextResponse } from 'next/server'
import { productionGatewayTokenDeps } from '@/auth/gateway-token-deps'
import { issueGatewayToken, type GatewayTokenFailureCode } from '@/domain/model-gateway-token/gateway-token'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'

export const dynamic = 'force-dynamic'

const STATUS: Record<GatewayTokenFailureCode, number> = {
  unauthenticated: 401,
  invalid_token: 401,
  forbidden: 403,
  agent_not_found: 403,
  bad_request: 400,
  key_missing: 503,
}

/** #772: MCP OAuth Bearer + { tenantSlug, agentId, installId } → 10 perces gateway-JWT. */
export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null)
  const result = await issueGatewayToken(await productionGatewayTokenDeps(), {
    authorizationHeader: request.headers.get('authorization'),
    resourceOrigin: resolvePublicAppOrigin(request),
    body,
  })
  if (!result.ok) return NextResponse.json({ error: result.code }, { status: STATUS[result.code] })
  return NextResponse.json({ token: result.token, expiresAt: result.expiresAt, policyVersion: result.policyVersion })
}
