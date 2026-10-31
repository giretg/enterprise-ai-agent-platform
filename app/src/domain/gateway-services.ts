/**
 * Target composition root for the Enterprise MCP control plane.
 *
 * KEEP services only. The legacy `@/domain` `services` graph (ModelGateway,
 * AgentChatRuntime, dispatcher, tickets, …) lives under `legacy/` and must not
 * be imported from this module or from the MCP/agent-definition/enterprise-tools
 * layers.
 */
import { repositories } from '@/repositories/postgres'
import { loadAgentMailIdentity } from '@/lib/agent-mailbox'
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
  canApproveGatewayOperation,
  toGatewayOperationView,
  type GatewayOperationServiceDeps,
  type GatewayPendingOperationRow,
  type GatewayOperationHistoryRow,
} from '@/domain/gateway-operation'
import type { GatewayOperationRecord } from '@/domain/gateway-operation/types'
import { modesFromAgentRow } from '@/lib/write-approval-modes'
import { clampWriteModesToCeiling, readTenantAutonomyCeiling } from '@/lib/agent-autonomy'
import { iconDataUrlByTemplateKey, resolveConnectorIcon } from '@/lib/connector-template-icon-map'
import { isSuperadmin } from '@/lib/tenant-policy'
import { readTenantLanguage } from '@/lib/tenant-language'
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
import { selfServiceTenantStore } from '@/repositories/postgres/self-service-tenant-store'
import { KnowledgeBaseService } from '@/domain/knowledge-base/knowledge-base-service'
import { WikiAccessService } from '@/domain/knowledge-base/wiki-access-service'
import { WikiService } from '@/domain/knowledge-base/wiki-service'
import { WikiConsoleService } from '@/domain/knowledge-base/wiki-console-service'
import { WikiHistoryService } from '@/domain/knowledge-base/wiki-history-service'
import { PostgresWikiConsoleRepository } from '@/repositories/postgres/wiki-console-repository'
import { executeKnowledgeBaseTool, executeWikiTool } from '@/domain/enterprise-tools/handlers/knowledge-base'
import { scopeSnapshotConnectorsToUser } from '@/lib/wiki-access'
import { executeSandboxRun } from '@/domain/enterprise-tools/handlers/sandbox-run'
import { getPolicySnapshot } from '@/domain/client-policy/policy-service'
import { PostgresClientPolicyRepository } from '@/repositories/postgres/client-policy-repository'
import { PostgresDocumentExportRepository } from '@/repositories/postgres/document-export-repository'
import { documentExportPath, loadOwnExport } from '@/domain/document-export/document-export-store'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'
import { ProjectWorkService } from '@/domain/project-work/project-work-service'
import { CustomerPromiseService } from '@/domain/customer-promise/customer-promise-service'
import { PostgresCustomerPromiseRepository } from '@/repositories/postgres/customer-promise-repository'
import { invokeCustomerPromise } from '@/domain/customer-promise/mcp'
import { PostgresHandoffRepository } from '@/repositories/postgres/handoff-repository'
import { ScheduledTaskService } from '@/domain/scheduled-task/scheduled-task-service'
import { invokeScheduledTask } from '@/domain/scheduled-task/mcp'
import { PostgresScheduledTaskRepository } from '@/repositories/postgres/scheduled-task-repository'
import { hashSnapshot } from '@/domain/agent-definition'
import { MiniAppService } from '@/domain/mini-app/mini-app-service'
import { invokeMiniAppTool } from '@/domain/mini-app/mcp'
import { invokeWarehouseTool } from '@/domain/warehouse/mcp'
import { warehousePageUrl, warehouseService } from '@/lib/warehouse'
import { readWarehouseSettings, warehouseAccessForAgent } from '@/lib/warehouse-settings'
import { readMiniAppSettings } from '@/lib/mini-app-settings'
import { miniAppPermanentUrl, mintMiniAppLinks } from '@/lib/mini-app-origin'
import { canReadPublishedAgent } from '@/domain/agent-definition'
import {
  invokeProjectWork,
  MCP_PROJECT_MEMORY_WRITE_TOOL,
} from '@/domain/project-work/mcp'
import { findHttpApiEndpoint, parseHttpApiConfig } from '@/domain/connector/http-api-client'
import { lookup } from 'node:dns/promises'
import { prisma } from '@/lib/db'
import { parseMcpCapabilitySet } from '@/domain/connector/mcp-tools'

const platformSettingsService = new PlatformSettingsService(repositories.platformSettings)

const resolveEgressAllowlist = (tenantId: string | null) =>
  platformSettingsService.getEgressAllowlist(tenantId)

const connectorGrantService = new ConnectorGrantService(
  repositories.connectorGrants,
  resolveEgressAllowlist,
  // #1028: megszakadt tenant-postafiók — auditnyom; az admin a vezérlőpulton és a Postafiókok oldalon látja.
  async (event) => {
    await repositories.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: 'connector.mailbox.broken',
      targetType: 'connector',
      targetId: event.connectorId,
      modelUsed: null,
      inputRef: event.address,
      outputRef: event.reason,
      policyDecision: 'denied',
      metadata: { grantId: event.grantId, address: event.address, reason: event.reason, actingUserId: event.actingUserId },
      tenantId: event.tenantId,
    })
  },
)

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
  selfServiceTenantStore,
)

const skillService = new SkillService(repositories.skills, repositories.agents, {
  findById: async (id) => {
    const agent = await repositories.agents.findById(id)
    return agent ? { tenantId: agent.tenantId } : null
  },
})

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
  extendEgressAllowlist: (tenantId, host, actorId, provenance) =>
    platformSettingsService.extendEgressAllowlist(tenantId, host, actorId, provenance),
  resolveBankPreset,
  sandboxTester: new HttpSandboxConnectionTester({
    resolveEgressAllowlist,
    resolveBankPreset,
    // Feloldás-utáni privát/reserved IP re-check (DNS-rebinding), mint a többi egress-nyelőnél.
    resolveHostIps: async (host) => (await lookup(host, { all: true })).map((e) => e.address),
  }),
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
  resolvePlatformGoogleAdsDeveloperToken: async () => ({
    configured: Boolean(await platformSettingsService.getGoogleAdsDeveloperToken()),
  }),
  audit: repositories.audit,
})

const agentDefinitionService = new AgentDefinitionService({
  agents: repositories.agents,
  versions: repositories.agentDefinitions,
  skills: repositories.skills,
  connectors: repositories.connectors,
  audit: repositories.audit,
})

/** #717: a modellnek szóló szövegek nyelve a tenant kimeneti nyelve — az UI-locale soha nem. */
const resolveTenantLanguage = async (tenantId: string) => {
  const tenant = await repositories.tenants.findById(tenantId)
  return readTenantLanguage(tenant?.settings)
}

const knowledgeBaseService = new KnowledgeBaseService({
  documents: repositories.documents,
  artifacts: repositories.knowledgeArtifacts,
  chunks: repositories.knowledgeChunks,
  agents: repositories.agents,
  connectors: repositories.connectors,
  audit: repositories.audit,
  resolveTenantLanguage,
})

const wikiAccessService = new WikiAccessService({
  connectors: repositories.connectors,
  agents: repositories.agents,
  wikis: repositories.wikis,
  privateKnowledgeBases: repositories.privateKnowledgeBases,
  audit: repositories.audit,
})

const wikiService = new WikiService({
  wikis: repositories.wikis,
  documents: repositories.documents,
  connectors: repositories.connectors,
  agents: repositories.agents,
  knowledgeBase: knowledgeBaseService,
  audit: repositories.audit,
  history: repositories.wikiHistory,
  async findUserLabel(userId) {
    const user = await repositories.users.findById(userId)
    return user ? user.name || user.email : null
  },
})

const wikiConsoleRepository = new PostgresWikiConsoleRepository()
const wikiConsoleService = new WikiConsoleService({
  documents: repositories.documents,
  connectors: repositories.connectors,
  agents: repositories.agents,
  wikis: repositories.wikis,
  console: wikiConsoleRepository,
  wiki: wikiService,
  wikiAccess: wikiAccessService,
  knowledgeBase: knowledgeBaseService,
  audit: repositories.audit,
  history: repositories.wikiHistory,
})

// #978 Wiki-előzmények (konzol + napi megőrzés).
const wikiHistoryService = new WikiHistoryService({
  history: repositories.wikiHistory,
  wikis: repositories.wikis,
  connectors: repositories.connectors,
  console: wikiConsoleRepository,
  wikiConsole: wikiConsoleService,
  wiki: wikiService,
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
    async findOutputFolder(agentId, tenantId) {
      const agent = await repositories.agents.findById(agentId, tenantId)
      return agent?.outputDriveFolderId ?? null
    },
    async updateOutputFolder(agentId, folderId) {
      await repositories.agents.updateOutputFolder({ agentId, folderId })
    },
  },
  repositories.users,
)

const handoffRepository = new PostgresHandoffRepository()
const customerPromiseService = new CustomerPromiseService(new PostgresCustomerPromiseRepository(), repositories.audit)

/** #640: ütemezett feladatok — nyilvántartás, slot-foglalás, szinkron-terv; modellt nem futtat. */
const scheduledTaskService = new ScheduledTaskService({
  store: new PostgresScheduledTaskRepository(),
  audit: repositories.audit,
  loadAgent: (tenantId, agentId) => repositories.agents.findById(agentId, tenantId),
  loadCurrentDefinition: async (tenantId, agentId) => {
    const definition = await agentDefinitionService.loadAgentDefinition({ tenantId, agentId })
    return definition ? { definitionId: definition.definitionId, contentHash: hashSnapshot(definition.snapshot) } : null
  },
  findAgentGrant: (input) => repositories.resourceGrants.findAgentGrant(input),
  listOperatorUserIds: async (tenantId, agentId) =>
    (await repositories.resourceGrants.listAgentGrantsForAgent({ tenantId, agentId }))
      .filter((grant) => grant.accessLevel === 'operate')
      .map((grant) => grant.userId),
  listOperableAgentIds: async (tenantId, userId) =>
    (await repositories.resourceGrants.listAgentGrantsForUser({ tenantId, userId }))
      .filter((grant) => grant.accessLevel === 'operate')
      .map((grant) => grant.resourceId),
  activeMemberIds: async (tenantId, userIds) => {
    if (!userIds.length) return new Set<string>()
    const rows = await prisma.tenantMembership.findMany({ where: { tenantId, userId: { in: userIds }, status: 'active' }, select: { userId: true } })
    return new Set(rows.map((row) => row.userId))
  },
  userNames: async (userIds) => {
    const users = userIds.length ? await repositories.users.findManyByIds(userIds) : []
    return new Map(users.map((user) => [user.id, user.name || user.email]))
  },
  countLinkedCalls: ({ tenantId, runId }) =>
    prisma.auditLog.count({ where: { tenantId, action: 'scheduled_task.run_tool_call', metadata: { path: ['scheduledTaskRunId'], equals: runId } } }),
})

/** #395: az MCP-connector aktív, jóváhagyott eszközlistája (null = nincs aktív verzió → fail-closed). */
const mcpGateDeps = {
  async loadMcpActiveTools(input: { connectorId: string; tenantId: string }) {
    const connector = await prisma.connector.findFirst({
      where: { id: input.connectorId, tenantId: input.tenantId, type: 'mcp' },
      select: { activeSpecVersion: { select: { status: true, capabilitySet: true } } },
    })
    const active = connector?.activeSpecVersion
    return active?.status === 'approved' ? parseMcpCapabilitySet(active.capabilitySet) : null
  },
}

function isStubDriveCredential(tokenRef: string): boolean {
  return tokenRef.startsWith('stub-') || process.env.GOOGLE_DRIVE_API_STUB === 'true'
}

async function canViewAgentLookup(lookup: { tenantId: string; userId: string; role: string; agentId: string }) {
  const grant = await repositories.resourceGrants.findAgentGrant({
    tenantId: lookup.tenantId,
    userId: lookup.userId,
    agentId: lookup.agentId,
  })
  return canReadPublishedAgent({ role: lookup.role as UserRole, grant })
}

/** #967: mini appok — DB-ben tárolt statikus HTML, gyors link külön originen. */
const miniAppService = new MiniAppService({
  store: repositories.miniApps,
  async agentNames(tenantId, agentIds) {
    const rows = await Promise.all(agentIds.map((id) => repositories.agents.findById(id, tenantId)))
    return new Map(rows.filter((row) => row !== null).map((row) => [row.id, row.name]))
  },
  async settings(tenantId) {
    const tenant = await repositories.tenants.findById(tenantId)
    return readMiniAppSettings(tenant?.settings)
  },
  links: { mint: mintMiniAppLinks, permanentUrl: miniAppPermanentUrl },
  audit: repositories.audit,
})

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
  findActiveGrants: (input: { tenantId: string; connectorId: string; userId: string }) =>
    repositories.connectorGrants.findActiveGrants(input),
  findActiveTenantGrant: (input: { tenantId: string; connectorId: string }) =>
    repositories.connectorGrants.findActiveTenantGrant(input),
  async resolveActingUser(input: { userId: string }) {
    const user = await repositories.users.findById(input.userId)
    return user ? { id: user.id, email: user.email } : null
  },
  // #717: briefing, KB-találat, http_api hintek — ugyanaz a feloldás.
  resolveTenantLanguage,
  markGrantExpired: connectorGrantService.markGrantExpired.bind(connectorGrantService),
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

/**
 * #663: megnevezett jóváhagyó feloldása (konnektor > agent). Csak aktív
 * tenant-tagság esetén érvényes; a nevet pillanatképként adjuk a művelethez.
 */
async function resolveDesignatedApprover(input: {
  tenantId: string
  agentId: string
  connectorId: string | null
}): Promise<{ userId: string; name: string } | null> {
  const [agent, connector] = await Promise.all([
    repositories.agents.findById(input.agentId, input.tenantId),
    input.connectorId
      ? repositories.connectors.findById(input.connectorId, input.tenantId)
      : Promise.resolve(null),
  ])
  // #943 D4: wiki-írásnál a wiki gazdája, nem az író agent jóváhagyója.
  const wikiScope =
    connector?.type === 'knowledge_base' ? await wikiService.approverScopeFor(connector) : null
  const approverUserId = wikiScope
    ? wikiScope.kind === 'owner_user'
      ? wikiScope.userId
      : wikiScope.approverUserId
    : (connector?.approverUserId ?? agent?.approverUserId ?? null)
  if (!approverUserId) return null
  const [membership, user] = await Promise.all([
    repositories.tenantMemberships.findByTenantAndUser(input.tenantId, approverUserId),
    repositories.users.findById(approverUserId),
  ])
  if (membership?.status !== 'active' || !user) return null
  return { userId: user.id, name: user.name || user.email }
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
  ...mcpGateDeps,
  resolveEgressAllowlist,
  operations: repositories.gatewayOperations,
  resolveRequester,
  resolveDesignatedApprover,
  startAuthorization,
  audit: repositories.audit,
  wikiChangeSets: {
    canDecide: ({ actor, changeSetId }) => wikiService.canDecide(actor, changeSetId),
    apply: ({ requester, definition, changeSetId }) =>
      wikiService.applyApproved(
        {
          tenantId: requester.tenantId,
          userId: requester.userId,
          agentId: definition.agentId,
          snapshot: {
            connectors: scopeSnapshotConnectorsToUser(definition.snapshot.connectors, requester.userId),
          },
        },
        changeSetId,
      ),
    reject: async ({ tenantId, changeSetId, actorUserId }) => {
      await wikiService.reject(changeSetId, { tenantId, actorUserId })
    },
  },
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

function operationArgs(row: GatewayOperationRecord): Record<string, unknown> {
  if (row.argsJson && typeof row.argsJson === 'object' && !Array.isArray(row.argsJson)) {
    return row.argsJson as Record<string, unknown>
  }
  return {}
}

function httpApiEndpointDescription(
  config: unknown,
  method: unknown,
  path: unknown,
): string | null {
  if (typeof method !== 'string' || typeof path !== 'string') return null
  try {
    const parsed = parseHttpApiConfig(config)
    const endpoint = findHttpApiEndpoint(parsed, method, path)
    const description = endpoint?.description?.trim()
    return description || null
  } catch {
    return null
  }
}

async function enrichGatewayOperationRows(
  tenantId: string,
  rows: Array<Awaited<ReturnType<typeof listPendingGatewayOperations>>[number]>,
): Promise<GatewayPendingOperationRow[]> {
  const templates = await repositories.connectorTemplates.listVisible({ tenantId })
  const iconByTemplateKey = iconDataUrlByTemplateKey(templates)
  const connectorIds = [
    ...new Set(rows.map((row) => row.connectorId).filter((id): id is string => Boolean(id))),
  ]
  const connectors = await Promise.all(
    connectorIds.map((id) => repositories.connectors.findById(id, tenantId)),
  )
  const connectorById = new Map(connectorIds.map((id, index) => [id, connectors[index]] as const))

  return Promise.all(
    rows.map(async (row) => {
      const [user, agent, definition] = await Promise.all([
        repositories.users.findById(row.principalUserId),
        repositories.agents.findById(row.agentId, tenantId),
        agentDefinitionService.loadAgentDefinition({
          tenantId,
          definitionId: row.definitionId,
        }),
      ])
      const connector = row.connectorId ? (connectorById.get(row.connectorId) ?? null) : null
      const args = row.args
      const icon = connector
        ? resolveConnectorIcon({
            name: connector.name,
            type: connector.type,
            config: connector.config,
            templates,
            iconByTemplateKey,
          })
        : { iconDataUrl: null, provider: row.toolName }
      return {
        ...row,
        requesterName: user?.name || user?.email || row.principalUserId,
        agentName: agent?.name || row.agentId,
        definitionLabel: definition?.snapshot.name || row.definitionId,
        connectorName: connector?.name ?? null,
        connectorIconDataUrl: icon.iconDataUrl,
        connectorIconProvider: icon.provider,
        endpointDescription:
          row.toolName === 'http_api_request' && connector
            ? httpApiEndpointDescription(connector.config, args.method, args.path)
            : null,
      }
    }),
  )
}

async function listPendingOperationRows(input: {
  tenantId: string
  principalUserId?: string
}): Promise<GatewayPendingOperationRow[]> {
  const pending = await listPendingGatewayOperations(gatewayOperationDeps, input)
  return enrichGatewayOperationRows(input.tenantId, pending)
}

const HISTORY_PAGE_SIZE = 10

async function listGatewayOperationHistoryRows(input: {
  tenantId: string
  actor: { userId: string; tenantId: string; role: string; assumed: boolean }
  page: number
}): Promise<{ rows: GatewayOperationHistoryRow[]; total: number; pageSize: number }> {
  const actor = {
    userId: input.actor.userId,
    tenantId: input.actor.tenantId,
    role: input.actor.role,
    assumed: input.actor.assumed,
  }
  const visibleToUserId = canApproveGatewayOperation(actor) ? undefined : actor.userId
  const page = Math.max(1, input.page)
  const { rows, total } = await repositories.gatewayOperations.listDecidedHistory(
    input.tenantId,
    visibleToUserId,
    { limit: HISTORY_PAGE_SIZE, offset: (page - 1) * HISTORY_PAGE_SIZE },
  )
  const enriched = await enrichGatewayOperationRows(
    input.tenantId,
    rows.map((row) => ({ ...toGatewayOperationView(row), args: operationArgs(row) })),
  )
  return { rows: enriched, total, pageSize: HISTORY_PAGE_SIZE }
}

const clientPolicyStore = new PostgresClientPolicyRepository()
const documentExportStore = new PostgresDocumentExportRepository()

const enterpriseToolDeps: EnterpriseToolDeps = {
  ...sharedToolLookups,
  ...mcpGateDeps,
  resolveEgressAllowlist,
  audit: repositories.audit,
  startAuthorization,
  findAgentOutputFolder: async ({ agentId, tenantId }) => {
    const agent = await repositories.agents.findById(agentId, tenantId)
    return agent?.outputDriveFolderId ?? null
  },
  findAgentWriteModes: async ({ agentId, tenantId }) => {
    const [agent, tenant] = await Promise.all([
      repositories.agents.findById(agentId, tenantId),
      repositories.tenants.findById(tenantId),
    ])
    // #957 D3: utólag szigorított céges korlát a már beállított agentekre is érvényes.
    return agent
      ? clampWriteModesToCeiling(modesFromAgentRow(agent), readTenantAutonomyCeiling(tenant?.settings))
      : null
  },
  findAgentMailSignature: async ({ agentId, tenantId }) => {
    const primary = (await loadAgentMailIdentity(tenantId, agentId))?.primary
    return primary ? { connectorId: primary.connectorId, connectorName: primary.connectorName, signature: primary.signature } : null
  },
  findPrimaryMailboxConnectorId: async ({ agentId, tenantId }) => {
    const primary = (await loadAgentMailIdentity(tenantId, agentId))?.primary
    return primary?.connectorId ?? null
  },
  enqueueWrite: (input) => enqueueWriteForMcp(gatewayOperationDeps, input),
  executeKbTool: (toolName, args, ctx) =>
    executeKnowledgeBaseTool(knowledgeBaseService, toolName, args, ctx, wikiService),
  executeWikiTool: (toolName, args, ctx) => executeWikiTool(wikiService, toolName, args, ctx),
  resolveKbConnector: async ({ tenantId, wikiId, documentId }) => {
    const connectorId = wikiId
      ? (await repositories.wikis.findById(wikiId))?.connectorId
      : documentId
        ? (await repositories.documents.findById(documentId))?.connectorId
        : null
    if (!connectorId) return null
    const connector = await repositories.connectors.findById(connectorId, tenantId)
    return connector?.tenantId === tenantId && connector.type === 'knowledge_base' ? connector.id : null
  },
  onWikiApprovalQueued: async ({ tenantId, changeSetId, operationId }) => {
    if (operationId) {
      await repositories.wikis.transitionChangeSet(changeSetId, 'pending', 'pending', { gatewayOperationId: operationId })
    } else {
      await wikiService.reject(changeSetId, { tenantId, actorUserId: null, reason: 'not_queued' })
    }
  },
  loadSkillVersion: async (skillVersionId) => {
    const version = await repositories.skills.findVersionById(skillVersionId)
    if (!version) return null
    return {
      attachments: version.attachments,
      status: version.status,
      tenantId: version.skill.tenantId,
    }
  },
  executeSandboxRun,
  resolveClientPolicy: (input) => getPolicySnapshot(clientPolicyStore, input),
  // #1024: letölthető fájlok ideiglenes tárolója.
  saveDocumentExport: ({ document, ...input }) =>
    documentExportStore.create({
      ...input,
      fileName: document.fileName,
      format: document.format,
      mimeType: document.mimeType,
      byteSize: document.bytes.length,
      data: document.bytes,
    }),
  loadOwnDocumentExport: (input) => loadOwnExport(documentExportStore, { ...input, now: new Date() }),
  documentExportUrl: (id) => `${resolvePublicAppOrigin()}${documentExportPath(id)}`,
  countWebSearchCalls: ({ tenantId, agentId, since }) =>
    prisma.auditLog.count({
      where: { tenantId, action: 'enterprise.tool.ok', inputRef: 'web_search', targetId: agentId, createdAt: { gte: since } },
    }),
  readWorkFile: async (input) => {
    const found = await projectWorkService.readFile(input)
    if (!found.ok) {
      if (found.code === 'file_not_found') return null
      throw new Error(found.code)
    }
    return { path: found.file.path, content: found.file.content }
  },
  writeWorkFile: async (input) => {
    const written = await projectWorkService.writeFile(input)
    if (!written.ok) throw new Error(written.code) // quota_exceeded | file_too_large | invalid_path
    return { path: written.file.path }
  },
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
  customerPromises: customerPromiseService,
  scheduledTasks: scheduledTaskService,
  scheduledTaskTools: {
    invoke: (input: Parameters<typeof invokeScheduledTask>[1]) => invokeScheduledTask({
      scheduledTasks: scheduledTaskService,
      audit: repositories.audit,
      resolveLanguage: resolveTenantLanguage,
    }, input),
  },
  customerPromiseTools: {
    invoke: (input: Parameters<typeof invokeCustomerPromise>[1]) => invokeCustomerPromise({
      ...sharedToolLookups,
      customerPromises: customerPromiseService,
      audit: repositories.audit,
    }, input),
  },
  wikiAccess: wikiAccessService,
  wiki: wikiService,
  wikiConsole: wikiConsoleService,
  wikiHistory: wikiHistoryService,
  projectWork: {
    service: projectWorkService,
    handoffs: handoffRepository,
    invoke: (input: Parameters<typeof invokeProjectWork>[1]) =>
      invokeProjectWork(
        {
          ...sharedToolLookups,
          loadDefinitionByAgent: (lookup) => agentDefinitionService.loadAgentDefinition(lookup),
          canViewAgent: canViewAgentLookup,
          isTenantMember: async (lookup) => {
            const membership = await repositories.tenantMemberships.findByTenantAndUser(
              lookup.tenantId,
              lookup.userId,
            )
            return membership?.status === 'active'
          },
          findTenantMemberByEmail: async (lookup) => {
            const candidates = await repositories.users.findManyByEmail(lookup.email.trim().toLowerCase())
            for (const user of candidates) {
              const membership = await repositories.tenantMemberships.findByTenantAndUser(lookup.tenantId, user.id)
              if (membership?.status === 'active') return { userId: user.id }
            }
            return null
          },
          projectWork: projectWorkService,
          handoffs: handoffRepository,
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
  miniApps: {
    service: miniAppService,
    invoke: (input: Parameters<typeof invokeMiniAppTool>[1]) =>
      invokeMiniAppTool(
        {
          ...sharedToolLookups,
          loadDefinitionByAgent: (lookup) => agentDefinitionService.loadAgentDefinition(lookup),
          canViewAgent: canViewAgentLookup,
          handoffs: handoffRepository,
          miniApps: miniAppService,
          audit: repositories.audit,
        },
        input,
      ),
  },
  /** #984 AI-adattárház — `warehouse.*` MCP-eszközök. */
  warehouse: {
    invoke: (input: Parameters<typeof invokeWarehouseTool>[1]) =>
      invokeWarehouseTool(
        {
          ...sharedToolLookups,
          warehouse: warehouseService(),
          audit: repositories.audit,
          pageUrl: warehousePageUrl,
          agentAccess: async ({ tenantId, agentId }) =>
            warehouseAccessForAgent(readWarehouseSettings((await repositories.tenants.findById(tenantId))?.settings), agentId),
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
    listHistory: (input: {
      tenantId: string
      actor: { userId: string; tenantId: string; role: string; assumed: boolean }
      page: number
    }) => listGatewayOperationHistoryRows(input),
    toMcpGet: getResultToMcp,
  },
}
