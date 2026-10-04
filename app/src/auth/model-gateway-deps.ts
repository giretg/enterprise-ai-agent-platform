import { repositories } from '@/repositories/postgres'
import { services } from '@/domain/gateway-services'
import { getPolicySnapshot } from '@/domain/client-policy/policy-service'
import { productionGatewayTokenDeps, clientPolicyStore } from '@/auth/gateway-token-deps'
import { verifyGatewayToken } from '@/domain/model-gateway-token/gateway-token'
import { envProviderRegistry, type ModelGatewayDeps } from '@/domain/model-gateway/proxy'
import { productionAiAuditDeps } from '@/auth/ai-audit-deps'
import { createGatewayAuditSink } from '@/domain/ai-audit/ai-audit-service'
import { createContentFilterHooks } from '@/domain/model-gateway/content-filter'
import { PostgresGatewaySurrogateRepository } from '@/repositories/postgres/gateway-surrogate-repository'
import { clientPolicyDeps } from '@/auth/client-policy-deps'
import { createManagedGate } from '@/domain/client-policy/client-install'

export async function productionModelGatewayDeps(): Promise<ModelGatewayDeps> {
  const tokenDeps = await productionGatewayTokenDeps()
  return {
    verify: (authorization) => verifyGatewayToken(tokenDeps, authorization),
    loadAgentModelConfig: async ({ tenantId, agentId }) =>
      (await repositories.agents.findById(agentId, tenantId))?.modelConfig ?? null,
    getTenantPolicy: (tenantId) => services.platformSettings.getModelPolicy(tenantId),
    getGlobalFallbackChain: () => services.platformSettings.getFallbackChain(),
    getAllowedModels: async (input) => (await getPolicySnapshot(clientPolicyStore, input)).models,
    providers: envProviderRegistry(),
    hooks: {
      gate: createManagedGate(clientPolicyDeps()),
      ...createContentFilterHooks({
        vault: new PostgresGatewaySurrogateRepository(),
        getCapabilities: async (ctx) => (await getPolicySnapshot(clientPolicyStore, ctx)).capabilities,
        audit: repositories.audit,
      }),
    },
    audit: createGatewayAuditSink(productionAiAuditDeps()),
  }
}
