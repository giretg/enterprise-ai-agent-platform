/**
 * Több kapcsolt Gmail/Drive fiók megkülönböztetése MCP-n: a user által adott
 * becenév (pl. magán, céges) vagy a Google-cím.
 */

export const LINKED_ACCOUNT_NICKNAME_MAX = 40

export type LinkedAccountGrant = {
  id: string
  accountLabel: string | null
  nickname: string | null
}

export type LinkedAccountChoice = {
  account: string
  email: string | null
  nickname: string | null
}

export type ResolveLinkedAccountResult<T extends LinkedAccountGrant> =
  | { ok: true; grant: T }
  | {
      ok: false
      reason: 'connector_grant_missing' | 'account_required' | 'unknown_account'
      accounts: LinkedAccountChoice[]
    }

export function normalizeNickname(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (!trimmed || trimmed.length > LINKED_ACCOUNT_NICKNAME_MAX) return null
  if (/[\u0000-\u001f]/.test(trimmed)) return null
  return trimmed
}

export function linkedAccountHandle(grant: LinkedAccountGrant): string {
  return grant.nickname?.trim() || grant.accountLabel?.trim() || grant.id
}

export function linkedAccountChoice(grant: LinkedAccountGrant): LinkedAccountChoice {
  return {
    account: linkedAccountHandle(grant),
    email: grant.accountLabel,
    nickname: grant.nickname,
  }
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase()
}

function matchesHandle(grant: LinkedAccountGrant, query: string): 'nickname' | 'email' | null {
  const nickname = grant.nickname?.trim().toLowerCase()
  if (nickname && nickname === query) return 'nickname'
  const email = grant.accountLabel?.trim().toLowerCase()
  if (email && email === query) return 'email'
  return null
}

export function resolveLinkedAccountGrant<T extends LinkedAccountGrant>(
  grants: T[],
  account: unknown,
): ResolveLinkedAccountResult<T> {
  const active = grants.filter((grant) => grant)
  const accounts = active.map(linkedAccountChoice)
  if (active.length === 0) {
    return { ok: false, reason: 'connector_grant_missing', accounts }
  }

  const requested = typeof account === 'string' ? normalizeQuery(account) : ''
  if (!requested) {
    if (active.length === 1) return { ok: true, grant: active[0] }
    return { ok: false, reason: 'account_required', accounts }
  }

  const byNickname = active.filter((grant) => matchesHandle(grant, requested) === 'nickname')
  if (byNickname.length === 1) return { ok: true, grant: byNickname[0] }
  const byEmail = active.filter((grant) => matchesHandle(grant, requested) === 'email')
  if (byEmail.length === 1) return { ok: true, grant: byEmail[0] }
  return { ok: false, reason: 'unknown_account', accounts }
}
