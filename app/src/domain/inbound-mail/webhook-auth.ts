/**
 * #1032 webhook-hitelesítés: AgentMail (Svix-aláírás), Gmail Pub/Sub push (Google OIDC ID token),
 * Microsoft Graph (clientState). Hálózat csak a Google-kulcsok letöltéséhez kell (injektálható).
 */
import { createHmac, createPublicKey, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto'

/** Svix: ennyi másodpercnél régebbi / jövőbeli kérés visszajátszásnak számít. */
export const SVIX_TOLERANCE_SECONDS = 5 * 60

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Svix-aláírás (`svix-id`, `svix-timestamp`, `svix-signature: v1,<base64> …`): HMAC-SHA256 a
 * `whsec_` utáni base64 kulccsal a `${id}.${timestamp}.${body}` szövegen.
 */
export function verifySvixSignature(input: {
  secret: string
  id: string | null
  timestamp: string | null
  signature: string | null
  body: string
  nowSeconds?: number
}): boolean {
  const { id, timestamp, signature } = input
  if (!id || !timestamp || !signature || !input.secret) return false
  const ts = Number(timestamp)
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (!Number.isInteger(ts) || Math.abs(now - ts) > SVIX_TOLERANCE_SECONDS) return false
  const key = Buffer.from(input.secret.replace(/^whsec_/, ''), 'base64')
  if (key.length === 0) return false
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${input.body}`).digest('base64')
  return signature
    .split(' ')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1,'))
    .some((part) => safeEqual(part.slice(3), expected))
}

/** Teszthez / saját aláíráshoz: ugyanaz a séma, mint amit ellenőrzünk. */
export function signSvix(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`
}

export function clientStateMatches(expected: string | null | undefined, provided: unknown): boolean {
  return typeof expected === 'string' && expected.length > 0 && typeof provided === 'string' && safeEqual(provided, expected)
}

// --- Google OIDC (Pub/Sub push) ---

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])
export type GoogleJwk = JsonWebKey & { kid?: string }
let jwksCache: { keys: GoogleJwk[]; until: number } | null = null

async function googleKeys(fetchImpl: typeof fetch): Promise<GoogleJwk[]> {
  if (jwksCache && jwksCache.until > Date.now()) return jwksCache.keys
  const res = await fetchImpl(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(5_000) })
  if (!res.ok) throw new Error(`google certs: ${res.status}`)
  const body = (await res.json()) as { keys: GoogleJwk[] }
  jwksCache = { keys: body.keys, until: Date.now() + 3600_000 }
  return body.keys
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** true = érvényes Google ID token a megadott audience-re és (push) service accountra. */
export async function verifyGoogleOidcToken(
  token: string,
  expected: { audience: string; email: string },
  opts: { fetchImpl?: typeof fetch; nowSeconds?: number; keys?: GoogleJwk[] } = {},
): Promise<boolean> {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const header = decodeJson(parts[0])
  const claims = decodeJson(parts[1])
  if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') return false
  const keys = opts.keys ?? (await googleKeys(opts.fetchImpl ?? fetch))
  const jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) return false
  let ok = false
  try {
    ok = verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'),
    )
  } catch {
    return false
  }
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
