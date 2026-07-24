/**
 * Aláírt, a konkrét jóváhagyáshoz kötött, egyszer felhasználható gomb-payload
 * (Telegram feature-spec #70/#76, D5/D6/D14).
 *
 * A Telegram inline-gomb `callback_data`-ja legfeljebb 64 BÁJT. Egy önhordó, aláírt payload
 * (kötött mezők + 32 bájtos HMAC) ezt túllépné, ezért — a `channel-link-token.ts` mintáját
 * követve — a `callback_data` CSAK egy rövid, kitalálhatatlan `promptId`-t, a döntés-kódot és
 * egy CSONKÍTOTT aláírást hordoz; a teljes kötés (ticket, kapu, címzett) szerveroldalon, a
 * `channel_approval_prompts` sorban él.
 *
 * Az aláírás a `promptId` + döntés + a kötött mezők (ticketId, gateId, recipientIdentityId)
 * felett képződik, ezért egy adott gomb-payload EGY konkrét jóváhagyáshoz és EGY címzetthez
 * tartozik — más ticketre/kapura/címzettre nem játszható vissza (hamisítás-detektálás konstans
 * idejű vetéssel). Az EGYSZER-használatot a sor atomi `consume`-ja kényszeríti (verseny-biztos),
 * az aláírás pedig az integritást védi.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { resolveSecret } from '@/lib/crypto/secret-resolver'

const APPROVAL_TOKEN_SECRET = resolveSecret(
  ['CHANNEL_APPROVAL_TOKEN_SECRET', 'WRITE_GATE_SECRET'],
  'dev-channel-approval-token-secret-change-in-prod',
)

/** A gomb két lehetséges döntése. `needs_info` SZÁNDÉKOSAN nincs — az nem egy-koppintásos gomb. */
export type ApprovalAction = 'approve' | 'reject'

/** A rövid döntés-kód a `callback_data`-ban (1 karakter, hogy beférjen a 64 bájtba). */
const ACTION_CODE: Record<ApprovalAction, string> = { approve: 'a', reject: 'r' }
const CODE_ACTION: Record<string, ApprovalAction> = { a: 'approve', r: 'reject' }

/** A `callback_data` prefixe — egyértelműen megkülönbözteti a jóváhagyó-gombot más frissítésektől. */
const CALLBACK_PREFIX = 'apv'

/** A csonkított aláírás hossza a payloadban (base64url karakter). 20 kar ≈ 120 bit — bőven elég. */
const SIG_LEN = 20

/** A gomb-payload kötött mezői. Az aláírás EZEK felett képződik. */
export type ApprovalTokenClaims = {
  promptId: string
  action: ApprovalAction
  ticketId: string
  /** A kapu azonosítója (ha van); a `null` üres stringgé kanonizálódik. */
  gateId: string | null
  /** A CÍMZETT csatorna-identitása — a gomb ehhez a címzetthez van kötve. */
  recipientIdentityId: string
}

/**
 * Kanonikus, egyértelmű szerializáció az aláíráshoz — `\n`-nel tagolt mezők, a `null`
 * üres stringként (mint a `channel-link-token.ts`). A UUID-k és az enum nem tartalmaznak `\n`-t.
 */
function canonical(claims: ApprovalTokenClaims): string {
  return [
    'channel-approval-v1',
    claims.promptId,
    claims.action,
    claims.ticketId,
    claims.gateId ?? '',
    claims.recipientIdentityId,
  ].join('\n')
}

/** A kötött mezők HMAC-aláírása (base64url), csonkítva a `callback_data` méretkorlátjához. */
export function signApprovalClaims(claims: ApprovalTokenClaims): string {
  return createHmac('sha256', APPROVAL_TOKEN_SECRET)
    .update(canonical(claims))
    .digest('base64url')
    .slice(0, SIG_LEN)
}

/** Új, kitalálhatatlan `promptId` (~22 base64url karakter). A `callback_data` kulcsa. */
export function newApprovalPromptId(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * A gomb `callback_data`-ja: `apv.<promptId>.<kód>.<aláírás>`. Garantáltan 64 bájt alatt
 * (prefix 3 + promptId ~22 + kód 1 + aláírás 20 + 3 pont ≈ 49).
 */
export function buildCallbackData(claims: ApprovalTokenClaims): string {
  return [CALLBACK_PREFIX, claims.promptId, ACTION_CODE[claims.action], signApprovalClaims(claims)].join('.')
}

export type ParsedCallbackData = {
  promptId: string
  action: ApprovalAction
  signature: string
}

/**
 * A `callback_data` biztonságos szétszedése — CSAK a formátumot ellenőrzi (bejövő adat, nem
 * parancs, D15). Az aláírás ÉRVÉNYESSÉGÉT nem itt, hanem a szolgáltatás a kötött mezők
 * ismeretében (a sorból) veti össze. Ismeretlen alak → `null`.
 */
export function parseCallbackData(data: string | null | undefined): ParsedCallbackData | null {
  if (!data) return null
  const parts = data.split('.')
  if (parts.length !== 4) return null
  const [prefix, promptId, code, signature] = parts
  if (prefix !== CALLBACK_PREFIX) return null
  const action = CODE_ACTION[code]
  if (!action) return null
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(promptId)) return null
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(signature)) return null
  return { promptId, action, signature }
}

/**
 * A gomb-payload aláírásának KONSTANS IDEJŰ ellenőrzése a sorból ismert kötött mezők felett
 * (hamisítás-detektálás). A hossz-eltérés is `false`, de a `timingSafeEqual` egyenlő hosszú
 * bufferekre fut (ne dobjon) — ugyanaz a minta, mint a `channel-link-token.ts`.
 */
export function verifyApprovalSignature(claims: ApprovalTokenClaims, signature: string): boolean {
  const expected = Buffer.from(signApprovalClaims(claims))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/** Az injektálható token-port a jóváhagyó-szolgáltatásnak (teszt felülírhatja). */
export type ChannelApprovalTokenPort = {
  newPromptId: () => string
  buildCallbackData: (claims: ApprovalTokenClaims) => string
  parseCallbackData: (data: string | null | undefined) => ParsedCallbackData | null
  verify: (claims: ApprovalTokenClaims, signature: string) => boolean
}

export const defaultChannelApprovalTokenPort: ChannelApprovalTokenPort = {
  newPromptId: newApprovalPromptId,
  buildCallbackData,
  parseCallbackData,
  verify: verifyApprovalSignature,
}
