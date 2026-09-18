/**
 * Megjelenítési érték titkosítása a surrogate-sorhoz (spec §5 R19, §6).
 *
 * A ref-surrogate maga NEM tárol nyers értéket — a `(connectorId, sourceId)`
 * referencia a forrás felé mutat. A trusted UI feloldásához viszont kell a
 * beszélgetésben egyszer már látott megjelenítési érték: enélkül a beszélgetés
 * újranyitása (vagy egy másik szerverpéldány) után a felhasználó `[[COMPANY_1]]`-et
 * lát a cégnév helyett, és a következő fordulóban ugyanaz a név nyersen megy ki
 * a modellhez, mert az ismert-érték szótár üres.
 *
 * Ezért a megjelenítési másolat KÜLÖN oszlopban, a per-conversation adatkulccsal
 * titkosítva él (crypto-shredding: a beszélgetés törlésekor a kulcs eltűnik). A
 * kulcs a scope-hoz ÉS az álnévhez van kötve, így egy másik sorba átmásolt
 * titkosított érték nem fejthető vissza.
 */
import { createHash } from 'node:crypto'
import { openAesGcm, sealAesGcm } from '@/domain/privacy/aes-gcm-envelope'
import { tenantValEncryptionKey } from '@/domain/privacy/conversation-privacy-key-crypto'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'

export type SurrogateDisplaySource = 'structured_field' | 'scanner'

export type SurrogateDisplayPayload = {
  value: string
  source: SurrogateDisplaySource
}

function displayPayloadKey(
  tenantId: string,
  dataKey: Buffer,
  scope: PrivacyScope,
  surrogate: string,
): Buffer {
  return createHash('sha256')
    .update(
      Buffer.concat([
        tenantValEncryptionKey(tenantId),
        dataKey,
        Buffer.from(`display-v1:${scope.type}:${scope.id}:${surrogate}`, 'utf8'),
      ]),
    )
    .digest()
}

export function encryptSurrogateDisplayValue(input: {
  tenantId: string
  dataKey: Buffer
  scope: PrivacyScope
  surrogate: string
  payload: SurrogateDisplayPayload
}): string {
  return sealAesGcm(
    displayPayloadKey(input.tenantId, input.dataKey, input.scope, input.surrogate),
    Buffer.from(JSON.stringify(input.payload), 'utf8'),
  )
}

/** Hibás/idegen ciphertext → `null`: a feloldás kimarad, nem dob. */
export function decryptSurrogateDisplayValue(input: {
  tenantId: string
  dataKey: Buffer
  scope: PrivacyScope
  surrogate: string
  encrypted: string
}): SurrogateDisplayPayload | null {
  try {
    const raw = openAesGcm(
      displayPayloadKey(input.tenantId, input.dataKey, input.scope, input.surrogate),
      input.encrypted,
      'surrogate_display_value',
    ).toString('utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as { value?: unknown; source?: unknown }
    if (typeof record.value !== 'string' || record.value.length === 0) return null
    const source: SurrogateDisplaySource =
      record.source === 'structured_field' ? 'structured_field' : 'scanner'
    return { value: record.value, source }
  } catch {
    return null
  }
}
