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
import { createPlatformChatGate, withPlatformChatSpend } from '@/domain/platform-chat/gateway'
import { platformChatGatewayDeps } from '@/auth/platform-chat-deps'

export async function productionModelGatewayDeps(): Promise<ModelGatewayDeps> {
  const tokenDeps = await productionGatewayTokenDeps()
  const platformChat = platformChatGatewayDeps()
  return {
    verify: (authorization) => verifyGatewayToken(tokenDeps, authorization),
    loadAgentModelConfig: async ({ tenantId, agentId }) =>
      (await repositories.agents.findById(agentId, tenantId))?.modelConfig ?? null,
    getTenantPolicy: (tenantId) => services.platformSettings.getModelPolicy(tenantId),
    getGlobalFallbackChain: () => services.platformSettings.getFallbackChain(),
    getAllowedModels: async (input) => (await getPolicySnapshot(clientPolicyStore, input)).models,
    providers: envProviderRegistry(),
    hooks: {
      // #1004: a platform-chat install saját kapun megy (kapcsolók + napi keret), minden más a Managed/Open-en.
      gate: createPlatformChatGate(platformChat, createManagedGate(clientPolicyDeps())),
      ...createContentFilterHooks({
        vault: new PostgresGatewaySurrogateRepository(),
        getCapabilities: async (ctx) => (await getPolicySnapshot(clientPolicyStore, ctx)).capabilities,
        audit: repositories.audit,
      }),
    },
    audit: withPlatformChatSpend(createGatewayAuditSink(productionAiAuditDeps()), platformChat),
  }
}
