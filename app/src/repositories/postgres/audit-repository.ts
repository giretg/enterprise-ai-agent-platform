import type { AuditLog, ModelCall, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { AuditRepository, ModelCallRepository } from '../interfaces'

export class PostgresAuditRepository implements AuditRepository {
  async append(data: Omit<AuditLog, 'id' | 'seq' | 'createdAt'>): Promise<AuditLog> {
    return prisma.auditLog.create({ data: data as Prisma.AuditLogCreateInput })
  }

  async findMany(filter?: { action?: string; limit?: number }): Promise<AuditLog[]> {
    return prisma.auditLog.findMany({
      where: filter?.action ? { action: filter.action } : undefined,
      orderBy: { seq: 'desc' },
      take: filter?.limit ?? 100,
    })
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
