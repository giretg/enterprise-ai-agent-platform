import type { Prisma } from '@prisma/client'

export const GMAIL_SCOPES = {
  full: 'https://mail.google.com/',
  readonly: 'https://www.googleapis.com/auth/gmail.readonly',
  compose: 'https://www.googleapis.com/auth/gmail.compose',
  modify: 'https://www.googleapis.com/auth/gmail.modify',
  send: 'https://www.googleapis.com/auth/gmail.send',
  metadata: 'https://www.googleapis.com/auth/gmail.metadata',
} as const

const ABBREVIATED_SCOPES: Record<string, string> = {
  full: GMAIL_SCOPES.full,
  'gmail.readonly': GMAIL_SCOPES.readonly,
  'gmail.compose': GMAIL_SCOPES.compose,
  'gmail.modify': GMAIL_SCOPES.modify,
  'gmail.send': GMAIL_SCOPES.send,
  'gmail.metadata': GMAIL_SCOPES.metadata,
}

export type GmailTool =
  | 'gmail_search'
  | 'gmail_get_message'
  | 'gmail_get_thread'
  | 'gmail_list_labels'
  | 'gmail_list_drafts'
  | 'gmail_create_draft'
  | 'gmail_send'
  | 'gmail_modify_labels'
  | 'gmail_trash'
  | 'mailbox_count'

export function normalizeGmailScope(scope: string): string {
  const trimmed = scope.trim()
  return ABBREVIATED_SCOPES[trimmed] ?? trimmed
}

export function parseGmailScopes(scopes: Prisma.JsonValue | string[] | null | undefined): string[] {
  if (!Array.isArray(scopes)) return []
  return (scopes as unknown[])
    .filter((scope): scope is string => typeof scope === 'string')
    .map(normalizeGmailScope)
}

function hasAnyScope(grantedScopes: string[], requiredScopes: string[]): boolean {
  const granted = new Set(grantedScopes.map(normalizeGmailScope))
  return requiredScopes.some((scope) => granted.has(scope))
}

export function gmailToolAllowedByScopes(params: {
  tool: GmailTool
  args?: Record<string, unknown>
  scopes: Prisma.JsonValue | string[] | null | undefined
}): boolean {
  const scopes = parseGmailScopes(params.scopes)
  if (scopes.length === 0) return false

  const canRead = hasAnyScope(scopes, [GMAIL_SCOPES.full, GMAIL_SCOPES.modify, GMAIL_SCOPES.readonly])
  // Válasznál az eredeti levél fejléceit is olvassuk — puszta gmail.send/compose ehhez kevés.
  const replyReadOk = !params.args?.replyToMessageId || canRead

  if (
    params.tool === 'gmail_search' ||
    params.tool === 'gmail_get_message' ||
    params.tool === 'gmail_get_thread' ||
    params.tool === 'gmail_list_labels' ||
    params.tool === 'mailbox_count'
  ) {
    return canRead
  }

  if (params.tool === 'gmail_list_drafts') {
    return hasAnyScope(scopes, [GMAIL_SCOPES.full, GMAIL_SCOPES.modify, GMAIL_SCOPES.compose, GMAIL_SCOPES.readonly])
  }

  if (params.tool === 'gmail_create_draft') {
    return replyReadOk && hasAnyScope(scopes, [GMAIL_SCOPES.full, GMAIL_SCOPES.modify, GMAIL_SCOPES.compose])
  }

  // Google: gmail.modify és gmail.compose is enged küldést (nem csak gmail.send).
  if (params.tool === 'gmail_send') {
    return (
      replyReadOk &&
      hasAnyScope(scopes, [GMAIL_SCOPES.full, GMAIL_SCOPES.send, GMAIL_SCOPES.compose, GMAIL_SCOPES.modify])
    )
  }

  if (params.tool === 'gmail_modify_labels' || params.tool === 'gmail_trash') {
    return hasAnyScope(scopes, [GMAIL_SCOPES.full, GMAIL_SCOPES.modify])
  }

  return false
}
