/**
 * Hitelesítés a workerben.
 * - Böngésző: a platform által kiadott chat-token (HS256, `aud=platform-chat`). A folytatási tokent
 *   (`aud=platform-chat-turn`) a böngésző-API elutasítja — az csak MCP-re és gateway-tokenre jó.
 * - Cloud Tasks → worker: Google OIDC ID token (RS256), audience = a worker címe, a sor service accountja.
 * A token-formátum a platform `domain/platform-chat/chat-token.ts`-ével egyezik; kódot nem importálunk onnan (D7).
 */
import { createHmac, createPublicKey, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto'

export type ChatClaims = {
  aud: 'platform-chat' | 'platform-chat-turn'
  sub: string
  tenant: string
  tid: string
  role: 'admin' | 'approver' | 'operator' | 'viewer'
  adminInsight: boolean
  turnId?: string
  agentId?: string
  jti: string
  iat: number
  exp: number
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function verifyChatToken(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  audience: ChatClaims['aud'] = 'platform-chat',
): ChatClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [head, body, sig] = parts
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  if (!safeEqual(sig, expected)) return null
  if (decodeJson(head)?.alg !== 'HS256') return null
  const c = decodeJson(body) as ChatClaims | null
  if (!c || c.aud !== audience) return null
  if (typeof c.exp !== 'number' || c.exp <= nowSeconds) return null
  if (![c.sub, c.tenant, c.tid, c.role, c.jti].every((v) => typeof v === 'string' && v)) return null
  return c
}

export function bearer(header: string | undefined | null): string | null {
  return /^Bearer\s+(\S+)/i.exec(header?.trim() ?? '')?.[1] ?? null
}

// --- Google OIDC (Cloud Tasks) ---

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])
type Jwk = JsonWebKey & { kid?: string }
let jwksCache: { keys: Jwk[]; until: number } | null = null

async function googleKeys(fetchImpl: typeof fetch): Promise<Jwk[]> {
  if (jwksCache && jwksCache.until > Date.now()) return jwksCache.keys
  const res = await fetchImpl(GOOGLE_CERTS_URL)
  if (!res.ok) throw new Error(`google certs: ${res.status}`)
  const body = (await res.json()) as { keys: Jwk[] }
  jwksCache = { keys: body.keys, until: Date.now() + 3600_000 }
  return body.keys
}

/** true = érvényes Google ID token a megadott audience-re és service accountra. */
export async function verifyGoogleOidc(
  token: string,
  expected: { audience: string; email: string },
  opts: { fetchImpl?: typeof fetch; nowSeconds?: number; keys?: Jwk[] } = {},
): Promise<boolean> {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const header = decodeJson(parts[0])
  const claims = decodeJson(parts[1])
  if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') return false
  const keys = opts.keys ?? (await googleKeys(opts.fetchImpl ?? fetch))
  const jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) return false
  const ok = verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(parts[2], 'base64url'),
  )
  if (!ok) return false
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  return (
    GOOGLE_ISSUERS.has(String(claims.iss)) &&
    claims.aud === expected.audience &&
    claims.email === expected.email &&
    claims.email_verified === true &&
    typeof claims.exp === 'number' &&
    claims.exp > now
  )
}
