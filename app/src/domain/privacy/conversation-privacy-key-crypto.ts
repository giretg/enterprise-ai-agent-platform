/**
 * Per-conversation adatkulcs kezelés (APG-18, spec §6).
 *
 * A nyers adatkulcs tenant-kulccsal envelope-olt formában tárolódik (AES-256-GCM).
 * Beszélgetés törlésekor a kulcs sor törlődik → crypto-shredding.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
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
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', tenantValEncryptionKey(tenantId), iv)
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.')
}

export function unwrapConversationDataKey(tenantId: string, wrapped: string): Buffer {
  const parts = wrapped.split('.')
  const [, ivValue, ciphertextValue, tagValue] = parts
  if (parts[0] !== 'v1' || !ivValue || !ciphertextValue || !tagValue) {
    throw new Error('conversation_privacy_key: malformed ciphertext')
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    tenantValEncryptionKey(tenantId),
    Buffer.from(ivValue, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ])
}
