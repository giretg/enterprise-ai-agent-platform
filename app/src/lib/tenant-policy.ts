import type {
  PlatformRole,
  TenantMembershipStatus,
  TenantStatus,
  UserRole,
} from '@prisma/client'

/**
 * Tenant Management — tiszta logika (Feature-spec Tenant-Management §5, §7).
 *
 * Ide kerül minden döntés, ami DB-hívás nélkül tesztelhető: aktív-tenant
 * feloldás, tenant-váltás/assume szabályok, tenant-státusz kapuk, platform-role
 * rangsor. A `TenantService`, a `getAuthContext` és a guardok ezekre a tiszta
 * függvényekre épülnek; a Prisma-hívásokat a repository réteg végzi
 * (`iam-policy.ts` mintájára).
 */

// ── Platform-role rangsor (§6.2) ────────────────────────────────────────────

/**
 * A platform-szerepek NEM összemérhetők a tenant-role rangsorral (§3.1). A
 * superadmin a legmagasabb; a platform_operator és platform_auditor egymás
 * mellett álló, nem-tenant-adat szerepek. A rangsor csak a "legalább X platform
 * szerep" kapuhoz kell; a superadmin minden platform-jogot teljesít.
 */
export const PLATFORM_ROLE_RANK: Record<PlatformRole, number> = {
  platform_auditor: 1,
  platform_operator: 2,
  superadmin: 3,
}

/** A superadmin minden platform-műveletet lefed; egyébként rang-alapú. */
export function hasMinimumPlatformRole(
  roles: PlatformRole[] | null | undefined,
  required: PlatformRole | PlatformRole[],
): boolean {
  if (!roles || roles.length === 0) return false
  const requiredRoles = Array.isArray(required) ? required : [required]
  const best = Math.max(...roles.map((r) => PLATFORM_ROLE_RANK[r]))
  // superadmin (rang 3) mindent lefed; egyébként az adott minimum rangot kell elérni.
  return requiredRoles.some((r) => best >= PLATFORM_ROLE_RANK[r])
}

export function isSuperadmin(roles: PlatformRole[] | null | undefined): boolean {
  return !!roles?.includes('superadmin')
}

// ── Tenant-státusz kapuk (§7.3) ─────────────────────────────────────────────

/**
 * Csak `active` tenant enged tenant-műveletet (agent run, connector use, model
 * call). suspended/offboarding/archived tenantban nincs futás (§7.3, elfogadási
 * kritérium §13/... és tesztstratégia §12: "suspended tenantban nincs run").
 */
export function tenantStatusAllowsOperations(status: TenantStatus): boolean {
  return status === 'active'
}

/** suspended tenant is beléphet (login lehet), de nem művelet-képes (§7.3). */
export function tenantStatusAllowsLogin(status: TenantStatus): boolean {
  return status === 'active' || status === 'suspended'
}

// ── Aktív-tenant feloldás (§5.2) ────────────────────────────────────────────

export type MembershipView = {
  tenantId: string
  role: UserRole
  status: TenantMembershipStatus
  isDefault: boolean
}

export type ResolvedContext =
  | {
      kind: 'tenant'
      tenantId: string
      role: UserRole
      /** true, ha a kiválasztott tenant a saját active membership (nem assume). */
      fromMembership: true
    }
  | {
      kind: 'platform'
    }
  | {
      kind: 'none'
    }

/**
 * §5.2 5. lépés: aktív tenant meghatározása membership-lista + explicit választás
 * + platform-szerep alapján. A superadmin "assume" út NEM itt dől el (az DB-ből
 * kell a tenant létezését ellenőrizni) — ez a függvény kizárólag a hívó SAJÁT
 * active membershipjeire és a platform-fallbackre dönt.
 *
 * Szabály:
 *  1. explicit `requestedTenantId` ⇒ ha az a hívó active membershipje, azt választja;
 *  2. különben a default active membership;
 *  3. különben ha pontosan egy active membership van, automatikusan az;
 *  4. különben ha több active van default nélkül, az elsőt (a lista-sorrend
 *     determinisztikus: a repo createdAt szerint rendez);
 *  5. különben ha nincs tenant, de van platform-szerep ⇒ platform-kontextus;
 *  6. különben `none` (pending / nincs hozzáférés).
 */
export function resolveActiveTenant(params: {
  memberships: MembershipView[]
  platformRoles: PlatformRole[]
  requestedTenantId?: string | null
}): ResolvedContext {
  const active = params.memberships.filter((m) => m.status === 'active')

  if (params.requestedTenantId) {
    const match = active.find((m) => m.tenantId === params.requestedTenantId)
    if (match) {
      return { kind: 'tenant', tenantId: match.tenantId, role: match.role, fromMembership: true }
    }
    // Érvénytelen/nem-active választás ⇒ nem dobunk, hanem a default-útra esünk vissza.
  }

  const byDefault = active.find((m) => m.isDefault)
  const chosen = byDefault ?? active[0]
  if (chosen) {
    return { kind: 'tenant', tenantId: chosen.tenantId, role: chosen.role, fromMembership: true }
  }

  if (params.platformRoles.length > 0) {
    return { kind: 'platform' }
  }

  return { kind: 'none' }
}

// ── Tenant-váltás / assume (§5.3) ───────────────────────────────────────────

export type SwitchDecision =
  | { allow: true; mode: 'member' }
  | { allow: true; mode: 'assume' }
  | { allow: false; reason: 'NOT_A_MEMBER' | 'MEMBERSHIP_NOT_ACTIVE' }

/**
 * §5.3: tenant-váltás szabálya.
 *  - tenant-tag csak SAJÁT active membershipre válthat (`member` mód);
 *  - superadmin bármely tenantot "assume" módban választhat (a tenant létezését/
 *    státuszát a service ellenőrzi, ez a döntés csak a jogosultságról szól);
 *  - a nem-tag, nem-superadmin hívó elutasítva.
 */
export function decideSwitch(params: {
  targetTenantId: string
  memberships: MembershipView[]
  platformRoles: PlatformRole[]
}): SwitchDecision {
  const membership = params.memberships.find((m) => m.tenantId === params.targetTenantId)
  if (membership) {
    if (membership.status !== 'active') return { allow: false, reason: 'MEMBERSHIP_NOT_ACTIVE' }
    return { allow: true, mode: 'member' }
  }
  if (isSuperadmin(params.platformRoles)) {
    return { allow: true, mode: 'assume' }
  }
  return { allow: false, reason: 'NOT_A_MEMBER' }
}

/** §5.3 audit-esemény nevek: superadmin assume / sima váltás / kilépés. */
export const TENANT_AUDIT_ACTIONS = {
  assume: 'tenant.assume',
  switch: 'tenant.switch',
  exit: 'tenant.exit',
  create: 'tenant.create',
  suspend: 'tenant.suspend',
  offboard: 'tenant.offboard',
  archive: 'tenant.archive',
  reactivate: 'tenant.reactivate',
} as const

// ── Utolsó tenant-admin lock membership-szinten (§7.2, §13/8) ────────────────

/**
 * §7.2 / N-IAM-5 membership-változat: legalább egy active admin membershipnek
 * mindig maradnia kell a tenantban. A hívó a célponton KÍVÜLI active admin
 * membershipek számát adja meg.
 */
export function checkLastTenantAdminLock(params: {
  otherActiveAdminCount: number
  targetIsActiveAdmin: boolean
}): { blocked: boolean } {
  if (params.targetIsActiveAdmin && params.otherActiveAdminCount === 0) {
    return { blocked: true }
  }
  return { blocked: false }
}

// ── domain_allowlist validáció (§4.1) ───────────────────────────────────────

/** Üres/hiányzó allowlist ⇒ minden domain engedett (opt-in korlát). */
export function isTenantDomainAllowed(email: string, domainAllowlist: string[]): boolean {
  if (!domainAllowlist || domainAllowlist.length === 0) return true
  const domain = email.trim().toLowerCase().split('@')[1]
  if (!domain) return false
  return domainAllowlist.map((d) => d.trim().toLowerCase()).includes(domain)
}

/** slug normalizálás + alap-validáció (tenant-létrehozáshoz, §7.1). */
export function normalizeTenantSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
}

export function isValidTenantSlug(slug: string): boolean {
  // Min. 2, max. 63 karakter; alfanumerikussal kezdődik/végződik, közötte kötőjel is.
  return /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(slug)
}
