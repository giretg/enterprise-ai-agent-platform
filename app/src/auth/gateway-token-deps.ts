import { repositories } from '@/repositories/postgres'
import { services } from '@/domain/gateway-services'
import { PostgresClientPolicyRepository } from '@/repositories/postgres/client-policy-repository'
import { getPolicySnapshot } from '@/domain/client-policy/policy-service'
import type { GatewayTokenDeps } from '@/domain/model-gateway-token/gateway-token'
import { canViewAgent, verifyClerkOAuthToken } from '@/auth/mcp-server'

const clientPolicy = new PostgresClientPolicyRepository()

/** Az aláíró kulcs a Secret Managerből jön env-ként; hiányában a route fail-closed (503). */
export function productionGatewayTokenDeps(): GatewayTokenDeps {
  return {
    signingKey: process.env.MODEL_GATEWAY_JWT_KEY,
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
