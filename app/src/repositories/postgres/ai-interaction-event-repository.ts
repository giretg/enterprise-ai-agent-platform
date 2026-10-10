import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { AiInteractionFilter, AiInteractionRow, AiInteractionStore } from '@/domain/ai-audit/ai-audit-service'

export class PostgresAiInteractionEventRepository implements AiInteractionStore {
  async insertMany(rows: AiInteractionRow[]): Promise<number> {
    const { count } = await prisma.aiInteractionEvent.createMany({
      data: rows.map((r) => ({ ...r, meta: r.meta as Prisma.InputJsonValue })),
      skipDuplicates: true,
    })
    return count
  }

  async list(f: AiInteractionFilter): Promise<AiInteractionRow[]> {
    const rows = await prisma.aiInteractionEvent.findMany({
      where: {
        tenantId: f.tenantId,
        userId: f.userId,
        agentId: f.agentId,
        sessionId: f.sessionId,
        createdAt: { gte: f.from, lte: f.to },
        expiresAt: { gt: new Date() },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
    })
    return rows.map((r) => ({
      ...r,
      kind: r.kind as AiInteractionRow['kind'],
      source: r.source as AiInteractionRow['source'],
      meta: (r.meta ?? {}) as Record<string, unknown>,
    }))
  }

  async deleteExpired(now: Date, limit: number): Promise<number> {
    return prisma.$executeRaw`
      DELETE FROM "ai_interaction_events" AS e
      USING (
        SELECT "tenant_id", "id" FROM "ai_interaction_events"
        WHERE "expires_at" <= ${now}
        LIMIT ${limit}
      ) AS d
      WHERE e."tenant_id" = d."tenant_id" AND e."id" = d."id"
    `
  }
}
