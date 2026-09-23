import { auth } from '@clerk/nextjs/server'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { z } from 'zod'
import { isClerkEnabled } from '@/lib/clerk-config'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'
import { repositories } from '@/repositories/postgres'
import type { AgentScaffoldDeps } from '@/domain/agent-scaffold'
import { mcpAuthNotConfigured } from './mcp-oauth-metadata'
import { services } from '@/domain/gateway-services'
import {
  AgentDefinitionService,
  canReadPublishedAgent,
  hashSnapshot,
  isPrivilegedAgentReader,
  type AgentDefinition,
} from '@/domain/agent-definition'
import {
  AgentScaffoldError,
  canMcpScaffoldRead,
  canMcpScaffoldWrite,
  createDraftAgent,
  publishAgentWorkingSet,
} from '@/domain/agent-scaffold'
import { isAvailableOnMcp, isDispatchable } from '@/lib/agent-lifecycle'
import {
  asCheckoutHarness,
  CHECKOUT_TOOL_DESCRIPTION,
  renderAgentCheckout,
  type CheckoutSkill,
} from '@/lib/agent-checkout'
import { parseSkillContent, parseSkillRequires } from '@/lib/skill/skill-content'
import {
  GMAIL_GET_MESSAGE_TOOL,
  GMAIL_SEARCH_TOOL,
  GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
  GOOGLE_DRIVE_READ_FILE_TOOL,
  GOOGLE_DRIVE_SEARCH_TOOL,
  GOOGLE_DRIVE_UPLOAD_FILE_TOOL,
  GOOGLE_SHEETS_WRITE_RANGE_TOOL,
  HTTP_API_GET_ALL_TOOL,
  HTTP_API_GET_TOOL,
  HTTP_API_REQUEST_TOOL,
  KB_GET_DOCUMENT_TOOL,
  KB_GET_PAGE_TOOL,
  KB_INGEST_TOOL,
  KB_LIST_INDEX_TOOL,
  KB_SEARCH_TOOL,
  gmailGetMessageInputSchema,
  gmailSearchInputSchema,
  googleDriveCreateFolderInputSchema,
  googleDriveReadFileInputSchema,
  googleDriveSearchInputSchema,
  googleDriveUploadFileInputSchema,
  googleSheetsWriteRangeInputSchema,
  httpApiGetAllInputSchema,
  httpApiGetInputSchema,
  httpApiRequestInputSchema,
  kbGetDocumentInputSchema,
  kbGetPageInputSchema,
  kbIngestInputSchema,
  kbListIndexInputSchema,
  kbSearchInputSchema,
  isEnterpriseTool,
  type EnterpriseToolMcpResult,
} from '@/domain/enterprise-tools'
import {
  auditMcpAuthDenied,
  auditMcpAuthOk,
  auditMcpResourceRead,
  auditMcpToolCall,
  auditMcpToolDenied,
  mcpResourceMetadataUrl,
  MCP_ALLOWED_TOOLS,
  MCP_AGENTS_LIST_TOOL,
  MCP_AGENT_CHECKOUT_TOOL,
  MCP_AGENT_CREATE_DRAFT_TOOL,
  MCP_AGENT_GET_DEFINITION_TOOL,
  MCP_AGENT_GET_WORKING_SET_TOOL,
  MCP_AGENT_PUBLISH_TOOL,
  MCP_GATEWAY_OPERATION_GET_TOOL,
  MCP_SKILLS_LIST_TOOL,
  MCP_SKILL_READ_TOOL,
  MCP_SKILL_SUBMIT_TOOL,
  MCP_WHOAMI_TOOL,
  resolveMcpPrincipal,
  type McpPrincipal,
  type McpPrincipalDeps,
  type McpPrincipalFailure,
  type VerifiedOAuthToken,
} from './mcp-principal'
import {
  findPackageByUri,
  findSkillFile,
  parseSkillResourceUri,
  skillFileUri,
  toSkillsListEntry,
  type McpSkillPackage,
} from '@/lib/skill/mcp-skill'
import {
  buildMcpServerInstructions,
  buildTenantContextPayload,
  mcpServerDisplayName,
  previewRoleInstruction,
  type McpCoworkerSummary,
} from '@/lib/mcp-tenant-context'
import type { AgentDefinitionSnapshot } from '@/domain/agent-definition'
import {
  conversationSkillSubmitSchema,
  parseConversationSkillJsonLists,
  submitConversationSkill,
} from '@/domain/skill/conversation-skill'
import { buildConversationSkillPorts } from '@/repositories/postgres/conversation-skill-repository'
import {
  isProjectWorkTool,
  MCP_PROJECTS_CREATE_TOOL,
  MCP_PROJECTS_LIST_TOOL,
  MCP_PROJECT_MEMORY_READ_TOOL,
  MCP_PROJECT_MEMORY_WRITE_TOOL,
  MCP_WORK_FILE_DELETE_TOOL,
  MCP_WORK_FILE_LIST_TOOL,
  MCP_WORK_FILE_READ_TOOL,
  MCP_WORK_FILE_WRITE_TOOL,
  projectMemoryReadInputSchema,
  projectMemoryWriteInputSchema,
  projectsCreateInputSchema,
  projectsListInputSchema,
  workFileDeleteInputSchema,
  workFileListInputSchema,
  workFileReadInputSchema,
  workFileWriteInputSchema,
} from '@/domain/project-work/mcp'

export type McpAgentListItem = McpCoworkerSummary

export type McpRuntimeDeps = McpPrincipalDeps & {
  isClerkConfigured: () => boolean
  resolveOrigin: (request: Request) => string
  listPublishedAgents: (input: {
    tenantId: string
    userId: string
    role: McpPrincipal['role']
  }) => Promise<McpAgentListItem[]>
  loadDefinition: (input: {
    tenantId: string
    definitionId?: string
    agentId?: string
    version?: number
  }) => Promise<AgentDefinition | null>
  canViewAgent: (input: {
    tenantId: string
    userId: string
    role: McpPrincipal['role']
    agentId: string
  }) => Promise<boolean>
  loadSkillVersions: (versionIds: string[]) => Promise<CheckoutSkill[]>
  invokeEnterpriseTool: (input: {
    principal: McpPrincipal
    toolName: string
    args: Record<string, unknown>
    origin?: string
  }) => Promise<EnterpriseToolMcpResult>
  getGatewayOperation: (input: {
    principal: McpPrincipal
    operationId: string
  }) => Promise<EnterpriseToolMcpResult>
  invokeProjectWork: (input: {
    principal: McpPrincipal
    toolName: string
    args: Record<string, unknown>
    origin?: string
  }) => Promise<EnterpriseToolMcpResult>
  listMcpSkills: (input: { tenantId: string }) => Promise<McpSkillPackage[]>
  agentScaffold: AgentScaffoldDeps
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(padded, 'base64').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

export async function verifyClerkOAuthToken(bearerToken: string): Promise<VerifiedOAuthToken | null> {
  const { verifyClerkToken } = await import('@clerk/mcp-tools/server')
  const clerkAuth = await auth({ acceptsToken: 'oauth_token' })
  const info = verifyClerkToken(clerkAuth, bearerToken)
  const clerkUserId = info?.extra?.userId
  if (!info || typeof clerkUserId !== 'string' || !clerkUserId) return null
  return {
    clerkUserId,
    claims: decodeJwtPayload(bearerToken),
  }
}

async function canViewAgent(input: {
  tenantId: string
  userId: string
  role: McpPrincipal['role']
  agentId: string
}): Promise<boolean> {
  const grant = await repositories.resourceGrants.findAgentGrant({
    tenantId: input.tenantId,
    userId: input.userId,
    agentId: input.agentId,
  })
  return canReadPublishedAgent({ role: input.role, grant })
}

function snapshotFromDefinition(row: { snapshot: unknown } | null | undefined): AgentDefinitionSnapshot | null {
  if (!row?.snapshot || typeof row.snapshot !== 'object' || Array.isArray(row.snapshot)) return null
  return row.snapshot as AgentDefinitionSnapshot
}

async function toPublishedListItem(agent: {
  id: string
  name: string
  status: string
  description: string | null
  roleInstruction: string
  currentDefinitionVersionId: string | null
}): Promise<McpAgentListItem> {
  const current = agent.currentDefinitionVersionId
    ? await repositories.agentDefinitions.findById(agent.currentDefinitionVersionId)
    : null
  const snapshot = snapshotFromDefinition(current)
  const roleInstruction = snapshot?.roleInstruction ?? agent.roleInstruction
  return {
    agentId: agent.id,
    name: agent.name,
    status: agent.status,
    description: agent.description ?? snapshot?.description ?? null,
    roleInstructionPreview: previewRoleInstruction(roleInstruction),
    currentDefinitionId: agent.currentDefinitionVersionId,
    currentVersion: current?.version ?? null,
  }
}

export function productionMcpDeps(): McpRuntimeDeps {
  return {
    isClerkConfigured: isClerkEnabled,
    resolveOrigin: resolvePublicAppOrigin,
    verifyOAuthToken: verifyClerkOAuthToken,
    users: repositories.users,
    tenants: repositories.tenants,
    memberships: repositories.tenantMemberships,
    platformMemberships: repositories.platformMemberships,
    audit: repositories.audit,
    async listPublishedAgents({ tenantId, userId, role }) {
      const published = await repositories.agents.findMany({
        tenantId,
        unbounded: true,
      })
      const withDefinition = published.filter(isAvailableOnMcp)
      if (isPrivilegedAgentReader(role)) {
        return Promise.all(withDefinition.map(toPublishedListItem))
      }
      const grantedIds = new Set(
        await repositories.resourceGrants.listAgentIdsGrantedToUser({ tenantId, userId }),
      )
      return Promise.all(
        withDefinition.filter((agent) => grantedIds.has(agent.id)).map(toPublishedListItem),
      )
    },
    loadDefinition: (input) => services.agentDefinitions.loadAgentDefinition(input),
    canViewAgent,
    async loadSkillVersions(versionIds) {
      const rows = await repositories.skills.findVersionsByIds(versionIds)
      return rows.map((row) => ({
        skillId: row.skillId,
        skillVersionId: row.id,
        name: row.skill.name,
        displayName: row.skill.displayName,
        description: row.skill.description,
        license: row.skill.license,
        content: parseSkillContent(row.content),
        requires: parseSkillRequires(row.requires),
      }))
    },
    invokeEnterpriseTool: (input) => services.enterpriseTools.invoke(input),
    getGatewayOperation: async (input) =>
      services.gatewayOperations.toMcpGet(
        await services.gatewayOperations.get({
          principal: input.principal,
          operationId: input.operationId,
        }),
      ),
    invokeProjectWork: (input) => services.projectWork.invoke(input),
    listMcpSkills: ({ tenantId }) => services.skills.listMcpSkillPackages(tenantId),
    agentScaffold: {
      agents: repositories.agents,
      versions: repositories.agentDefinitions,
      skills: repositories.skills,
      connectors: repositories.connectors,
      audit: repositories.audit,
    },
  }
}

function unauthorizedResponse(origin: string): Response {
  const resourceMetadata = mcpResourceMetadataUrl(origin)
  return Response.json(
    { error: { code: 'invalid_token', message: 'Authentication required' } },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer realm="mcp", resource_metadata="${resourceMetadata}"`,
      },
    },
  )
}

function forbiddenResponse(failure: McpPrincipalFailure): Response {
  return Response.json(
    { error: { code: failure.code, message: failure.message } },
    { status: 403 },
  )
}

function whoamiPayload(
  principal: McpPrincipal,
  tenantContext: ReturnType<typeof buildTenantContextPayload>,
) {
  return {
    userId: principal.userId,
    tenantId: principal.tenantId,
    tenantSlug: principal.tenantSlug,
    role: principal.role,
    assumed: principal.assumed,
    tenantDisplayName: tenantContext.tenantDisplayName,
    tenantLegalName: tenantContext.tenantLegalName,
    organizationLabel: tenantContext.organizationLabel,
    mcpIntro: tenantContext.mcpIntro,
    coworkers: tenantContext.coworkers,
  }
}

function textResult(payload: unknown, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  }
}

function definitionNotFound() {
  return textResult({ code: 'definition_not_found', message: 'Agent definition not found' }, true)
}

const mcpSkillResourceSchema = z.object({
  uri: z.string(),
  digest: z.string(),
})
const mcpSkillEntrySchema = z.object({
  uri: z.string(),
  frontmatter: z.object({
    name: z.string(),
    description: z.string(),
    license: z.string().optional(),
  }),
  resources: z.array(mcpSkillResourceSchema),
})
const mcpSkillsListResultSchema = z.object({
  skills: z.array(mcpSkillEntrySchema),
})
const mcpSkillsListParamsSchema = z.object({ cursor: z.string().optional() })
const mcpSkillsGetParamsSchema = z.object({ uri: z.string().min(1) })

async function loadTenantContext(principal: McpPrincipal, deps: McpRuntimeDeps) {
  const [tenant, coworkers] = await Promise.all([
    deps.tenants.findById(principal.tenantId),
    deps.listPublishedAgents({
      tenantId: principal.tenantId,
      userId: principal.userId,
      role: principal.role,
    }),
  ])
  return {
    tenant,
    context: buildTenantContextPayload({
      tenant,
      tenantSlug: principal.tenantSlug,
      coworkers,
    }),
  }
}

async function whoamiToolResult(principal: McpPrincipal, deps: McpRuntimeDeps) {
  await auditMcpAuthOk(deps, principal)
  await auditMcpToolCall(deps, principal, MCP_WHOAMI_TOOL)
  const { context } = await loadTenantContext(principal, deps)
  return textResult(whoamiPayload(principal, context))
}

async function listAgentsToolResult(principal: McpPrincipal, deps: McpRuntimeDeps) {
  await auditMcpToolCall(deps, principal, MCP_AGENTS_LIST_TOOL)
  const { context } = await loadTenantContext(principal, deps)
  return textResult({ agents: context.coworkers })
}

async function listSkillsToolResult(
  principal: McpPrincipal,
  deps: McpRuntimeDeps,
  packages: McpSkillPackage[],
) {
  await auditMcpToolCall(deps, principal, MCP_SKILLS_LIST_TOOL)
  return textResult({ skills: packages.map(toSkillsListEntry) })
}

async function readSkillToolResult(
  principal: McpPrincipal,
  args: Record<string, unknown>,
  deps: McpRuntimeDeps,
  packages: McpSkillPackage[],
) {
  await auditMcpToolCall(deps, principal, MCP_SKILL_READ_TOOL)
  const uri = typeof args.uri === 'string' ? args.uri : ''
  const parsed = parseSkillResourceUri(uri)
  const pkg = parsed ? findPackageByUri(packages, uri) : undefined
  const file = pkg && parsed ? findSkillFile(pkg, parsed.filePath) : undefined
  if (!file) return textResult({ code: 'skill_resource_not_found', message: 'Skill resource not found' }, true)
  await auditMcpResourceRead(deps, principal, uri)
  return textResult({
    contents: [{ uri, mimeType: file.mimeType, text: file.text }],
  })
}

async function submitSkillToolResult(
  principal: McpPrincipal,
  args: Record<string, unknown>,
  deps: McpRuntimeDeps,
) {
  await auditMcpToolCall(deps, principal, MCP_SKILL_SUBMIT_TOOL)
  const parsed = conversationSkillSubmitSchema.safeParse(args)
  if (!parsed.success) {
    return textResult({
      outcome: 'rejected',
      reason: 'validation',
      message: `Elutasítva: ${parsed.error.issues.map((issue) => issue.message).join(' · ')} Semmi nem került tárolásra.`,
    })
  }
  const lists = parseConversationSkillJsonLists(parsed.data)
  if (!lists.ok) {
    return textResult({
      outcome: 'rejected',
      reason: 'validation',
      message: `Elutasítva: ${lists.message} Semmi nem került tárolásra.`,
    })
  }
  const outcome = await submitConversationSkill(
    {
      userId: principal.userId,
      tenantId: principal.tenantId,
      role: principal.role,
      assumed: principal.assumed,
      agentId: parsed.data.agentId,
      name: parsed.data.name,
      description: parsed.data.description,
      instructions: parsed.data.instructions,
      requires: lists.requires,
      attachments: lists.attachments,
    },
    buildConversationSkillPorts(),
  )
  return textResult(outcome)
}

function asUuid(value: unknown): string | undefined {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      ? value
      : undefined
  )
}

function asVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

async function getDefinitionToolResult(
  principal: McpPrincipal,
  args: Record<string, unknown>,
  deps: McpRuntimeDeps,
) {
  await auditMcpToolCall(deps, principal, MCP_AGENT_GET_DEFINITION_TOOL)
  const loaded = await deps.loadDefinition({
    tenantId: principal.tenantId,
    definitionId: asUuid(args.definitionId),
    agentId: asUuid(args.agentId),
    version: asVersion(args.version),
  })
  if (!loaded) return definitionNotFound()
  const allowed = await deps.canViewAgent({
    tenantId: principal.tenantId,
    userId: principal.userId,
    role: principal.role,
    agentId: loaded.agentId,
  })
  if (!allowed) return definitionNotFound()
  return textResult({ ...loaded, contentHash: hashSnapshot(loaded.snapshot) })
}

function invalidArgs(message: string) {
  return textResult({ code: 'invalid_args', message }, true)
}

function scaffoldWriteDenied(principal: McpPrincipal, deps: McpRuntimeDeps, toolName: string) {
  return auditMcpToolDenied(deps, principal, toolName).then(() =>
    textResult({ code: 'tool_not_allowed', message: 'Admin membership required' }, true),
  )
}

async function createDraftToolResult(
  principal: McpPrincipal,
  args: Record<string, unknown>,
  deps: McpRuntimeDeps,
) {
  if (!canMcpScaffoldWrite(principal.role, principal.assumed)) {
    return scaffoldWriteDenied(principal, deps, MCP_AGENT_CREATE_DRAFT_TOOL)
  }
  const name = typeof args.name === 'string' ? args.name : ''
  const roleInstruction = typeof args.roleInstruction === 'string' ? args.roleInstruction : ''
  const description = typeof args.description === 'string' ? args.description : undefined
  const capabilities = Array.isArray(args.capabilities)
    ? args.capabilities.filter((row): row is string => typeof row === 'string')
    : undefined
  const skills = Array.isArray(args.skills)
    ? args.skills.filter((row): row is string => typeof row === 'string')
    : undefined
  const connectors = Array.isArray(args.connectors)
    ? args.connectors
        .filter((row): row is Record<string, unknown> => row && typeof row === 'object' && !Array.isArray(row))
        .map((row) => ({
          name: typeof row.name === 'string' ? row.name : '',
          accessMode:
            row.accessMode === 'read' || row.accessMode === 'write'
              ? (row.accessMode as 'read' | 'write')
              : undefined,
        }))
        .filter((row) => row.name.trim().length > 0)
    : undefined

  await auditMcpToolCall(deps, principal, MCP_AGENT_CREATE_DRAFT_TOOL)
  try {
    const result = await createDraftAgent(deps.agentScaffold, {
      tenantId: principal.tenantId,
      actorId: principal.userId,
      name,
      roleInstruction,
      description,
      capabilities,
      skills,
      connectors,
    })
    return textResult(result)
  } catch (error) {
    if (error instanceof AgentScaffoldError && error.code === 'invalid_args') {
      return invalidArgs(error.message)
    }
    throw error
  }
}

async function getWorkingSetToolResult(
  principal: McpPrincipal,
  args: Record<string, unknown>,
  deps: McpRuntimeDeps,
) {
  if (!canMcpScaffoldRead(principal.role)) return definitionNotFound()
  const agentId = asUuid(args.agentId)
  if (!agentId) return invalidArgs('agentId must be a uuid')
  const definitionService = new AgentDefinitionService({
    agents: deps.agentScaffold.agents,
    versions: deps.agentScaffold.versions,
    skills: deps.agentScaffold.skills,
    connectors: deps.agentScaffold.connectors,
    audit: deps.agentScaffold.audit,
  })
  await auditMcpToolCall(deps, principal, MCP_AGENT_GET_WORKING_SET_TOOL)
  try {
    const result = await definitionService.getWorkingSet({
      agentId,
      tenantId: principal.tenantId,
    })
    return textResult(result)
  } catch {
    return definitionNotFound()
  }
}

async function publishAgentToolResult(
  principal: McpPrincipal,
  args: Record<string, unknown>,
  deps: McpRuntimeDeps,
) {
  if (!canMcpScaffoldWrite(principal.role, principal.assumed)) {
    return definitionNotFound()
  }
  const agentId = asUuid(args.agentId)
  if (!agentId) return invalidArgs('agentId must be a uuid')
  await auditMcpToolCall(deps, principal, MCP_AGENT_PUBLISH_TOOL)
  try {
    const result = await publishAgentWorkingSet(deps.agentScaffold, {
      agentId,
      tenantId: principal.tenantId,
      publishedById: principal.userId,
    })
    return textResult(result)
  } catch (error) {
    if (error instanceof AgentScaffoldError) {
      if (error.code === 'not_found') return definitionNotFound()
      if (error.code === 'invalid_state') {
        return textResult({ code: 'invalid_state', message: error.message }, true)
      }
    }
    throw error
  }
}

async function checkoutToolResult(
  principal: McpPrincipal,
  args: Record<string, unknown>,
  deps: McpRuntimeDeps,
  origin: string,
) {
  await auditMcpToolCall(deps, principal, MCP_AGENT_CHECKOUT_TOOL)
  const agentId = asUuid(args.agentId)
  if (!agentId) return invalidArgs('agentId must be a uuid')
  if (args.version !== undefined && asVersion(args.version) === undefined) {
    return invalidArgs('version must be a positive integer')
  }
  const loaded = await deps.loadDefinition({
    tenantId: principal.tenantId,
    agentId,
    version: asVersion(args.version),
  })
  if (!loaded || !isDispatchable(loaded.status)) return definitionNotFound()
  const allowed = await deps.canViewAgent({
    tenantId: principal.tenantId,
    userId: principal.userId,
    role: principal.role,
    agentId: loaded.agentId,
  })
  if (!allowed) return definitionNotFound()
  const skills = await deps.loadSkillVersions(
    loaded.snapshot.skills.map((skill) => skill.skillVersionId),
  )
  return textResult(
    renderAgentCheckout({
      definition: loaded,
      skills,
      mcpUrl: `${origin.replace(/\/+$/, '')}/api/mcp/${principal.tenantSlug}`,
      harness: asCheckoutHarness(args.harness),
    }),
  )
}

async function createMcpResourceHandler(principal: McpPrincipal, deps: McpRuntimeDeps, origin: string) {
  const { tenant, context } = await loadTenantContext(principal, deps)
  const instructions = buildMcpServerInstructions({
    tenant,
    tenantSlug: principal.tenantSlug,
    coworkers: context.coworkers,
  })

  return createMcpHandler(
    async (server) => {
      const packages = await deps.listMcpSkills({ tenantId: principal.tenantId })
      server.registerTool(
        MCP_WHOAMI_TOOL,
        {
          title: 'Who am I',
          description:
            'Return the authenticated MCP principal, tenant organization context, and visible coworkers for this tenant URL.',
          inputSchema: z.object({}).passthrough(),
        },
        async () => whoamiToolResult(principal, deps),
      )
      server.registerTool(
        MCP_AGENTS_LIST_TOOL,
        {
          title: 'List agents',
          description:
            'List published AI coworkers visible to this principal, including short descriptions and role previews.',
          inputSchema: z.object({}).passthrough(),
        },
        async () => listAgentsToolResult(principal, deps),
      )
      server.registerTool(
        MCP_AGENT_GET_DEFINITION_TOOL,
        {
          title: 'Get agent definition',
          description:
            'Load one published agent definition snapshot (capabilities, connectors with names/connectorIds, http_api endpoints). Call this before enterprise tools and pass definitionId on each call. Use agentId or definitionId; optional version.',
          inputSchema: z
            .object({
              definitionId: z.string().uuid().optional(),
              agentId: z.string().uuid().optional(),
              version: z.number().int().positive().optional(),
            })
            .passthrough(),
        },
        async (args) => getDefinitionToolResult(principal, args as Record<string, unknown>, deps),
      )
      server.registerTool(
        MCP_AGENT_CHECKOUT_TOOL,
        {
          title: 'Checkout agent workspace',
          description: CHECKOUT_TOOL_DESCRIPTION,
          inputSchema: z
            .object({
              agentId: z.string().uuid(),
              version: z.number().int().positive().optional(),
              harness: z.enum(['claude', 'codex', 'goose', 'grok']).optional(),
            })
            .passthrough(),
        },
        async (args) =>
          checkoutToolResult(principal, args as Record<string, unknown>, deps, origin),
      )
      server.registerTool(
        MCP_AGENT_CREATE_DRAFT_TOOL,
        {
          title: 'Create agent draft',
          description:
            'Persist a tenant agent draft with the full working set. Admin only — operators are denied at tools/call.',
          inputSchema: z
            .object({
              name: z.string().min(1).max(120),
              roleInstruction: z.string().min(1).max(20_000),
              description: z.string().max(2000).optional(),
            })
            .passthrough(),
        },
        async (args) => createDraftToolResult(principal, args as Record<string, unknown>, deps),
      )
      server.registerTool(
        MCP_AGENT_GET_WORKING_SET_TOOL,
        {
          title: 'Get agent working set',
          description:
            'Return the exact unpublished or stale working-set snapshot for an agent. Admin or approver only.',
          inputSchema: z.object({ agentId: z.string().uuid() }).passthrough(),
          annotations: { readOnlyHint: true },
        },
        async (args) => getWorkingSetToolResult(principal, args as Record<string, unknown>, deps),
      )
      server.registerTool(
        MCP_AGENT_PUBLISH_TOOL,
        {
          title: 'Publish agent',
          description:
            'Publish the working set and activate draft agents. Admin only — existence is hidden from non-admins.',
          inputSchema: z.object({ agentId: z.string().uuid() }).passthrough(),
        },
        async (args) => publishAgentToolResult(principal, args as Record<string, unknown>, deps),
      )
      server.registerTool(
        MCP_SKILLS_LIST_TOOL,
        {
          title: 'List skills',
          description:
            'List active skills available to this tenant. Each skill includes a SKILL.md URI and resource URIs. Use platform.skills.read when the MCP client cannot read resources directly.',
          inputSchema: mcpSkillsListParamsSchema,
          annotations: { readOnlyHint: true },
        },
        async () => listSkillsToolResult(principal, deps, packages),
      )
      server.registerTool(
        MCP_SKILL_READ_TOOL,
        {
          title: 'Read skill resource',
          description:
            'Read a skill:// resource returned by platform.skills.list. Returns SKILL.md instructions or an attachment as text.',
          inputSchema: mcpSkillsGetParamsSchema,
          annotations: { readOnlyHint: true },
        },
        async (args) =>
          readSkillToolResult(principal, args as Record<string, unknown>, deps, packages),
      )
      server.registerTool(
        MCP_SKILL_SUBMIT_TOOL,
        {
          title: 'Submit skill from conversation',
          description:
            'Submit a new tenant skill written in this conversation for the named agentId. requires and attachments are JSON strings, not arrays. The server decides the outcome and the text must be relayed to the user: created (live, assigned, enabled), pending_approval, or rejected with a reason (no_producer_skill, cannot_use_agent, validation, name_taken). A tenant admin gets a live skill without opening the web UI. Anyone else who can operate the agent gets one open proposal (a new call overwrites it). Viewers and agents without an enabled producer skill are rejected and nothing is stored. Missing tools are listed; this call does not grant them. This tool cannot create or mark a producer skill.',
          inputSchema: conversationSkillSubmitSchema,
        },
        async (args) =>
          submitSkillToolResult(principal, args as Record<string, unknown>, deps),
      )
      server.registerTool(
        MCP_PROJECTS_LIST_TOOL,
        {
          title: 'List work projects',
          description:
            'List named projects in this tenant plus the built-in __general__ project. Pass the same projectKey on work_file and project_memory calls. Pass definitionId from platform.agent.get_definition.',
          inputSchema: projectsListInputSchema,
          annotations: { readOnlyHint: true },
        },
        async (args) => projectWorkToolResult(principal, MCP_PROJECTS_LIST_TOOL, args, deps),
      )
      server.registerTool(
        MCP_PROJECTS_CREATE_TOOL,
        {
          title: 'Create work project',
          description:
            'Create a named project for durable work files and project memory. Returns the projectKey to pass on later calls. Pass definitionId from platform.agent.get_definition.',
          inputSchema: projectsCreateInputSchema,
        },
        async (args) => projectWorkToolResult(principal, MCP_PROJECTS_CREATE_TOOL, args, deps),
      )
      server.registerTool(
        MCP_WORK_FILE_LIST_TOOL,
        {
          title: 'List work files',
          description:
            'List work files for a project (plans, notes, drafts). Shared across agents on the same project. Optional prefix. Pass projectKey; omit for __general__. These files are not injected into the prompt.',
          inputSchema: workFileListInputSchema,
          annotations: { readOnlyHint: true },
        },
        async (args) => projectWorkToolResult(principal, MCP_WORK_FILE_LIST_TOOL, args, deps),
      )
      server.registerTool(
        MCP_WORK_FILE_READ_TOOL,
        {
          title: 'Read work file',
          description:
            'Read one work file by path under the project. No approval. Pass projectKey; omit for __general__.',
          inputSchema: workFileReadInputSchema,
          annotations: { readOnlyHint: true },
        },
        async (args) => projectWorkToolResult(principal, MCP_WORK_FILE_READ_TOOL, args, deps),
      )
      server.registerTool(
        MCP_WORK_FILE_WRITE_TOOL,
        {
          title: 'Write work file',
          description:
            'Create or overwrite a work file under the project (plans, notes, drafts). No approval; quota-capped. Do not write these into the checkout folder. Pass projectKey; omit for __general__.',
          inputSchema: workFileWriteInputSchema,
        },
        async (args) => projectWorkToolResult(principal, MCP_WORK_FILE_WRITE_TOOL, args, deps),
      )
      server.registerTool(
        MCP_WORK_FILE_DELETE_TOOL,
        {
          title: 'Delete work file',
          description: 'Delete a work file under the project prefix. No approval. Pass projectKey; omit for __general__.',
          inputSchema: workFileDeleteInputSchema,
        },
        async (args) => projectWorkToolResult(principal, MCP_WORK_FILE_DELETE_TOOL, args, deps),
      )
      server.registerTool(
        MCP_PROJECT_MEMORY_READ_TOOL,
        {
          title: 'Read project memory',
          description:
            'Read this agent\'s project-memory items (decisions, open tasks, findings, handoffs, artifact pointers). Each item is tagged with the conversation partner (withUserId / withUserName) stamped by the server. Pass mine=true to filter to the calling user. Ask which project, then pass the same projectKey. Do not store personal facts unless they constrain the project.',
          inputSchema: projectMemoryReadInputSchema,
          annotations: { readOnlyHint: true },
        },
        async (args) => projectWorkToolResult(principal, MCP_PROJECT_MEMORY_READ_TOOL, args, deps),
      )
      server.registerTool(
        MCP_PROJECT_MEMORY_WRITE_TOOL,
        {
          title: 'Write project memory',
          description:
            'Write a project-memory item for this agent (decision, open_task, finding, constraint, artifact, handoff_summary). The work plan itself belongs in a work file; store only a pointer here. The server stamps the calling user as conversation partner — do not name them. Cannot change trained operating rules. Approval-mode agents return awaiting_approval + approvalUrl; direct-mode agents write immediately. Personal facts (vacation, private preference) do not belong here unless they constrain the project.',
          inputSchema: projectMemoryWriteInputSchema,
        },
        async (args) => projectWorkToolResult(principal, MCP_PROJECT_MEMORY_WRITE_TOOL, args, deps),
      )
      server.registerTool(
        GOOGLE_DRIVE_SEARCH_TOOL,
        {
          title: 'Search Google Drive',
          description:
            'List or search Google Drive files. Returns file id, name, mimeType. Call this to get a fileId before google_drive_read_file. Pass definitionId from platform.agent.get_definition. Omit query to list recent files. If the result includes authorizationUrl, show that URL to the user and retry after they finish connecting.',
          inputSchema: googleDriveSearchInputSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => enterpriseToolResult(principal, GOOGLE_DRIVE_SEARCH_TOOL, args, deps),
      )
      server.registerTool(
        GOOGLE_DRIVE_READ_FILE_TOOL,
        {
          title: 'Read Google Drive file',
          description:
            'Read or export a Drive file under a published agent definition. Credentials stay on the server. maxBytes is a rejection limit (default 10MB): a larger Drive file fails with 413 file_too_large, omitting it reads the most. Native Google Docs/Sheets/Slides are exported as text and PDFs are returned as extracted text; other binary files return metadata with warnings only, no text. If the result includes authorizationUrl, show that URL to the user and retry after they finish connecting.',
          inputSchema: googleDriveReadFileInputSchema,
        },
        async (args) => enterpriseToolResult(principal, GOOGLE_DRIVE_READ_FILE_TOOL, args, deps),
      )
      server.registerTool(
        GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
        {
          title: 'Create Google Drive folder',
          description:
            'Request creation of a Drive folder under a published agent definition. Does not call Google until a human approves the operation: returns immediately with status: awaiting_approval and an approvalUrl — show that link to the user so they can approve it, do not poll or wait for completion.',
          inputSchema: googleDriveCreateFolderInputSchema,
        },
        async (args) => enterpriseToolResult(principal, GOOGLE_DRIVE_CREATE_FOLDER_TOOL, args, deps),
      )
      server.registerTool(
        GOOGLE_DRIVE_UPLOAD_FILE_TOOL,
        {
          title: 'Upload Google Drive file',
          description:
            'Request upload of a text file (HTML, CSV, JSON) to the user\'s Drive. Pass definitionId from platform.agent.get_definition. Does not call Google until a human approves the operation: returns immediately with status: awaiting_approval and an approvalUrl — show that link to the user so they can approve it, do not poll or wait for completion.',
          inputSchema: googleDriveUploadFileInputSchema,
        },
        async (args) => enterpriseToolResult(principal, GOOGLE_DRIVE_UPLOAD_FILE_TOOL, args, deps),
      )
      server.registerTool(
        GOOGLE_SHEETS_WRITE_RANGE_TOOL,
        {
          title: 'Write Google Sheet range',
          description:
            'Request writing cells to a Google Sheet the user can edit. values is a JSON 2D array string. Does not write until a human approves the operation: returns immediately with status: awaiting_approval and an approvalUrl — show that link to the user so they can approve it, do not poll or wait for completion.',
          inputSchema: googleSheetsWriteRangeInputSchema,
        },
        async (args) => enterpriseToolResult(principal, GOOGLE_SHEETS_WRITE_RANGE_TOOL, args, deps),
      )
      server.registerTool(
        GMAIL_SEARCH_TOOL,
        {
          title: 'Search Gmail',
          description:
            'Search the connected Gmail mailbox. Returns id, from, subject, snippet. Call gmail_get_message with an id to read a body. If the result includes authorizationUrl, show that URL to the user and retry after they finish connecting.',
          inputSchema: gmailSearchInputSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => enterpriseToolResult(principal, GMAIL_SEARCH_TOOL, args, deps),
      )
      server.registerTool(
        GMAIL_GET_MESSAGE_TOOL,
        {
          title: 'Read Gmail message',
          description:
            'Read one Gmail message by id from gmail_search. Credentials stay on the server. If the result includes authorizationUrl, show that URL to the user and retry after they finish connecting.',
          inputSchema: gmailGetMessageInputSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => enterpriseToolResult(principal, GMAIL_GET_MESSAGE_TOOL, args, deps),
      )
      server.registerTool(
        HTTP_API_GET_TOOL,
        {
          title: 'HTTP API GET',
          description:
            'One GET against a bound company HTTP API connector. Requires definitionId from platform.agent.get_definition. Path is relative to the connector baseUrl — do not send credentials. For large lists use http_api_get_all. Allowed paths are under connectors[].endpoints in get_definition. With several HTTP connectors, the server usually picks by method+path; otherwise pass connectorName (connectors[].name) or connectorId. Unlisted paths return endpoint_not_allowed with the allowed list.',
          inputSchema: httpApiGetInputSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => enterpriseToolResult(principal, HTTP_API_GET_TOOL, args, deps),
      )
      server.registerTool(
        HTTP_API_GET_ALL_TOOL,
        {
          title: 'HTTP API GET all pages',
          description:
            'Paginated GET of a company HTTP API list in one call. Requires definitionId from platform.agent.get_definition and pagination on the chosen connectors[].endpoints entry; without it the call returns an error. Required for ownerships/partners/large registers — do not page http_api_get yourself. Path is relative to the connector baseUrl. Disambiguate with connectorName or connectorId when needed.',
          inputSchema: httpApiGetAllInputSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => enterpriseToolResult(principal, HTTP_API_GET_ALL_TOOL, args, deps),
      )
      server.registerTool(
        HTTP_API_REQUEST_TOOL,
        {
          title: 'HTTP API write',
          description:
            'POST/PUT/PATCH/DELETE against a bound company HTTP API. Requires definitionId from platform.agent.get_definition. body is a JSON string. Path is relative to the connector baseUrl. Use connectors[].endpoints; disambiguate with connectorName or connectorId when several APIs are bound. Does not call the API until a human approves the operation: returns immediately with status: awaiting_approval and an approvalUrl — show that link to the user so they can approve it, do not poll or wait for completion.',
          inputSchema: httpApiRequestInputSchema,
        },
        async (args) => enterpriseToolResult(principal, HTTP_API_REQUEST_TOOL, args, deps),
      )
      server.registerTool(
        KB_SEARCH_TOOL,
        {
          title: 'Search knowledge base',
          description:
            'Keyword search when kb_list_index does not name the source. Returns short snippets, not full documents. Pass definitionId from platform.agent.get_definition.',
          inputSchema: kbSearchInputSchema,
        },
        async (args) => enterpriseToolResult(principal, KB_SEARCH_TOOL, args, deps),
      )
      server.registerTool(
        KB_LIST_INDEX_TOOL,
        {
          title: 'List knowledge base index',
          description:
            'Call this first. With no pathPrefix or artifactId, returns one row per source (filename, purpose, size; wiki rows include page titles). Pass pathPrefix or artifactId to list wiki pages.',
          inputSchema: kbListIndexInputSchema,
        },
        async (args) => enterpriseToolResult(principal, KB_LIST_INDEX_TOOL, args, deps),
      )
      server.registerTool(
        KB_GET_PAGE_TOOL,
        {
          title: 'Get knowledge base page',
          description:
            'Read one wiki page by path. For the table of contents pass path "index.md" and artifactId from kb_list_index. Do not open every page.',
          inputSchema: kbGetPageInputSchema,
        },
        async (args) => enterpriseToolResult(principal, KB_GET_PAGE_TOOL, args, deps),
      )
      server.registerTool(
        KB_GET_DOCUMENT_TOOL,
        {
          title: 'Get knowledge base file',
          description:
            'Read one raw file by documentId from kb_list_index. Files over 8000 characters return an outline; pass section to read one heading. Wiki sources return artifactId instead of the full text.',
          inputSchema: kbGetDocumentInputSchema,
          annotations: { readOnlyHint: true },
        },
        async (args) => enterpriseToolResult(principal, KB_GET_DOCUMENT_TOOL, args, deps),
      )
      server.registerTool(
        KB_INGEST_TOOL,
        {
          title: 'Ingest knowledge base file',
          description:
            'Load a file into the agent knowledge base. processingMode=raw_text_only keeps the extracted text; okf splits it into a wiki. Optional purpose is one line on what the file is for. Pass UTF-8 content or contentBase64 for PDF/DOCX/XLSX.',
          inputSchema: kbIngestInputSchema,
        },
        async (args) => enterpriseToolResult(principal, KB_INGEST_TOOL, args, deps),
      )
      server.registerTool(
        MCP_GATEWAY_OPERATION_GET_TOOL,
        {
          title: 'Get gateway operation',
          description: 'Read one gateway operation the caller is allowed to see.',
          inputSchema: z.object({ operationId: z.string().uuid() }).passthrough(),
        },
        async (args) =>
          getGatewayOperationToolResult(principal, args as Record<string, unknown>, deps),
      )

      for (const pkg of packages) {
        for (const file of pkg.files) {
          const uri = skillFileUri(pkg.uriName, file.path)
          server.registerResource(
            `${pkg.uriName}/${file.path}`,
            uri,
            {
              title: file.path === 'SKILL.md' ? pkg.name : file.path,
              mimeType: file.mimeType,
              ...(file.path === 'SKILL.md' ? { description: pkg.description } : {}),
            },
            async () => {
              await auditMcpResourceRead(deps, principal, uri)
              return { contents: [{ uri, mimeType: file.mimeType, text: file.text }] }
            },
          )
        }
      }
      server.server.setRequestHandler(
        'skills/list',
        { params: mcpSkillsListParamsSchema, result: mcpSkillsListResultSchema },
        async () => ({ skills: packages.map(toSkillsListEntry) }),
      )
      server.server.setRequestHandler(
        'skills/get',
        { params: mcpSkillsGetParamsSchema, result: mcpSkillEntrySchema },
        async (params) => {
          const pkg = findPackageByUri(packages, params.uri)
          if (!pkg) throw new Error('Skill not found')
          await auditMcpResourceRead(deps, principal, params.uri)
          return toSkillsListEntry(pkg)
        },
      )

      server.server.setRequestHandler('tools/call', async (request) => {
        const toolName = request.params.name
        if (!(MCP_ALLOWED_TOOLS as readonly string[]).includes(toolName)) {
          await auditMcpToolDenied(deps, principal, toolName)
          return textResult(
            { code: 'tool_not_allowed', message: 'Tool is not allowed on this MCP endpoint' },
            true,
          )
        }
        const rawArgs = request.params.arguments
        const args =
          rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
            ? (rawArgs as Record<string, unknown>)
            : {}
        if (toolName === MCP_AGENTS_LIST_TOOL) return listAgentsToolResult(principal, deps)
        if (toolName === MCP_AGENT_GET_DEFINITION_TOOL) {
          return getDefinitionToolResult(principal, args, deps)
        }
        if (toolName === MCP_AGENT_CHECKOUT_TOOL) {
          return checkoutToolResult(principal, args, deps, origin)
        }
        if (toolName === MCP_AGENT_CREATE_DRAFT_TOOL) {
          return createDraftToolResult(principal, args, deps)
        }
        if (toolName === MCP_AGENT_GET_WORKING_SET_TOOL) {
          return getWorkingSetToolResult(principal, args, deps)
        }
        if (toolName === MCP_AGENT_PUBLISH_TOOL) {
          return publishAgentToolResult(principal, args, deps)
        }
        if (toolName === MCP_SKILLS_LIST_TOOL) {
          return listSkillsToolResult(principal, deps, packages)
        }
        if (toolName === MCP_SKILL_READ_TOOL) {
          return readSkillToolResult(principal, args, deps, packages)
        }
        if (toolName === MCP_SKILL_SUBMIT_TOOL) {
          return submitSkillToolResult(principal, args, deps)
        }
        if (isProjectWorkTool(toolName)) {
          return projectWorkToolResult(principal, toolName, args, deps, origin)
        }
        if (toolName === MCP_GATEWAY_OPERATION_GET_TOOL) {
          return getGatewayOperationToolResult(principal, args, deps)
        }
        if (isEnterpriseTool(toolName)) {
          return enterpriseToolResult(principal, toolName, args, deps, origin)
        }
        return whoamiToolResult(principal, deps)
      })
    },
    {
      serverInfo: { name: mcpServerDisplayName(tenant), version: '1.0' },
      instructions,
    },
  )
}

async function enterpriseToolResult(
  principal: McpPrincipal,
  toolName: string,
  args: Record<string, unknown>,
  deps: McpRuntimeDeps,
  origin?: string,
) {
  return deps.invokeEnterpriseTool({ principal, toolName, args, origin })
}

async function projectWorkToolResult(
  principal: McpPrincipal,
  toolName: string,
  args: Record<string, unknown>,
  deps: McpRuntimeDeps,
  origin?: string,
) {
  return deps.invokeProjectWork({ principal, toolName, args, origin })
}

async function getGatewayOperationToolResult(
  principal: McpPrincipal,
  args: Record<string, unknown>,
  deps: McpRuntimeDeps,
) {
  await auditMcpToolCall(deps, principal, MCP_GATEWAY_OPERATION_GET_TOOL)
  const operationId = typeof args.operationId === 'string' ? args.operationId : ''
  return deps.getGatewayOperation({ principal, operationId })
}

function toAuthInfo(token: string, verified: VerifiedOAuthToken): AuthInfo {
  return {
    token,
    clientId: 'clerk',
    scopes: ['openid', 'profile', 'email'],
    extra: { userId: verified.clerkUserId },
  }
}

/**
 * Tenant-scoped Streamable HTTP MCP resource. Authenticate every request.
 * `userId` / `tenantId` never come from tool JSON.
 */
export async function handleMcpRequest(
  request: Request,
  tenantSlug: string,
  deps: McpRuntimeDeps = productionMcpDeps(),
): Promise<Response> {
  if (!deps.isClerkConfigured()) return mcpAuthNotConfigured()

  const origin = deps.resolveOrigin(request)
  const verifyToken = async (_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> => {
    if (!bearerToken) return undefined
    const verified = await deps.verifyOAuthToken(bearerToken)
    if (!verified) {
      // withMcpAuth(required) 401s here and never calls inner / resolveMcpPrincipal.
      await auditMcpAuthDenied(deps, { code: 'invalid_token' }, tenantSlug)
      return undefined
    }
    return toAuthInfo(bearerToken, verified)
  }

  const inner = async (req: Request): Promise<Response> => {
    const resolved = await resolveMcpPrincipal(
      {
        authorizationHeader: req.headers.get('authorization'),
        tenantSlug,
        resourceOrigin: origin,
      },
      deps,
    )
    if (!resolved.ok) {
      if (resolved.code === 'unauthenticated' || resolved.code === 'invalid_token') {
        return unauthorizedResponse(origin)
      }
      return forbiddenResponse(resolved)
    }
    const handler = await createMcpResourceHandler(resolved.principal, deps, origin)
    return handler(req)
  }

  return withMcpAuth(inner, verifyToken, {
    required: true,
    resourceMetadataPath: '/.well-known/oauth-protected-resource/api/mcp',
    resourceUrl: origin,
  })(request)
}
