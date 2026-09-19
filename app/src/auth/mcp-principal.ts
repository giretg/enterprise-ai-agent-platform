import type { PlatformRole, UserRole } from '@prisma/client'
import { ENTERPRISE_DRIVE_TOOLS } from '@/domain/enterprise-tools/tool-definitions'
import {
  isSuperadmin,
  normalizeTenantSlug,
  tenantStatusAllowsOperations,
} from '@/lib/tenant-policy'
import type {
  PlatformMembershipRepository,
  TenantMembershipRepository,
  TenantRepository,
  UserRepository,
} from '@/repositories/interfaces'
import type { AuditSink } from '@/lib/audit/types'
import { writeAudit } from '@/lib/audit/types'

export const MCP_WHOAMI_TOOL = 'platform.whoami'
export const MCP_AGENTS_LIST_TOOL = 'platform.agents.list'
export const MCP_AGENT_GET_DEFINITION_TOOL = 'platform.agent.get_definition'
export const MCP_GATEWAY_OPERATION_GET_TOOL = 'platform.gateway_operation.get'
export const MCP_PLATFORM_TOOLS = [
  MCP_WHOAMI_TOOL,
  MCP_AGENTS_LIST_TOOL,
  MCP_AGENT_GET_DEFINITION_TOOL,
  MCP_GATEWAY_OPERATION_GET_TOOL,
] as const
export const MCP_ALLOWED_TOOLS = [...MCP_PLATFORM_TOOLS, ...ENTERPRISE_DRIVE_TOOLS] as const
export const MCP_RESOURCE_PATH = '/api/mcp'
export const MCP_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource/api/mcp'

export type McpPrincipal = {
  userId: string
  tenantId: string
  tenantSlug: string
  role: UserRole
  assumed: boolean
  platformRoles: PlatformRole[]
}

export type McpPrincipalFailureCode =
  | 'unauthenticated'
  | 'invalid_token'
  | 'user_inactive'
  | 'tenant_unavailable'
  | 'tenant_not_active'
  | 'not_a_member'

export type McpPrincipalFailure = {
  ok: false
  code: McpPrincipalFailureCode
  message: string
  userId?: string
  tenantId?: string
}

export type McpPrincipalSuccess = { ok: true; principal: McpPrincipal }

export type McpPrincipalResult = McpPrincipalSuccess | McpPrincipalFailure

export type VerifiedOAuthToken = {
  clerkUserId: string
  claims?: Record<string, unknown>
}

export type McpPrincipalDeps = {
  verifyOAuthToken: (bearerToken: string) => Promise<VerifiedOAuthToken | null>
  users: Pick<UserRepository, 'findByExternalAuthId'>
  tenants: Pick<TenantRepository, 'findBySlug'>
  memberships: Pick<TenantMembershipRepository, 'findByTenantAndUser'>
  platformMemberships: Pick<PlatformMembershipRepository, 'findByUser'>
  audit?: AuditSink
}

const GENERIC_MESSAGE: Record<McpPrincipalFailureCode, string> = {
  unauthenticated: 'Authentication required',
  invalid_token: 'Authentication required',
  user_inactive: 'Access denied',
  tenant_unavailable: 'Access denied',
  tenant_not_active: 'Access denied',
  not_a_member: 'Access denied',
}

export function mcpResourceIdentifier(origin: string): string {
  return `${origin.replace(/\/$/, '')}${MCP_RESOURCE_PATH}`
}

export function mcpResourceMetadataUrl(origin: string): string {
  return `${origin.replace(/\/$/, '')}${MCP_RESOURCE_METADATA_PATH}`
}

export function parseBearerToken(authorizationHeader: string | null): {
  kind: 'missing' | 'non_bearer' | 'bearer'
  token?: string
} {
  if (!authorizationHeader || !authorizationHeader.trim()) {
    return { kind: 'missing' }
  }
  const match = /^(Bearer)\s+(\S+)/i.exec(authorizationHeader.trim())
  if (!match) return { kind: 'non_bearer' }
  return { kind: 'bearer', token: match[2] }
}

function claimValues(claim: unknown): unknown[] {
  if (claim === undefined || claim === null) return []
  return Array.isArray(claim) ? claim : [claim]
}

/** After signature verification: deny only URL-shaped aud/resource for a different origin. */
export function tokenClaimsForeignOrigin(
  claims: Record<string, unknown> | undefined,
  resourceOrigin: string,
): boolean {
  if (!claims) return false
  let expectedOrigin: string
  try {
    expectedOrigin = new URL(resourceOrigin).origin
  } catch {
    return false
  }
  for (const value of [...claimValues(claims.aud), ...claimValues(claims.resource)]) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) continue
    try {
      if (new URL(value).origin !== expectedOrigin) return true
    } catch {
      // Malformed URL claim is not "obviously a different origin".
    }
  }
  return false
}

/** Missing/invalid Bearer is attacker-controlled volume — console only, no hash-chain lock. */
const UNAUDITED_MCP_AUTH_CODES: ReadonlySet<McpPrincipalFailureCode> = new Set([
  'unauthenticated',
  'invalid_token',
])

/** Successful whoami evidence. Not written from resolveMcpPrincipal — that path is every HTTP request. */
export async function auditMcpAuthOk(
  deps: Pick<McpPrincipalDeps, 'audit'>,
  principal: McpPrincipal,
): Promise<void> {
  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: principal.userId,
    agentVersion: null,
    action: 'mcp.auth.ok',
    targetType: 'mcp',
    targetId: principal.tenantId,
    modelUsed: null,
    inputRef: null,
    outputRef: null,
    policyDecision: 'allowed',
    metadata: { tenantSlug: principal.tenantSlug, assumed: principal.assumed },
    tenantId: principal.tenantId,
  })
}

/** Denials persist to audit_log except unauthenticated/invalid_token (flood). */
export async function auditMcpAuthDenied(
  deps: McpPrincipalDeps | { audit?: AuditSink },
  failure: Pick<McpPrincipalFailure, 'code'> & { userId?: string; tenantId?: string },
  tenantSlug?: string,
): Promise<void> {
  console.info('mcp.auth.deny', { code: failure.code, tenantSlug, userId: failure.userId })
  if (UNAUDITED_MCP_AUTH_CODES.has(failure.code)) return
  await writeAudit(deps.audit, {
    actorType: failure.userId ? 'human' : 'system',
    actorId: failure.userId ?? null,
    agentVersion: null,
    action: 'mcp.auth.deny',
    targetType: 'mcp',
    targetId: failure.tenantId ?? null,
    modelUsed: null,
    inputRef: failure.code,
    outputRef: tenantSlug ?? null,
    policyDecision: 'denied',
    metadata: { code: failure.code, tenantSlug, userId: failure.userId },
    tenantId: failure.tenantId ?? null,
  })
}

async function deny(
  deps: McpPrincipalDeps,
  failure: McpPrincipalFailure,
  tenantSlug?: string,
): Promise<McpPrincipalFailure> {
  await auditMcpAuthDenied(deps, failure, tenantSlug)
  return failure
}

function fail(
  code: McpPrincipalFailureCode,
  extra?: { userId?: string; tenantId?: string },
): McpPrincipalFailure {
  return {
    ok: false,
    code,
    message: GENERIC_MESSAGE[code],
    ...extra,
  }
}

/**
 * MCP resource-server principal. Cookies and Control Plane `getAuthContext()`
 * are not a tenant selector here — the URL slug is.
 */
export async function resolveMcpPrincipal(
  input: {
    authorizationHeader: string | null
    tenantSlug: string
    resourceOrigin: string
  },
  deps: McpPrincipalDeps,
): Promise<McpPrincipalResult> {
  const parsed = parseBearerToken(input.authorizationHeader)
  if (parsed.kind !== 'bearer' || !parsed.token) {
    return deny(deps, fail('unauthenticated'), input.tenantSlug)
  }

  const verified = await deps.verifyOAuthToken(parsed.token)
  if (!verified) {
    return deny(deps, fail('invalid_token'), input.tenantSlug)
  }

  if (tokenClaimsForeignOrigin(verified.claims, input.resourceOrigin)) {
    return deny(deps, fail('invalid_token'), input.tenantSlug)
  }

  const user = await deps.users.findByExternalAuthId(verified.clerkUserId)
  if (!user || user.status !== 'active') {
    return deny(deps, fail('user_inactive'), input.tenantSlug)
  }

  const slug = normalizeTenantSlug(input.tenantSlug)
  const tenant = slug ? await deps.tenants.findBySlug(slug) : null
  if (!tenant) {
    return deny(deps, fail('tenant_unavailable', { userId: user.id }), input.tenantSlug)
  }

  if (!tenantStatusAllowsOperations(tenant.status)) {
    return deny(
      deps,
      fail('tenant_not_active', { userId: user.id, tenantId: tenant.id }),
      tenant.slug,
    )
  }

  const platformRows = await deps.platformMemberships.findByUser(user.id)
  const platformRoles = platformRows.filter((row) => row.status === 'active').map((row) => row.role)

  const membership = await deps.memberships.findByTenantAndUser(tenant.id, user.id)
  const activeMembership = membership?.status === 'active' ? membership : null

  let role: UserRole
  let assumed: boolean
  if (activeMembership) {
    role = activeMembership.role
    assumed = false
  } else if (isSuperadmin(platformRoles)) {
    role = 'admin'
    assumed = true
  } else {
    return deny(
      deps,
      fail('not_a_member', { userId: user.id, tenantId: tenant.id }),
      tenant.slug,
    )
  }

  return {
    ok: true,
    principal: {
      userId: user.id,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      role,
      assumed,
      platformRoles,
    },
  }
}

export async function auditMcpToolCall(
  deps: { audit?: AuditSink },
  principal: McpPrincipal,
  toolName?: string,
): Promise<void> {
  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: principal.userId,
    agentVersion: null,
    action: 'mcp.tools.call',
    targetType: 'mcp',
    targetId: principal.tenantId,
    modelUsed: null,
    inputRef: toolName ?? null,
    outputRef: null,
    policyDecision: 'allowed',
    metadata: {
      toolName,
      tenantSlug: principal.tenantSlug,
      assumed: principal.assumed,
    },
    tenantId: principal.tenantId,
  })
}

export async function auditMcpToolDenied(
  deps: { audit?: AuditSink },
  principal: McpPrincipal,
  toolName: string,
): Promise<void> {
  console.info('mcp.tools.call.deny', {
    toolName,
    code: 'tool_not_allowed',
    tenantSlug: principal.tenantSlug,
  })
  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: principal.userId,
    agentVersion: null,
    action: 'mcp.tools.call.deny',
    targetType: 'mcp',
    targetId: principal.tenantId,
    modelUsed: null,
    inputRef: toolName,
    outputRef: null,
    policyDecision: 'denied',
    metadata: { toolName, code: 'tool_not_allowed', tenantSlug: principal.tenantSlug },
    tenantId: principal.tenantId,
  })
}

export async function auditMcpResourceRead(
  deps: { audit?: AuditSink },
  principal: McpPrincipal,
  uri: string,
): Promise<void> {
  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: principal.userId,
    agentVersion: null,
    action: 'mcp.resources.read',
    targetType: 'mcp',
    targetId: principal.tenantId,
    modelUsed: null,
    inputRef: uri,
    outputRef: null,
    policyDecision: 'allowed',
    metadata: { uri, tenantSlug: principal.tenantSlug, assumed: principal.assumed },
    tenantId: principal.tenantId,
  })
}
