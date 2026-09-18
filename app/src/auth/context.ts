import { cache } from 'react'
import { cookies } from 'next/headers'
import type { PlatformRole, UserRole } from '@prisma/client'
import { repositories } from '@/repositories/postgres'
import {
  resolveActiveTenant,
  isSuperadmin,
  type MembershipView,
} from '@/lib/tenant-policy'
import { getCurrentUser } from './index'
import type { AuthUser } from './types'

export const ACTIVE_TENANT_COOKIE = 'active_tenant_id'

/**
 * Egységes auth + tenant kontextus (Feature-spec Tenant-Management §5.1, §5.2).
 *
 * A `getCurrentUser()` a globális identitást adja (Clerk/dev provider); erre épül
 * a platform-szerep lista, a tenant-membershipek és az AKTÍV tenant feloldása.
 * A superadmin "assume tenant" út is itt dől el: ha a session-cookie egy olyan
 * tenantot választ, amelyben a hívónak nincs membershipje, de superadmin, akkor
 * assume-módban lép be (§3.3/1-2) — az audit-eseményt a `switchTenant` action írja.
 */
export type AuthContext = {
  user: AuthUser
  platformRoles: PlatformRole[]
  memberships: MembershipView[]
  kind: 'tenant' | 'platform' | 'none'
  activeTenantId: string | null
  activeTenantRole: UserRole | null
  /** true, ha superadmin idegen tenantba lépett be (nem saját membership). */
  assumed: boolean
}

export type TenantAuthContext = AuthContext & {
  kind: 'tenant'
  activeTenantId: string
  activeTenantRole: UserRole
}

export type PlatformAuthContext = AuthContext & {
  platformRoles: [PlatformRole, ...PlatformRole[]]
}

async function readActiveTenantCookie(): Promise<string | null> {
  try {
    const store = await cookies()
    return store.get(ACTIVE_TENANT_COOKIE)?.value ?? null
  } catch {
    // A cookies() dinamikus API — statikus/nem-request kontextusban dobhat; ilyenkor
    // nincs explicit választás, a default-membership útra esünk vissza.
    return null
  }
}

/**
 * §11.2 / §13/9: visszafelé kompatibilitás. Ha a user-nek még nincs egyetlen
 * TenantMembership sora sem (migráció előtti / egytenantos dev-demo mód), de a
 * legacy `User.tenantId` + aktív szerep megvan, szintetizálunk EGY membershipet,
 * hogy az egytenantos folyamat a migráció után is működjön.
 */
function legacyFallbackMembership(_user: AuthUser): MembershipView[] {
  return []
}

async function resolveAuthContext(): Promise<AuthContext | null> {
  const user = await getCurrentUser()
  if (!user) return null

  let platformRoles: PlatformRole[] = []
  let memberships: MembershipView[] = []

  // Platform-szerepek és tenant-membershipek külön fetch, hogy az egyik hiba
  // ne nullázza el a másikat (pl. ha a tenant-táblák még nem léteznek, a
  // platform-szerepek akkor is működjenek).
  try {
    const platformRows = await repositories.platformMemberships.findByUser(user.id)
    platformRoles = platformRows.filter((r) => r.status === 'active').map((r) => r.role)
  } catch {
    platformRoles = []
  }

  try {
    const membershipRows = await repositories.tenantMemberships.findByUser(user.id)
    memberships = membershipRows.map((m) => ({
      tenantId: m.tenantId,
      role: m.role,
      status: m.status,
      isDefault: m.isDefault,
    }))
  } catch {
    // A tenant-táblák hiányozhatnak a db push előtt — ilyenkor legacy-only mód.
    memberships = []
  }

  if (memberships.length === 0) {
    memberships = legacyFallbackMembership(user)
  }

  const requestedTenantId = await readActiveTenantCookie()

  // Superadmin assume: ha a cookie EXPLICIT egy olyan tenantra mutat, ahol a
  // hívónak nincs active membershipje, ez assume-szándék. Ezt a default-membership
  // visszaesés ELŐTT kell eldönteni — különben (ha van bármilyen membershipünk) a
  // resolveActiveTenant mindig a defaultra esne, és az assume soha nem érvényesülne
  // (a fejléc-váltó „beragadna" a default tenantra, §5.3/§9.1).
  const requestedIsActiveMembership =
    !!requestedTenantId &&
    memberships.some((m) => m.tenantId === requestedTenantId && m.status === 'active')

  if (requestedTenantId && !requestedIsActiveMembership && isSuperadmin(platformRoles)) {
    try {
      const tenant = await repositories.tenants.findById(requestedTenantId)
      if (tenant) {
        return {
          user,
          platformRoles,
          memberships,
          kind: 'tenant',
          activeTenantId: tenant.id,
          // A superadmin az assumed tenantban tenant-admin jogkörrel jár el (§3.3/1).
          activeTenantRole: 'admin',
          assumed: true,
        }
      }
    } catch {
      // ignore — a normál feloldásra (membership/default/platform) esünk vissza
    }
  }

  const resolved = resolveActiveTenant({ memberships, platformRoles, requestedTenantId })

  if (resolved.kind === 'tenant') {
    return {
      user,
      platformRoles,
      memberships,
      kind: 'tenant',
      activeTenantId: resolved.tenantId,
      activeTenantRole: resolved.role,
      assumed: false,
    }
  }

  if (resolved.kind === 'platform') {
    return {
      user,
      platformRoles,
      memberships,
      kind: 'platform',
      activeTenantId: null,
      activeTenantRole: null,
      assumed: false,
    }
  }

  return {
    user,
    platformRoles,
    memberships,
    kind: 'none',
    activeTenantId: null,
    activeTenantRole: null,
    assumed: false,
  }
}

/** Request-szintű deduplikáció: párhuzamos Server Action / RSC hívások egy auth stacket osztanak. */
export const getAuthContext = cache(resolveAuthContext)
