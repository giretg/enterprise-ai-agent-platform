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

export function nicknameTakenByPeer(
  grants: Array<{
    id: string
    nickname: string | null
    accountLabel?: string | null
    status?: string
  }>,
  nickname: string,
  exceptId?: string,
): boolean {
  const query = nickname.trim().toLowerCase()
  if (!query) return false
  return grants.some((grant) => {
    if (grant.id === exceptId) return false
    if (grant.status != null && grant.status !== 'active') return false
    if (grant.nickname?.trim().toLowerCase() === query) return true
    // Becenév ne ütközzön más aktív fiók e-mailjével: a whoami `account` mezője
    // és a resolveLinkedAccountGrant különben két grantot is ugyanarra a
    // stringre kötne, és a céges címre szánt írás a magán postafiókból mehetne.
    if (grant.accountLabel?.trim().toLowerCase() === query) return true
    return false
  })
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

  // Egyezés becenév / e-mail / grant.id szerint. Ha több grant is találatot ad
  // (pl. az egyik beceneve a másik e-mailje), fail-closed — ne válasszunk
  // hallgatólag a becenév javára (rossz postafiók / Drive).
  const matched = new Map<string, T>()
  for (const grant of active) {
    if (matchesHandle(grant, requested) || grant.id.toLowerCase() === requested) {
      matched.set(grant.id, grant)
    }
  }
  if (matched.size === 1) {
    return { ok: true, grant: matched.values().next().value as T }
  }
  if (matched.size > 1) {
    return { ok: false, reason: 'account_required', accounts }
  }
  return { ok: false, reason: 'unknown_account', accounts }
}
