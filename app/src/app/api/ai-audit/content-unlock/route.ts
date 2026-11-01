import { NextResponse } from 'next/server'
import { productionContentGrantKey } from '@/auth/ai-audit-deps'
import { issueUnlockRequest, UNLOCK_REQUEST_TTL_SECONDS } from '@/domain/ai-audit/content-grant'
import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import { repositories } from '@/repositories/postgres'
import { writeAudit } from '@/lib/audit/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * #759 négy szem, 1. lépés: a tenant-admin kér egy kéréstokent a prompt-napló
 * tartalmának olvasásához. A tokent egy *másik* admin hagyja jóvá
 * `POST /api/ai-audit/content-unlock/approve`.
 */
export async function POST(): Promise<Response> {
  const auth = await requireTenantApiUser('admin')
  if (!auth.ok) return auth.response
  const { user } = auth
  const token = issueUnlockRequest(productionContentGrantKey(), {
    tenantId: user.activeTenantId,
    requesterId: user.user.id,
  })
  await writeAudit(repositories.audit, {
    actorType: 'human',
    actorId: user.user.id,
    action: 'ai_audit.content_unlock.request',
    targetType: 'ai_interaction_event',
    policyDecision: 'allowed',
    tenantId: user.activeTenantId,
  })
  return NextResponse.json({
    requestToken: token,
    expiresInSeconds: UNLOCK_REQUEST_TTL_SECONDS,
  })
}
