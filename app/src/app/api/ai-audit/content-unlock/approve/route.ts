import { NextResponse } from 'next/server'
import { z } from 'zod'
import { productionContentGrantKey } from '@/auth/ai-audit-deps'
import {
  approveUnlockRequest,
  CONTENT_GRANT_TTL_SECONDS,
} from '@/domain/ai-audit/content-grant'
import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import { repositories } from '@/repositories/postgres'
import { writeAudit } from '@/lib/audit/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const bodySchema = z.object({ requestToken: z.string().min(1).max(4000) })

/**
 * #759 négy szem, 2. lépés: egy *másik* tenant-admin jóváhagyja a kéréstokent.
 * A grant 15 percig él, és csak a kérő vagy a jóváhagyó GET-jén érvényes.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireTenantApiUser('admin')
  if (!auth.ok) return auth.response
  const { user } = auth

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(payload)
  if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 })

  const result = approveUnlockRequest(productionContentGrantKey(), parsed.data.requestToken, {
    tenantId: user.activeTenantId,
    approverId: user.user.id,
  })
  if (!result.ok) {
    const status = result.code === 'same_actor' ? 403 : 400
    return NextResponse.json({ error: result.code }, { status })
  }

  await writeAudit(repositories.audit, {
    actorType: 'human',
    actorId: user.user.id,
    action: 'ai_audit.content_unlock.approve',
    targetType: 'ai_interaction_event',
    policyDecision: 'allowed',
    tenantId: user.activeTenantId,
  })
  return NextResponse.json({
    grantToken: result.token,
    expiresInSeconds: CONTENT_GRANT_TTL_SECONDS,
  })
}
