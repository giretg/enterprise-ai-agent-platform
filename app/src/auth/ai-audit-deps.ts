import { clientPolicyStore } from '@/auth/gateway-token-deps'
import { normalizeDepth, type AiAuditDeps } from '@/domain/ai-audit/ai-audit-service'
import { getPolicySnapshot } from '@/domain/client-policy/policy-service'
import { resolveSecret } from '@/lib/crypto/secret-resolver'
import { PostgresAiInteractionEventRepository } from '@/repositories/postgres/ai-interaction-event-repository'

export const aiInteractionStore = new PostgresAiInteractionEventRepository()

export function productionAiAuditDeps(): AiAuditDeps {
  return {
    store: aiInteractionStore,
    depthFor: async (input) =>
      normalizeDepth((await getPolicySnapshot(clientPolicyStore, input)).capabilities.audit_depth),
  }
}

export function productionContentGrantKey(): string {
  return resolveSecret(
    ['AI_AUDIT_GRANT_KEY', 'AI_AUDIT_ENCRYPTION_KEY', 'WRITE_GATE_SECRET'],
    'dev-ai-audit-grant-key-change-in-prod',
  )
}
