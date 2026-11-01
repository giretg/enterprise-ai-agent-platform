/**
 * Négy szem a prompt-napló tartalmának olvasásához (#759 / §14).
 *
 * A metaadat-lista egy admin Clerk-munkamenettel olvasható. A visszafejtett tartalomhoz
 * két, egymástól különböző tenant-admin kell: A kér egy kéréstokent, B (bejelentkezve)
 * jóváhagyja, a grant csak A vagy B GET-jén érvényes. Nincs új tábla — rövid életű HMAC-JWT.
 */
import { createHmac } from 'node:crypto'
import { safeSecretEquals } from '@/lib/crypto/timing-safe'

export const UNLOCK_REQUEST_TTL_SECONDS = 30 * 60
export const CONTENT_GRANT_TTL_SECONDS = 15 * 60

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type UnlockRequestClaims = {
  typ: 'ai_audit_unlock_req'
  tenantId: string
  requesterId: string
  iat: number
  exp: number
}

export type ContentGrantClaims = {
  typ: 'ai_audit_content_grant'
  tenantId: string
  requesterId: string
  approverId: string
  iat: number
  exp: number
}

export type GrantFailureCode = 'invalid_token' | 'same_actor' | 'tenant_mismatch' | 'not_party'

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')

function sign(payload: object, key: string): string {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64u(JSON.stringify(payload))
  return `${head}.${body}.${createHmac('sha256', key).update(`${head}.${body}`).digest('base64url')}`
}

function verify<T extends { typ: string; exp: number }>(
  token: string,
  key: string,
  typ: T['typ'],
  nowSeconds: number,
): T | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [head, body, sig] = parts
  const expected = createHmac('sha256', key).update(`${head}.${body}`).digest('base64url')
  if (!safeSecretEquals(sig, expected)) return null
  try {
    if (JSON.parse(Buffer.from(head, 'base64url').toString()).alg !== 'HS256') return null
    const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as T
    if (c.typ !== typ || typeof c.exp !== 'number' || c.exp <= nowSeconds) return null
    return c
  } catch {
    return null
  }
}

function seconds(now?: Date): number {
  return Math.floor((now ?? new Date()).getTime() / 1000)
}

export function issueUnlockRequest(
  key: string,
  input: { tenantId: string; requesterId: string; now?: Date },
): string {
  const iat = seconds(input.now)
  return sign(
    {
      typ: 'ai_audit_unlock_req',
      tenantId: input.tenantId,
      requesterId: input.requesterId,
      iat,
      exp: iat + UNLOCK_REQUEST_TTL_SECONDS,
    } satisfies UnlockRequestClaims,
    key,
  )
}

export function approveUnlockRequest(
  key: string,
  requestToken: string,
  input: { tenantId: string; approverId: string; now?: Date },
): { ok: true; token: string } | { ok: false; code: GrantFailureCode } {
  const now = seconds(input.now)
  const req = verify<UnlockRequestClaims>(requestToken, key, 'ai_audit_unlock_req', now)
  if (!req) return { ok: false, code: 'invalid_token' }
  if (req.tenantId !== input.tenantId) return { ok: false, code: 'tenant_mismatch' }
  if (req.requesterId === input.approverId) return { ok: false, code: 'same_actor' }
  if (!UUID_RE.test(req.requesterId) || !UUID_RE.test(input.approverId)) {
    return { ok: false, code: 'invalid_token' }
  }
  const iat = now
  return {
    ok: true,
    token: sign(
      {
        typ: 'ai_audit_content_grant',
        tenantId: req.tenantId,
        requesterId: req.requesterId,
        approverId: input.approverId,
        iat,
        exp: iat + CONTENT_GRANT_TTL_SECONDS,
      } satisfies ContentGrantClaims,
      key,
    ),
  }
}

export function verifyContentGrant(
  key: string,
  grantToken: string | null | undefined,
  input: { tenantId: string; readerId: string; now?: Date },
): { ok: true; grant: ContentGrantClaims } | { ok: false; code: GrantFailureCode } {
  if (!grantToken) return { ok: false, code: 'invalid_token' }
  const grant = verify<ContentGrantClaims>(grantToken, key, 'ai_audit_content_grant', seconds(input.now))
  if (!grant) return { ok: false, code: 'invalid_token' }
  if (grant.tenantId !== input.tenantId) return { ok: false, code: 'tenant_mismatch' }
  if (grant.requesterId !== input.readerId && grant.approverId !== input.readerId) {
    return { ok: false, code: 'not_party' }
  }
  return { ok: true, grant }
}
