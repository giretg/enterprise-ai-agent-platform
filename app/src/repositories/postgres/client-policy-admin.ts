import { prisma } from '@/lib/db'
import type { Prisma } from '@prisma/client'
import type { AdminPolicyStore, AdminPolicyTarget } from '@/domain/client-policy/admin-policy'
import type { PolicyRow } from '@/domain/client-policy/resolve-effective-policy'
import { appendAuditInTransaction } from './audit-repository'

export async function clientPolicyTargetExists(db: Pick<Prisma.TransactionClient, 'tenantMembership' | 'agent'>, tenantId: string, target: AdminPolicyTarget): Promise<boolean> {
  if (target.scope === 'tenant') return target.scopeId === tenantId
  if (target.scope === 'user') {
    return !!await db.tenantMembership.findFirst({
      where: { tenantId, userId: target.scopeId, status: 'active', user: { status: 'active' } }, select: { id: true },
    })
  }
  return !!await db.agent.findFirst({ where: { id: target.scopeId, tenantId }, select: { id: true } })
}

export const clientPolicyAdminStore: AdminPolicyStore = {
  transaction: (tenantId, run) => prisma.$transaction(async (tx) => {
    // ponytail: tenantenként soros adminmentés a D3 miatt; soronkénti lock, ha a mentési terhelés indokolja.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(776, hashtext(${tenantId}))`
    return run({
      targetExists: (target) => clientPolicyTargetExists(tx, tenantId, target),
      find: async ({ scope, scopeId }) => await tx.clientPolicy.findUnique({
        where: { tenantId_scope_scopeId: { tenantId, scope, scopeId } },
      }) as PolicyRow | null,
      save: async (row, expectedVersion, actorId) => {
        const data = {
          preset: row.preset, capabilities: row.capabilities as Prisma.InputJsonValue,
          version: row.version, updatedById: actorId,
        }
        if (expectedVersion === 0) {
          // skipDuplicates turns two concurrent creates into a clean version conflict.
          const result = await tx.clientPolicy.createMany({
            data: { tenantId, scope: row.scope, scopeId: row.scopeId, ...data }, skipDuplicates: true,
          })
          return result.count === 1
        }
        const result = await tx.clientPolicy.updateMany({
          where: { tenantId, scope: row.scope, scopeId: row.scopeId, version: expectedVersion }, data,
        })
        return result.count === 1
      },
      audit: (event) => appendAuditInTransaction(tx, event),
    })
  }, { timeout: 60_000 }),
}
