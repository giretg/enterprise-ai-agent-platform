import type { AuditLog, ModelCall, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { AuditRepository, ModelCallRepository } from '../interfaces'
import { computeAuditHash, GENESIS_HASH } from '@/lib/crypto/hash-chain'
import { chainHasGaps, reconcileAuditChain } from '@/lib/crypto/audit-backfill'

const AUDIT_CHAIN_LOCK_KEY = 424242

export class PostgresAuditRepository implements AuditRepository {
  async append(
    data: Omit<AuditLog, 'id' | 'seq' | 'createdAt' | 'hash' | 'prevHash'>,
  ): Promise<AuditLog> {
    return prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`

        let prevHash = GENESIS_HASH
        if (await chainHasGaps(tx)) {
          prevHash = await reconcileAuditChain(tx)
        } else {
          const last = await tx.auditLog.findFirst({ orderBy: { seq: 'desc' } })
          prevHash = last?.hash ?? GENESIS_HASH
        }

        const row = await tx.auditLog.create({
          data: { ...data, prevHash, hash: '' } as Prisma.AuditLogCreateInput,
        })

        const hash = computeAuditHash({
          seq: row.seq,
          prevHash,
          actorType: row.actorType,
          actorId: row.actorId,
          action: row.action,
          targetType: row.targetType,
          targetId: row.targetId,
          createdAt: row.createdAt,
        })

        return tx.auditLog.update({ where: { id: row.id }, data: { hash } })
      },
      { timeout: 60_000 },
    )
  }

  async findMany(filter?: { action?: string; limit?: number }): Promise<AuditLog[]> {
    return prisma.auditLog.findMany({
      where: filter?.action ? { action: filter.action } : undefined,
      orderBy: { seq: 'desc' },
      take: filter?.limit ?? 100,
    })
  }

  async findAll(): Promise<AuditLog[]> {
    return prisma.auditLog.findMany({ orderBy: { seq: 'asc' } })
  }
}

export class PostgresModelCallRepository implements ModelCallRepository {
  async create(data: Omit<ModelCall, 'id' | 'createdAt'>): Promise<ModelCall> {
    return prisma.modelCall.create({ data })
  }

  async getCostSummary(since?: Date) {
    const rows = await prisma.modelCall.findMany({
      where: since ? { createdAt: { gte: since } } : undefined,
      select: {
        promptTokens: true,
        completionTokens: true,
        costEstimate: true,
      },
    })

    return rows.reduce(
      (acc, row) => ({
        tokens: acc.tokens + row.promptTokens + row.completionTokens,
        cost: acc.cost + Number(row.costEstimate),
      }),
      { tokens: 0, cost: 0 },
    )
  }
}
