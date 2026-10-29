/**
 * #1004 WP-2: chat-token a böngészőnek és folytatási token a worker háttérfutásához.
 * Minden kiadás előtt: tenant-kapcsoló, céges modell-kulcs, (agentnél) agent-kapcsoló és hozzáférés.
 */
import type { UserRole } from '@prisma/client'
import type { AuditSink } from '@/lib/audit/types'
import { writeAudit } from '@/lib/audit/types'
import { resolvePrincipalForUser, type McpPrincipalDeps } from '@/auth/mcp-principal'
import type { PlatformChatAccess } from '@/domain/platform-chat/gateway'
import {
  CHAT_TOKEN_AUDIENCE,
  CHAT_TURN_TOKEN_AUDIENCE,
  signChatToken,
  usableChatTokenKey,
  verifyChatToken,
} from '@/domain/platform-chat/chat-token'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ChatSessionFailureCode =
  | 'unauthenticated'
  | 'platform_chat_disabled'
  | 'key_missing'
  | 'agent_unavailable'
  | 'not_configured'
  | 'bad_request'

export type ChatSessionDeps = {
  signingKey: string | undefined
  workerUrl: string | undefined
  loadTenant: (tenantId: string) => Promise<{ slug: string; settings: { enabled: boolean; adminInsight: boolean } } | null>
  modelKeyConfigured: (tenantId: string) => Promise<boolean>
  loadAccess: (input: { tenantId: string; agentId: string }) => Promise<PlatformChatAccess>
  /** Publikált + a user láthatja (ugyanaz a szabály, mint az MCP-n). */
  canUseAgent: (input: { tenantId: string; userId: string; role: UserRole; agentId: string }) => Promise<boolean>
  audit?: AuditSink
  now?: () => Date
}

export type ChatSessionResult =
  | { ok: true; token: string; expiresAt: string; workerUrl: string; tenantSlug: string; adminInsight: boolean }
  | { ok: false; code: ChatSessionFailureCode }

export async function issueChatSession(
  deps: ChatSessionDeps,
  input: { userId: string; tenantId: string; role: UserRole; agentId?: unknown },
): Promise<ChatSessionResult> {
  const key = usableChatTokenKey(deps.signingKey)
  if (!key || !deps.workerUrl) return { ok: false, code: 'not_configured' }
  if (input.agentId !== undefined && (typeof input.agentId !== 'string' || !UUID_RE.test(input.agentId))) {
    return { ok: false, code: 'bad_request' }
  }
  const tenant = await deps.loadTenant(input.tenantId)
  if (!tenant?.settings.enabled) return { ok: false, code: 'platform_chat_disabled' }
  if (!(await deps.modelKeyConfigured(input.tenantId))) return { ok: false, code: 'key_missing' }
  if (typeof input.agentId === 'string') {
    const access = await deps.loadAccess({ tenantId: input.tenantId, agentId: input.agentId })
    const usable =
      access.agentEnabled &&
      (await deps.canUseAgent({ tenantId: input.tenantId, userId: input.userId, role: input.role, agentId: input.agentId }))
    if (!usable) return { ok: false, code: 'agent_unavailable' }
  }
  const { token, claims } = signChatToken(
    {
      aud: CHAT_TOKEN_AUDIENCE,
      sub: input.userId,
      tenant: tenant.slug,
      tid: input.tenantId,
      role: input.role,
      adminInsight: tenant.settings.adminInsight,
    },
    key,
    (deps.now ?? (() => new Date()))(),
  )
  return {
    ok: true,
    token,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    workerUrl: deps.workerUrl.replace(/\/+$/, ''),
    tenantSlug: tenant.slug,
    adminInsight: tenant.settings.adminInsight,
  }
}

export type ContinuationDeps = Omit<ChatSessionDeps, 'workerUrl' | 'loadTenant' | 'modelKeyConfigured'> & {
  principal: McpPrincipalDeps
}

/**
 * Folytatási token (§7): a böngésző chat-tokenjével, egy fordulóra és agentre szűkítve.
 * Folytatási tokennel nem kérhető újabb — a lánc nem hosszabbítható a végtelenségig.
 */
export async function issueContinuationToken(
  deps: ContinuationDeps,
  input: { authorizationHeader: string | null; body: unknown },
): Promise<{ ok: true; token: string; expiresAt: string } | { ok: false; code: ChatSessionFailureCode }> {
  const key = usableChatTokenKey(deps.signingKey)
  if (!key) return { ok: false, code: 'not_configured' }
  const now = (deps.now ?? (() => new Date()))()
  const bearer = /^Bearer\s+(\S+)/i.exec(input.authorizationHeader?.trim() ?? '')?.[1]
  const chat = bearer ? verifyChatToken(bearer, key, Math.floor(now.getTime() / 1000), [CHAT_TOKEN_AUDIENCE]) : null
  if (!chat) return { ok: false, code: 'unauthenticated' }
  const b = (input.body ?? {}) as Record<string, unknown>
  if (typeof b.turnId !== 'string' || !b.turnId || b.turnId.length > 128 || typeof b.agentId !== 'string' || !UUID_RE.test(b.agentId)) {
    return { ok: false, code: 'bad_request' }
  }
  const resolved = await resolvePrincipalForUser(await deps.principal.users.findById(chat.sub), chat.tenant, deps.principal)
  if (!resolved.ok) return { ok: false, code: 'unauthenticated' }
  const p = resolved.principal
  const access = await deps.loadAccess({ tenantId: p.tenantId, agentId: b.agentId })
  if (!access.tenantEnabled) return { ok: false, code: 'platform_chat_disabled' }
  if (!access.agentEnabled || !(await deps.canUseAgent({ tenantId: p.tenantId, userId: p.userId, role: p.role, agentId: b.agentId }))) {
    return { ok: false, code: 'agent_unavailable' }
  }
  const { token, claims } = signChatToken(
    {
      aud: CHAT_TURN_TOKEN_AUDIENCE,
      sub: p.userId,
      tenant: p.tenantSlug,
      tid: p.tenantId,
      role: p.role,
      adminInsight: false,
      turnId: b.turnId,
      agentId: b.agentId,
    },
    key,
    now,
  )
  await writeAudit(deps.audit, {
    actorType: 'human',
    actorId: p.userId,
    action: 'platform_chat.continuation_issued',
    targetType: 'agent',
    targetId: b.agentId,
    policyDecision: 'allowed',
    metadata: { turnId: b.turnId, jti: claims.jti, client: 'platform_chat' },
    tenantId: p.tenantId,
  })
  return { ok: true, token, expiresAt: new Date(claims.exp * 1000).toISOString() }
}
