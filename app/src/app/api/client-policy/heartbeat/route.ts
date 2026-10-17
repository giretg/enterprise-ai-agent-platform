import { NextResponse } from 'next/server'
import { productionGatewayTokenDeps } from '@/auth/gateway-token-deps'
import { clientPolicyDeps } from '@/auth/client-policy-deps'
import { heartbeatBodySchema, recordHeartbeat } from '@/domain/client-policy/client-install'
import { verifyGatewayToken } from '@/domain/model-gateway-token/gateway-token'
import { readBoundedJson, RequestTooLargeError } from '@/lib/request-body'

export const dynamic = 'force-dynamic'

/** A heartbeat törzse apró (hash-ek + legfeljebb 50 × 200 karakteres session). 64 KiB bőven elég. */
const MAX_HEARTBEAT_BODY_BYTES = 64 * 1024

/** #774 (D14): a Guard heartbeatje a gateway-JWT-vel; ez teszi a klienst Managed-dé a Model Gateway-en. */
export async function POST(request: Request): Promise<Response> {
  const verified = await verifyGatewayToken(await productionGatewayTokenDeps(), request.headers.get('authorization'))
  if (!verified.ok) {
    const status = verified.code === 'key_missing' ? 503 : verified.code === 'forbidden' ? 403 : 401
    return NextResponse.json({ error: verified.code }, { status })
  }
  let raw: unknown
  try {
    raw = await readBoundedJson(request, MAX_HEARTBEAT_BODY_BYTES)
  } catch (error) {
    if (error instanceof RequestTooLargeError) return NextResponse.json({ error: 'request_too_large' }, { status: 413 })
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }
  const body = heartbeatBodySchema.safeParse(raw)
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
