import type {
  Prisma,
  PlatformMembershipStatus,
  PlatformRole,
  TenantMembershipStatus,
  TenantStatus,
  UserRole,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  TenantRepository,
  TenantMembershipRepository,
  PlatformMembershipRepository,
} from '@/repositories/interfaces'

export class PostgresTenantRepository implements TenantRepository {
  async findById(id: string) {
    return prisma.tenant.findUnique({ where: { id } })
  }

  async findBySlug(slug: string) {
    return prisma.tenant.findUnique({ where: { slug } })
  }

  async findMany(filter?: { status?: TenantStatus }) {
    return prisma.tenant.findMany({
      where: { ...(filter?.status ? { status: filter.status } : {}) },
      orderBy: { createdAt: 'asc' },
    })
  }

  async create(data: {
    slug: string
    displayName: string
    legalName?: string | null
    domainAllowlist?: string[]
    settings?: Prisma.InputJsonValue
    createdById?: string | null
  }) {
    return prisma.tenant.create({
      data: {
        slug: data.slug,
        displayName: data.displayName,
        legalName: data.legalName ?? null,
        domainAllowlist: (data.domainAllowlist ?? []) as Prisma.InputJsonValue,
        ...(data.settings !== undefined ? { settings: data.settings } : {}),
        createdById: data.createdById ?? null,
      },
    })
  }

  async update(
    id: string,
    data: Partial<{
      displayName: string
      legalName: string | null
      status: TenantStatus
      domainAllowlist: string[]
      settings: Prisma.InputJsonValue
    }>,
  ) {
    return prisma.tenant.update({
      where: { id },
      data: {
        ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
        ...(data.legalName !== undefined ? { legalName: data.legalName } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.domainAllowlist !== undefined
          ? { domainAllowlist: data.domainAllowlist as Prisma.InputJsonValue }
          : {}),
        ...(data.settings !== undefined ? { settings: data.settings } : {}),
      },
    })
  }
}

export class PostgresTenantMembershipRepository implements TenantMembershipRepository {
  async findById(id: string) {
    return prisma.tenantMembership.findUnique({ where: { id } })
  }

  async findByTenantAndUser(tenantId: string, userId: string) {
    return prisma.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId, userId } } })
  }

  async findByUser(userId: string) {
    return prisma.tenantMembership.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    })
  }

  async findByTenant(
    tenantId: string,
    filter?: { status?: TenantMembershipStatus; role?: UserRole },
  ) {
    return prisma.tenantMembership.findMany({
      where: {
        tenantId,
        ...(filter?.status ? { status: filter.status } : {}),
        ...(filter?.role ? { role: filter.role } : {}),
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  async countActiveAdmins(tenantId: string, excludeUserId?: string) {
    return prisma.tenantMembership.count({
      where: {
        tenantId,
        role: 'admin',
        status: 'active',
        ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
      },
    })
  }

  async create(data: {
    tenantId: string
    userId: string
    role: UserRole
    status?: TenantMembershipStatus
    isDefault?: boolean
    invitedById?: string | null
  }) {
    return prisma.tenantMembership.create({
      data: {
        tenantId: data.tenantId,
        userId: data.userId,
        role: data.role,
        status: data.status ?? 'pending',
        isDefault: data.isDefault ?? false,
        invitedById: data.invitedById ?? null,
        ...(data.status === 'active' ? { activatedAt: new Date() } : {}),
      },
    })
  }

  async update(
    id: string,
    data: Partial<{
      role: UserRole
      status: TenantMembershipStatus
      isDefault: boolean
      activatedAt: Date | null
    }>,
  ) {
    return prisma.tenantMembership.update({ where: { id }, data })
  }
}

export class PostgresPlatformMembershipRepository implements PlatformMembershipRepository {
  async findByUser(userId: string) {
    return prisma.platformMembership.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })
  }

  async findByRole(role: PlatformRole, filter?: { status?: PlatformMembershipStatus }) {
    return prisma.platformMembership.findMany({
      where: { role, ...(filter?.status ? { status: filter.status } : {}) },
      orderBy: { createdAt: 'asc' },
    })
  }

  async findAll() {
    const rows = await prisma.platformMembership.findMany({
      include: { user: { select: { email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    })
    return rows.map(({ user, ...m }) => ({ ...m, userEmail: user.email, userName: user.name }))
  }

  async upsert(data: { userId: string; role: PlatformRole; status?: PlatformMembershipStatus }) {
    return prisma.platformMembership.upsert({
      where: { userId_role: { userId: data.userId, role: data.role } },
      create: { userId: data.userId, role: data.role, status: data.status ?? 'active' },
      update: { ...(data.status ? { status: data.status } : {}) },
    })
  }

  async delete(userId: string, role: PlatformRole) {
    await prisma.platformMembership.deleteMany({ where: { userId, role } })
  }
}
