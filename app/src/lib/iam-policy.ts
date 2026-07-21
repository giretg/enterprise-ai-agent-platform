import type { Invitation, UserRole, UserStatus } from '@prisma/client'

/**
 * IAM / RBAC — tiszta logika (Feature-spec IAM-RBAC §4, §6, §8).
 *
 * Ide kerül minden döntés, ami DB-hívás nélkül tesztelhető: szerep-rangsor,
 * lock-out predikátum, meghívó-érvényesség, domain-allowlist, deny-by-default
 * permission-rangsor. A `IamService` és a `requirePermission` middleware ezekre
 * a függvényekre épül, a Prisma-hívásokat a repository réteg végzi.
 */

export const ROLE_RANK: Record<UserRole, number> = {
  viewer: 0,
  operator: 1,
  approver: 2,
  admin: 3,
}

/** Placeholder Clerk subject for admin-pre-provisioned users awaiting first login. */
export const PREPROVISIONED_AUTH_PREFIX = 'preprovisioned:'

export function isPreProvisionedAuthId(externalAuthId: string): boolean {
  return externalAuthId.startsWith(PREPROVISIONED_AUTH_PREFIX)
}

export function makePreProvisionedAuthId(): string {
  return `${PREPROVISIONED_AUTH_PREFIX}${globalThis.crypto.randomUUID()}`
}

/** N-IAM-2: `role = NULL` soha nem éri el egyetlen minimum-szerepet sem. */
export function meetsMinRole(role: UserRole | null | undefined, minRole: UserRole): boolean {
  if (!role) return false
  return ROLE_RANK[role] >= ROLE_RANK[minRole]
}

export function hasMinimumRole(role: UserRole | null | undefined, required: UserRole | UserRole[]): boolean {
  if (!role) return false
  const requiredRoles = Array.isArray(required) ? required : [required]
  return requiredRoles.some((r) => ROLE_RANK[role] >= ROLE_RANK[r])
}

/** N-IAM-3: a kettős kapu — csak `active` **és** kiosztott `role` mellett dől el bármi. */
export function isActiveWithRole(user: { status: UserStatus; role: UserRole | null }): boolean {
  return user.status === 'active' && user.role !== null
}

// ── Lock-out invariáns (N-IAM-5) ────────────────────────────────────────────

export type LockoutCheck =
  | { blocked: false }
  | { blocked: true; reason: 'LAST_ADMIN_LOCK' }

/**
 * @param otherActiveAdminCount a célponton kívüli, ugyanabban a tenantban aktív adminok száma
 * @param isTargetCurrentlyActiveAdmin a célpont JELENLEG aktív admin-e (a művelet előtt)
 */
export function checkLastAdminLock(
  otherActiveAdminCount: number,
  isTargetCurrentlyActiveAdmin: boolean,
): LockoutCheck {
  if (isTargetCurrentlyActiveAdmin && otherActiveAdminCount === 0) {
    return { blocked: true, reason: 'LAST_ADMIN_LOCK' }
  }
  return { blocked: false }
}

export function isSelfModification(actorId: string, targetUserId: string): boolean {
  return actorId === targetUserId
}

// ── Meghívó-érvényesség (N-IAM-4) ───────────────────────────────────────────

export type InvitationRejectionReason =
  | 'NOT_FOUND'
  | 'ALREADY_REDEEMED'
  | 'REVOKED'
  | 'EXPIRED'
  | 'EMAIL_MISMATCH'

export type InvitationCheck =
  | { ok: true }
  | { ok: false; reason: InvitationRejectionReason }

export function checkInvitationRedeemable(
  invitation: Pick<Invitation, 'status' | 'expiresAt' | 'email'>,
  params: { email: string; now: Date },
): InvitationCheck {
  if (invitation.status === 'redeemed') return { ok: false, reason: 'ALREADY_REDEEMED' }
  if (invitation.status === 'revoked') return { ok: false, reason: 'REVOKED' }
  if (invitation.status === 'expired' || params.now > invitation.expiresAt) {
    return { ok: false, reason: 'EXPIRED' }
  }
  if (invitation.email.trim().toLowerCase() !== params.email.trim().toLowerCase()) {
    return { ok: false, reason: 'EMAIL_MISMATCH' }
  }
  return { ok: true }
}

// ── Önregisztrációs domain-allowlist (§7/B, opcionális) ─────────────────────

/** Üres/hiányzó allowlist ⇒ minden domain engedett (az allowlist opt-in, §7/B). */
export function isEmailDomainAllowed(email: string, allowlistCsv: string | undefined | null): boolean {
  const allowlist = (allowlistCsv ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
  if (allowlist.length === 0) return true
  const domain = email.trim().toLowerCase().split('@')[1]
  if (!domain) return false
  return allowlist.includes(domain)
}

// ── Deny-by-default permission-kikényszerítés (§6, N-IAM-2) ─────────────────

export type AuthzDenyReason =
  | 'NO_TOKEN'
  | 'INVALID_TOKEN'
  | 'NO_USER'
  | 'INACTIVE'
  | 'NO_ROLE'
  | 'UNKNOWN_PERMISSION'
  | 'INSUFFICIENT_ROLE'

export type AuthzDecision =
  | { allow: true }
  | { allow: false; reason: AuthzDenyReason }

/**
 * A §6 8-lépéses algoritmus 4-7. lépése — a token/subject-feloldás a hívó
 * (auth-provider) felelőssége, ez a függvény a felbontott userre dönt.
 * Ismeretlen `minRole` (a permission-kulcs nincs a mátrixban) ⇒ tilt (6. lépés).
 */
export function decideAuthz(
  user: { status: UserStatus; role: UserRole | null },
  minRole: UserRole | null,
): AuthzDecision {
  if (user.status !== 'active') return { allow: false, reason: 'INACTIVE' }
  if (!user.role) return { allow: false, reason: 'NO_ROLE' }
  if (minRole === null) return { allow: false, reason: 'UNKNOWN_PERMISSION' }
  if (!meetsMinRole(user.role, minRole)) return { allow: false, reason: 'INSUFFICIENT_ROLE' }
  return { allow: true }
}
