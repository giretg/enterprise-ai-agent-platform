/**
 * Rövid életű, aláírt preview token (Feature-spec — App Registry §4.5, §6.1).
 *
 * A token NEM hordoz platform sessiont — kizárólag a
 * `tenantId + appId + version + contentHash` (+ opcionális requester user)
 * kombinációra érvényes, HMAC-SHA256-tal aláírva, lejárattal. Így a preview
 * origin cookie/token nélkül, csak a token alapján szolgálhat ki artefaktot, és
 * a tartalom megváltozása (contentHash eltérés) érvényteleníti.
 *
 * Az aláírás-minta az oauth-state.ts-ével konzisztens (createHmac + base64url +
 * timingSafeEqual). A `u` mező a megjelenítési álnév-feloldáshoz kell
 * (APG-08 participant), nem session-cookie pótlék.
 */
import { createHmac, timingSafeEqual } from 'crypto'
import { resolveSecret } from '@/lib/crypto/secret-resolver'

const PREVIEW_SECRET = resolveSecret(
  ['SANDBOX_PREVIEW_SECRET', 'WRITE_GATE_SECRET'],
  'dev-sandbox-preview-secret-change-in-prod',
)

export const PREVIEW_TOKEN_TTL_MS = 10 * 60 * 1000 // 10 perc (§4.5: rövid életű)

export type PreviewTokenPayload = {
  /** tenant izoláció — null = globális (tenant nélküli) app */
  t: string | null
  /** appId */
  a: string
  /** version */
  v: number
  /** content hash (integritás-pecsét) */
  h: string
  /** lejárat epoch ms */
  exp: number
  /**
   * Opcionális requester userId — HTML álnév-feloldáshoz a cookieless
   * preview route-on (APG-08). Hiányzik → a HTML feloldatlanul megy ki.
   */
  u?: string
}

export class PreviewTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreviewTokenError'
  }
}

function sign(encoded: string): string {
  return createHmac('sha256', PREVIEW_SECRET).update(encoded).digest('base64url')
}

export function signPreviewToken(params: {
  tenantId: string | null
  appId: string
  version: number
  contentHash: string
  expiresAt: number
  requesterUserId?: string | null
}): string {
  const payload: PreviewTokenPayload = {
    t: params.tenantId,
    a: params.appId,
    v: params.version,
    h: params.contentHash,
    exp: params.expiresAt,
    ...(params.requesterUserId ? { u: params.requesterUserId } : {}),
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${encoded}.${sign(encoded)}`
}

export function verifyPreviewToken(token: string, now = Date.now()): PreviewTokenPayload {
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature) throw new PreviewTokenError('preview token malformed')

  const expected = Buffer.from(sign(encoded))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new PreviewTokenError('preview token signature invalid')
  }

  let payload: PreviewTokenPayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as PreviewTokenPayload
  } catch {
    throw new PreviewTokenError('preview token payload invalid')
  }

  if (typeof payload.exp !== 'number' || payload.exp < now) {
    throw new PreviewTokenError('preview token expired')
  }
  if (payload.u != null && (typeof payload.u !== 'string' || !payload.u)) {
    throw new PreviewTokenError('preview token requester invalid')
  }
  return payload
}
