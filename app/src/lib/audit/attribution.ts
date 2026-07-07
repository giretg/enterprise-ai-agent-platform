import type { AuditLog, Prisma } from '@prisma/client'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readUuidField(metadata: Prisma.JsonValue | null | undefined, keys: string[]): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const obj = metadata as Record<string, unknown>
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && UUID_RE.test(value)) return value
  }
  return null
}

/**
 * Feature-spec AuditLog-Observability §3.1 — explicit tenant_id/ticket_id/conversation_id
 * oszlopok az indexelt lekérdezéshez. A hívók továbbra sem kötelesek ezeket külön átadni:
 * a write-időben `targetType`/`targetId`-ből (ticket/conversation célpont) vagy a metadata
 * ismert kulcsaiból (ticketId/ticket_id stb.) származtatjuk. A v2 audit-hash (WP-2) a
 * származtatott tenant/ticket/conversation attribúciót IS fedi (a hash a deriveAuditAttribution
 * kimenetével együtt számolódik az append-ben), így ezek az azonosítók sem módosíthatók
 * utólag a lánc megtörése nélkül.
 */
export function deriveAuditAttribution(
  data: Pick<AuditLog, 'targetType' | 'targetId' | 'metadata'> & {
    tenantId?: string | null
    ticketId?: string | null
    conversationId?: string | null
  },
): { tenantId: string | null; ticketId: string | null; conversationId: string | null } {
  const ticketId =
    data.ticketId ??
    (data.targetType === 'ticket' ? data.targetId : null) ??
    readUuidField(data.metadata, ['ticketId', 'ticket_id'])

  const conversationId =
    data.conversationId ??
    (data.targetType === 'conversation' ? data.targetId : null) ??
    readUuidField(data.metadata, ['conversationId', 'conversation_id'])

  const tenantId = data.tenantId ?? readUuidField(data.metadata, ['tenantId', 'tenant_id'])

  return { tenantId, ticketId, conversationId }
}
