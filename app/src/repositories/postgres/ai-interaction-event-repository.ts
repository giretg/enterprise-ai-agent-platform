import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { AiInteractionFilter, AiInteractionRow, AiInteractionStore } from '@/domain/ai-audit/ai-audit-service'
import type { UnclassifiedToolUse } from '@/domain/client-policy/tool-catalog'

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

  async unclassifiedTools(tenantId: string): Promise<UnclassifiedToolUse[]> {
    const rows = await prisma.$queryRaw<{ tool: string; attempts: bigint; last_seen_at: Date; hermes_version: string | null }[]>`
      SELECT "meta"->>'tool' AS tool, COUNT(*) AS attempts, MAX("created_at") AS last_seen_at,
             (ARRAY_AGG("meta"->>'hermesVersion' ORDER BY "created_at" DESC))[1] AS hermes_version
      FROM "ai_interaction_events"
      WHERE "tenant_id" = ${tenantId}::uuid AND "kind" = 'tool_unclassified'
        AND "expires_at" > NOW() AND "meta"->>'tool' IS NOT NULL
      GROUP BY 1
      ORDER BY last_seen_at DESC
      LIMIT 200
    `
    return rows.map((r) => ({ tool: r.tool, attempts: Number(r.attempts), lastSeenAt: r.last_seen_at, hermesVersion: r.hermes_version }))
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
