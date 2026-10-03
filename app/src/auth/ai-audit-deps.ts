import { clientPolicyStore } from '@/auth/gateway-token-deps'
import { normalizeDepth, type AiAuditDeps } from '@/domain/ai-audit/ai-audit-service'
import { getPolicySnapshot } from '@/domain/client-policy/policy-service'
import { PostgresAiInteractionEventRepository } from '@/repositories/postgres/ai-interaction-event-repository'

export const aiInteractionStore = new PostgresAiInteractionEventRepository()

export function productionAiAuditDeps(): AiAuditDeps {
  return {
    store: aiInteractionStore,
    depthFor: async (input) =>
      normalizeDepth((await getPolicySnapshot(clientPolicyStore, input)).capabilities.audit_depth),
  }
}
