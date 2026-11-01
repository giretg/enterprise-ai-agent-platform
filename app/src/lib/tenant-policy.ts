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

  // Több `isDefault` előfordulhat (régi addMember nem vette le a korábbi
  // defaultot). A membership-lista createdAt szerint nő — az UTOLSÓ default
  // a frissebb tagság, ne a legrégebbi Demo nyelje el a cookie nélküli belépést.
  const defaults = active.filter((m) => m.isDefault)
  const byDefault = defaults.length > 0 ? defaults[defaults.length - 1] : undefined
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

// ── Self-service cégindítás (#830) ──────────────────────────────────────────

/** Egy user legfeljebb ennyi saját (self-service, nem archivált) céget indíthat. */
export const SELF_SERVICE_TENANT_CAP = 5

/** Az archivált cég felszabadítja a kvótát; a felfüggesztett / kivezetés alatti nem. */
export function countsTowardSelfServiceCap(status: TenantStatus): boolean {
  return status !== 'archived'
}

export function selfServiceCapReached(ownedCount: number): boolean {
  return ownedCount >= SELF_SERVICE_TENANT_CAP
}

const HU_TRANSLITERATION: Record<string, string> = {
  á: 'a', é: 'e', í: 'i', ó: 'o', ö: 'o', ő: 'o', ú: 'u', ü: 'u', ű: 'u',
  Á: 'A', É: 'E', Í: 'I', Ó: 'O', Ö: 'O', Ő: 'O', Ú: 'U', Ü: 'U', Ű: 'U',
}

/**
 * Magyar ékezetek ASCII-ra (`Őstermelő` → `Ostermelo`), hogy a slug ne csonkuljon
 * (`normalizeTenantSlug` minden nem-ASCII betűt kötőjellé tenne). Más nyelvek
 * ékezetes betűit (pl. ä, č) Unicode-felbontás után a jelölő eldobásával kezeljük.
 */
export function transliterateHungarian(raw: string): string {
  return raw
    .replace(/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/g, (ch) => HU_TRANSLITERATION[ch] ?? ch)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

const TENANT_SLUG_MAX = 63

/** A cégnévből képzett slug-alap; érvénytelen alak (pl. csupa írásjel) ⇒ `null`. */
export function selfServiceSlugBase(displayName: string): string | null {
  const slug = normalizeTenantSlug(transliterateHungarian(displayName))
    .slice(0, TENANT_SLUG_MAX)
    .replace(/-+$/g, '')
  return isValidTenantSlug(slug) ? slug : null
}

/** Ütközéskor: `slug`, `slug-2`, `slug-3`, … — a hossz-limitet a toldalék sem lépheti át. */
export function selfServiceSlugCandidate(base: string, attempt: number): string {
  if (attempt <= 1) return base
  const suffix = `-${attempt}`
  return `${base.slice(0, TENANT_SLUG_MAX - suffix.length).replace(/-+$/g, '')}${suffix}`
}

/** Érvénytelen névből képzett slug helyett: `t-` + 8 karakter egy azonosító elejéről. */
export function selfServiceFallbackSlug(id: string): string {
  const head = id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)
  return `t-${head.padEnd(8, '0')}`
}

export const TAX_ID_MAX_LENGTH = 32

/** Adószám: szabad szöveg, trim; üres ⇒ `null`; túl hosszú ⇒ `undefined` (a hívó hibát ad). */
export function normalizeTaxId(raw: string | null | undefined): string | null | undefined {
  const value = (raw ?? '').trim()
  if (!value) return null
  if (value.length > TAX_ID_MAX_LENGTH) return undefined
  return value
}

/**
 * Indíthat-e most a user saját céget (tenant-váltó „Új cég" / onboarding)?
 * Felfüggesztett fiók és superadmin-assume kontextus fail closed; különben a limit dönt.
 */
export function canStartSelfServiceTenant(params: {
  userStatus: string
  assumed: boolean
  ownedSelfServiceCount: number
}): boolean {
  if (params.userStatus === 'suspended') return false
  if (params.assumed) return false
  return !selfServiceCapReached(params.ownedSelfServiceCount)
}

/**
 * A team-lépés csak a URL-ben kért cégre megy, és csak ha a user ott aktív admin.
 * Így a „második cég" nem a süti szerinti régi tenantba hív meg munkatársat.
 */
export function resolveOnboardingTeamTenantId(params: {
  step?: string | null
  requestedTenantId?: string | null
  memberships: ReadonlyArray<{ tenantId: string; role: UserRole; status: TenantMembershipStatus }>
}): string | null {
  if (params.step !== 'team' || !params.requestedTenantId) return null
  const ok = params.memberships.some(
    (row) => row.tenantId === params.requestedTenantId && row.status === 'active' && row.role === 'admin',
  )
  return ok ? params.requestedTenantId : null
}
