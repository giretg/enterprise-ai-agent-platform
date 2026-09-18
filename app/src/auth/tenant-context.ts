import { cache } from 'react'
import type { PlatformRole, UserRole } from '@prisma/client'
import { repositories } from '@/repositories/postgres'
import { decideAuthz, hasMinimumRole } from '@/lib/iam-policy'
import { hasMinimumPlatformRole, tenantStatusAllowsOperations } from '@/lib/tenant-policy'
import {
  getAuthContext,
  type AuthContext,
  type PlatformAuthContext,
  type TenantAuthContext,
} from './context'

const getTenantById = cache((tenantId: string) => repositories.tenants.findById(tenantId))

/**
 * Tenant- és platform-szintű guardok (Feature-spec Tenant-Management §5.4).
 *
 * - `requireTenantRole`: aktív tenant-kontextust és minimum tenant-szerepet vár;
 *   suspended/offboarding/archived tenantban elutasít (§7.3) — kivéve a superadmin
 *   assume-módot, ahol a lifecycle-kezeléshez a platform-guardot kell használni.
 * - `requirePlatformRole`: platform-szintű szerepet vár (nem tenant-adat, §3.1).
 *
 * A mai `requireRole()` továbbra is működik (tenant-kontextusban), de PLATFORM-
 * szintű action MÁR NEM használhat `requireRole('admin')`-t (§5.4 migrációs elv).
 */

export class TenantAuthError extends Error {
  code:
    | 'NO_USER'
    | 'NO_TENANT'
    | 'INSUFFICIENT_ROLE'
    | 'TENANT_NOT_ACTIVE'
    | 'UNKNOWN_PERMISSION'
  constructor(code: TenantAuthError['code']) {
    super(code)
    this.name = 'TenantAuthError'
    this.code = code
  }
}

export class PlatformAuthError extends Error {
  code: 'NO_USER' | 'INSUFFICIENT_PLATFORM_ROLE'
  constructor(code: PlatformAuthError['code']) {
    super(code)
    this.name = 'PlatformAuthError'
    this.code = code
  }
}

/**
 * §7.3: suspended/offboarding/archived tenantban nincs tenant-művelet.
 *
 * Fail-closed: a hiányzó tenant-sor is tiltás. Korábban a `tenant &&` alak miatt egy
 * fel nem oldható tenant-azonosító ÁTENGEDTE a kaput — a lekérdezés bizonytalansága
 * engedélyre fordult. Egy helyen él, hogy a két guard ne tudjon szétcsúszni.
 */
async function assertTenantOperable(tenantId: string): Promise<void> {
  const tenant = await getTenantById(tenantId)
  if (!tenant || !tenantStatusAllowsOperations(tenant.status)) {
    throw new TenantAuthError('TENANT_NOT_ACTIVE')
  }
}

export async function requireTenantRoleFromContext(
  ctx: AuthContext | null,
  minimum: UserRole | UserRole[],
): Promise<TenantAuthContext> {
  if (!ctx) throw new TenantAuthError('NO_USER')
  if (ctx.kind !== 'tenant' || !ctx.activeTenantId || !ctx.activeTenantRole) {
    throw new TenantAuthError('NO_TENANT')
  }

  await assertTenantOperable(ctx.activeTenantId)

  if (!hasMinimumRole(ctx.activeTenantRole, minimum)) {
    throw new TenantAuthError('INSUFFICIENT_ROLE')
  }

  return ctx as TenantAuthContext
}

export async function requireTenantRole(
  minimum: UserRole | UserRole[],
): Promise<TenantAuthContext> {
  return requireTenantRoleFromContext(await getAuthContext(), minimum)
}

/**
 * Permission-kulcs alapú tenant-kapu (§5.4, §6.3). A `requireTenantRole` szerep-
 * literálos megfelelője: a `role_permissions` deklaratív mátrixból oldja fel a
 * minimum tenant-szerepet, és az AKTÍV tenant-szerepre (membership / superadmin
 * assume) dönt — nem a legacy `User.role`-ra. Ismeretlen kulcs ⇒ tilt (deny-by-
 * default, N-IAM-2). Minden elutasítás `user.authz.deny` audit-eseményt ír.
 */
export async function requireTenantPermission(
  permissionKey: string,
): Promise<TenantAuthContext> {
  const ctx = await getAuthContext()
  if (!ctx) throw new TenantAuthError('NO_USER')
  if (ctx.kind !== 'tenant' || !ctx.activeTenantId || !ctx.activeTenantRole) {
    throw new TenantAuthError('NO_TENANT')
  }

  await assertTenantOperable(ctx.activeTenantId)

  const entry = await repositories.rolePermissions.findByKey(permissionKey)
  // Az aktív tenant-szerep az igazság forrása; a status itt definíció szerint 'active'
  // (a tenant-kontextus feloldás csak aktív membershipre / assume-ra ad tenant-kindet).
  const decision = decideAuthz(
    { status: 'active', role: ctx.activeTenantRole },
    entry?.minRole ?? null,
  )

  if (!decision.allow) {

    if (decision.reason === 'UNKNOWN_PERMISSION') {
      throw new TenantAuthError('UNKNOWN_PERMISSION')
    }
    throw new TenantAuthError('INSUFFICIENT_ROLE')
  }

  return ctx as TenantAuthContext
}

export async function requirePlatformRole(
  minimum: PlatformRole | PlatformRole[],
): Promise<PlatformAuthContext> {
  const ctx = await getAuthContext()
  if (!ctx) throw new PlatformAuthError('NO_USER')
  if (!hasMinimumPlatformRole(ctx.platformRoles, minimum)) {
    throw new PlatformAuthError('INSUFFICIENT_PLATFORM_ROLE')
  }
  return ctx as PlatformAuthContext
}
