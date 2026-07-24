/**
 * Csatorna-identitás titkosítás és kereső-hash (Telegram feature-spec #70/#72, D14/§64).
 *
 * A külső fiók-azonosító (Telegram numerikus user id) KÉT alakban él a `channel_identities`
 * sorban:
 *
 *  - `externalUserIdEnc` — a NYERS azonosító AES-256-GCM titkosítva (visszafejthető, de csak
 *    szerveroldalon, a titokkal). Az `oauth-state.ts` v2 encode-mintáját követi.
 *  - `lookupHash` — determinisztikus, kulcsolt HMAC-SHA256 (hex). Ez az EGYEDI kereső-kulcs
 *    (`@@unique([channelType, lookupHash])`), amivel a bejövő üzenet O(1)-ben megtalálja a
 *    kötést anélkül, hogy a nyers azonosítót indexelnénk. Determinisztikus, mert TÁROLÁSKOR és
 *    KERESÉSKOR ugyanabból a függvényből kell származnia (mint az agent-api-kulcs kereső-hash).
 *
 * Az audit ÁLNEVESÍTETT azonosítót lát (a `lookupHash` rövid prefixe), sosem a nyerset (§64).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto'
import { resolveSecret } from '@/lib/crypto/secret-resolver'

const IDENTITY_SECRET = resolveSecret(
  ['CHANNEL_IDENTITY_SECRET', 'WRITE_GATE_SECRET'],
  'dev-channel-identity-secret-change-in-prod',
)

function encryptionKey(): Buffer {
  return createHash('sha256').update(`${IDENTITY_SECRET}:enc`).digest()
}

/** A nyers külső azonosító titkosítása (AES-256-GCM, `oauth-state.ts` v2 minta). */
export function encryptExternalId(rawExternalId: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(rawExternalId, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.')
}

/** A titkosított külső azonosító visszafejtése (szerveroldalon, pl. audit-korreláció). */
export function decryptExternalId(enc: string): string {
  const parts = enc.split('.')
  const [, ivValue, ciphertextValue, tagValue] = parts
  if (parts[0] !== 'v1' || !ivValue || !ciphertextValue || !tagValue) {
    throw new Error('channel_identity: malformed ciphertext')
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivValue, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * Determinisztikus, kulcsolt kereső-hash a külső azonosítóra (hex, 64 kar). A `channelType`
 * bele van keverve, hogy a hash csatorna-scope-olt legyen. TÁROLÁS=KERESÉS invariáns.
 */
export function deriveChannelLookupHash(channelType: string, rawExternalId: string): string {
  return createHmac('sha256', IDENTITY_SECRET)
    .update(`${channelType}:${rawExternalId}`)
    .digest('hex')
}

/** Álnevesített azonosító az audithoz — a kereső-hash rövid prefixe (sosem a nyers id, §64). */
export function pseudonymFromLookupHash(lookupHash: string): string {
  return lookupHash.slice(0, 16)
}

/**
 * Álnevesített SZÁL-azonosító az audithoz (D4/#78 megőrzési takarítás). A külső chat-azonosító
 * determinisztikus, nem visszafejthető prefix-álneve — a nyers `externalThreadId` SOHA nem kerül
 * auditba (§64). A megőrzési takarítás nem igényel kereshetőséget a szálra, csak stabil álnevet,
 * ezért itt a `channelType`-pal kevert SHA-256 rövid prefixe elég (nem kell hozzá a titok).
 */
export function pseudonymFromExternalThreadId(channelType: string, externalThreadId: string): string {
  return createHash('sha256').update(`${channelType}:${externalThreadId}`).digest('hex').slice(0, 16)
}

/** Az injektálható identitás-kripto port a linking-szolgáltatásnak (teszt felülírhatja). */
export type ChannelIdentityCryptoPort = {
  encryptExternalId: (rawExternalId: string) => string
  deriveLookupHash: (channelType: string, rawExternalId: string) => string
}

export const defaultChannelIdentityCryptoPort: ChannelIdentityCryptoPort = {
  encryptExternalId,
  deriveLookupHash: deriveChannelLookupHash,
}
