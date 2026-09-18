import type { PlatformRole, Prisma, UserRole } from '@prisma/client'
import {
  isSuperadmin,
  normalizeTenantSlug,
  tenantStatusAllowsOperations,
} from '@/lib/tenant-policy'
import type {
  AuditRepository,
  PlatformMembershipRepository,
  TenantMembershipRepository,
  TenantRepository,
  UserRepository,
} from '@/repositories/interfaces'

export const PHASE_A_TOOL_NAME = 'platform.whoami'
export const PHASE_A_ALLOWED_TOOLS = [PHASE_A_TOOL_NAME] as const
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
  audit: Pick<AuditRepository, 'append'>
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

async function appendMcpAudit(
  deps: Pick<McpPrincipalDeps, 'audit'>,
  data: {
    action: 'mcp.auth.ok' | 'mcp.auth.deny' | 'mcp.tools.call' | 'mcp.tools.call.deny'
    actorId: string | null
    tenantId?: string | null
    targetId?: string | null
    policyDecision: string
    metadata: Prisma.JsonObject
  },
): Promise<void> {
  await deps.audit.append({
    actorType: 'human',
    actorId: data.actorId,
    agentVersion: null,
    action: data.action,
    targetType: 'mcp',
    targetId: data.targetId ?? null,
    modelUsed: null,
    inputRef: null,
    outputRef: null,
    policyDecision: data.policyDecision,
    metadata: data.metadata,
    tenantId: data.tenantId ?? null,
  })
}

/** Unauthenticated 401s log only; invalid_token and membership/inactive denies are audited. */
export async function auditMcpAuthDenied(
  deps: Pick<McpPrincipalDeps, 'audit'>,
  failure: Pick<McpPrincipalFailure, 'code'> & { userId?: string; tenantId?: string },
  tenantSlug?: string,
): Promise<void> {
  if (failure.code === 'unauthenticated') {
    console.info('mcp.auth.deny', { code: failure.code, tenantSlug })
    return
  }
  await appendMcpAudit(deps, {
    action: 'mcp.auth.deny',
    actorId: failure.userId ?? null,
    tenantId: failure.tenantId ?? null,
    targetId: failure.tenantId ?? null,
    policyDecision: 'deny',
    metadata: {
      code: failure.code,
      ...(tenantSlug ? { tenantSlug } : {}),
    },
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

  const principal: McpPrincipal = {
    userId: user.id,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    role,
    assumed,
    platformRoles,
  }

  await appendMcpAudit(deps, {
    action: 'mcp.auth.ok',
    actorId: principal.userId,
    tenantId: principal.tenantId,
    targetId: principal.tenantId,
    policyDecision: 'allow',
    metadata: { tenantSlug: principal.tenantSlug, assumed: principal.assumed },
  })

  return { ok: true, principal }
}

export async function auditMcpToolCall(
  deps: Pick<McpPrincipalDeps, 'audit'>,
  principal: McpPrincipal,
): Promise<void> {
  await appendMcpAudit(deps, {
    action: 'mcp.tools.call',
    actorId: principal.userId,
    tenantId: principal.tenantId,
    targetId: principal.tenantId,
    policyDecision: 'allow',
    metadata: { toolName: PHASE_A_TOOL_NAME, assumed: principal.assumed },
  })
}

export async function auditMcpToolDenied(
  deps: Pick<McpPrincipalDeps, 'audit'>,
  principal: McpPrincipal,
  toolName: string,
): Promise<void> {
  await appendMcpAudit(deps, {
    action: 'mcp.tools.call.deny',
    actorId: principal.userId,
    tenantId: principal.tenantId,
    targetId: principal.tenantId,
    policyDecision: 'deny',
    metadata: { toolName, code: 'tool_not_allowed' },
  })
}
