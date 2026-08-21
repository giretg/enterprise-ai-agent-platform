/**
 * AES-256-GCM boríték a privacy-titkokhoz (APG-18, spec §6).
 *
 * Egyetlen `v1.iv.ct.tag` formátum a per-conversation adatkulcs becsomagolására
 * ÉS a val-surrogate értékmásolatra. Azért közös, mert két külön másolat esetén
 * a formátum elcsúszhat, és a titkosított adat visszafejthetetlenné válik —
 * beszélgetés-történet, amit a jogos tulajdonosa sem tud többé elolvasni.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ENVELOPE_VERSION = 'v1'

export function sealAesGcm(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.')
}

export function openAesGcm(key: Buffer, envelope: string, context: string): Buffer {
  const parts = envelope.split('.')
  const [version, ivValue, ciphertextValue, tagValue] = parts
  if (version !== ENVELOPE_VERSION || !ivValue || !ciphertextValue || !tagValue) {
    throw new Error(`${context}: malformed ciphertext`)
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, 'base64url')), decipher.final()])
}
