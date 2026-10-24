/**
 * #942 D13: privát tudásbázis audit-eseményei tartalommentesek — csak azonosítók,
 * darabszámok, hash-ek és rövid enum-szerű értékek maradnak. Oldalcím, path,
 * fájlnév, cél (`purpose`) nem kerülhet bele: már egy path (`conditions/cukorbetegseg.md`)
 * is egészségügyi adat.
 *
 * Allowlist, nem tiltólista: ismeretlen string-kulcs kiesik. Közös KB-nál a
 * bemenet változatlanul megy tovább.
 */
import type { AuditAppendInput } from './types'
import { isPrivateKnowledgeBase, type KbVisibilityRow } from '../wiki-access'

/** Azonosító / hash / szám jellegű kulcsok (normalizált: kisbetű, `_`/`-` nélkül). */
const SAFE_STRING_KEY = /(id|ids|hash|hashes)$/
const SAFE_ENUM_KEYS = new Set([
  'processingmode',
  'status',
  'fromstatus',
  'tostatus',
  'op',
  'kind',
  'action',
  'scope',
  'visibility',
  'access',
  'wikiaccess',
  'fromaccess',
  'toaccess',
  'writemode',
  'wikiwritemode',
  'fromwritemode',
  'towritemode',
  'trigger',
  'actortype',
])
const MAX_ENUM_LENGTH = 64

function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, '').toLowerCase()
}

function redactValue(key: string, value: unknown): unknown {
  const normalized = normalizeKey(key)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (SAFE_STRING_KEY.test(normalized)) return value
    if (SAFE_ENUM_KEYS.has(normalized) && value.length <= MAX_ENUM_LENGTH && /^[a-z0-9_.:-]*$/i.test(value)) {
      return value
    }
    return undefined
  }
  if (Array.isArray(value)) {
    if (!SAFE_STRING_KEY.test(normalized)) {
      return value.every((item) => typeof item === 'number') ? value : undefined
    }
    return value.filter((item) => typeof item === 'string' || typeof item === 'number')
  }
  if (typeof value === 'object') return redactMetadata(value as Record<string, unknown>)
  return undefined
}

export function redactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    const kept = redactValue(key, value)
    if (kept !== undefined) out[key] = kept
  }
  return out
}

/**
 * Egy KB-hoz kötött audit-sor privát KB-nál tartalommentes változata: az
 * `inputRef`/`outputRef` csak azonosító lehet (UUID / hash), a metadata allowlistes.
 */
export function redactKbAuditForVisibility(
  connector: KbVisibilityRow | null | undefined,
  entry: AuditAppendInput,
): AuditAppendInput {
  if (!isPrivateKnowledgeBase(connector)) return entry
  const metadata =
    entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata)
      ? redactMetadata(entry.metadata as Record<string, unknown>)
      : {}
  return {
    ...entry,
    inputRef: idOnly(entry.inputRef),
    outputRef: idOnly(entry.outputRef),
    metadata: { ...metadata, privateKb: true },
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH_RE = /^(sha256:)?[0-9a-f]{64}$/i

function idOnly(value: string | null | undefined): string | null {
  if (!value) return null
  return UUID_RE.test(value) || HASH_RE.test(value) ? value : null
}
