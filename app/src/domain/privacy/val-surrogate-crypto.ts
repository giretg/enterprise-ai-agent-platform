/**
 * Val-surrogate titkosított értékmásolat (APG-18, spec §6).
 *
 * Kulcs: tenant-kulcs + per-conversation adatkulcs (double-envelope deriváció).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { tenantValEncryptionKey } from '@/domain/privacy/conversation-privacy-key-crypto'

function valPayloadKey(tenantId: string, dataKey: Buffer): Buffer {
  return createHash('sha256')
    .update(Buffer.concat([tenantValEncryptionKey(tenantId), dataKey, Buffer.from('val-surrogate-v1')]))
    .digest()
}

export function encryptValSurrogateValue(
  tenantId: string,
  dataKey: Buffer,
  plaintext: string,
): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', valPayloadKey(tenantId, dataKey), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.')
}

export function decryptValSurrogateValue(
  tenantId: string,
  dataKey: Buffer,
  encrypted: string,
): string {
  const parts = encrypted.split('.')
  const [, ivValue, ciphertextValue, tagValue] = parts
  if (parts[0] !== 'v1' || !ivValue || !ciphertextValue || !tagValue) {
    throw new Error('val_surrogate: malformed ciphertext')
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    valPayloadKey(tenantId, dataKey),
    Buffer.from(ivValue, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}
