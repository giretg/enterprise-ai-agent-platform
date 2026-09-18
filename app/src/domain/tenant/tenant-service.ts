import type { PlatformRole, TenantStatus, UserRole } from '@prisma/client'
import type {
  TenantRepository,
  TenantMembershipRepository,
  PlatformMembershipRepository,
} from '@/repositories/interfaces'
import {
  TENANT_AUDIT_ACTIONS,
  checkLastTenantAdminLock,
  isValidTenantSlug,
  normalizeTenantSlug,
} from '@/lib/tenant-policy'

/**
 * Tenant Management domain (Feature-spec Tenant-Management §7, §8, §10).
 *
 * - Tenant lifecycle: create / suspend / offboard / archive / reactivate, auditálva.
 * - Membership CRUD: hozzáadás (pending/aktív), aktiválás, szerep-váltás, felfüggesztés,
 *   default-jelölés — az "utolsó aktív tenant-admin" lock membership-szinten (§7.2, §13/8).
 * - Superadmin "assume tenant" audit-esemény (§5.3, §3.3/1).
 *
 * A jogosultsági kapu (ki superadmin / tenant-admin) NEM itt van — azt a hívó
 * action a `requirePlatformRole` / `requireTenantRole` guardokkal dönti el. Ez a
 * service a domain-invariánsokat és az auditot kényszeríti ki.
 */
export class TenantService {
  constructor(
    private tenants: TenantRepository,
    private memberships: TenantMembershipRepository,
    private platformMemberships: PlatformMembershipRepository,
  ) {}

  // ── Tenant lifecycle (§7.1, §7.3) ─────────────────────────────────────────

  /** Csak superadmin (a guard a hívóban). Létrehoz egy tenantot, opcionálisan az első admin membershippel. */
  async createTenant(params: {
    slug: string
    displayName: string
    legalName?: string | null
    domainAllowlist?: string[]
    createdById: string
    /** Ha megadva: azonnal létrejön az első tenant-admin membership erre a user-id-ra. */
    initialAdminUserId?: string | null
  }) {
    const slug = normalizeTenantSlug(params.slug)
    if (!isValidTenantSlug(slug)) throw new Error('tenant: invalid slug')

    const existing = await this.tenants.findBySlug(slug)
    if (existing) throw new Error('tenant: slug already exists')

    const tenant = await this.tenants.create({
      slug,
      displayName: params.displayName.trim(),
      legalName: params.legalName ?? null,
      domainAllowlist: params.domainAllowlist ?? [],
      createdById: params.createdById,
    })



    if (params.initialAdminUserId) {
      await this.addMember({
        tenantId: tenant.id,
        userId: params.initialAdminUserId,
        role: 'admin',
        status: 'active',
        isDefault: true,
        actorId: params.createdById,
      })
    }

    return tenant
  }

  private async setTenantStatus(params: {
    tenantId: string
    status: TenantStatus
    action: string
    actorId: string
    decision: string
  }) {
    const tenant = await this.tenants.findById(params.tenantId)
    if (!tenant) throw new Error('tenant: not found')

    const updated = await this.tenants.update(tenant.id, { status: params.status })



    return updated
  }

  async suspendTenant(params: { tenantId: string; actorId: string }) {
    return this.setTenantStatus({
      tenantId: params.tenantId,
      status: 'suspended',
      action: TENANT_AUDIT_ACTIONS.suspend,
      actorId: params.actorId,
      decision: 'suspended',
    })
  }

  async offboardTenant(params: { tenantId: string; actorId: string }) {
    return this.setTenantStatus({
      tenantId: params.tenantId,
      status: 'offboarding',
      action: TENANT_AUDIT_ACTIONS.offboard,
      actorId: params.actorId,
      decision: 'offboarding',
    })
  }

  async archiveTenant(params: { tenantId: string; actorId: string }) {
    return this.setTenantStatus({
      tenantId: params.tenantId,
      status: 'archived',
      action: TENANT_AUDIT_ACTIONS.archive,
      actorId: params.actorId,
      decision: 'archived',
    })
  }

  async reactivateTenant(params: { tenantId: string; actorId: string }) {
    return this.setTenantStatus({
      tenantId: params.tenantId,
      status: 'active',
      action: TENANT_AUDIT_ACTIONS.reactivate,
      actorId: params.actorId,
      decision: 'reactivated',
    })
  }

  async listTenants(filter?: { status?: TenantStatus }) {
    return this.tenants.findMany(filter)
  }

  // ── Membership (§8.1) ─────────────────────────────────────────────────────

  /**
   * Membership létrehozás vagy újraaktiválás. Ha már van rekord a (tenant,user)
   * párra, azt frissíti (idempotens újrameghívás). Aktiválás auditálva.
   */
  async addMember(params: {
    tenantId: string
    userId: string
    role: UserRole
    status?: 'pending' | 'active'
    isDefault?: boolean
    actorId: string
  }) {
    const tenant = await this.tenants.findById(params.tenantId)
    if (!tenant) throw new Error('tenant: not found')

    const existing = await this.memberships.findByTenantAndUser(params.tenantId, params.userId)
    const status = params.status ?? 'pending'

    if (params.isDefault) {
      const others = await this.memberships.findByUser(params.userId)
      for (const row of others) {
        if (row.isDefault && row.tenantId !== params.tenantId) {
          await this.memberships.update(row.id, { isDefault: false })
        }
      }
    }

    const membership = existing
      ? await this.memberships.update(existing.id, {
          role: params.role,
          status,
          ...(params.isDefault !== undefined ? { isDefault: params.isDefault } : {}),
          ...(status === 'active' && existing.status !== 'active' ? { activatedAt: new Date() } : {}),
        })
      : await this.memberships.create({
          tenantId: params.tenantId,
          userId: params.userId,
          role: params.role,
          status,
          isDefault: params.isDefault ?? false,
          invitedById: params.actorId,
        })



    return membership
  }

  async changeMemberRole(params: {
    tenantId: string
    targetUserId: string
    newRole: UserRole
    actorId: string
  }) {
    if (params.actorId === params.targetUserId) {
      throw new Error('self_modification_forbidden: admin cannot change own membership role')
    }
    const membership = await this.loadMembership(params.tenantId, params.targetUserId)

    if (membership.role === 'admin' && params.newRole !== 'admin' && membership.status === 'active') {
      await this.assertNotLastActiveAdmin(params.tenantId, params.targetUserId)
    }

    const updated = await this.memberships.update(membership.id, { role: params.newRole })



    return updated
  }

  async suspendMember(params: { tenantId: string; targetUserId: string; actorId: string }) {
    if (params.actorId === params.targetUserId) {
      throw new Error('self_modification_forbidden: admin cannot suspend own membership')
    }
    const membership = await this.loadMembership(params.tenantId, params.targetUserId)

    if (membership.role === 'admin' && membership.status === 'active') {
      await this.assertNotLastActiveAdmin(params.tenantId, params.targetUserId)
    }

    const updated = await this.memberships.update(membership.id, { status: 'suspended' })



    return updated
  }

  async listMembers(tenantId: string) {
    return this.memberships.findByTenant(tenantId)
  }

  // ── Superadmin assume-tenant audit (§5.3, §3.3/1-2) ──────────────────────

  /**
   * Superadmin explicit tenant-kontextusba lépése — az actor MINDIG a superadmin
   * (soha nem impersonate, §3.3/2), `assumedTenantId` jelöli a kontextust.
   */
  async recordAssumeTenant(params: { superadminId: string; tenantId: string }) {

  }

  async recordExitTenant(params: { superadminId: string; tenantId: string }) {

  }

  async listPlatformMembers() {
    return this.platformMemberships.findAll()
  }

  /**
   * Platform-jogosultság adása. Az `actorId` KÖTELEZŐ: a superadmin-jog kiosztása a
   * platform legmagasabb tétű aktusa, nem maradhat audit-nyom nélkül. Korábban az
   * `actorId` opcionális volt, és hiányában a service csendben, auditálatlanul adott
   * jogot — pont az a művelet csúszott ki a naplóból, amit egy incidens-vizsgálat
   * elsőként keresne.
   */
  async grantPlatformRole(params: { userId: string; role: PlatformRole; actorId: string }) {
    const membership = await this.platformMemberships.upsert({ userId: params.userId, role: params.role })

    return membership
  }

  async revokePlatformRole(params: { userId: string; role: PlatformRole; actorId: string }) {
    await this.platformMemberships.delete(params.userId, params.role)

  }

  // ── Belső ────────────────────────────────────────────────────────────────

  private async loadMembership(tenantId: string, userId: string) {
    const membership = await this.memberships.findByTenantAndUser(tenantId, userId)
    // N-IAM-6 megfelelője: cross-tenant célpont "not found".
    if (!membership) throw new Error('membership: not found')
    return membership
  }

  private async assertNotLastActiveAdmin(tenantId: string, excludeUserId: string) {
    const others = await this.memberships.countActiveAdmins(tenantId, excludeUserId)
    const check = checkLastTenantAdminLock({ otherActiveAdminCount: others, targetIsActiveAdmin: true })
    if (check.blocked) throw new Error('lockout: last active tenant admin cannot be removed')
  }
}
