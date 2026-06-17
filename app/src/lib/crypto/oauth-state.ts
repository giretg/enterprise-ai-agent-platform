import { createHash, createHmac, randomBytes } from 'crypto'

const OAUTH_STATE_SECRET =
  process.env.OAUTH_STATE_SECRET ?? process.env.WRITE_GATE_SECRET ?? 'dev-oauth-state-secret-change-in-prod'

const STATE_TTL_MS = 10 * 60 * 1000 // 10 perc

export type OAuthStatePayload = {
  userId: string
  connectorId: string
  tenantId: string | null
  codeVerifier: string
  expiresAt: number
}

function signPayload(payload: string): string {
  return createHmac('sha256', OAUTH_STATE_SECRET).update(payload).digest('hex')
}

export function createOAuthState(params: {
  userId: string
  connectorId: string
  tenantId: string | null
}): { state: string; codeVerifier: string } {
  const codeVerifier = randomBytes(32).toString('base64url')
  const payload: OAuthStatePayload = {
    userId: params.userId,
    connectorId: params.connectorId,
    tenantId: params.tenantId,
    codeVerifier,
    expiresAt: Date.now() + STATE_TTL_MS,
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = signPayload(encoded)
  return { state: `${encoded}.${signature}`, codeVerifier }
}

export function verifyOAuthState(state: string): OAuthStatePayload {
  const [encoded, signature] = state.split('.')
  if (!encoded || !signature) throw new Error('oauth_state: malformed')
  const expected = signPayload(encoded)
  if (expected !== signature) throw new Error('oauth_state: signature invalid')
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OAuthStatePayload
  if (Date.now() > payload.expiresAt) throw new Error('oauth_state: expired')
  return payload
}

export function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url')
}
