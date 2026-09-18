/**
 * Target composition root for the Enterprise MCP control plane.
 *
 * KEEP services only. The legacy `@/domain` `services` graph (ModelGateway,
 * AgentChatRuntime, dispatcher, tickets, …) lives under `legacy/` and must not
 * be imported from this module or from the MCP/agent-definition/enterprise-tools
 * layers.
 */
import { prisma } from '@/lib/db'
import { repositories } from '@/repositories/postgres'
import { IamService } from '@/domain/iam/iam-service'
import { TenantService } from '@/domain/tenant/tenant-service'
import { AuditChainService } from '@/domain/audit/audit-chain-service'
import { ConnectorGrantService } from '@/domain/connector-grant/connector-grant-service'
import { SkillService } from '@/domain/skill/skill-service'
import { AgentAccessService } from '@/domain/agent-access/agent-access-service'
import { ProvisioningService } from '@/domain/provisioning/provisioning-service'
import { PlatformSettingsService } from '@/domain/platform-settings/platform-settings-service'

const AGENT_GRAPH_NODE_SELECT = {
  id: true,
  name: true,
  avatarUrl: true,
  personaNickname: true,
  personaTrait: true,
  role: true,
  systemRole: true,
  status: true,
  tenantId: true,
  hiddenFromOperators: true,
  inboundRestricted: true,
  outboundRestricted: true,
  taskOnly: true,
} as const

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
      const agent = await prisma.agent.findUnique({
        where: { id: agentId },
        select: AGENT_GRAPH_NODE_SELECT,
      })
      return agent ?? null
    },
    listForTenant: async (tenantId) =>
      prisma.agent.findMany({
        where: { tenantId },
        select: AGENT_GRAPH_NODE_SELECT,
        orderBy: { name: 'asc' },
      }),
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
