/**
 * Val-surrogate titkosított értékmásolat (APG-18, spec §6).
 *
 * Kulcs: tenant-kulcs + per-conversation adatkulcs (double-envelope deriváció).
 * A boríték-formátum a közös `aes-gcm-envelope` modulé.
 */
import { createHash } from 'node:crypto'
import { openAesGcm, sealAesGcm } from '@/domain/privacy/aes-gcm-envelope'
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
  return sealAesGcm(valPayloadKey(tenantId, dataKey), Buffer.from(plaintext, 'utf8'))
}

export function decryptValSurrogateValue(
  tenantId: string,
  dataKey: Buffer,
  encrypted: string,
): string {
  return openAesGcm(valPayloadKey(tenantId, dataKey), encrypted, 'val_surrogate').toString('utf8')
}
