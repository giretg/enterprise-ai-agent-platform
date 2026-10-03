import { NextResponse } from 'next/server'
import { z } from 'zod'
import { aiInteractionStore, productionAiAuditDeps } from '@/auth/ai-audit-deps'
import { productionGatewayTokenDeps } from '@/auth/gateway-token-deps'
import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import { repositories } from '@/repositories/postgres'
import { writeAudit } from '@/lib/audit/types'
import { MAX_BATCH_BYTES, MAX_LIST_LIMIT, ingestGuardEvents, listAuditEvents } from '@/domain/ai-audit/ai-audit-service'
import { verifyGatewayToken } from '@/domain/model-gateway-token/gateway-token'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * #770: a Hermes Guard esemény-batch-e gateway-JWT-vel. A tenant, user, agent és install a tokenből jön,
 * a payloadból soha. Ismételt `id` nem duplikál (a Guard bátran újrapróbálhat).
 */
export async function POST(request: Request): Promise<Response> {
  const verified = await verifyGatewayToken(productionGatewayTokenDeps(), request.headers.get('authorization'))
  if (!verified.ok) {
    const status = verified.code === 'key_missing' ? 503 : verified.code === 'forbidden' || verified.code === 'agent_not_found' ? 403 : 401
    return NextResponse.json({ error: verified.code }, { status })
  }
  const { principal, claims } = verified

  if (Number(request.headers.get('content-length') ?? 0) > MAX_BATCH_BYTES) {
    return NextResponse.json({ error: 'batch_too_large' }, { status: 413 })
  }
  const text = await request.text()
  if (text.length > MAX_BATCH_BYTES) return NextResponse.json({ error: 'batch_too_large' }, { status: 413 })
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const result = await ingestGuardEvents(
    productionAiAuditDeps(),
    {
      tenantId: principal.tenantId,
      userId: principal.userId,
      agentId: claims.agentId,
      installId: claims.installId,
      policyVersion: claims.policyVersion,
    },
    payload,
  )
  return result.ok
    ? NextResponse.json({ received: result.received, stored: result.stored })
    : NextResponse.json({ error: result.code }, { status: result.status })
}

const querySchema = z.object({
  userId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  sessionId: z.string().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(100),
  includeContent: z.enum(['true', 'false']).default('false'),
})

/**
 * Admin olvasó API: alapból csak metaadat; `includeContent=true` visszafejti a tartalmat, és maga a
 * visszafejtés is `AuditLog` esemény (ki, milyen szűrővel, hány eseményt olvasott).
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireTenantApiUser('admin')
  if (!auth.ok) return auth.response
  const { user } = auth

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  const { includeContent, ...filter } = parsed.data
  const decrypt = includeContent === 'true'

  const events = await listAuditEvents(aiInteractionStore, { ...filter, tenantId: user.activeTenantId }, { decrypt })
  if (decrypt) {
    await writeAudit(repositories.audit, {
      actorType: 'human',
      actorId: user.user.id,
      action: 'ai_audit.content_read',
      targetType: 'ai_interaction_event',
      policyDecision: 'allowed',
      metadata: { filter: { ...filter, from: filter.from?.toISOString(), to: filter.to?.toISOString() }, count: events.length },
      tenantId: user.activeTenantId,
    })
  }
  return NextResponse.json({ events })
}
