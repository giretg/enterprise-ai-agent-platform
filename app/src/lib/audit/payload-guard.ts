/**
 * Content/metadata szétválasztás kódszintű őre (Feature-spec AuditLog-Observability §2/5, §4.1/1).
 * Nyers üzenet-, PII-, dokumentum-, argumentum- vagy secret-tartalom SOHA nem kerülhet az
 * audit_log.metadata mezőbe — csak referencia (*_ref/*_hash/*_alias) vagy kis méretű metaadat.
 */
const MAX_AUDIT_STRING_LENGTH = 4096

const FORBIDDEN_METADATA_KEYS = new Set([
  'authorization',
  'body',
  'content',
  'cookie',
  'message',
  'password',
  'prompt',
  'raw',
  'response',
  'secret',
  'text',
  'token',
])

// Ezek a kulcsok a tiltólista szavait tartalmazhatják, de a spec engedélyezett ref/hash/alias
// formájúak (pl. contentRef, secretAlias, tokenHash) — nem nyers tartalom.
const ALLOWED_REF_SUFFIX_KEYS = new Set([
  'contenthash',
  'contentref',
  'diffhash',
  'inputref',
  'messageref',
  'outputref',
  'queryhash',
  'secretalias',
  'sourcehash',
  'storageref',
  'tokenhash',
])

function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, '').toLowerCase()
}

export class UnsafeAuditPayloadError extends Error {
  constructor(path: string) {
    super(`Unsafe audit payload: "${path}" must be stored as a ref/hash/meta field, not raw content`)
    this.name = 'UnsafeAuditPayloadError'
  }
}

/** Fail-fast guard: eldobja a hívást, ha a metadata tiltott kulcsot vagy túl nagy nyers stringet tartalmaz. */
export function assertAuditMetadataSafe(value: unknown, path = 'metadata'): void {
  if (value == null) return

  if (typeof value === 'string') {
    if (value.length > MAX_AUDIT_STRING_LENGTH) {
      throw new UnsafeAuditPayloadError(path)
    }
    return
  }

  if (typeof value !== 'object') return

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAuditMetadataSafe(item, `${path}[${index}]`))
    return
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeKey(key)
    if (FORBIDDEN_METADATA_KEYS.has(normalized) && !ALLOWED_REF_SUFFIX_KEYS.has(normalized)) {
      throw new UnsafeAuditPayloadError(`${path}.${key}`)
    }
    assertAuditMetadataSafe(child, `${path}.${key}`)
  }
}
