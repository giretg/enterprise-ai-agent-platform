/**
 * Val-surrogate entitásazonosító: normalizált érték hash a bijektív vault-kulcsba (spec §6, D2).
 * A `source_id` mezőben `val:<hex>` formában tároljuk; connectorId mindig null.
 */
import { createHash, createHmac } from 'node:crypto'

const VAL_FINGERPRINT_PREFIX = 'val:'

export function normalizeValSurrogatePlaintext(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

export function valSurrogateFingerprint(value: string): string {
  const normalized = normalizeValSurrogatePlaintext(value)
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex')
  return `${VAL_FINGERPRINT_PREFIX}${digest}`
}

/** Kulcsos HMAC, típussal: az e-mail szótárból ne legyen visszafejthető (Model Gateway vault). */
export function keyedValSurrogateFingerprint(tenantKey: string, entityType: string, value: string): string {
  return `${VAL_FINGERPRINT_PREFIX}${createHmac('sha256', tenantKey)
    .update(`fp\n${entityType}\n${normalizeValSurrogatePlaintext(value)}`)
    .digest('hex')}`
}

export function isValSurrogateFingerprint(sourceId: string): boolean {
  return sourceId.startsWith(VAL_FINGERPRINT_PREFIX)
}
