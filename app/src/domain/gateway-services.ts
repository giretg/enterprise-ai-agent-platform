/**
 * Target composition root for the Enterprise MCP control plane.
 *
 * KEEP services only. The legacy `@/domain` `services` graph (ModelGateway,
 * AgentChatRuntime, dispatcher, tickets, …) lives under `legacy/` and must not
 * be imported from this module or from the MCP/agent-definition/enterprise-tools
 * layers.
 */
import { repositories } from '@/repositories/postgres'
import { AgentDefinitionService } from '@/domain/agent-definition'
import { ConnectorGrantService } from '@/domain/connector-grant/connector-grant-service'
import {
  authorizeToolCall,
  invokeEnterpriseTool,
  type EnterpriseToolDeps,
} from '@/domain/enterprise-tools'
import { recordGoogleDriveAppCreatedFile } from '@/domain/connector-grant/google-drive-grant-store'
import {
  enqueueGatewayOperation,
  enqueueResultToMcp,
  getGatewayOperation,
  getResultToMcp,
  approveGatewayOperation,
  rejectGatewayOperation,
  listPendingGatewayOperations,
  type GatewayOperationServiceDeps,
  type GatewayPendingOperationRow,
} from '@/domain/gateway-operation'
import { isSuperadmin } from '@/lib/tenant-policy'
import { IamService } from '@/domain/iam/iam-service'
import { PlatformSettingsService } from '@/domain/platform-settings/platform-settings-service'
import { ProvisioningService } from '@/domain/provisioning/provisioning-service'
import { SkillService } from '@/domain/skill/skill-service'
import { TenantService } from '@/domain/tenant/tenant-service'

const connectorGrantService = new ConnectorGrantService(repositories.connectorGrants)

const platformSettingsService = new PlatformSettingsService(repositories.platformSettings)

const iamService = new IamService(
  repositories.users,
  repositories.invitations,
  repositories.rolePermissions,
  connectorGrantService,
  repositories.tenantMemberships,
)

const tenantService = new TenantService(
  repositories.tenants,
  repositories.tenantMemberships,
  repositories.platformMemberships,
)

const skillService = new SkillService(repositories.skills, repositories.agents, {
  findById: async (id) => {
    const agent = await repositories.agents.findById(id)
    return agent ? { tenantId: agent.tenantId } : null
  },
})

const provisioningService = new ProvisioningService({
  drafts: repositories.connectorDrafts,
  connectorGrants: connectorGrantService,
  resolveEgressAllowlist: (tenantId) => platformSettingsService.getEgressAllowlist(tenantId),
  resolveBankPreset: async () => process.env.PROVISIONING_BANK_PRESET === 'true',
})

const agentDefinitionService = new AgentDefinitionService({
  agents: repositories.agents,
  versions: repositories.agentDefinitions,
  skills: repositories.skills,
})

function isStubDriveCredential(tokenRef: string): boolean {
  return tokenRef.startsWith('stub-') || process.env.GOOGLE_DRIVE_API_STUB === 'true'
}

const sharedToolLookups = {
  loadDefinition: (input: { tenantId: string; definitionId: string }) =>
    agentDefinitionService.loadAgentDefinition(input),
  findAgentGrant: (input: { tenantId: string; userId: string; agentId: string }) =>
    repositories.resourceGrants.findAgentGrant(input),
  findConnector: (id: string) => repositories.connectors.findById(id),
  findActiveGrant: (input: { tenantId: string; connectorId: string; userId: string }) =>
    repositories.connectorGrants.findActiveGrant(input),
  async resolveAccessToken(params: {
    connector: { id: string }
    grantId: string
    tokenRef: string
    actingUserId: string
    tenantId: string
  }) {
    if (isStubDriveCredential(params.tokenRef)) {
      return params.tokenRef.startsWith('stub-') ? params.tokenRef : `stub-${params.grantId}`
    }
    const connector = await repositories.connectors.findById(params.connector.id)
    if (!connector) throw new Error('connector_not_active')
    return connectorGrantService.resolveAccessToken({
      connector,
      grantId: params.grantId,
      tokenRef: params.tokenRef,
      actingUserId: params.actingUserId,
      tenantId: params.tenantId,
    })
  },
}

async function resolveRequester(input: { tenantId: string; userId: string }) {
  const membership = await repositories.tenantMemberships.findByTenantAndUser(
    input.tenantId,
    input.userId,
  )
  if (membership?.status === 'active') {
    return { role: membership.role, assumed: false }
  }
  const platformRows = await repositories.platformMemberships.findByUser(input.userId)
  const platformRoles = platformRows.filter((row) => row.status === 'active').map((row) => row.role)
  if (isSuperadmin(platformRoles)) return { role: 'admin', assumed: true }
  return null
}

const gatewayOperationDeps: GatewayOperationServiceDeps = {
  ...sharedToolLookups,
  operations: repositories.gatewayOperations,
  resolveRequester,
  async recordCreatedDriveFiles({ grantId, files }) {
    for (const file of files) {
      await recordGoogleDriveAppCreatedFile({ grantId, ...file })
    }
  },
}

async function listPendingOperationRows(input: {
  tenantId: string
}): Promise<GatewayPendingOperationRow[]> {
  const pending = await listPendingGatewayOperations(gatewayOperationDeps, input)
  return Promise.all(
    pending.map(async (row) => {
      const [user, agent, definition] = await Promise.all([
        repositories.users.findById(row.principalUserId),
        repositories.agents.findById(row.agentId, input.tenantId),
        agentDefinitionService.loadAgentDefinition({
          tenantId: input.tenantId,
          definitionId: row.definitionId,
        }),
      ])
      return {
        ...row,
        requesterName: user?.name || user?.email || row.principalUserId,
        agentName: agent?.name || row.agentId,
        definitionLabel: definition?.snapshot.name || row.definitionId,
      }
    }),
  )
}

const enterpriseToolDeps: EnterpriseToolDeps = {
  ...sharedToolLookups,
  enqueueWrite: async (input) =>
    enqueueResultToMcp(await enqueueGatewayOperation(gatewayOperationDeps, input)),
}

export const services = {
  platformSettings: platformSettingsService,
  iam: iamService,
  tenants: tenantService,
  skills: skillService,
  agentDefinitions: agentDefinitionService,
  provisioning: provisioningService,
  connectorGrants: connectorGrantService,
  enterpriseTools: {
    authorizeToolCall: (input: Parameters<typeof authorizeToolCall>[1]) =>
      authorizeToolCall(enterpriseToolDeps, input),
    invoke: (input: Parameters<typeof invokeEnterpriseTool>[1]) =>
      invokeEnterpriseTool(enterpriseToolDeps, input),
  },
  gatewayOperations: {
    enqueue: (input: Parameters<typeof enqueueGatewayOperation>[1]) =>
      enqueueGatewayOperation(gatewayOperationDeps, input),
    get: (input: Parameters<typeof getGatewayOperation>[1]) =>
      getGatewayOperation(gatewayOperationDeps, input),
    approve: (input: Parameters<typeof approveGatewayOperation>[1]) =>
      approveGatewayOperation(gatewayOperationDeps, input),
    reject: (input: Parameters<typeof rejectGatewayOperation>[1]) =>
      rejectGatewayOperation(gatewayOperationDeps, input),
    listPending: (input: { tenantId: string }) => listPendingOperationRows(input),
    toMcpGet: getResultToMcp,
  },
}
