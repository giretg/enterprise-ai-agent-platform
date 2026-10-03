import { NextResponse } from 'next/server'
import { aiInteractionStore } from '@/auth/ai-audit-deps'
import { sweepExpiredAiAuditEvents } from '@/domain/ai-audit/ai-audit-service'
import { handleAiAuditRetentionRequest } from '@/domain/ai-audit/retention-request'
import { repositories } from '@/repositories/postgres'
import { writeAudit } from '@/lib/audit/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * #759: napi retenciós sweep élő hívója. Cloud Scheduler hívja `x-dispatcher-token`-nel
 * (ugyanaz a titok, mint a dispatch-ciklusé, vagy `AI_AUDIT_SWEEP_TOKEN`). Clerk-kapu
 * nélkül, mert a Schedulernek nincs munkamenete — a minta a public-routes allowlisten van.
 */
export async function POST(request: Request): Promise<Response> {
  const result = await handleAiAuditRetentionRequest(
    { providedToken: request.headers.get('x-dispatcher-token') },
    async () => {
      const swept = await sweepExpiredAiAuditEvents(aiInteractionStore)
      await writeAudit(repositories.audit, {
        actorType: 'system',
        action: 'ai_audit.retention_sweep',
        targetType: 'ai_interaction_event',
        policyDecision: 'allowed',
        metadata: { deleted: swept.deleted },
      })
      return swept
    },
  )
  return NextResponse.json(result.body, { status: result.status })
}
