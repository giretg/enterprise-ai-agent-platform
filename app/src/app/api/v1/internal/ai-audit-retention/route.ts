import { NextResponse } from 'next/server'
import { aiInteractionStore } from '@/auth/ai-audit-deps'
import { drainExpiredAiAuditEvents } from '@/domain/ai-audit/ai-audit-service'
import { handleAiAuditRetentionRequest } from '@/domain/ai-audit/retention-request'
import { WikiAccessService } from '@/domain/knowledge-base/wiki-access-service'
import { repositories } from '@/repositories/postgres'
import { writeAudit } from '@/lib/audit/types'
import { services } from '@/domain/gateway-services'
import { publicChatMaintenanceDeps } from '@/auth/public-chat-deps'
import { runPublicChatMaintenance } from '@/domain/public-chat/maintenance'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * #759: napi retenciós sweep élő hívója (+ #942 privát KB 30 napos törlés, #967 archivált mini appok 90 nap után,
 * #978 wiki-verziók megőrzése). Cloud Scheduler hívja `x-dispatcher-token`-nel
 * (ugyanaz a titok, mint a dispatch-ciklusé, vagy `AI_AUDIT_SWEEP_TOKEN`). Clerk-kapu
 * nélkül, mert a Schedulernek nincs munkamenete — a minta a public-routes allowlisten van.
 */
export async function POST(request: Request): Promise<Response> {
  const result = await handleAiAuditRetentionRequest(
    { providedToken: request.headers.get('x-dispatcher-token') },
    async () => {
      const swept = await drainExpiredAiAuditEvents(aiInteractionStore)
      await writeAudit(repositories.audit, {
        actorType: 'system',
        action: 'ai_audit.retention_sweep',
        targetType: 'ai_interaction_event',
        policyDecision: 'allowed',
        metadata: { deleted: swept.deleted, complete: swept.complete },
      })
      // #942 D16: eltávolított tulajdonos privát tudásbázisa 30 nap után végleg törlődik
      // (KB-nként saját `kb.private.deleted` audit-sor). Ugyanez a napi retenciós hívó.
      await new WikiAccessService({
        connectors: repositories.connectors,
        agents: repositories.agents,
        wikis: repositories.wikis,
        privateKnowledgeBases: repositories.privateKnowledgeBases,
        audit: repositories.audit,
      }).sweepOrphanedPrivateKnowledgeBases()
      // #967 D10: archivált mini appok 90 nap után végleg törlődnek (appenként `mini_app.purged`).
      await services.miniApps.service.purgeExpiredArchives()
      // #978 §6: wiki-verziók napi ritkítása / törlése, régi change-setek tartalmának kiürítése.
      await services.wikiHistory.sweepRetention()
      // #1016 D17/D20: nyilvános beszélgetések 30 napos törlése + megválaszolatlan kérdések napi csoportosítása.
      const publicChat = await runPublicChatMaintenance(publicChatMaintenanceDeps())
      await writeAudit(repositories.audit, {
        actorType: 'system',
        action: 'public_chat.retention_sweep',
        targetType: 'public_chat_session',
        policyDecision: 'allowed',
        metadata: publicChat,
      })
      return swept
    },
  )
  return NextResponse.json(result.body, { status: result.status })
}
