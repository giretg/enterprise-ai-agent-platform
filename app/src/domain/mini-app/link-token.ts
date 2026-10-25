/**
 * Mini app gyors link (#967 §5.3, §5.3.1) — a legacy `preview-token.ts` mintája.
 *
 * Önhordó, HMAC-SHA256-tal aláírt token: `tenantId + appId + version + contentHash +
 * lejárat + kérő userId`. Platform-sessiont nem hordoz; a megnyitó route cookie-t
 * nem olvas. Lejárt, de hiteles tokenből az appId kiolvasható (a lejárt-oldal
 * „Megnyitás a platformon" gombjához) — a jogosultságot ott a bejelentkezés adja.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { resolveSecret } from '@/lib/crypto/secret-resolver'

export type MiniAppLinkPayload = {
  /** tenantId */
  t: string
  /** appId */
  a: string
  /** version */
  v: number
  /** contentHash */
  h: string
  /** lejárat epoch ms */
  exp: number
  /** kérő userId (álnév-feloldáshoz, audithoz) */
  u?: string
}

export type MiniAppLinkVerdict =
  | { ok: true; payload: MiniAppLinkPayload }
  | { ok: false; reason: 'expired'; payload: MiniAppLinkPayload }
  | { ok: false; reason: 'invalid' }

let cachedSecret: string | null = null
function secret(): string {
  // Lusta feloldás: prod alatt a resolver hiányzó titoknál dob — ne import-időben.
  cachedSecret ??= resolveSecret(
    ['MINI_APP_LINK_SECRET', 'WRITE_GATE_SECRET'],
    'dev-mini-app-link-secret-change-in-prod',
  )
  return cachedSecret
}

function sign(encoded: string): string {
  return createHmac('sha256', secret()).update(`mini-app-link:${encoded}`).digest('base64url')
}

export function signMiniAppLink(input: {
  tenantId: string
  appId: string
  version: number
  contentHash: string
  expiresAt: number
  requesterUserId?: string | null
}): string {
  const payload: MiniAppLinkPayload = {
    t: input.tenantId,
    a: input.appId,
    v: input.version,
    h: input.contentHash,
    exp: input.expiresAt,
    ...(input.requesterUserId ? { u: input.requesterUserId } : {}),
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${encoded}.${sign(encoded)}`
}

function isPayload(value: unknown): value is MiniAppLinkPayload {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return (
    typeof p.t === 'string' &&
    typeof p.a === 'string' &&
    typeof p.v === 'number' &&
    Number.isInteger(p.v) &&
    typeof p.h === 'string' &&
    typeof p.exp === 'number' &&
    (p.u === undefined || (typeof p.u === 'string' && p.u.length > 0))
  )
}

export function verifyMiniAppLink(token: string, now = Date.now()): MiniAppLinkVerdict {
  if (typeof token !== 'string' || token.length > 2048) return { ok: false, reason: 'invalid' }
  const [encoded, signature, extra] = token.split('.')
  if (!encoded || !signature || extra !== undefined) return { ok: false, reason: 'invalid' }
  const expected = Buffer.from(sign(encoded))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'invalid' }
  }
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (!isPayload(payload)) return { ok: false, reason: 'invalid' }
  if (payload.exp < now) return { ok: false, reason: 'expired', payload }
  return { ok: true, payload }
}
