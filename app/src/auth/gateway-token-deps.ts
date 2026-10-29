import { isAvailableOnMcp } from '@/lib/agent-lifecycle'
import { repositories } from '@/repositories/postgres'
import { services } from '@/domain/gateway-services'
import { PostgresClientPolicyRepository } from '@/repositories/postgres/client-policy-repository'
import { getPolicySnapshot } from '@/domain/client-policy/policy-service'
import type { GatewayTokenDeps } from '@/domain/model-gateway-token/gateway-token'
import { canViewAgent, productionChatTokenVerifier, verifyClerkOAuthToken } from '@/auth/mcp-server'
import { loadPlatformChatAccess, platformChatGatewayStore } from '@/auth/platform-chat-deps'
import { resolveModelGatewayJwtKey } from '@/lib/model-gateway-jwt-key'

const clientPolicy = new PostgresClientPolicyRepository()

/** Az aláíró kulcs a titoktárból (UI) vagy env-ből; hiányában a route fail-closed (503). */
export async function productionGatewayTokenDeps(): Promise<GatewayTokenDeps> {
  return {
    signingKey: (await resolveModelGatewayJwtKey()) ?? undefined,
    verifyOAuthToken: verifyClerkOAuthToken,
    verifyChatToken: productionChatTokenVerifier,
    users: repositories.users,
    tenants: repositories.tenants,
    memberships: repositories.tenantMemberships,
    platformMemberships: repositories.platformMemberships,
    audit: repositories.audit,
    loadDefinition: (input) => services.agentDefinitions.loadAgentDefinition(input),
    canViewAgent,
    listAgentIds: async ({ tenantId }) => (await repositories.agents.findMany({ tenantId, unbounded: true })).filter(isAvailableOnMcp).map((a) => a.id).reverse(), // a repo createdAt desc-et ad
    platformChat: {
      loadAccess: loadPlatformChatAccess,
      registerSession: (input) => platformChatGatewayStore.registerSession(input),
    },
    policyVersion: async (input) => (await getPolicySnapshot(clientPolicy, input)).policyVersion,
  }
}

export { clientPolicy as clientPolicyStore }
