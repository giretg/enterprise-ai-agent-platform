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

export const services = {
  platformSettings: platformSettingsService,
  iam: iamService,
  tenants: tenantService,
  skills: skillService,
  agentDefinitions: agentDefinitionService,
  provisioning: provisioningService,
  connectorGrants: connectorGrantService,
}
