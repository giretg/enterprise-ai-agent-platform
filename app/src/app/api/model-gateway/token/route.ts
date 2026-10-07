import { NextResponse } from 'next/server'
import { productionGatewayTokenDeps } from '@/auth/gateway-token-deps'
import { issueGatewayToken, type GatewayTokenFailureCode } from '@/domain/model-gateway-token/gateway-token'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'
import { readBoundedJson, RequestTooLargeError } from '@/lib/request-body'

export const dynamic = 'force-dynamic'

/** A token-kérés törzse apró: { tenantSlug, agentId, installId }. 16 KiB bőven elég. */
const MAX_TOKEN_BODY_BYTES = 16 * 1024

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
  let body: unknown = null
  try {
    body = await readBoundedJson(request, MAX_TOKEN_BODY_BYTES)
  } catch (error) {
    // Túl nagy törzs → 413; érvénytelen JSON → a meglévő bad_request-út (body marad null).
    if (error instanceof RequestTooLargeError) return NextResponse.json({ error: 'request_too_large' }, { status: 413 })
  }
  const result = await issueGatewayToken(await productionGatewayTokenDeps(), {
    authorizationHeader: request.headers.get('authorization'),
    resourceOrigin: resolvePublicAppOrigin(request),
    body,
  })
  if (!result.ok) return NextResponse.json({ error: result.code }, { status: STATUS[result.code] })
  return NextResponse.json({ token: result.token, expiresAt: result.expiresAt, policyVersion: result.policyVersion })
}
