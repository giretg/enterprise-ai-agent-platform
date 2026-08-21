/**
 * Per-conversation adatkulcs kezelés (APG-18, spec §6).
 *
 * A nyers adatkulcs tenant-kulccsal envelope-olt formában tárolódik (AES-256-GCM,
 * l. `aes-gcm-envelope`). Beszélgetés törlésekor a kulcs sor törlődik → crypto-shredding.
 */
import { createHash, randomBytes } from 'node:crypto'
import { openAesGcm, sealAesGcm } from '@/domain/privacy/aes-gcm-envelope'
import { resolveSecret } from '@/lib/crypto/secret-resolver'

const ROOT = resolveSecret(
  ['PRIVACY_VAL_ENCRYPTION_KEY', 'PRIVACY_SURROGATE_HMAC_KEY', 'WRITE_GATE_SECRET'],
  'dev-privacy-val-encryption-change-in-prod',
)

export function tenantValEncryptionKey(tenantId: string): Buffer {
  return createHash('sha256').update(`${ROOT}:${tenantId}:val-enc`).digest()
}

export function generateConversationDataKey(): Buffer {
  return randomBytes(32)
}

export function wrapConversationDataKey(tenantId: string, dataKey: Buffer): string {
  return sealAesGcm(tenantValEncryptionKey(tenantId), dataKey)
}

export function unwrapConversationDataKey(tenantId: string, wrapped: string): Buffer {
  return openAesGcm(tenantValEncryptionKey(tenantId), wrapped, 'conversation_privacy_key')
}

/**
 * Tartalék adatkulcs olyan scope-ra, amihez nincs `Conversation` sor (feladat-ticket
 * futás: a scope a ticket azonosítója). Determinisztikusan származtatott, ezért NEM
 * ad crypto-shreddinget — a titkosított másolat a `surrogate_map` sor törlésével
 * tűnik el. A korábbi viselkedés ennél rosszabb volt: a val-allokáció idegen kulcs
 * hibára futott, és a fail-closed szabály miatt a teljes modellhívás megállt.
 */
export function deriveScopeDataKey(tenantId: string, scopeType: string, scopeId: string): Buffer {
  return createHash('sha256')
    .update(`${ROOT}:${tenantId}:scope-data-key-v1:${scopeType}:${scopeId}`)
    .digest()
}
