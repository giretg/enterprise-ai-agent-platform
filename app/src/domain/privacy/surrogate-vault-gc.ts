/**
 * Lejárt surrogate_map sorok takarítása (APG-18, spec §6).
 *
 * A per-conversation adatkulcs már törlődött (crypto-shredding), az üzenettartalom
 * kiürült — a mapping sorok fizikailag is törölhetők.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'

export type SurrogateVaultGcResult = {
  deletedCount: number
  conversationIds: string[]
}

const DEFAULT_GC_LIMIT = 100

function clampLimit(limit?: number): number {
  if (limit == null || !Number.isInteger(limit) || limit <= 0) return DEFAULT_GC_LIMIT
  return limit
}

export async function gcShreddedConversationSurrogateMappings(
  limit?: number,
): Promise<SurrogateVaultGcResult> {
  const take = clampLimit(limit)
  const rows = await prisma.$queryRaw<Array<{ conversation_id: string }>>(Prisma.sql`
    SELECT c.id::text AS conversation_id
    FROM conversations c
    WHERE c.legal_hold = false
      AND NOT EXISTS (
        SELECT 1 FROM conversation_privacy_keys k WHERE k.conversation_id = c.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.conversation_id = c.id
          AND m.content_deleted_at IS NULL
          AND m.content_ref IS NOT NULL
      )
      AND EXISTS (
        SELECT 1 FROM surrogate_map sm
        WHERE sm.scope_type = 'conversation'::"surrogate_scope_type"
          AND sm.scope_id = c.id::text
      )
    ORDER BY c.retain_until ASC NULLS LAST
    LIMIT ${take}
  `)

  const conversationIds = rows.map((row) => row.conversation_id)
  if (conversationIds.length === 0) {
    return { deletedCount: 0, conversationIds: [] }
  }

  const deleted = await prisma.surrogateMap.deleteMany({
    where: {
      scopeType: 'conversation',
      scopeId: { in: conversationIds },
    },
  })

  return { deletedCount: deleted.count, conversationIds }
}
