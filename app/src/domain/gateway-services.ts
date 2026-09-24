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
import { AuditChainService } from '@/domain/audit/audit-chain-service'
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
  enqueueWriteForMcp,
  getGatewayOperation,
  getResultToMcp,
  approveGatewayOperation,
  rejectGatewayOperation,
  listPendingGatewayOperations,
  type GatewayOperationServiceDeps,
  type GatewayPendingOperationRow,
} from '@/domain/gateway-operation'
import { isSuperadmin } from '@/lib/tenant-policy'
import { hasMinimumRole } from '@/lib/iam-policy'
import type { UserRole } from '@prisma/client'
import { IamService } from '@/domain/iam/iam-service'
import { PlatformSettingsService } from '@/domain/platform-settings/platform-settings-service'
import { ProvisioningService } from '@/domain/provisioning/provisioning-service'
import { HttpSandboxConnectionTester } from '@/domain/provisioning/sandbox-connection-tester'
import { SelfUpdatingConnectorService } from '@/domain/connector-self-update/self-update-service'
import { SpecSyncService } from '@/domain/connector-self-update/spec-sync'
import { SkillService } from '@/domain/skill/skill-service'
import { TenantService } from '@/domain/tenant/tenant-service'
import { KnowledgeBaseService } from '@/domain/knowledge-base/knowledge-base-service'
import { executeKnowledgeBaseTool } from '@/domain/enterprise-tools/handlers/knowledge-base'
import { ProjectWorkService } from '@/domain/project-work/project-work-service'
import {
  invokeProjectWork,
  MCP_PROJECT_MEMORY_WRITE_TOOL,
} from '@/domain/project-work/mcp'
import { lookup } from 'node:dns/promises'

const connectorGrantService = new ConnectorGrantService(repositories.connectorGrants)

const platformSettingsService = new PlatformSettingsService(repositories.platformSettings)

const iamService = new IamService(
  repositories.users,
  repositories.invitations,
  repositories.rolePermissions,
  connectorGrantService,
  repositories.tenantMemberships,
  repositories.audit,
)

const tenantService = new TenantService(
  repositories.tenants,
  repositories.tenantMemberships,
  repositories.platformMemberships,
  repositories.audit,
)

const skillService = new SkillService(repositories.skills, repositories.agents, {
  findById: async (id) => {
    const agent = await repositories.agents.findById(id)
    return agent ? { tenantId: agent.tenantId } : null
  },
})

const resolveEgressAllowlist = (tenantId: string | null) =>
  platformSettingsService.getEgressAllowlist(tenantId)
const resolveBankPreset = async () => process.env.PROVISIONING_BANK_PRESET === 'true'

const selfUpdatingConnectorService = new SelfUpdatingConnectorService(
  repositories.selfUpdatingConnectors,
  new SpecSyncService({
    resolveHostIps: async (host) => (await lookup(host, { all: true })).map((entry) => entry.address),
  }),
  {
    append: async (event) => {
      await repositories.audit.append({
        actorType: event.actorId ? 'human' : 'system',
        actorId: event.actorId,
        agentVersion: null,
        action: event.action,
        targetType: 'connector',
        targetId: event.connectorId,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: event.policyDecision,
        metadata: event.metadata ?? {},
        tenantId: event.tenantId,
      })
    },
  },
)

const provisioningService = new ProvisioningService({
  drafts: repositories.connectorDrafts,
  connectorGrants: connectorGrantService,
  resolveEgressAllowlist,
  resolveBankPreset,
  sandboxTester: new HttpSandboxConnectionTester({ resolveEgressAllowlist, resolveBankPreset }),
  resolvePlatformGoogleOAuth: async (service: 'gmail' | 'drive' | 'api' = 'gmail') => {
    if (process.env.GOOGLE_DRIVE_API_STUB === 'true' && service === 'drive') {
      return { configured: true }
    }
    const cfg =
      service === 'drive'
        ? await platformSettingsService.getGoogleDriveOAuthConfig()
        : service === 'api'
          ? await platformSettingsService.getGoogleApiOAuthConfig()
          : await platformSettingsService.getGoogleOAuthConfig()
    return { configured: Boolean(cfg) }
  },
  audit: repositories.audit,
})

const agentDefinitionService = new AgentDefinitionService({
  agents: repositories.agents,
  versions: repositories.agentDefinitions,
  skills: repositories.skills,
  connectors: repositories.connectors,
  audit: repositories.audit,
})

const knowledgeBaseService = new KnowledgeBaseService({
  documents: repositories.documents,
  artifacts: repositories.knowledgeArtifacts,
  chunks: repositories.knowledgeChunks,
  agents: repositories.agents,
  connectors: repositories.connectors,
  audit: repositories.audit,
})

const projectWorkService = new ProjectWorkService(
  repositories.workProjects,
  repositories.workFiles,
  repositories.projectMemory,
  {
    async findMemoryWriteMode(agentId, tenantId) {
      const agent = await repositories.agents.findById(agentId, tenantId)
      return agent?.memoryWriteMode ?? null
    },
    async updateMemoryWriteMode(agentId, memoryWriteMode) {
      await repositories.agents.updateMemoryWriteMode({ agentId, memoryWriteMode })
    },
  },
  repositories.users,
)

function isStubDriveCredential(tokenRef: string): boolean {
  return tokenRef.startsWith('stub-') || process.env.GOOGLE_DRIVE_API_STUB === 'true'
}

const sharedToolLookups = {
  loadDefinition: (input: { tenantId: string; definitionId: string }) =>
    agentDefinitionService.loadAgentDefinition(input),
  findCurrentDefinitionId: async (input: { tenantId: string; agentId: string }) => {
    const agent = await repositories.agents.findById(input.agentId, input.tenantId)
    return agent?.currentDefinitionVersionId ?? null
  },
  findAgentGrant: (input: { tenantId: string; userId: string; agentId: string }) =>
    repositories.resourceGrants.findAgentGrant(input),
  findConnector: (id: string) => repositories.connectors.findById(id),
  findActiveGrant: (input: { tenantId: string; connectorId: string; userId: string }) =>
    repositories.connectorGrants.findActiveGrant(input),
  async resolveActingUser(input: { userId: string }) {
    const user = await repositories.users.findById(input.userId)
    return user ? { id: user.id, email: user.email } : null
  },
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

async function startAuthorization(input: {
  connectorId: string
  userId: string
  tenantId: string
  role: string
  toolName: string
}): Promise<{ url: string } | null> {
  const connector = await repositories.connectors.findById(input.connectorId)
  if (!connector) return null
  if (connector.tenantId && connector.tenantId !== input.tenantId) return null
  if (connector.authMode !== 'user_delegated' || connector.lifecycleState !== 'active') return null
  try {
    return await connectorGrantService.startUserAuthorization({
      connector,
      userId: input.userId,
      tenantId: input.tenantId,
      isAdmin: hasMinimumRole(input.role as UserRole, 'admin'),
      toolName: input.toolName,
      returnTo: { kind: 'mcp' },
    })
  } catch {
    return null
  }
}

const gatewayOperationDeps: GatewayOperationServiceDeps = {
  ...sharedToolLookups,
  operations: repositories.gatewayOperations,
  resolveRequester,
  startAuthorization,
  audit: repositories.audit,
  async recordCreatedDriveFiles({ grantId, files }) {
    for (const file of files) {
      await recordGoogleDriveAppCreatedFile({ grantId, ...file })
    }
  },
  async commitProjectMemory({ tenantId, agentId, args }) {
    const withUserId = typeof args.withUserId === 'string' ? args.withUserId : ''
    return projectWorkService.commitMemory({
      tenantId,
      agentId,
      projectKey: typeof args.projectKey === 'string' ? args.projectKey : undefined,
      kind: String(args.kind ?? ''),
      title: String(args.title ?? ''),
      body: String(args.body ?? ''),
      artifactPath: typeof args.artifactPath === 'string' ? args.artifactPath : undefined,
      replaceId: typeof args.replaceId === 'string' ? args.replaceId : undefined,
      mergeIds: typeof args.mergeIds === 'string' ? args.mergeIds.split(',').map((id) => id.trim()).filter(Boolean) : undefined,
      withUserId,
    })
  },
}

async function listPendingOperationRows(input: {
  tenantId: string
  principalUserId?: string
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
  audit: repositories.audit,
  startAuthorization,
  enqueueWrite: (input) => enqueueWriteForMcp(gatewayOperationDeps, input),
  executeKbTool: (toolName, args, ctx) =>
    executeKnowledgeBaseTool(knowledgeBaseService, toolName, args, ctx),
}

export const services = {
  platformSettings: platformSettingsService,
  iam: iamService,
  tenants: tenantService,
  skills: skillService,
  agentDefinitions: agentDefinitionService,
  provisioning: provisioningService,
  selfUpdatingConnectors: selfUpdatingConnectorService,
  connectorGrants: connectorGrantService,
  knowledgeBase: knowledgeBaseService,
  projectWork: {
    service: projectWorkService,
    invoke: (input: Parameters<typeof invokeProjectWork>[1]) =>
      invokeProjectWork(
        {
          ...sharedToolLookups,
          projectWork: projectWorkService,
          enqueueMemoryWrite: async (enqueueInput) =>
            enqueueResultToMcp(
              await enqueueGatewayOperation(gatewayOperationDeps, {
                principal: enqueueInput.principal,
                toolName: MCP_PROJECT_MEMORY_WRITE_TOOL,
                args: enqueueInput.args,
              }),
              enqueueInput.origin,
            ),
          audit: repositories.audit,
        },
        input,
      ),
  },
  audit: repositories.audit,
  auditChain: new AuditChainService(repositories.audit),
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
    listPending: (input: { tenantId: string; principalUserId?: string }) =>
      listPendingOperationRows(input),
    toMcpGet: getResultToMcp,
  },
}
