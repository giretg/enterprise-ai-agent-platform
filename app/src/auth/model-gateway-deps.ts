import { repositories } from '@/repositories/postgres'
import { services } from '@/domain/gateway-services'
import { getPolicySnapshot } from '@/domain/client-policy/policy-service'
import { productionGatewayTokenDeps, clientPolicyStore } from '@/auth/gateway-token-deps'
import { verifyGatewayToken } from '@/domain/model-gateway-token/gateway-token'
import { envProviderRegistry, type ModelGatewayDeps } from '@/domain/model-gateway/proxy'
import { writeAudit } from '@/lib/audit/types'

/**
 * Amíg V1-5 (`AiInteractionEvent`) nincs kész, a modellhívás a meglévő AuditLog-ba megy, tartalom nélkül
 * (prompt/válasz nem kerül ide) — a V1-5 ezt az egy `record`-ot váltja le.
 */
export function productionModelGatewayDeps(): ModelGatewayDeps {
  const tokenDeps = productionGatewayTokenDeps()
  return {
    verify: (authorization) => verifyGatewayToken(tokenDeps, authorization),
    loadAgentModelConfig: async ({ tenantId, agentId }) =>
      (await repositories.agents.findById(agentId, tenantId))?.modelConfig ?? null,
    getTenantPolicy: (tenantId) => services.platformSettings.getModelPolicy(tenantId),
    getGlobalFallbackChain: () => services.platformSettings.getFallbackChain(),
    getAllowedModels: async (input) => (await getPolicySnapshot(clientPolicyStore, input)).models,
    providers: envProviderRegistry(),
    audit: {
      record: (e) =>
        writeAudit(repositories.audit, {
          actorType: 'human',
          actorId: e.userId,
          action: 'model_call',
          targetType: 'model_gateway',
          targetId: e.agentId,
          modelUsed: e.model,
          policyDecision: e.outcome === 'blocked' ? 'denied' : e.outcome === 'ok' ? 'allowed' : e.outcome,
          metadata: {
            source: 'gateway',
            sessionId: e.sessionId,
            installId: e.installId,
            policyVersion: e.policyVersion,
            stream: e.stream,
            requestedModel: e.requestedModel,
            substituted: e.substituted,
            failedCandidates: e.failedCandidates,
            blockReason: e.blockReason,
            errorClass: e.errorClass,
            usage: e.usage,
            latencyMs: e.latencyMs,
          },
          tenantId: e.tenantId,
        }),
    },
  }
}
