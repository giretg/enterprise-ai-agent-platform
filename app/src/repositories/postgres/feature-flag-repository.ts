import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { AuditAppendInput } from '@/lib/audit/types'
import {
  FEATURE_FLAG_AUDIT_ACTIONS,
  FEATURE_FLAG_AUDIT_TARGET,
  FeatureFlagAuditWriteError,
  type FeatureFlagCommit,
  type FeatureFlagHistoryEntry,
  type FeatureFlagRow,
  type FeatureFlagStore,
} from '@/domain/feature-flags/admin-service'
import { appendAuditInTransaction } from './audit-repository'

const WITH_TENANTS = { tenants: { select: { tenantId: true, access: true } } } as const

export class PostgresFeatureFlagRepository implements FeatureFlagStore {
  constructor(
    private readonly appendAudit: (tx: Prisma.TransactionClient, data: AuditAppendInput) => Promise<unknown> = appendAuditInTransaction,
  ) {}

  async loadAll(): Promise<FeatureFlagRow[]> {
    return prisma.featureFlag.findMany({ include: WITH_TENANTS })
  }

  async find(key: string): Promise<FeatureFlagRow | null> {
    return prisma.featureFlag.findUnique({ where: { key }, include: WITH_TENANTS })
  }

  /**
   * Az állapot és az audit egy tranzakcióban íródik (read committed, az audit-lánc ezt várja el).
   * A sorrend fix: előbb a flag sora a `version` feltétellel, utána a cégek, végül az audit-zár.
   */
  async commit(input: FeatureFlagCommit): Promise<'committed' | 'conflict'> {
    const fields = {
      mode: input.mode,
      fullRolloutAt: input.fullRolloutAt,
      removeBy: input.removeBy,
      stoppedAt: input.stoppedAt,
      updatedById: input.actorId,
    }
    return prisma.$transaction(
      async (tx) => {
        const claimed =
          input.expectedVersion === 0
            ? await tx.featureFlag.createMany({ data: [{ key: input.key, ...fields }], skipDuplicates: true })
            : await tx.featureFlag.updateMany({
                where: { key: input.key, version: input.expectedVersion },
                data: { ...fields, version: { increment: 1 } },
              })
        if (claimed.count === 0) return 'conflict'

        for (const { tenantId, access } of input.tenantAccess) {
          if (access === null) {
            await tx.featureFlagTenant.deleteMany({ where: { flagKey: input.key, tenantId } })
          } else {
            await tx.featureFlagTenant.upsert({
              where: { flagKey_tenantId: { flagKey: input.key, tenantId } },
              create: { flagKey: input.key, tenantId, access, updatedById: input.actorId },
              update: { access, updatedById: input.actorId },
            })
          }
        }

        for (const row of input.audit) {
          try {
            await this.appendAudit(tx, row)
          } catch (error) {
            throw new FeatureFlagAuditWriteError(error)
          }
        }
        return 'committed'
      },
      { timeout: 60_000 },
    )
  }

  /** Csak a platform-szintű sorok: ezek tartalmazzák az indoklást és a teljes változást. */
  async listHistory(key: string, limit: number): Promise<FeatureFlagHistoryEntry[]> {
    return prisma.auditLog.findMany({
      where: {
        action: { in: [...FEATURE_FLAG_AUDIT_ACTIONS] },
        targetType: FEATURE_FLAG_AUDIT_TARGET,
        tenantId: null,
        metadata: { path: ['flagKey'], equals: key },
      },
      orderBy: { seq: 'desc' },
      take: limit,
      select: { id: true, action: true, actorId: true, createdAt: true, metadata: true },
    })
  }
}
