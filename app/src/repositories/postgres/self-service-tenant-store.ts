import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { SelfServiceTenantStore } from '@/domain/tenant/self-service-store'
import { appendAuditInTransaction } from './audit-repository'

// Minden self-service cégindítás sorosítva fut: a cap-számlálás és a slug-foglalás
// így nem versenyezhet (ritka művelet, a globális zár nem szűk keresztmetszet).
const SELF_SERVICE_LOCK_KEY = 830

export const selfServiceTenantStore: SelfServiceTenantStore = {
  transaction: (run) =>
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SELF_SERVICE_LOCK_KEY})`
        return run({
          findUser: (userId) =>
            tx.user.findUnique({ where: { id: userId }, select: { id: true, status: true, role: true } }),
          countSelfServiceTenants: (userId) =>
            tx.tenant.count({
              where: { createdById: userId, selfService: true, status: { not: 'archived' } },
            }),
          slugExists: async (slug) =>
            !!(await tx.tenant.findUnique({ where: { slug }, select: { id: true } })),
          createTenant: (data) =>
            tx.tenant.create({
              data: {
                slug: data.slug,
                displayName: data.displayName,
                legalName: data.legalName,
                taxId: data.taxId,
                status: 'active',
                domainAllowlist: [] as Prisma.InputJsonValue,
                createdById: data.createdById,
                selfService: true,
              },
            }),
          clearDefaultMemberships: async (userId) => {
            await tx.tenantMembership.updateMany({
              where: { userId, isDefault: true },
              data: { isDefault: false },
            })
          },
          createAdminMembership: ({ tenantId, userId }) =>
            tx.tenantMembership.create({
              data: {
                tenantId,
                userId,
                role: 'admin',
                status: 'active',
                isDefault: true,
                invitedById: userId,
                activatedAt: new Date(),
              },
            }),
          activateUser: async (userId, role) => {
            await tx.user.update({
              where: { id: userId },
              data: { status: 'active', role, activatedAt: new Date() },
            })
          },
          audit: (event) => appendAuditInTransaction(tx, event),
        })
      },
      { timeout: 60_000 },
    ),
}
