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
function legacyFallbackMembership(user: AuthUser): MembershipView[] {
  if (!user.tenantId || !user.role || user.status !== 'active') return []
  return [{ tenantId: user.tenantId, role: user.role, status: 'active', isDefault: true }]
}

export async function getAuthContext(): Promise<AuthContext | null> {
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

  // Superadmin assume: a cookie egy olyan tenantra mutat, ahol nincs membership.
  if (requestedTenantId && isSuperadmin(platformRoles)) {
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
      // ignore — platform/none útra esünk
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
