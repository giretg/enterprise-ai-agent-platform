/**
 * OBSERVE mód UI-előnézet perzisztencia (APG-22).
 *
 * A vault-soroktól külön tároljuk a megfigyelt entitásértékeket, hogy a chat
 * újranyitásakor is kiemelhető legyen, mit tokenizáltunk volna — anélkül, hogy
 * a `[[COMPANY_1]]` előnézet-álnevek ütköznének egy későbbi ENFORCE allokációval.
 */
import { createHash } from 'node:crypto'
import { openAesGcm, sealAesGcm } from '@/domain/privacy/aes-gcm-envelope'
import { tenantValEncryptionKey } from '@/domain/privacy/conversation-privacy-key-crypto'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'

function observePreviewPayloadKey(
  tenantId: string,
  dataKey: Buffer,
  scope: PrivacyScope,
  entityType: string,
  fingerprint: string,
): Buffer {
  return createHash('sha256')
    .update(
      Buffer.concat([
        tenantValEncryptionKey(tenantId),
        dataKey,
        Buffer.from(
          `observe-preview-v1:${scope.type}:${scope.id}:${entityType}:${fingerprint}`,
          'utf8',
        ),
      ]),
    )
    .digest()
}

export function encryptObservePreviewValue(input: {
  tenantId: string
  dataKey: Buffer
  scope: PrivacyScope
  entityType: string
  fingerprint: string
  value: string
}): string {
  return sealAesGcm(
    observePreviewPayloadKey(
      input.tenantId,
      input.dataKey,
      input.scope,
      input.entityType,
      input.fingerprint,
    ),
    Buffer.from(input.value, 'utf8'),
  )
}

export function decryptObservePreviewValue(input: {
  tenantId: string
  dataKey: Buffer
  scope: PrivacyScope
  entityType: string
  fingerprint: string
  encrypted: string
}): string | null {
  try {
    const raw = openAesGcm(
      observePreviewPayloadKey(
        input.tenantId,
        input.dataKey,
        input.scope,
        input.entityType,
        input.fingerprint,
      ),
      input.encrypted,
      'observe_preview_value',
    ).toString('utf8')
    return raw.length > 0 ? raw : null
  } catch {
    return null
  }
}
