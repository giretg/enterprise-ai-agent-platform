/**
 * Target composition root for the Enterprise MCP control plane.
 *
 * KEEP services only. The legacy `@/domain` `services` graph (ModelGateway,
 * AgentChatRuntime, dispatcher, tickets, …) lives under `legacy/` and must not
 * be imported from this module or from the MCP/agent-definition/enterprise-tools
 * layers.
 */
import type { Agent } from '@prisma/client'
import { repositories } from '@/repositories/postgres'
import {
  AgentAccessService,
  type AgentGraphNode,
} from '@/domain/agent-access/agent-access-service'
import { AuditChainService } from '@/domain/audit/audit-chain-service'
import { ConnectorGrantService } from '@/domain/connector-grant/connector-grant-service'
import { IamService } from '@/domain/iam/iam-service'
import { PlatformSettingsService } from '@/domain/platform-settings/platform-settings-service'
import { ProvisioningService } from '@/domain/provisioning/provisioning-service'
import { SkillService } from '@/domain/skill/skill-service'
import { TenantService } from '@/domain/tenant/tenant-service'

function toAgentGraphNode(agent: Agent): AgentGraphNode {
  return {
    id: agent.id,
    name: agent.name,
    avatarUrl: agent.avatarUrl,
    personaNickname: agent.personaNickname,
    personaTrait: agent.personaTrait,
    role: agent.role,
    systemRole: agent.systemRole,
    status: agent.status,
    tenantId: agent.tenantId,
    hiddenFromOperators: agent.hiddenFromOperators,
    inboundRestricted: agent.inboundRestricted,
    outboundRestricted: agent.outboundRestricted,
    taskOnly: agent.taskOnly,
  }
}

const connectorGrantService = new ConnectorGrantService(
  repositories.connectorGrants,
  repositories.audit,
)

const platformSettingsService = new PlatformSettingsService(
  repositories.platformSettings,
  repositories.audit,
)

const iamService = new IamService(
  repositories.users,
  repositories.invitations,
  repositories.rolePermissions,
  repositories.audit,
  connectorGrantService,
  repositories.tenantMemberships,
)

const tenantService = new TenantService(
  repositories.tenants,
  repositories.tenantMemberships,
  repositories.platformMemberships,
  repositories.audit,
)

const skillService = new SkillService(
  repositories.skills,
  repositories.audit,
  repositories.toolBroker,
  {
    findById: async (id) => {
      const agent = await repositories.agents.findById(id)
      return agent ? { tenantId: agent.tenantId, systemRole: agent.systemRole } : null
    },
  },
)

const auditChainService = new AuditChainService(repositories.audit)

const agentAccessService = new AgentAccessService({
  agents: {
    findById: async (agentId) => {
      const agent = await repositories.agents.findById(agentId)
      return agent ? toAgentGraphNode(agent) : null
    },
    listForTenant: async (tenantId) => {
      const agents = await repositories.agents.findMany({ tenantId, unbounded: true })
      return agents.map(toAgentGraphNode).sort((a, b) => a.name.localeCompare(b.name))
    },
    setRestrictions: (input) => repositories.agents.updateAccessRestrictions(input),
  },
  grants: repositories.agentAccessGrants,
  audit: repositories.audit,
})

const provisioningService = new ProvisioningService({
  drafts: repositories.connectorDrafts,
  audit: repositories.audit,
  connectorGrants: connectorGrantService,
  resolveEgressAllowlist: (tenantId) => platformSettingsService.getEgressAllowlist(tenantId),
  resolveBankPreset: async () => process.env.PROVISIONING_BANK_PRESET === 'true',
})

export const services = {
  platformSettings: platformSettingsService,
  iam: iamService,
  tenants: tenantService,
  skills: skillService,
  auditChain: auditChainService,
  agentAccess: agentAccessService,
  provisioning: provisioningService,
  connectorGrants: connectorGrantService,
}
