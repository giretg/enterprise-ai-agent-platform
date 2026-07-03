import type { UserRole, UserStatus, InvitationStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  UserRepository,
  InvitationRepository,
  RolePermissionRepository,
} from '@/repositories/interfaces'

export class PostgresUserRepository implements UserRepository {
  async findById(id: string) {
    return prisma.user.findUnique({ where: { id } })
  }

  async findByExternalAuthId(externalAuthId: string) {
    return prisma.user.findUnique({ where: { externalAuthId } })
  }

  async findMany(filter?: { tenantId?: string | null; status?: UserStatus; role?: UserRole }) {
    return prisma.user.findMany({
      where: {
        ...(filter?.tenantId !== undefined ? { tenantId: filter.tenantId } : {}),
        ...(filter?.status ? { status: filter.status } : {}),
        ...(filter?.role ? { role: filter.role } : {}),
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  async countActiveAdmins(tenantId: string | null, excludeUserId?: string) {
    return prisma.user.count({
      where: {
        tenantId,
        role: 'admin',
        status: 'active',
        ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
      },
    })
  }

  async create(data: {
    externalAuthId: string
    email: string
    name: string
    role?: UserRole | null
    status?: UserStatus
    tenantId?: string | null
  }) {
    return prisma.user.create({
      data: {
        externalAuthId: data.externalAuthId,
        email: data.email,
        name: data.name,
        role: data.role ?? null,
        status: data.status ?? 'pending',
        tenantId: data.tenantId ?? null,
      },
    })
  }

  async update(
    id: string,
    data: Partial<{
      role: UserRole | null
      status: UserStatus
      tenantId: string | null
      invitedById: string | null
      activatedAt: Date | null
      suspendedAt: Date | null
      suspendedById: string | null
      suspendedReason: string | null
      lastLoginAt: Date | null
      email: string
      name: string
    }>,
  ) {
    return prisma.user.update({ where: { id }, data })
  }

  async upsertByExternalAuthId(params: {
    externalAuthId: string
    create: {
      email: string
      name: string
      role?: UserRole | null
      status?: UserStatus
      tenantId?: string | null
    }
    update: Partial<{ role: UserRole | null; status: UserStatus; activatedAt: Date; invitedById: string | null }>
  }) {
    return prisma.user.upsert({
      where: { externalAuthId: params.externalAuthId },
      create: {
        externalAuthId: params.externalAuthId,
        email: params.create.email,
        name: params.create.name,
        role: params.create.role ?? null,
        status: params.create.status ?? 'pending',
        tenantId: params.create.tenantId ?? null,
      },
      update: params.update,
    })
  }
}

export class PostgresInvitationRepository implements InvitationRepository {
  async findById(id: string) {
    return prisma.invitation.findUnique({ where: { id } })
  }

  async findByTokenHash(tokenHash: string) {
    return prisma.invitation.findUnique({ where: { tokenHash } })
  }

  async findMany(filter?: { tenantId?: string | null; status?: InvitationStatus }) {
    return prisma.invitation.findMany({
      where: {
        ...(filter?.tenantId !== undefined ? { tenantId: filter.tenantId } : {}),
        ...(filter?.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  async create(data: {
    tenantId: string | null
    email: string
    role: UserRole
    tokenHash: string
    expiresAt: Date
    createdById: string
  }) {
    return prisma.invitation.create({
      data: {
        tenantId: data.tenantId,
        email: data.email,
        role: data.role,
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
        createdById: data.createdById,
      },
    })
  }

  async update(id: string, data: Partial<{ status: InvitationStatus; redeemedAt: Date; revokedAt: Date }>) {
    return prisma.invitation.update({ where: { id }, data })
  }
}

/** Deklaratív permission-mátrix (§3.3): permission_key → minimális szerep, deny-by-default a hiányzó kulcsra. */
export class PostgresRolePermissionRepository implements RolePermissionRepository {
  async findAll() {
    return prisma.rolePermission.findMany({ orderBy: { permissionKey: 'asc' } })
  }

  async findByKey(permissionKey: string) {
    return prisma.rolePermission.findUnique({ where: { permissionKey } })
  }

  async upsert(permissionKey: string, minRole: UserRole, description?: string | null) {
    return prisma.rolePermission.upsert({
      where: { permissionKey },
      create: { permissionKey, minRole, description: description ?? null },
      update: { minRole, ...(description !== undefined ? { description } : {}) },
    })
  }
}

/**
 * Kanonikus permission_key → minimális szerep leképezés (§3.3, §6 API-tábla).
 * Idempotens seed: csak a HIÁNYZÓ kulcsokat hozza létre — a futásidőben admin
 * által módosított `min_role`-t nem írja felül (a mátrix futásidőben szerkeszthető).
 */
export const DEFAULT_ROLE_PERMISSIONS: Array<{
  permissionKey: string
  minRole: UserRole
  description: string
}> = [
  { permissionKey: 'user.invite', minRole: 'admin', description: 'Meghívó kiállítása' },
  { permissionKey: 'user.invite.revoke', minRole: 'admin', description: 'Meghívó visszavonása' },
  { permissionKey: 'user.approve', minRole: 'admin', description: 'Pending önregisztráció jóváhagyása' },
  { permissionKey: 'user.role.write', minRole: 'admin', description: 'Szerepkör módosítása' },
  { permissionKey: 'user.suspend', minRole: 'admin', description: 'Felfüggesztés / visszaállítás' },
  { permissionKey: 'user.read', minRole: 'admin', description: 'Felhasználólista olvasása' },
  { permissionKey: 'audit.read', minRole: 'approver', description: 'Hozzáférési audit olvasása' },
  { permissionKey: 'user.permission.write', minRole: 'admin', description: 'Permission-mátrix szerkesztése' },
  {
    permissionKey: 'connector_template:manage',
    minRole: 'admin',
    description: 'Connector-sablon katalógus kezelése',
  },
]

export async function ensureDefaultRolePermissions(
  repo: Pick<RolePermissionRepository, 'findByKey' | 'upsert'> = new PostgresRolePermissionRepository(),
) {
  for (const entry of DEFAULT_ROLE_PERMISSIONS) {
    const existing = await repo.findByKey(entry.permissionKey)
    if (!existing) {
      await repo.upsert(entry.permissionKey, entry.minRole, entry.description)
    }
  }
}
