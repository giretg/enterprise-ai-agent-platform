import { NextResponse } from 'next/server'
import { clientPolicyStore, productionGatewayTokenDeps } from '@/auth/gateway-token-deps'
import { getPolicySnapshot } from '@/domain/client-policy/policy-service'
import { verifyGatewayToken } from '@/domain/model-gateway-token/gateway-token'

export const dynamic = 'force-dynamic'

/** #772 (D14): a V1-1 policy-snapshot a gateway-JWT-vel; minden hívásnál újra-ellenőrzött hozzáférés. */
export async function GET(request: Request): Promise<Response> {
  const verified = await verifyGatewayToken(await productionGatewayTokenDeps(), request.headers.get('authorization'))
  if (!verified.ok) {
    const status = verified.code === 'key_missing' ? 503 : verified.code === 'forbidden' ? 403 : 401
    return NextResponse.json({ error: verified.code }, { status })
  }
  const { principal, claims } = verified
  return NextResponse.json(
    await getPolicySnapshot(clientPolicyStore, { tenantId: principal.tenantId, userId: principal.userId, agentId: claims.agentId }),
  )
}
