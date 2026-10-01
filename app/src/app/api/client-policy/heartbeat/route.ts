import { NextResponse } from 'next/server'
import { productionGatewayTokenDeps } from '@/auth/gateway-token-deps'
import { clientPolicyDeps } from '@/auth/client-policy-deps'
import { heartbeatBodySchema, recordHeartbeat } from '@/domain/client-policy/client-install'
import { verifyGatewayToken } from '@/domain/model-gateway-token/gateway-token'

export const dynamic = 'force-dynamic'

/** #774 (D14): a Guard heartbeatje a gateway-JWT-vel; ez teszi a klienst Managed-dé a Model Gateway-en. */
export async function POST(request: Request): Promise<Response> {
  const verified = await verifyGatewayToken(productionGatewayTokenDeps(), request.headers.get('authorization'))
  if (!verified.ok) {
    const status = verified.code === 'key_missing' ? 503 : verified.code === 'forbidden' ? 403 : 401
    return NextResponse.json({ error: verified.code }, { status })
  }
  const body = heartbeatBodySchema.safeParse(await request.json().catch(() => null))
  if (!body.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 })

  const { principal, claims } = verified
  const timing = await recordHeartbeat(clientPolicyDeps(), {
    tenantId: principal.tenantId,
    userId: principal.userId,
    installId: claims.installId,
    agentId: claims.agentId,
    body: body.data,
  })
  return NextResponse.json({ ok: true, ...timing })
}
