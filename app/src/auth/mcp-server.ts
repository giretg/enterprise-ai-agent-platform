import { auth } from '@clerk/nextjs/server'
import type { SkillVersionStatus } from '@prisma/client'
import {
  createRequestStateCodec,
  inputResponse,
  type AuthInfo,
  type CallToolResult,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server'
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
  CHECKOUT_HARNESSES,
  CHECKOUT_TOOL_DESCRIPTION,
  checkoutSlug,
  hermesBotTitle,
  renderAgentBriefing,
  renderAgentCheckout,
  renderAgentPrompt,
  type CheckoutSkill,
} from '@/lib/agent-checkout'
import { localRootsDefinitionBlock, withLocalRootsMemoryNote } from '@/lib/agent-local-roots'
import { parseSkillContent, parseSkillRequires } from '@/lib/skill/skill-content'
import {
  GMAIL_CREATE_DRAFT_TOOL,
  GMAIL_GET_MESSAGE_TOOL,
  GMAIL_GET_THREAD_TOOL,
  GMAIL_LIST_DRAFTS_TOOL,
  GMAIL_LIST_LABELS_TOOL,
  GMAIL_MCP_INPUT_SCHEMAS,
  GMAIL_MODIFY_LABELS_TOOL,
  GMAIL_SEARCH_TOOL,
  GMAIL_SEND_TOOL,
  GMAIL_TRASH_TOOL,
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
  SANDBOX_RUN_TOOL,
  sandboxRunInputSchema,
  gmailGetMessageInputSchema,
  gmailGetThreadInputSchema,
  gmailListDraftsInputSchema,
  gmailListLabelsInputSchema,
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
  isEnterpriseWriteTool,
  type EnterpriseToolMcpResult,
  type InputRequiredToolResult,
  type WriteConfirmInput,
  type WriteConfirmState,
} from '@/domain/enterprise-tools'
import { WRITE_CONFIRM_KEY } from '@/domain/gateway-operation'
import {
  formElicitationCapable,
  writeConfirmLinkReason,
} from '@/domain/gateway-operation/write-confirm-branch'
import {
  auditMcpAuthDenied,
  auditMcpAuthOk,
  auditMcpPromptGet,
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
  type McpAuditCtx,
  type McpPrincipal,
  type McpPrincipalDeps,
  type McpPrincipalFailure,
  type VerifiedOAuthToken,
} from './mcp-principal'
import { getMcpRequestContext, scopeMcpAuditSink } from '@/lib/mcp-session'
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
  MCP_HANDOFF_ACK_TOOL,
  MCP_HANDOFF_TOOL,
  MCP_PROJECTS_CREATE_TOOL,
  MCP_PROJECTS_LIST_TOOL,
  MCP_PROJECT_MEMORY_READ_TOOL,
  MCP_PROJECT_MEMORY_WRITE_TOOL,
  MCP_WORK_FILE_DELETE_TOOL,
  MCP_WORK_FILE_LIST_TOOL,
  MCP_WORK_FILE_READ_TOOL,
  MCP_WORK_FILE_WRITE_TOOL,
  MCP_WORK_FILE_APPEND_TOOL,
  handoffAckInputSchema,
  handoffInputSchema,
  projectMemoryReadInputSchema,
  projectMemoryWriteInputSchema,
  projectsCreateInputSchema,
  projectsListInputSchema,
  workFileAppendInputSchema,
  workFileDeleteInputSchema,
  workFileListInputSchema,
  workFileReadInputSchema,
  workFileWriteInputSchema,
} from '@/domain/project-work/mcp'

export type McpAgentListItem = McpCoworkerSummary

type McpCheckoutSkill = CheckoutSkill & {
  status: SkillVersionStatus
}

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
  /** #663: az agent megnevezett jóváhagyójának neve a briefing Jóváhagyások blokkjához. */
  loadAgentApproverName?: (input: { tenantId: string; agentId: string }) => Promise<string | null>
  loadSkillVersions: (versionIds: string[]) => Promise<McpCheckoutSkill[]>
  invokeEnterpriseTool: (input: {
    principal: McpPrincipal
    toolName: string
    args: Record<string, unknown>
    origin?: string
    confirm?: WriteConfirmInput
  }) => Promise<EnterpriseToolMcpResult | InputRequiredToolResult>
  /** HMAC key for the write-confirmation `requestState` (#618); missing → link only. */
  requestStateKey?: string
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
  /** skillVersionIds: exactly these pinned versions (#653); omitted → the tenant's active skills. */
  listMcpSkills: (input: { tenantId: string; skillVersionIds?: string[] }) => Promise<McpSkillPackage[]>
  agentScaffold: AgentScaffoldDeps
  listOpenHandoffs?: (input: { tenantId: string; agentId: string }) => Promise<HandoffHeadline[]>
}

export type HandoffHeadline = {
  id: string
  title: string
  projectKey: string
  createdAt: string
  fromAgentName: string | null
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

export async function canViewAgent(input: {
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
    loadAgentApproverName: async ({ tenantId, agentId }) => {
      const agent = await repositories.agents.findById(agentId, tenantId)
      if (!agent?.approverUserId) return null
      const user = await repositories.users.findById(agent.approverUserId)
      return user ? user.name || user.email : null
    },
    async loadSkillVersions(versionIds) {
      const rows = await repositories.skills.findVersionsByIds(versionIds)
      return rows.map((row) => ({
        skillId: row.skillId,
        skillVersionId: row.id,
        status: row.status,
        name: row.skill.name,
        displayName: row.skill.displayName,
        description: row.skill.description,
        license: row.skill.license,
        content: parseSkillContent(row.content),
        requires: parseSkillRequires(row.requires),
      }))
    },
    invokeEnterpriseTool: (input) => services.enterpriseTools.invoke(input),
    requestStateKey: process.env.MCP_REQUEST_STATE_KEY,
    getGatewayOperation: async (input) =>
      services.gatewayOperations.toMcpGet(
        await services.gatewayOperations.get({
          principal: input.principal,
          operationId: input.operationId,
        }),
      ),
    invokeProjectWork: (input) => services.projectWork.invoke(input),
    listOpenHandoffs: async (input) => {
      const rows = await services.projectWork.handoffs.listOpenForAgent(input.tenantId, input.agentId, 10)
      return Promise.all(
        rows.map(async (row) => {
          const from = await repositories.agents.findById(row.fromAgentId, input.tenantId)
          return {
            id: row.id,
            title: row.title,
            projectKey: row.projectKey,
            createdAt: row.createdAt.toISOString(),
            fromAgentName: from?.name ?? null,
          }
        }),
      )
    },
    listMcpSkills: ({ tenantId, skillVersionIds }) =>
      services.skills.listMcpSkillPackages(tenantId, skillVersionIds),
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
const agentScopeSchema = {
  definitionId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
}
const skillsListToolSchema = mcpSkillsListParamsSchema.extend({
  ...agentScopeSchema,
  includeOtherSkills: z.boolean().optional(),
})
const skillReadToolSchema = mcpSkillsGetParamsSchema.extend(agentScopeSchema)

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

type AgentSkills = {
  agentId: string
  packages: McpSkillPackage[]
  entrySkillVersionId: string | null
}

/**
 * #653: definitionId / agentId → exactly the skill versions pinned in that
 * published definition (not the skill's current active version). null = no
 * agent named; 'not_found' = unknown or not visible to this user.
 */
async function loadAgentSkills(
  principal: McpPrincipal,
  args: Record<string, unknown>,
  deps: McpRuntimeDeps,
): Promise<AgentSkills | null | 'not_found'> {
  if (args.definitionId === undefined && args.agentId === undefined) return null
  const definitionId = asUuid(args.definitionId)
  const agentId = asUuid(args.agentId)
  if (!definitionId && !agentId) return 'not_found'
  const loaded = await deps.loadDefinition({ tenantId: principal.tenantId, definitionId, agentId })
  if (
    !loaded ||
    !(await deps.canViewAgent({
      tenantId: principal.tenantId,
      userId: principal.userId,
      role: principal.role,
      agentId: loaded.agentId,
    }))
  ) {
    return 'not_found'
  }
  const pins = loaded.snapshot.skills
  const entrySkillVersionId = pins.find((pin) => pin.entry)?.skillVersionId ?? null
  const packages = [
    ...(await deps.listMcpSkills({
      tenantId: principal.tenantId,
      skillVersionIds: pins.map((pin) => pin.skillVersionId),
    })),
  ]
  if (entrySkillVersionId) {
    packages.sort(
      (a, b) =>
        Number(b.skillVersionId === entrySkillVersionId) -
        Number(a.skillVersionId === entrySkillVersionId),
    )
  }
  return { agentId: loaded.agentId, packages, entrySkillVersionId }
}

async function listSkillsToolResult(
  principal: McpPrincipal,
  args: Record<string, unknown>,
  deps: McpRuntimeDeps,
  tenantPackages: McpSkillPackage[],
) {
  await auditMcpToolCall(deps, principal, MCP_SKILLS_LIST_TOOL, agentCtx(args))
  const agent = await loadAgentSkills(principal, args, deps)
  if (agent === 'not_found') return definitionNotFound()
  if (!agent) return textResult({ skills: tenantPackages.map(toSkillsListEntry) })
  const own = new Set(agent.packages.map((pkg) => pkg.uriName))
  return textResult({
    skills: [
      ...agent.packages.map((pkg) => ({
        ...toSkillsListEntry(pkg),
        ...(pkg.skillVersionId === agent.entrySkillVersionId ? { entry: true } : {}),
      })),
      ...(args.includeOtherSkills === true
        ? tenantPackages
            .filter((pkg) => !own.has(pkg.uriName))
            .map((pkg) => ({ ...toSkillsListEntry(pkg), assignedToAgent: false }))
        : []),
    ],
  })
}

async function readSkillToolResult(
  principal: McpPrincipal,
  args: Record<string, unknown>,
  deps: McpRuntimeDeps,
  tenantPackages: McpSkillPackage[],
) {
  await auditMcpToolCall(deps, principal, MCP_SKILL_READ_TOOL, agentCtx(args))
  const agent = await loadAgentSkills(principal, args, deps)
  if (agent === 'not_found') return definitionNotFound()
  const uri = typeof args.uri === 'string' ? args.uri : ''
  const parsed = parseSkillResourceUri(uri)
  const own = parsed ? findPackageByUri(agent?.packages ?? tenantPackages, uri) : undefined
  // Another skill of the tenant only by explicit uri, and the answer says so.
  const pkg = own ?? (agent && parsed ? findPackageByUri(tenantPackages, uri) : undefined)
  const file = pkg && parsed ? findSkillFile(pkg, parsed.filePath) : undefined
  if (!file) return textResult({ code: 'skill_resource_not_found', message: 'Skill resource not found' }, true)
  await auditMcpResourceRead(deps, principal, uri)
  return textResult({
    contents: [{ uri, mimeType: file.mimeType, text: file.text }],
    ...(own
      ? {}
      : {
          assignedToAgent: false,
          note: 'This skill is not assigned to the selected agent. Use it only because the user asked for it explicitly, and tell them.',
        }),
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

/** Paritás-telemetria (#666): ha az args hordoz agentId-t, pecsételjük az audit-sorba. */
function agentCtx(args: Record<string, unknown>): McpAuditCtx | undefined {
  const agentId = asUuid(args.agentId)
  return agentId ? { agentId } : undefined
}

function asVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

async function getDefinitionToolResult(
  principal: McpPrincipal,
  args: Record<string, unknown>,
  deps: McpRuntimeDeps,
  bound = false,
) {
  await auditMcpToolCall(deps, principal, MCP_AGENT_GET_DEFINITION_TOOL, agentCtx(args))
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
  const [memoryContext, skills] = await Promise.all([
    readMemoryContext(principal, loaded.definitionId, loaded.agentId, deps),
    deps.loadSkillVersions(loaded.snapshot.skills.map((skill) => skill.skillVersionId)),
  ])
  const approverName = await deps.loadAgentApproverName?.({
    tenantId: principal.tenantId,
    agentId: loaded.agentId,
  })
  const roots = loaded.snapshot.localRoots
  if (memoryContext.memoryIndex) {
    memoryContext.memoryIndex = {
      ...memoryContext.memoryIndex,
      note: withLocalRootsMemoryNote(memoryContext.memoryIndex.note, roots),
    }
  }
  return textResult({
    briefing: renderAgentBriefing({
      definition: loaded,
      skills,
      bound,
      recentSessionLogs: memoryContext.recentSessionLogs?.entries,
      handoffs: memoryContext.handoffs?.entries,
      approverName: approverName ?? null,
    }),
    ...loaded,
    contentHash: hashSnapshot(loaded.snapshot),
    ...localRootsDefinitionBlock(roots),
    ...memoryContext,
  })
}

function isFocusMemoryItem(item: unknown): boolean {
  return typeof item === 'object' && item !== null && (item as { kind?: unknown }).kind === 'focus'
}

const MEMORY_INDEX_NOTE =
  'Catalog of the agent\'s __general__ memory (company facts, decisions, locations). It overrides search results — if Drive/KB/API results contradict it, follow the memory and say so. Full text: platform.project_memory.read with ids="<comma-separated ids>" or query="…".'

/**
 * Push the agent's __general__ memory into get_definition so the client has the
 * company facts before its first enterprise tool call, instead of having to
 * remember to read them. Goes through invokeProjectWork, so the same operate
 * check + audit as platform.project_memory.read apply; denied → omitted.
 *
 * The focus (#656) is the agent's current state: returned before memoryIndex,
 * in full. The memory catalog lists every non-focus item (#657); bodies load on demand.
 */
type MemoryContext = {
  focus?: { note: string; items: unknown[] }
  recentSessionLogs?: {
    note: string
    entries: Array<{ id: string; title: string; createdAt: string; withUserName: string }>
  }
  handoffs?: {
    note: string
    entries: HandoffHeadline[]
  }
  memoryIndex?: {
    note: string
    entries: unknown[]
    totalCount: number
    offset: number
    nextOffset: number | null
  }
}

async function readMemoryContext(
  principal: McpPrincipal,
  definitionId: string,
  agentId: string,
  deps: McpRuntimeDeps,
): Promise<MemoryContext> {
  const [result, handoffs] = await Promise.all([
    deps.invokeProjectWork({
      principal,
      toolName: MCP_PROJECT_MEMORY_READ_TOOL,
      args: { definitionId },
    }),
    (deps.listOpenHandoffs
      ? deps.listOpenHandoffs({ tenantId: principal.tenantId, agentId }).catch(() => [] as HandoffHeadline[])
      : Promise.resolve([] as HandoffHeadline[])),
  ])
  const handoffBlock =
    handoffs.length > 0
      ? {
          handoffs: {
            note: 'Open tasks handed off to this agent by a coworker. The briefing "Handed-off work" block mirrors this list. Full text: platform.project_memory.read with query="<title>". Acknowledge with platform.handoff_ack { handoffId, decision: accepted|done|rejected }.',
            entries: handoffs,
          },
        }
      : {}
  if (result.isError) return { ...handoffBlock }
  type MemoryReadPayload = {
    items?: unknown[]
    recentSessionLogs?: Array<{ id: string; title: string; createdAt: string; withUserName: string }>
    index?: { entries: unknown[]; totalCount: number; offset: number; nextOffset: number | null }
  }
  let payload: MemoryReadPayload = {}
  try {
    payload = JSON.parse(result.content[0]?.text ?? '{}') as MemoryReadPayload
  } catch {
    return { ...handoffBlock }
  }

  const index = payload.index
  if (!index) return { ...handoffBlock }

  const focusItems = Array.isArray(payload.items) ? payload.items.filter(isFocusMemoryItem) : []
  const recentSessionLogs = Array.isArray(payload.recentSessionLogs) ? payload.recentSessionLogs : []
  const paginated = index.nextOffset != null
  return {
    ...handoffBlock,
    ...(focusItems.length > 0
      ? {
          focus: {
            note:
              'The agent\'s current focus, always loaded in full before memoryIndex: what it is doing now, the next step, what it is waiting for. It overrides the rest of the memory. Rewrite it with platform.project_memory.write kind="focus" (it replaces the previous one) when a task closes or the direction changes.',
            items: focusItems,
          },
        }
      : {}),
    ...(recentSessionLogs.length > 0
      ? {
          recentSessionLogs: {
            note:
              'Append-only session journal (titles only here). The briefing "Recently" block mirrors this list. Full text: platform.project_memory.read with ids. Write new entries with platform.project_memory.write kind="session_log" when a task or conversation ends.',
            entries: recentSessionLogs,
          },
        }
      : {}),
    memoryIndex: {
      note:
        MEMORY_INDEX_NOTE +
        (paginated
          ? ` More catalog rows: platform.project_memory.read with offset=${index.nextOffset}.`
          : ''),
      entries: index.entries,
      totalCount: index.totalCount,
      offset: index.offset,
      nextOffset: index.nextOffset,
    },
  }
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
  await auditMcpToolCall(deps, principal, MCP_AGENT_GET_WORKING_SET_TOOL, agentId ? { agentId } : undefined)
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
  await auditMcpToolCall(deps, principal, MCP_AGENT_PUBLISH_TOOL, agentId ? { agentId } : undefined)
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
  await auditMcpToolCall(deps, principal, MCP_AGENT_CHECKOUT_TOOL, agentCtx(args))
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
  // A published snapshot történeti bizonyíték: a később visszavont skill csak
  // akkor kerülhetne újra helyi checkoutba, ha itt nem ellenőriznénk az élő státuszát.
  return textResult(
    renderAgentCheckout({
      definition: loaded,
      skills: skills.filter((skill) => skill.status === 'active'),
      mcpUrl: `${origin.replace(/\/+$/, '')}/api/mcp/${principal.tenantSlug}`,
      harness: asCheckoutHarness(args.harness),
    }),
  )
}

/**
 * prompts/get for one agent (#651): always the current published definition, re-checked for visibility.
 * `boundAgentId` is the agent the {@link MCP_AGENT_ID_HEADER} pins this client to — a prompt for any
 * other agent is refused, because every tool call would still run on the bound agent's definition.
 */
async function agentPromptResult(
  principal: McpPrincipal,
  deps: McpRuntimeDeps,
  promptName: string,
  agentId: string,
  task: string | undefined,
  boundAgentId: string | null,
) {
  await auditMcpPromptGet(deps, principal, promptName, agentId)
  if (boundAgentId && boundAgentId !== agentId) throw new Error('Agent not found')
  const loaded = await deps.loadDefinition({ tenantId: principal.tenantId, agentId })
  if (
    !loaded ||
    !isDispatchable(loaded.status) ||
    !(await deps.canViewAgent({
      tenantId: principal.tenantId,
      userId: principal.userId,
      role: principal.role,
      agentId: loaded.agentId,
    }))
  ) {
    throw new Error('Agent not found')
  }
  const skills = await deps.loadSkillVersions(loaded.snapshot.skills.map((skill) => skill.skillVersionId))
  return {
    description: hermesBotTitle(loaded.snapshot),
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: renderAgentPrompt({ definition: loaded, skills, task, bound: boundAgentId !== null }),
        },
      },
    ],
  }
}

/** Per-client agent binding (#682 WP-2): Hermes Bots etc. send it on every MCP request. */
export const MCP_AGENT_ID_HEADER = 'x-excellence-agent-id'

/**
 * The header is only input: it picks the agent, it never widens access. The
 * agent must be in this tenant, published and visible to the user; the tool's
 * own gate (capability, connector grant, approval) still runs afterwards.
 * No definitionId in args → the agent's current published definition.
 * definitionId / agentId of another agent → agent_mismatch.
 */
async function bindAgentHeader(
  principal: McpPrincipal,
  deps: McpRuntimeDeps,
  toolName: string,
  args: Record<string, unknown>,
  header: string,
): Promise<{ ok: true; args: Record<string, unknown> } | { ok: false; result: CallToolResult }> {
  const deny = async (code: string) => {
    await auditMcpToolDenied(deps, principal, toolName, code, { headerAgentId: header.slice(0, 64) })
    return { ok: false as const, result: textResult({ code, message: `${MCP_AGENT_ID_HEADER}: ${code}` }, true) }
  }
  const agentId = asUuid(header)
  const current = agentId ? await deps.loadDefinition({ tenantId: principal.tenantId, agentId }) : null
  if (
    !current ||
    !isDispatchable(current.status) ||
    !(await deps.canViewAgent({
      tenantId: principal.tenantId,
      userId: principal.userId,
      role: principal.role,
      agentId: current.agentId,
    }))
  ) {
    return deny('agent_not_found')
  }
  if (args.agentId !== undefined && args.agentId !== current.agentId) return deny('agent_mismatch')
  if (args.definitionId !== undefined && args.definitionId !== current.definitionId) {
    const definitionId = asUuid(args.definitionId)
    const pinned = definitionId
      ? await deps.loadDefinition({ tenantId: principal.tenantId, definitionId })
      : null
    if (pinned?.agentId !== current.agentId) return deny('agent_mismatch')
    return { ok: true, args }
  }
  if (toolUsesAgentIdArgs(toolName)) {
    return { ok: true, args: args.definitionId ? args : { ...args, agentId: current.agentId } }
  }
  return { ok: true, args: { ...args, definitionId: current.definitionId } }
}

function toolUsesAgentIdArgs(toolName: string): boolean {
  return (
    toolName === MCP_AGENT_GET_DEFINITION_TOOL ||
    toolName === MCP_AGENT_CHECKOUT_TOOL ||
    toolName === MCP_AGENT_GET_WORKING_SET_TOOL ||
    toolName === MCP_AGENT_PUBLISH_TOOL
  )
}

function toolBindsToAgentHeader(toolName: string): boolean {
  return (
    toolUsesAgentIdArgs(toolName) ||
    toolName === MCP_SKILLS_LIST_TOOL ||
    toolName === MCP_SKILL_READ_TOOL ||
    isProjectWorkTool(toolName) ||
    isEnterpriseTool(toolName)
  )
}

function requestStateCodec(key: string | undefined): RequestStateCodec<WriteConfirmState> | null {
  if (!key) return null
  try {
    // ponytail: codec TTL well past the 15-minute payload `exp`, so an expired but
    // authentic state reaches the handler and falls back to the link (#618) instead of -32602.
    return createRequestStateCodec<WriteConfirmState>({ key, ttlSeconds: 24 * 60 * 60 })
  } catch {
    return null // shorter than 32 bytes: fail closed to the link
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** #618 branch selection: a form only for a 2026-07-28 request that declares form elicitation. */
function writeConfirmInput(
  ctx: ServerContext,
  codec: RequestStateCodec<WriteConfirmState> | null,
): WriteConfirmInput {
  const envelope: Record<string, unknown> = ctx.mcpReq.envelope ?? {}
  const formCapable = formElicitationCapable(envelope)
  const state = ctx.mcpReq.requestState()
  const responses = ctx.mcpReq.inputResponses
  const answer = inputResponse(responses, WRITE_CONFIRM_KEY)
  const mint =
    formCapable && codec ? (payload: WriteConfirmState) => codec.mint(payload) : null
  return {
    mint,
    ...(mint ? {} : { linkReason: writeConfirmLinkReason(envelope, codec !== null) }),
    ...(state !== undefined || responses !== undefined
      ? {
          retry: {
            state,
            response:
              answer.kind === 'elicit' ? { action: answer.action, content: answer.content } : null,
          },
        }
      : {}),
  }
}

async function createMcpResourceHandler(
  principal: McpPrincipal,
  deps: McpRuntimeDeps,
  origin: string,
  agentHeader: string | null = null,
) {
  const { tenant, context } = await loadTenantContext(principal, deps)
  const boundSkills = agentHeader
    ? await loadAgentSkills(principal, { agentId: agentHeader }, deps)
    : null
  const boundAgentId = boundSkills && boundSkills !== 'not_found' ? boundSkills.agentId : null
  /**
   * A client bound by {@link MCP_AGENT_ID_HEADER} can only work as that one agent — `bindAgentHeader`
   * denies every other agentId. So the instructions and the slash prompts must offer that agent only,
   * otherwise the client takes on a teammate's role while the server keeps running the bound one.
   */
  const coworkers = agentHeader
    ? context.coworkers.filter((row) => row.agentId === boundAgentId)
    : context.coworkers
  const instructions = buildMcpServerInstructions({
    tenant,
    tenantSlug: principal.tenantSlug,
    coworkers,
    bound: agentHeader !== null,
  })
  const codec = requestStateCodec(deps.requestStateKey)

  return createMcpHandler(
    async (server) => {
      const tenantPackages = await deps.listMcpSkills({ tenantId: principal.tenantId })
      // A client bound to one agent lists only that agent's skills (resources/list, skills/list).
      const packages = !agentHeader
        ? tenantPackages
        : boundSkills && boundSkills !== 'not_found'
          ? boundSkills.packages
          : []
      server.registerTool(
        MCP_WHOAMI_TOOL,
        {
          title: 'Who am I',
          description:
            'Return the authenticated MCP principal, tenant organization context, and visible coworkers for this tenant URL. Next step: platform.agent.get_definition — its response carries the agent\'s memory (company facts) that you need before answering company questions.',
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
            'Load one published agent: briefing (read `briefing` first and act as the agent it describes — role, published hard/trained rules in full, platform rules, start and closing steps, skills), then the definition snapshot (including snapshot.rules, capabilities, connectors with names/connectorIds, http_api endpoints), then localRoots when set (candidate git paths across machines — hints, not a grant; use only a path that exists on this host), then focus: the agent\'s current state (what it is doing now, the next step, what it waits for), always in full, then memoryIndex: a catalog (id, kind, title, date) of all other memory items. Published agent rules override a conflicting user request — stop and ask for approval instead of breaking them. Call platform.project_memory.read with ids or query for full text. Call this at the start of the conversation, before enterprise tools, and pass definitionId on each call. Read focus, localRoots and memoryIndex before answering — they override search results. Use agentId or definitionId; optional version.',
          inputSchema: z
            .object({
              definitionId: z.string().uuid().optional(),
              agentId: z.string().uuid().optional(),
              version: z.number().int().positive().optional(),
            })
            .passthrough(),
        },
        async (args) =>
          getDefinitionToolResult(principal, args as Record<string, unknown>, deps, agentHeader !== null),
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
              harness: z.enum(CHECKOUT_HARNESSES).optional(),
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
            'List skills. Pass definitionId (or agentId) from platform.agent.get_definition: then only that agent\'s skills come back, in the exact versions pinned in its definition, and the entry skill (read it first on every new task) has entry: true. includeOtherSkills=true adds the tenant\'s other skills marked assignedToAgent: false — only when the user explicitly asks for one. Without definitionId: every active skill of the tenant. Each skill includes a SKILL.md URI and resource URIs. Use platform.skills.read when the MCP client cannot read resources directly.',
          inputSchema: skillsListToolSchema,
          annotations: { readOnlyHint: true },
        },
        async (args) =>
          listSkillsToolResult(principal, args as Record<string, unknown>, deps, tenantPackages),
      )
      server.registerTool(
        MCP_SKILL_READ_TOOL,
        {
          title: 'Read skill resource',
          description:
            'Read a skill:// resource returned by platform.skills.list. Returns SKILL.md instructions or an attachment as text. Pass definitionId so you get the version pinned for the agent; a skill outside the agent comes back with assignedToAgent: false.',
          inputSchema: skillReadToolSchema,
          annotations: { readOnlyHint: true },
        },
        async (args) =>
          readSkillToolResult(principal, args as Record<string, unknown>, deps, tenantPackages),
      )
      server.registerTool(
        MCP_SKILL_SUBMIT_TOOL,
        {
          title: 'Submit skill from conversation',
          description:
            'Submit a new tenant skill written in this conversation for the named agentId — use for operating rules and procedures ("how we do it"), not for one-off facts (see Where to save what table). requires and attachments are JSON strings, not arrays. The server decides the outcome and the text must be relayed to the user: created (live, assigned, enabled), pending_approval, or rejected with a reason (no_producer_skill, cannot_use_agent, validation, name_taken). A tenant admin gets a live skill without opening the web UI. Anyone else who can operate the agent gets one open proposal (a new call overwrites it). Viewers and agents without an enabled producer skill are rejected and nothing is stored. Missing tools are listed; this call does not grant them. This tool cannot create or mark a producer skill.',
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
            'Create or overwrite a work file under the project (plans, notes, drafts). No approval; quota-capped. Do not write these into the checkout folder. Pass projectKey; omit for __general__. See the Where to save what table — work files are not memory.',
          inputSchema: workFileWriteInputSchema,
        },
        async (args) => projectWorkToolResult(principal, MCP_WORK_FILE_WRITE_TOOL, args, deps),
      )
      server.registerTool(
        MCP_WORK_FILE_APPEND_TOOL,
        {
          title: 'Append work file',
          description:
            'Append text to the end of a work file under the project (metrics JSONL, changelog CSV). Creates the file when missing. No approval; the quota applies to the resulting file size. Pass projectKey; omit for __general__.',
          inputSchema: workFileAppendInputSchema,
        },
        async (args) => projectWorkToolResult(principal, MCP_WORK_FILE_APPEND_TOOL, args, deps),
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
            'Read this agent\'s memory: company facts, decisions, locations, open tasks, findings, handoffs, artifact pointers. Default: memoryIndex catalog (every item id/kind/title/date; focus in full in items; recent session_log titles in recentSessionLogs). Pass ids (comma-separated) for full text of those items, or query to search title/body. Use offset when nextOffset is set. Read before answering company-specific questions and before searching Drive/KB — memory overrides search results. Each full item includes withUserId / withUserName. Pass mine=true to filter to the calling user. Call before platform.project_memory.write to update via replaceId. Omit projectKey for general memory.',
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
            'Write a project-memory item for this agent (decision, open_task, finding, constraint, artifact, handoff_summary, focus, session_log). See the Where to save what table before writing — short facts and decisions only; operating rules belong in platform.skills.submit, reference material in kb_ingest, plans in platform.work_file.write. The server returns wrong_placement when the body looks like a rule or long document. First call platform.project_memory.read for the same projectKey: if an item already covers this subject (including when the user corrects or changes it), pass its id as replaceId with the merged, current text — do not add a second item. If several items are outdated by the same change, write ONE item: replaceId for one, mergeIds for the rest. Write only what is valid now; do not keep "this is outdated" notes. If other similar active items would remain, the server answers possible_duplicate with candidates and writes nothing; then retry with replaceId/mergeIds, or confirmNew=true if none match. focus is the current state (what we are doing now, the next step, what we wait for), at most 3000 characters: there is only ever one active focus per agent and project, and this write always replaces it — no replaceId, no duplicate check. Rewrite it when a task closes or the direction changes. session_log is append-only when a task or conversation ends (what you did, outcome, where outputs live, next step): never replaceId, no duplicate check. The work plan itself belongs in a work file; store only a pointer here. The server stamps the calling user as conversation partner — do not name them. Cannot change trained operating rules. Approval-mode agents return awaiting_approval + approvalUrl; direct-mode agents write immediately. Personal facts (vacation, private preference) do not belong here unless they constrain the project.',
          inputSchema: projectMemoryWriteInputSchema,
        },
        async (args) => projectWorkToolResult(principal, MCP_PROJECT_MEMORY_WRITE_TOOL, args, deps),
      )
      server.registerTool(
        MCP_HANDOFF_TOOL,
        {
          title: 'Hand off work',
          description:
            'Hand off a task outside this agent\'s responsibility to another AI coworker or a human. Agent recipient: pass toAgentId (from platform.agents.list) — the task lands as an open_task in their memory and in their next get_definition briefing ("Handed-off work"). Human recipient: pass toUserId — they see it in the Control Plane inbox. Pass definitionId from platform.agent.get_definition, a short title, summary (what, why, expected outcome), optional projectKey (defaults to __general__), and optional links as a comma-separated string ("label | work_file:/path, label | https://…"). Exactly one of toAgentId / toUserId.',
          inputSchema: handoffInputSchema,
        },
        async (args) => projectWorkToolResult(principal, MCP_HANDOFF_TOOL, args, deps),
      )
      server.registerTool(
        MCP_HANDOFF_ACK_TOOL,
        {
          title: 'Acknowledge handoff',
          description:
            'Accept, complete, or reject a handed-off task addressed to this agent. Pass definitionId from platform.agent.get_definition, the handoffId from the briefing, and decision accepted|done|rejected.',
          inputSchema: handoffAckInputSchema,
        },
        async (args) => projectWorkToolResult(principal, MCP_HANDOFF_ACK_TOOL, args, deps),
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
            'Request upload of a file (HTML, CSV, JSON, image, PDF) to the user\'s Drive — finished deliverables for humans (see Where to save what table). Pass textContent for text or contentBase64 for binary bytes. Pass definitionId from platform.agent.get_definition. If this agent has a configured output folder, omit parentFolderId (or pass that folder id) to upload there immediately without approval; any other destination does not call Google until a human approves: returns immediately with status: awaiting_approval and an approvalUrl — show that link to the user so they can approve it, do not poll or wait for completion.',
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
            'Search the connected Gmail mailbox. Returns id, threadId, from, subject, snippet. Call gmail_get_message with an id to read a body, gmail_get_thread for the whole conversation. If the result includes authorizationUrl, show that URL to the user and retry after they finish connecting.',
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
            'Read one Gmail message by id from gmail_search: from, to, cc, subject, body, labelIds and attachment names. Credentials stay on the server. If the result includes authorizationUrl, show that URL to the user and retry after they finish connecting.',
          inputSchema: gmailGetMessageInputSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => enterpriseToolResult(principal, GMAIL_GET_MESSAGE_TOOL, args, deps),
      )
      server.registerTool(
        GMAIL_GET_THREAD_TOOL,
        {
          title: 'Read Gmail thread',
          description:
            'Read every message of one Gmail conversation (threadId from gmail_search or gmail_get_message), oldest first. Use before replying so the answer fits the whole conversation.',
          inputSchema: gmailGetThreadInputSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => enterpriseToolResult(principal, GMAIL_GET_THREAD_TOOL, args, deps),
      )
      server.registerTool(
        GMAIL_LIST_LABELS_TOOL,
        {
          title: 'List Gmail labels',
          description:
            'List the mailbox labels (system labels like INBOX, UNREAD, STARRED and user labels with their ids) for gmail_modify_labels.',
          inputSchema: gmailListLabelsInputSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => enterpriseToolResult(principal, GMAIL_LIST_LABELS_TOOL, args, deps),
      )
      server.registerTool(
        GMAIL_LIST_DRAFTS_TOOL,
        {
          title: 'List Gmail drafts',
          description: 'List saved Gmail drafts (draftId, to, subject, snippet). Send one with gmail_send draftId.',
          inputSchema: gmailListDraftsInputSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => enterpriseToolResult(principal, GMAIL_LIST_DRAFTS_TOOL, args, deps),
      )
      server.registerTool(
        GMAIL_SEND_TOOL,
        {
          title: 'Send Gmail message',
          description:
            'Send an email from the connected Gmail account. To reply to a message pass replyToMessageId (from gmail_search) and body: the reply stays in the same thread, subject becomes "Re: …" and it goes to the original sender unless you pass to (replyAll=true adds the other recipients). For a new message pass to, subject, body. To send an existing draft pass only draftId. Use this whenever the user asks to send, reply or answer an email — do not just show a draft. Does not call Gmail until a human approves the operation: returns immediately with status: awaiting_approval and an approvalUrl — show that link to the user so they can approve it, do not poll or wait for completion.',
          inputSchema: GMAIL_MCP_INPUT_SCHEMAS[GMAIL_SEND_TOOL],
          annotations: { destructiveHint: false, openWorldHint: true },
        },
        async (args) => enterpriseToolResult(principal, GMAIL_SEND_TOOL, args, deps),
      )
      server.registerTool(
        GMAIL_CREATE_DRAFT_TOOL,
        {
          title: 'Create Gmail draft',
          description:
            'Save a Gmail draft without sending it (new message, or a reply with replyToMessageId — same fields as gmail_send). Use when the user wants to review or finish the email in Gmail. Does not call Gmail until a human approves the operation: returns immediately with status: awaiting_approval and an approvalUrl — show that link to the user so they can approve it, do not poll or wait for completion.',
          inputSchema: GMAIL_MCP_INPUT_SCHEMAS[GMAIL_CREATE_DRAFT_TOOL],
          annotations: { destructiveHint: false, openWorldHint: true },
        },
        async (args) => enterpriseToolResult(principal, GMAIL_CREATE_DRAFT_TOOL, args, deps),
      )
      server.registerTool(
        GMAIL_MODIFY_LABELS_TOOL,
        {
          title: 'Label / archive Gmail message',
          description:
            'Change labels of one message (messageId) or a whole thread (threadId). Mark read: removeLabelIds=UNREAD. Mark unread: addLabelIds=UNREAD. Archive: removeLabelIds=INBOX. Star: addLabelIds=STARRED. User label ids come from gmail_list_labels. Does not call Gmail until a human approves the operation: returns immediately with status: awaiting_approval and an approvalUrl — show that link to the user so they can approve it, do not poll or wait for completion.',
          inputSchema: GMAIL_MCP_INPUT_SCHEMAS[GMAIL_MODIFY_LABELS_TOOL],
          annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async (args) => enterpriseToolResult(principal, GMAIL_MODIFY_LABELS_TOOL, args, deps),
      )
      server.registerTool(
        GMAIL_TRASH_TOOL,
        {
          title: 'Move Gmail message to trash',
          description:
            'Move one message (messageId) or a whole thread (threadId) to the trash; Gmail keeps it restorable for 30 days. There is no permanent delete. Does not call Gmail until a human approves the operation: returns immediately with status: awaiting_approval and an approvalUrl — show that link to the user so they can approve it, do not poll or wait for completion.',
          inputSchema: GMAIL_MCP_INPUT_SCHEMAS[GMAIL_TRASH_TOOL],
          annotations: { destructiveHint: true, openWorldHint: true },
        },
        async (args) => enterpriseToolResult(principal, GMAIL_TRASH_TOOL, args, deps),
      )
      server.registerTool(
        HTTP_API_GET_TOOL,
        {
          title: 'HTTP API GET',
          description:
            'One GET against a bound company HTTP API connector. Requires definitionId from platform.agent.get_definition — agentId is optional. Path is relative to the connector baseUrl — do not send credentials or trace headers (X-Agent-Id, X-Acting-User, X-Connector-Call-Id); the platform injects them. For large lists use http_api_get_all. Allowed paths are under connectors[].endpoints in get_definition. With several HTTP connectors, the server usually picks by method+path; otherwise pass connectorName (connectors[].name) or connectorId. Unlisted paths return endpoint_not_allowed with the allowed list.',
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
            'Paginated GET of a company HTTP API list in one call. Requires definitionId from platform.agent.get_definition (agentId optional) and pagination on the chosen connectors[].endpoints entry; without it the call returns an error. Required for ownerships/partners/large registers — do not page http_api_get yourself. Path is relative to the connector baseUrl. The platform injects trace headers — do not pass them. Disambiguate with connectorName or connectorId when needed.',
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
            'POST/PUT/PATCH/DELETE against a bound company HTTP API. Requires definitionId from platform.agent.get_definition (agentId optional). body is a JSON string. Path is relative to the connector baseUrl. Use connectors[].endpoints; disambiguate with connectorName or connectorId when several APIs are bound. The platform injects trace headers and Idempotency-Key — do not pass them in headers. Does not call the API until a human approves the operation: returns immediately with status: awaiting_approval and an approvalUrl — show that link to the user so they can approve it, do not poll or wait for completion.',
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
            'Load a file into the agent knowledge base (reference documents and knowledge material — see Where to save what table). processingMode=raw_text_only keeps the extracted text; okf splits it into a wiki. Optional purpose is one line on what the file is for. Pass UTF-8 content or contentBase64 for PDF/DOCX/XLSX.',
          inputSchema: kbIngestInputSchema,
        },
        async (args) => enterpriseToolResult(principal, KB_INGEST_TOOL, args, deps),
      )
      server.registerTool(
        SANDBOX_RUN_TOOL,
        {
          title: 'Run pinned skill script',
          description:
            'Run a Python script that belongs to a skill pinned on this published agent, inside the platform sandbox. Pass skillVersionId and entry from snapshot.skills. Do not run skill code on this machine. Outputs are written to work files under sandbox-output/. Credentials stay on the server.',
          inputSchema: sandboxRunInputSchema,
        },
        async (args) => enterpriseToolResult(principal, SANDBOX_RUN_TOOL, args, deps),
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

      const promptNames = new Set<string>()
      for (const coworker of coworkers) {
        const slug = checkoutSlug(coworker.name)
        const name = promptNames.has(slug) ? `${slug}-${coworker.agentId.slice(0, 8)}` : slug
        promptNames.add(name)
        server.registerPrompt(
          name,
          {
            title: hermesBotTitle({
              name: coworker.name,
              description: coworker.description,
              roleInstruction: coworker.roleInstructionPreview ?? '',
            }),
            description: coworker.description?.trim()
              ? `Call when: ${coworker.description.trim()}`
              : `Work as ${coworker.name}: loads the agent's role, rules and skills from its current published definition.`,
            argsSchema: z.object({
              feladat: z.string().optional().describe('Optional: today\'s task, appended to the end of the prompt.'),
            }),
          },
          async ({ feladat }) =>
            agentPromptResult(principal, deps, name, coworker.agentId, feladat, boundAgentId),
        )
      }

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

      server.server.setRequestHandler('tools/call', async (request, ctx) => {
        const toolName = request.params.name
        if (!(MCP_ALLOWED_TOOLS as readonly string[]).includes(toolName)) {
          await auditMcpToolDenied(deps, principal, toolName)
          return textResult(
            { code: 'tool_not_allowed', message: 'Tool is not allowed on this MCP endpoint' },
            true,
          )
        }
        const rawArgs = request.params.arguments
        let args =
          rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
            ? (rawArgs as Record<string, unknown>)
            : {}
        if (agentHeader && toolBindsToAgentHeader(toolName)) {
          const bound = await bindAgentHeader(principal, deps, toolName, args, agentHeader)
          if (!bound.ok) return bound.result
          args = bound.args
        }
        if (toolName === MCP_AGENTS_LIST_TOOL) return listAgentsToolResult(principal, deps)
        if (toolName === MCP_AGENT_GET_DEFINITION_TOOL) {
          return getDefinitionToolResult(principal, args, deps, agentHeader !== null)
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
          return listSkillsToolResult(principal, args, deps, tenantPackages)
        }
        if (toolName === MCP_SKILL_READ_TOOL) {
          return readSkillToolResult(principal, args, deps, tenantPackages)
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
          const confirm = isEnterpriseWriteTool(toolName) ? writeConfirmInput(ctx, codec) : undefined
          return enterpriseToolResult(principal, toolName, args, deps, origin, confirm)
        }
        return whoamiToolResult(principal, deps)
      })
    },
    {
      serverInfo: { name: mcpServerDisplayName(tenant), version: '1.0' },
      instructions,
      // #618 D3: we pick the link branch ourselves; the shim would try a live
      // server→client elicitation on 2025 requests, which stalls on stateless HTTP.
      inputRequired: { legacyShim: false },
      ...(codec ? { requestState: { verify: codec.verify } } : {}),
    },
  )
}

async function enterpriseToolResult(
  principal: McpPrincipal,
  toolName: string,
  args: Record<string, unknown>,
  deps: McpRuntimeDeps,
  origin?: string,
  confirm?: WriteConfirmInput,
) {
  // InputRequiredToolResult is the wire shape of the SDK's InputRequiredResult.
  return deps.invokeEnterpriseTool({ principal, toolName, args, origin, confirm }) as Promise<
    CallToolResult | InputRequiredResult
  >
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
    const handler = await createMcpResourceHandler(
      resolved.principal,
      // #666: per-request audit-hatókör — sessionId + kliens minden sor metadata-jába.
      { ...deps, audit: scopeMcpAuditSink(deps.audit, getMcpRequestContext(req.headers)) },
      origin,
      req.headers.get(MCP_AGENT_ID_HEADER)?.trim() || null,
    )
    return handler(req)
  }

  return withMcpAuth(inner, verifyToken, {
    required: true,
    resourceMetadataPath: '/.well-known/oauth-protected-resource/api/mcp',
    resourceUrl: origin,
  })(request)
}
