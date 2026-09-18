const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readUuidField(metadata: unknown, keys: string[]): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const obj = metadata as Record<string, unknown>
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && UUID_RE.test(value)) return value
  }
  return null
}

/**
 * Tenant attribution only. ticketId / conversationId columns are gone; the v2
 * hash still receives `''` for those fields so the formula does not fork.
 */
export function deriveAuditAttribution(data: {
  targetType: string
  targetId?: string | null
  metadata?: unknown
  tenantId?: string | null
}): { tenantId: string | null } {
  const tenantId =
    data.tenantId ??
    (data.targetType === 'tenant' ? data.targetId ?? null : null) ??
    readUuidField(data.metadata, ['tenantId', 'tenant_id'])
  return { tenantId: tenantId ?? null }
}
