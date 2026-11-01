/**
 * Platform-chat tokenek (#1004 §3, §7). HS256, közös titok a platform és a worker között
 * (`PLATFORM_CHAT_TOKEN_SECRET`), a gateway-JWT kulcsától független: a worker ellenőrizheti,
 * de gateway-tokent nem tud vele kiállítani.
 *
 * - `platform-chat`: a böngésző Clerk-sessionjéből, 10 perc. A worker böngésző-API-ja csak ezt fogadja.
 * - `platform-chat-turn`: folytatási token egy forduló háttérfutásához (turnId + agentId),
 *   csak MCP-hívásra és gateway-token kérésre jó; a worker böngésző-API-ja elutasítja.
 */
import { createHmac, randomUUID } from 'node:crypto'
import type { UserRole } from '@prisma/client'
import { safeSecretEquals } from '@/lib/crypto/timing-safe'

export const CHAT_TOKEN_AUDIENCE = 'platform-chat'
export const CHAT_TURN_TOKEN_AUDIENCE = 'platform-chat-turn'
export const CHAT_TOKEN_TTL_SECONDS = 600
/** A forduló max. falióra-ideje (a worker `PLATFORM_CHAT_TURN_MAX_SECONDS`-ával egyezzen). */
export const CHAT_TURN_TOKEN_TTL_SECONDS = 45 * 60
const MIN_KEY_LENGTH = 32

export type ChatTokenAudience = typeof CHAT_TOKEN_AUDIENCE | typeof CHAT_TURN_TOKEN_AUDIENCE

export type ChatTokenClaims = {
  aud: ChatTokenAudience
  sub: string
  /** tenant slug — az MCP URL-je ezzel egyezzen */
  tenant: string
  tid: string
  role: UserRole
  /** A tenant admin-betekintés kapcsolója kiállításkor (#1004 D15). */
  adminInsight: boolean
  turnId?: string
  agentId?: string
  jti: string
  iat: number
  exp: number
}

export function usableChatTokenKey(key: string | undefined): string | null {
  return key && key.length >= MIN_KEY_LENGTH ? key : null
}

const b64u = (value: string) => Buffer.from(value).toString('base64url')

export function signChatToken(
  input: Omit<ChatTokenClaims, 'jti' | 'iat' | 'exp'>,
  key: string,
  now: Date,
): { token: string; claims: ChatTokenClaims } {
  const iat = Math.floor(now.getTime() / 1000)
  const ttl = input.aud === CHAT_TURN_TOKEN_AUDIENCE ? CHAT_TURN_TOKEN_TTL_SECONDS : CHAT_TOKEN_TTL_SECONDS
  const claims: ChatTokenClaims = { ...input, jti: randomUUID(), iat, exp: iat + ttl }
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64u(JSON.stringify(claims))
  const sig = createHmac('sha256', key).update(`${head}.${body}`).digest('base64url')
  return { token: `${head}.${body}.${sig}`, claims }
}

/** Aláírás + lejárat + audience. Bármi más → null (a hívó a Clerk-útra eshet vissza). */
export function verifyChatToken(
  token: string,
  key: string | undefined,
  nowSeconds: number,
  audiences: readonly ChatTokenAudience[] = [CHAT_TOKEN_AUDIENCE, CHAT_TURN_TOKEN_AUDIENCE],
): ChatTokenClaims | null {
  const usable = usableChatTokenKey(key)
  if (!usable) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [head, body, sig] = parts
  const expected = createHmac('sha256', usable).update(`${head}.${body}`).digest('base64url')
  if (!safeSecretEquals(sig, expected)) return null
  try {
    if (JSON.parse(Buffer.from(head, 'base64url').toString()).alg !== 'HS256') return null
    const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as ChatTokenClaims
    if (!audiences.includes(c.aud)) return null
    if (typeof c.exp !== 'number' || c.exp <= nowSeconds) return null
    if (![c.sub, c.tenant, c.tid, c.role, c.jti].every((v) => typeof v === 'string' && v)) return null
    if (c.aud === CHAT_TURN_TOKEN_AUDIENCE && !(typeof c.turnId === 'string' && typeof c.agentId === 'string')) return null
    return c
  } catch {
    return null
  }
}

export function chatTokenKeyFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  return usableChatTokenKey(env.PLATFORM_CHAT_TOKEN_SECRET) ?? undefined
}
