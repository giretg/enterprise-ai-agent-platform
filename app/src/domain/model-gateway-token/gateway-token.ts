/**
 * Hermes Managed Client — Model Gateway token (#746 V1-2, D1).
 * Az MCP OAuth token → 10 perces, userhez + agenthez kötött gateway-JWT (HS256).
 * A céges modell-kulcs soha nem kerül a gépre; `verifyGatewayToken` MINDEN hívásnál újra
 * ellenőrzi a hozzáférést, így a visszavont user a következő hívásnál elveszti a tokent.
 */
import { createHmac, randomUUID } from 'node:crypto'
import type { AgentDefinition } from '@/domain/agent-definition'
import { isDispatchable } from '@/lib/agent-lifecycle'
import { safeSecretEquals } from '@/lib/crypto/timing-safe'
import type { AuditSink } from '@/lib/audit/types'
import { writeAudit } from '@/lib/audit/types'
import {
  resolveMcpPrincipal,
  resolvePrincipalForUser,
  type McpPrincipal,
  type McpPrincipalDeps,
} from '@/auth/mcp-principal'

export const GATEWAY_TOKEN_TTL_SECONDS = 600
const MIN_KEY_LENGTH = 32
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type GatewayTokenClaims = {
  sub: string
  tenant: string
  agentId: string
  installId: string
  policyVersion: string
  jti: string
  iat: number
  exp: number
}

export type GatewayTokenDeps = McpPrincipalDeps & {
  /** Aláíró kulcs (Secret Manager → env). Hiányzó/rövid kulcs → fail-closed, nincs fallback. */
  signingKey: string | undefined
  loadDefinition: (input: { tenantId: string; agentId: string }) => Promise<Pick<AgentDefinition, 'agentId' | 'status'> | null>
  canViewAgent: (input: { tenantId: string; userId: string; role: McpPrincipal['role']; agentId: string }) => Promise<boolean>
  policyVersion: (input: { tenantId: string; userId: string; agentId: string }) => Promise<string>
  now?: () => Date
}

export type GatewayTokenFailureCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'bad_request'
  | 'agent_not_found'
  | 'key_missing'
  | 'invalid_token'

export type GatewayTokenFailure = { ok: false; code: GatewayTokenFailureCode }

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')

function signJwt(claims: GatewayTokenClaims, key: string): string {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64u(JSON.stringify(claims))
  return `${head}.${body}.${createHmac('sha256', key).update(`${head}.${body}`).digest('base64url')}`
}

/** Aláírás + lejárat. Az `alg` rögzített (HS256) — a fejléc nem választhat algoritmust. */
export function verifyJwt(token: string, key: string, nowSeconds: number): GatewayTokenClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [head, body, sig] = parts
  const expected = createHmac('sha256', key).update(`${head}.${body}`).digest('base64url')
  if (!safeSecretEquals(sig, expected)) return null
  try {
    if (JSON.parse(Buffer.from(head, 'base64url').toString()).alg !== 'HS256') return null
    const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as GatewayTokenClaims
    if (typeof c.exp !== 'number' || c.exp <= nowSeconds) return null
    if (![c.sub, c.tenant, c.agentId, c.installId, c.policyVersion, c.jti].every((v) => typeof v === 'string' && v)) return null
    return c
  } catch {
    return null
  }
}

function usableKey(key: string | undefined): string | null {
  return key && key.length >= MIN_KEY_LENGTH ? key : null
}

async function deny(
  audit: AuditSink | undefined,
  failure: GatewayTokenFailure,
  meta: { tenantId?: string | null; userId?: string | null; agentId?: string | null; installId?: string; reason?: string },
  action = 'model_gateway.token.deny',
): Promise<GatewayTokenFailure> {
  // Aláíratlan/ismeretlen token: csak konzol (flood) — mint az MCP-n.
  if (failure.code !== 'unauthenticated' && failure.code !== 'invalid_token') {
    await writeAudit(audit, {
      actorType: meta.userId ? 'human' : 'system',
      actorId: meta.userId ?? null,
      action,
      targetType: 'model_gateway',
      targetId: meta.agentId ?? null,
      policyDecision: 'denied',
      inputRef: failure.code,
      metadata: { code: failure.code, installId: meta.installId, reason: meta.reason },
      tenantId: meta.tenantId ?? null,
    })
  }
  return failure
}

/** A user eléri-e az agentet: ugyanaz a szabály, mint az MCP `bindAgentHeader`-ben. */
async function agentAccessible(deps: GatewayTokenDeps, p: McpPrincipal, agentId: string): Promise<boolean> {
  if (!UUID_RE.test(agentId)) return false
  const def = await deps.loadDefinition({ tenantId: p.tenantId, agentId })
  return !!def && isDispatchable(def.status) && deps.canViewAgent({ tenantId: p.tenantId, userId: p.userId, role: p.role, agentId })
}

export async function issueGatewayToken(
  deps: GatewayTokenDeps,
  input: { authorizationHeader: string | null; resourceOrigin: string; body: unknown },
): Promise<{ ok: true; token: string; expiresAt: string; policyVersion: string } | GatewayTokenFailure> {
  const key = usableKey(deps.signingKey)
  if (!key) return { ok: false, code: 'key_missing' }

  const b = (input.body ?? {}) as Record<string, unknown>
  const { tenantSlug, agentId, installId } = b
  if (typeof tenantSlug !== 'string' || typeof agentId !== 'string' || typeof installId !== 'string' || !installId || installId.length > 128) {
    return { ok: false, code: 'bad_request' }
  }

  const resolved = await resolveMcpPrincipal(
    { authorizationHeader: input.authorizationHeader, tenantSlug, resourceOrigin: input.resourceOrigin },
    deps,
  )
  if (!resolved.ok) {
    const code = resolved.code === 'unauthenticated' || resolved.code === 'invalid_token' ? 'unauthenticated' : 'forbidden'
    return { ok: false, code } // az mcp.auth.deny auditot a resolveMcpPrincipal már megírta
  }
  const p = resolved.principal

  if (!(await agentAccessible(deps, p, agentId))) {
    return deny(deps.audit, { ok: false, code: 'agent_not_found' }, { tenantId: p.tenantId, userId: p.userId, agentId: agentId.slice(0, 64), installId })
  }

  const now = (deps.now ?? (() => new Date()))()
  const iat = Math.floor(now.getTime() / 1000)
  const policyVersion = await deps.policyVersion({ tenantId: p.tenantId, userId: p.userId, agentId })
  const claims: GatewayTokenClaims = {
    sub: p.userId,
    tenant: p.tenantSlug,
    agentId,
    installId,
    policyVersion,
    jti: randomUUID(),
    iat,
    exp: iat + GATEWAY_TOKEN_TTL_SECONDS,
  }
  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: p.userId,
    action: 'model_gateway.token.issued',
    targetType: 'model_gateway',
    targetId: agentId,
    policyDecision: 'allowed',
    metadata: { installId, jti: claims.jti, policyVersion, tenantSlug: p.tenantSlug, assumed: p.assumed },
    tenantId: p.tenantId,
  })
  return { ok: true, token: signJwt(claims, key), expiresAt: new Date(claims.exp * 1000).toISOString(), policyVersion }
}

/**
 * Közös ellenőrző a Model Gateway (V1-3), a snapshot és a heartbeat route-hoz.
 * Aláírás + lejárat, majd MINDEN hívásnál: user aktív, tenant aktív, tagság, agent látható.
 */
export async function verifyGatewayToken(
  deps: GatewayTokenDeps,
  authorizationHeader: string | null,
): Promise<{ ok: true; claims: GatewayTokenClaims; principal: McpPrincipal } | GatewayTokenFailure> {
  const key = usableKey(deps.signingKey)
  if (!key) return { ok: false, code: 'key_missing' }
  const bearer = /^Bearer\s+(\S+)/i.exec(authorizationHeader?.trim() ?? '')?.[1]
  const claims = bearer ? verifyJwt(bearer, key, Math.floor((deps.now ?? (() => new Date()))().getTime() / 1000)) : null
  if (!claims) return { ok: false, code: 'invalid_token' }

  const user = await deps.users.findById(claims.sub)
  const resolved = await resolvePrincipalForUser(user, claims.tenant, deps)
  const meta = { userId: claims.sub, agentId: claims.agentId, installId: claims.installId }
  if (!resolved.ok || resolved.principal.userId !== claims.sub) {
    return deny(deps.audit, { ok: false, code: 'forbidden' }, { ...meta, tenantId: resolved.ok ? null : resolved.tenantId, reason: 'principal' }, 'model_gateway.token.revoked')
  }
  if (!(await agentAccessible(deps, resolved.principal, claims.agentId))) {
    return deny(deps.audit, { ok: false, code: 'forbidden' }, { ...meta, tenantId: resolved.principal.tenantId, reason: 'agent' }, 'model_gateway.token.revoked')
  }
  return { ok: true, claims, principal: resolved.principal }
}
