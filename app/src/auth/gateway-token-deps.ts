import { repositories } from '@/repositories/postgres'
import { services } from '@/domain/gateway-services'
import { PostgresClientPolicyRepository } from '@/repositories/postgres/client-policy-repository'
import { getPolicySnapshot } from '@/domain/client-policy/policy-service'
import type { GatewayTokenDeps } from '@/domain/model-gateway-token/gateway-token'
import { canViewAgent, verifyClerkOAuthToken } from '@/auth/mcp-server'
import { resolveModelGatewayJwtKey } from '@/lib/model-gateway-jwt-key'

const clientPolicy = new PostgresClientPolicyRepository()

/** Az aláíró kulcs a titoktárból (UI) vagy env-ből; hiányában a route fail-closed (503). */
export async function productionGatewayTokenDeps(): Promise<GatewayTokenDeps> {
  return {
    signingKey: (await resolveModelGatewayJwtKey()) ?? undefined,
    verifyOAuthToken: verifyClerkOAuthToken,
    users: repositories.users,
    tenants: repositories.tenants,
    memberships: repositories.tenantMemberships,
    platformMemberships: repositories.platformMemberships,
    audit: repositories.audit,
    loadDefinition: (input) => services.agentDefinitions.loadAgentDefinition(input),
    canViewAgent,
    policyVersion: async (input) => (await getPolicySnapshot(clientPolicy, input)).policyVersion,
  }
}

export { clientPolicy as clientPolicyStore }
