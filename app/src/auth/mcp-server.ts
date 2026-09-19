import { auth } from '@clerk/nextjs/server'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { z } from 'zod'
import { isClerkEnabled } from '@/lib/clerk-config'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'
import { repositories } from '@/repositories/postgres'
import { mcpAuthNotConfigured } from './mcp-oauth-metadata'
import { services } from '@/domain/gateway-services'
import {
  canReadPublishedAgent,
  isPrivilegedAgentReader,
  type AgentDefinition,
} from '@/domain/agent-definition'
import { isAvailableOnMcp } from '@/lib/agent-lifecycle'
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
  isEnterpriseTool,
  type EnterpriseToolMcpResult,
} from '@/domain/enterprise-tools'
import {
  auditMcpAuthDenied,
  auditMcpAuthOk,
  auditMcpToolCall,
  auditMcpToolDenied,
  mcpResourceMetadataUrl,
  MCP_ALLOWED_TOOLS,
  MCP_AGENTS_LIST_TOOL,
  MCP_AGENT_GET_DEFINITION_TOOL,
  MCP_GATEWAY_OPERATION_GET_TOOL,
  MCP_WHOAMI_TOOL,
  resolveMcpPrincipal,
  type McpPrincipal,
  type McpPrincipalDeps,
  type McpPrincipalFailure,
  type VerifiedOAuthToken,
} from './mcp-principal'

export type McpAgentListItem = {
  agentId: string
  name: string
  status: string
  currentDefinitionId: string | null
  currentVersion: number | null
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
  invokeEnterpriseTool: (input: {
    principal: McpPrincipal
    toolName: string
    args: Record<string, unknown>
  }) => Promise<EnterpriseToolMcpResult>
  getGatewayOperation: (input: {
    principal: McpPrincipal
    operationId: string
  }) => Promise<EnterpriseToolMcpResult>
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

async function toPublishedListItem(agent: {
  id: string
  name: string
  status: string
  currentDefinitionVersionId: string | null
}) {
  const current = agent.currentDefinitionVersionId
    ? await repositories.agentDefinitions.findById(agent.currentDefinitionVersionId)
    : null
  return {
    agentId: agent.id,
    name: agent.name,
    status: agent.status,
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
    invokeEnterpriseTool: (input) => services.enterpriseTools.invoke(input),
    getGatewayOperation: async (input) =>
      services.gatewayOperations.toMcpGet(
        await services.gatewayOperations.get({
          principal: input.principal,
          operationId: input.operationId,
        }),
      ),
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

function whoamiPayload(principal: McpPrincipal) {
  return {
    userId: principal.userId,
    tenantId: principal.tenantId,
    tenantSlug: principal.tenantSlug,
    role: principal.role,
    assumed: principal.assumed,
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

async function whoamiToolResult(principal: McpPrincipal, deps: McpPrincipalDeps) {
  await auditMcpAuthOk(deps, principal)
  await auditMcpToolCall(deps, principal, MCP_WHOAMI_TOOL)
  return textResult(whoamiPayload(principal))
}

async function listAgentsToolResult(principal: McpPrincipal, deps: McpRuntimeDeps) {
  await auditMcpToolCall(deps, principal, MCP_AGENTS_LIST_TOOL)
  const agents = await deps.listPublishedAgents({
    tenantId: principal.tenantId,
    userId: principal.userId,
    role: principal.role,
  })
  return textResult({ agents })
}

function asUuid(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined
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
  return textResult(loaded)
}

function createMcpResourceHandler(principal: McpPrincipal, deps: McpRuntimeDeps) {
  return createMcpHandler(
    (server) => {
      server.registerTool(
        MCP_WHOAMI_TOOL,
        {
          title: 'Who am I',
          description: 'Return the authenticated MCP principal for this tenant URL.',
          inputSchema: z.object({}).passthrough(),
        },
        async () => whoamiToolResult(principal, deps),
      )
      server.registerTool(
        MCP_AGENTS_LIST_TOOL,
        {
          title: 'List agents',
          description: 'List published agent definitions visible to this principal.',
          inputSchema: z.object({}).passthrough(),
        },
        async () => listAgentsToolResult(principal, deps),
      )
      server.registerTool(
        MCP_AGENT_GET_DEFINITION_TOOL,
        {
          title: 'Get agent definition',
          description: 'Load one published agent definition snapshot for this tenant.',
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
            'Read or export a Drive file under a published agent definition. Credentials stay on the server. If the result includes authorizationUrl, show that URL to the user and retry after they finish connecting.',
          inputSchema: googleDriveReadFileInputSchema,
        },
        async (args) => enterpriseToolResult(principal, GOOGLE_DRIVE_READ_FILE_TOOL, args, deps),
      )
      server.registerTool(
        GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
        {
          title: 'Create Google Drive folder',
          description:
            'Request creation of a Drive folder under a published agent definition. Does not call Google until a human approves the operation.',
          inputSchema: googleDriveCreateFolderInputSchema,
        },
        async (args) => enterpriseToolResult(principal, GOOGLE_DRIVE_CREATE_FOLDER_TOOL, args, deps),
      )
      server.registerTool(
        GOOGLE_DRIVE_UPLOAD_FILE_TOOL,
        {
          title: 'Upload Google Drive file',
          description:
            'Request upload of a text file (HTML, CSV, JSON) to the user\'s Drive. Waits for human approval. Pass definitionId from platform.agent.get_definition.',
          inputSchema: googleDriveUploadFileInputSchema,
        },
        async (args) => enterpriseToolResult(principal, GOOGLE_DRIVE_UPLOAD_FILE_TOOL, args, deps),
      )
      server.registerTool(
        GOOGLE_SHEETS_WRITE_RANGE_TOOL,
        {
          title: 'Write Google Sheet range',
          description:
            'Request writing cells to a Google Sheet the user can edit. values is a JSON 2D array string. Waits for human approval.',
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
            'One GET against a bound company HTTP API connector. Path is relative to the connector baseUrl — do not send credentials. For large lists use http_api_get_all. If several HTTP connectors are bound, pass connectorId from the agent definition.',
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
            'Paginated GET of a company HTTP API list in one call. Required for ownerships/partners/large registers — do not page http_api_get yourself. Path is relative to the connector baseUrl.',
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
            'POST/PUT/PATCH/DELETE against a bound company HTTP API. Waits for human approval. body is a JSON string. Path is relative to the connector baseUrl.',
          inputSchema: httpApiRequestInputSchema,
        },
        async (args) => enterpriseToolResult(principal, HTTP_API_REQUEST_TOOL, args, deps),
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
        if (toolName === MCP_GATEWAY_OPERATION_GET_TOOL) {
          return getGatewayOperationToolResult(principal, args, deps)
        }
        if (isEnterpriseTool(toolName)) {
          return enterpriseToolResult(principal, toolName, args, deps)
        }
        return whoamiToolResult(principal, deps)
      })
    },
    {
      serverInfo: { name: 'enterprise-mcp', version: 'phase-f' },
      instructions:
        'Company systems: http_api_get / http_api_get_all / http_api_request with definitionId and a relative path — credentials stay on the connector. Gmail: gmail_search then gmail_get_message. Drive: google_drive_search then google_drive_read_file; upload/sheets/create_folder wait for human approval. If a tool returns authorizationUrl, show that URL to the user, wait until they finish consent, then retry.',
    },
  )
}

async function enterpriseToolResult(
  principal: McpPrincipal,
  toolName: string,
  args: Record<string, unknown>,
  deps: McpRuntimeDeps,
) {
  return deps.invokeEnterpriseTool({ principal, toolName, args })
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
    return createMcpResourceHandler(resolved.principal, deps)(req)
  }

  return withMcpAuth(inner, verifyToken, {
    required: true,
    resourceMetadataPath: '/.well-known/oauth-protected-resource/api/mcp',
    resourceUrl: origin,
  })(request)
}
