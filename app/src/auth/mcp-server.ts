import { auth } from '@clerk/nextjs/server'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { z } from 'zod'
import { isClerkEnabled } from '@/lib/clerk-config'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'
import { repositories } from '@/repositories/postgres'
import {
  auditMcpToolCall,
  auditMcpToolDenied,
  mcpResourceMetadataUrl,
  PHASE_A_ALLOWED_TOOLS,
  PHASE_A_TOOL_NAME,
  resolveMcpPrincipal,
  type McpPrincipal,
  type McpPrincipalDeps,
  type McpPrincipalFailure,
  type VerifiedOAuthToken,
} from './mcp-principal'

export type McpRuntimeDeps = McpPrincipalDeps & {
  isClerkConfigured: () => boolean
  resolveOrigin: (request: Request) => string
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

function authNotConfiguredResponse(): Response {
  return Response.json(
    { error: { code: 'auth_not_configured', message: 'Authentication is not configured' } },
    { status: 503 },
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

function createPhaseAMcpHandler(principal: McpPrincipal, deps: McpPrincipalDeps) {
  return createMcpHandler(
    (server) => {
      server.registerTool(
        PHASE_A_TOOL_NAME,
        {
          title: 'Who am I',
          description: 'Return the authenticated MCP principal for this tenant URL.',
          inputSchema: z.object({}).passthrough(),
        },
        async () => {
          await auditMcpToolCall(deps, principal)
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(whoamiPayload(principal)) }],
          }
        },
      )

      server.server.setRequestHandler('tools/call', async (request) => {
        const toolName = request.params.name
        if (!(PHASE_A_ALLOWED_TOOLS as readonly string[]).includes(toolName)) {
          await auditMcpToolDenied(deps, principal, toolName)
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  code: 'tool_not_allowed',
                  message: 'Tool is not allowed on this MCP endpoint',
                }),
              },
            ],
          }
        }
        await auditMcpToolCall(deps, principal)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(whoamiPayload(principal)) }],
        }
      })
    },
    {
      serverInfo: { name: 'enterprise-mcp', version: 'phase-a' },
    },
  )
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
  if (!deps.isClerkConfigured()) return authNotConfiguredResponse()

  const origin = deps.resolveOrigin(request)
  const verifyToken = async (_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> => {
    if (!bearerToken) return undefined
    const verified = await deps.verifyOAuthToken(bearerToken)
    if (!verified) return undefined
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
    return createPhaseAMcpHandler(resolved.principal, deps)(req)
  }

  return withMcpAuth(inner, verifyToken, {
    required: true,
    resourceMetadataPath: '/.well-known/oauth-protected-resource/api/mcp',
    resourceUrl: origin,
  })(request)
}
