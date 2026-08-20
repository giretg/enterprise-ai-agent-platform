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
