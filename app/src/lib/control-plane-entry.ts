import type { AuthContext } from '@/auth/context'

/** A gyökér (`/control-plane`) mindig továbbredirectel — önmagára esni loop. */
export const DEFAULT_AGENT_WORKSPACE_FALLBACK = '/control-plane/agents'
export const CONTROL_PLANE_PENDING_PATH = '/control-plane/pending'
export const CONTROL_PLANE_PLATFORM_HOME = '/control-plane/platform/tenants'

type EntryUser = { status: string; role: unknown }

/**
 * Belépési útvonal a session-fajtából. `null` = van tenant-kontextus, a hívó
 * az első munkatárshoz (vagy a listára) oldhatja fel.
 *
 * Platform-módban (superadmin tenant nélkül) NEM a munkatárs-lista a cél —
 * ott `requireTenantRole` elhasal, és üres/hibás képernyő marad.
 * Tenant nélküli aktív fiók se a pending↔gyökér loopba kerüljön.
 */
export function homePathForAuthContext(
  ctx: { kind: AuthContext['kind']; user: EntryUser } | null,
): string | null {
  if (!ctx) return '/sign-in'
  if (ctx.user.status !== 'active' || !ctx.user.role) return CONTROL_PLANE_PENDING_PATH
  if (ctx.kind === 'platform') return CONTROL_PLANE_PLATFORM_HOME
  if (ctx.kind === 'none') return CONTROL_PLANE_PENDING_PATH
  return null
}
