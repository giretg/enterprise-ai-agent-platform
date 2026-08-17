import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto'
import type { OAuthReturnTo } from '@/domain/connector-grant/connector-grant-needed'
import { isSafeOAuthReturnTo } from '@/domain/connector-grant/connector-grant-needed'
import { resolveSecret } from './secret-resolver'

const OAUTH_STATE_SECRET = resolveSecret(
  ['OAUTH_STATE_SECRET', 'WRITE_GATE_SECRET'],
  'dev-oauth-state-secret-change-in-prod',
)

const STATE_TTL_MS = 10 * 60 * 1000 // 10 perc

export type OAuthStatePayload = {
  userId: string
  connectorId: string
  tenantId: string | null
  requestedScopes?: string[]
  codeVerifier: string
  expiresAt: number
  /** Chat/ticket folytatás OAuth után — csak kind + uuid, nem nyers URL. */
  returnTo?: OAuthReturnTo
}

function signPayload(payload: string): string {
  return createHmac('sha256', OAUTH_STATE_SECRET).update(payload).digest('hex')
}

function encryptionKey(): Buffer {
  return createHash('sha256').update(OAUTH_STATE_SECRET).digest()
}

function encodeJson(payload: OAuthStatePayload): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return [
    'v2',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.')
}

function decodeEncryptedState(parts: string[]): OAuthStatePayload {
  const [, ivValue, ciphertextValue, tagValue] = parts
  if (!ivValue || !ciphertextValue || !tagValue) throw new Error('oauth_state: malformed')

  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivValue, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  const raw = Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
  return JSON.parse(raw) as OAuthStatePayload
}

function decodeLegacySignedState(parts: string[]): OAuthStatePayload {
  const [encoded, signature] = parts
  if (!encoded || !signature) throw new Error('oauth_state: malformed')
  const expected = Buffer.from(signPayload(encoded))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('oauth_state: signature invalid')
  }
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OAuthStatePayload
}

export function createOAuthState(params: {
  userId: string
  connectorId: string
  tenantId: string | null
  requestedScopes?: string[]
  returnTo?: OAuthReturnTo
}): { state: string; codeVerifier: string } {
  const codeVerifier = randomBytes(32).toString('base64url')
  const payload: OAuthStatePayload = {
    userId: params.userId,
    connectorId: params.connectorId,
    tenantId: params.tenantId,
    requestedScopes: params.requestedScopes,
    codeVerifier,
    expiresAt: Date.now() + STATE_TTL_MS,
    ...(params.returnTo && isSafeOAuthReturnTo(params.returnTo) ? { returnTo: params.returnTo } : {}),
  }
  return { state: encodeJson(payload), codeVerifier }
}

export function verifyOAuthState(state: string): OAuthStatePayload {
  const parts = state.split('.')
  const payload = parts[0] === 'v2'
    ? decodeEncryptedState(parts)
    : decodeLegacySignedState(parts)
  if (Date.now() > payload.expiresAt) throw new Error('oauth_state: expired')
  return payload
}

export function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url')
}
