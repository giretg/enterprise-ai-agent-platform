import type { AuthContext } from '@/auth/context'

/**
 * A gyökér (`/control-plane`) mindig továbbredirectel — önmagára esni loop.
 * Aktív tenant-userre ez a kezdőlap (teendők + munkatársak), nem egy agent adatlapja.
 */
export const DEFAULT_AGENT_WORKSPACE_FALLBACK = '/control-plane/dashboard'
export const CONTROL_PLANE_PENDING_PATH = '/control-plane/pending'
export const CONTROL_PLANE_PLATFORM_HOME = '/control-plane/platform/tenants'
/** #830: self-service cégindító varázsló (Clerk-session kell, nem publikus). */
export const ONBOARDING_PATH = '/onboarding'

type EntryUser = { status: string; role: unknown }

/**
 * Belépési útvonal a session-fajtából. `null` = van tenant-kontextus, a hívó
 * a kezdőlapra (`DEFAULT_AGENT_WORKSPACE_FALLBACK`) mehet.
 *
 * - Felfüggesztett fiók ⇒ pending képernyő (csak ott maradt értelme, #830 D6).
 * - Tenant nélküli fiók (meghívó nélküli új regisztráció is) ⇒ onboarding: saját
 *   céget indíthat, vagy a saját e-mailjére szóló meghívót fogadhatja el (D8).
 * - Platform-módban (superadmin tenant nélkül) NEM a munkatárs-lista a cél —
 *   ott `requireTenantRole` elhasal, és üres/hibás képernyő marad.
 */
export function homePathForAuthContext(
  ctx: { kind: AuthContext['kind']; user: EntryUser } | null,
): string | null {
  if (!ctx) return '/sign-in'
  if (ctx.user.status === 'suspended') return CONTROL_PLANE_PENDING_PATH
  if (ctx.kind === 'none') return ONBOARDING_PATH
  if (ctx.user.status !== 'active' || !ctx.user.role) return CONTROL_PLANE_PENDING_PATH
  if (ctx.kind === 'platform') return CONTROL_PLANE_PLATFORM_HOME
  return null
}

/**
 * A Clerk SignUp utáni kényszerített cél (#830 §8). Meghívó-ticketes regisztrációnál
 * NINCS kényszerítés — a meghívó beváltása (Clerk-webhook) a meghívó cégébe visz,
 * nem a varázslóba; különben a friss fiók az onboardingon indíthat saját céget.
 */
export function signUpForceRedirectUrl(
  params: Record<string, string | string[] | undefined>,
): string | undefined {
  const hasInvitationTicket = Boolean(params.__clerk_ticket || params.ticket)
  return hasInvitationTicket ? undefined : ONBOARDING_PATH
}
