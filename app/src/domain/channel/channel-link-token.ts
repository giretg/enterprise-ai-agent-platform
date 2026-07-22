/**
 * Aláírt, rövid élettartamú, egyszer felhasználható deep-link összekötő token
 * (Telegram feature-spec #70/#72, D12).
 *
 * A token BELE van kötve a szervezetbe, a felhasználóba és a lejáratba, és HMAC-SHA256-tal
 * aláírt — a beváltó oldal az aláírást KONSTANS IDŐVEL veti össze (timingSafeEqual), a
 * lejáratot és az egyszer-használatot külön ellenőrzi.
 *
 * Telegram-korlát: a `start` mélylink-paraméter legfeljebb 64 karakter és csak
 * `[A-Za-z0-9_-]`. Egy önhordó, aláírt token (payload + 32 bájtos HMAC) ezt túllépné, ezért
 * a MÉLYLINK CSAK a rövid, kitalálhatatlan `jti`-t hordozza; az aláírt kötés (mezők +
 * `signature`) szerveroldalon, a `channel_link_tokens` sorban él. Ez a write-gate token
 * `tokenHash`+`signature` mintáját követi: a sor a hiteles, az aláírás a hamisítás-detektor.
 *
 * Az aláírás-minta a `preview-token.ts` / `oauth-state.ts` konvencióját tükrözi
 * (createHmac + base64url + timingSafeEqual).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import type { ChannelType } from '@prisma/client'
import { resolveSecret } from '@/lib/crypto/secret-resolver'

const LINK_TOKEN_SECRET = resolveSecret(
  ['CHANNEL_LINK_TOKEN_SECRET', 'WRITE_GATE_SECRET'],
  'dev-channel-link-token-secret-change-in-prod',
)

/** Rövid életű: 15 perc (D12 — „rövid élettartamú"; egy véletlenül továbbküldött link ablaka szűk). */
export const LINK_TOKEN_TTL_MS = 15 * 60 * 1000

/** A kötés aláírt, kanonikus mezői. Az aláírás EZEK felett képződik. */
export type ChannelLinkTokenClaims = {
  jti: string
  channelType: ChannelType
  userId: string
  tenantId: string | null
}

/**
 * Kanonikus, egyértelmű szerializáció az aláíráshoz — a mezőket `\n`-nel tagoljuk, és a
 * `tenantId` null-t üres stringgé tesszük, hogy ne legyen kétértelmű határ. (A UUID-k és az
 * enum nem tartalmaznak `\n`-t.)
 */
function canonical(claims: ChannelLinkTokenClaims): string {
  return [
    'channel-link-v1',
    claims.jti,
    claims.channelType,
    claims.userId,
    claims.tenantId ?? '',
  ].join('\n')
}

/** A kötött mezők HMAC-aláírása (base64url). */
export function signLinkClaims(claims: ChannelLinkTokenClaims): string {
  return createHmac('sha256', LINK_TOKEN_SECRET).update(canonical(claims)).digest('base64url')
}

/** Új, kitalálhatatlan `jti` (a mélylink `start` paramétere). ~27 base64url karakter, <64. */
export function newLinkJti(): string {
  return randomBytes(20).toString('base64url')
}

/**
 * A kötött mezők aláírásának KONSTANS IDEJŰ ellenőrzése (hamisítás-detektálás). A hossz-eltérés
 * is `false`, de a `timingSafeEqual` egyenlő hosszú bufferekre fut (ne dobjon). Ugyanaz a minta,
 * mint a `preview-token.ts` / `oauth-state.ts`.
 */
export function verifyLinkSignature(
  claims: ChannelLinkTokenClaims,
  signature: string,
): boolean {
  const expected = Buffer.from(signLinkClaims(claims))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/** A Telegram `start` paraméter formátum-őre: `[A-Za-z0-9_-]{1,64}` (D15 — bejövő adat, nem parancs). */
export function isValidStartParam(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

/** Az injektálható token-port a linking-szolgáltatásnak (teszt felülírhatja). */
export type ChannelLinkTokenPort = {
  newJti: () => string
  sign: (claims: ChannelLinkTokenClaims) => string
  verify: (claims: ChannelLinkTokenClaims, signature: string) => boolean
  ttlMs: number
}

export const defaultChannelLinkTokenPort: ChannelLinkTokenPort = {
  newJti: newLinkJti,
  sign: signLinkClaims,
  verify: verifyLinkSignature,
  ttlMs: LINK_TOKEN_TTL_MS,
}
