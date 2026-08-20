/**
 * Val-surrogate entitásazonosító: normalizált érték hash a bijektív vault-kulcsba (spec §6, D2).
 * A `source_id` mezőben `val:<hex>` formában tároljuk; connectorId mindig null.
 */
import { createHash } from 'node:crypto'

const VAL_FINGERPRINT_PREFIX = 'val:'

export function normalizeValSurrogatePlaintext(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

export function valSurrogateFingerprint(value: string): string {
  const normalized = normalizeValSurrogatePlaintext(value)
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex')
  return `${VAL_FINGERPRINT_PREFIX}${digest}`
}

export function isValSurrogateFingerprint(sourceId: string): boolean {
  return sourceId.startsWith(VAL_FINGERPRINT_PREFIX)
}
