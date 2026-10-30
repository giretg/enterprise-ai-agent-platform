/**
 * #1030 provider-független levelező eszközök. A modell `mail_*`-ot hív;
 * a Gmail / AgentMail / Microsoft 365 különbség itt marad.
 */
import {
  AGENTMAIL_PROVIDER,
  mailboxConnectorInfo,
  type MailboxKind,
} from '@/domain/agent-mailbox/agent-mailbox'
import { isMicrosoft365Connector } from '@/domain/connector-grant/tenant-mailbox'
import {
  linkedAccountHandle,
  type LinkedAccountChoice,
} from '@/domain/connector-grant/linked-account'
import type { AgentDefinition } from '@/domain/agent-definition'
import type { LiveConnectorRow, LiveGrantRow } from '@/domain/enterprise-tools/authorize-tool-call'

export type MailAccount = {
  account: string
  address: string | null
  kind: MailboxKind
  access: 'read' | 'write'
  primary: boolean
  connectorId: string
  grantId?: string
}

export type MailSearchQuery = {
  query?: string
  from?: string
  to?: string
  subject?: string
  unread?: boolean
  after?: string
  before?: string
  label?: string
  maxResults?: number
}

export type MailAttachmentInfo = {
  attachmentId: string
  fileName: string
  mimeType: string
  size?: number
}

export type MailMessage = {
  account: string
  messageId: string
  threadId: string
  from: string
  to: string
  cc: string
  subject: string
  date: string
  snippet: string
  labels: string[]
  hasAttachments: boolean
  body?: string
  attachments?: MailAttachmentInfo[]
}

export type MailCompose = {
  to?: string
  cc?: string
  bcc?: string
  subject: string
  body: string
  threadId?: string
  inReplyTo?: string
  references?: string
  replyToMessageId?: string
  replyAll?: boolean
  draftId?: string
}

export type ReplyContext = {
  threadId: string
  from: string
  replyTo: string
  to: string
  cc: string
  subject: string
  messageIdHeader: string
  references: string
}

export type MailMark = {
  messageId?: string
  threadId?: string
  read?: boolean
  unread?: boolean
  archive?: boolean
  label?: string
}

export type MailProvider = {
  search(query: MailSearchQuery): Promise<MailMessage[]>
  getMessage(id: string): Promise<MailMessage>
  getThread(threadId: string): Promise<{ threadId: string; messages: MailMessage[] }>
  getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ fileName: string; mimeType: string; text?: string; contentBase64?: string }>
  send(compose: MailCompose): Promise<{ messageId: string; threadId?: string }>
  createDraft(compose: MailCompose): Promise<{ draftId: string }>
  mark(input: MailMark): Promise<{ ok: true }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function csv(value: unknown): string[] {
  return (optionalString(value) ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function addressOf(entry: string): string {
  return (entry.match(/<([^>]+)>/)?.[1] ?? entry).trim().toLowerCase()
}

export function mergeAddresses(lists: string[], exclude: Set<string>): string {
  const seen = new Set(exclude)
  const out: string[] = []
  for (const entry of lists.flatMap((list) => list.split(',')).map((e) => e.trim()).filter(Boolean)) {
    const address = addressOf(entry)
    if (seen.has(address)) continue
    seen.add(address)
    out.push(entry)
  }
  return out.join(', ')
}

/** Válasz mezői: szál, Re: tárgy, címzettek. A Gmail-handler is ezt hívja. */
export function composeFromReply(
  original: ReplyContext,
  ownAddress: string | undefined,
  args: Record<string, unknown>,
): MailCompose {
  const body = optionalString(args.body) ?? ''
  const to = optionalString(args.to)
  const cc = optionalString(args.cc)
  const bcc = optionalString(args.bcc)
  const originalSubject = original.subject.trim()
  const subject =
    optionalString(args.subject) ??
    (/^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`.trim())
  const sender = original.replyTo || original.from
  let replyTo = to ?? sender
  let replyCc = cc
  if (!to && args.replyAll === true) {
    const self = new Set<string>()
    if (ownAddress) self.add(ownAddress.toLowerCase())
    replyTo = mergeAddresses([sender, original.to], self)
    replyCc = mergeAddresses([original.cc, cc ?? ''], new Set([...self, ...csv(replyTo).map(addressOf)])) || undefined
  }
  const references = [original.references, original.messageIdHeader].filter(Boolean).join(' ')
  return {
    to: replyTo,
    cc: replyCc,
    bcc,
    subject,
    body,
    threadId: original.threadId || undefined,
    inReplyTo: original.messageIdHeader || undefined,
    references: references || undefined,
    replyToMessageId: optionalString(args.replyToMessageId),
    replyAll: args.replyAll === true,
  }
}

export function composeNew(args: Record<string, unknown>): MailCompose {
  return {
    to: optionalString(args.to),
    cc: optionalString(args.cc),
    bcc: optionalString(args.bcc),
    subject: optionalString(args.subject) ?? '',
    body: optionalString(args.body) ?? '',
    draftId: optionalString(args.draftId),
    replyToMessageId: optionalString(args.replyToMessageId),
    replyAll: args.replyAll === true,
  }
}

function ymd(value: string): string {
  const d = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return d ? `${d[1]}/${d[2]}/${d[3]}` : value.replace(/-/g, '/')
}

/** Gmail keresőszintaxis a strukturált `mail_search` mezőkből. */
export function gmailSearchQuery(q: MailSearchQuery): string {
  const parts: string[] = []
  if (q.query) parts.push(q.query)
  if (q.from) parts.push(`from:${q.from}`)
  if (q.to) parts.push(`to:${q.to}`)
  if (q.subject) parts.push(`subject:(${q.subject})`)
  if (q.unread) parts.push('is:unread')
  if (q.after) parts.push(`after:${ymd(q.after)}`)
  if (q.before) parts.push(`before:${ymd(q.before)}`)
  if (q.label) parts.push(`label:${q.label}`)
  return parts.join(' ').trim()
}

export function searchQueryFromArgs(args: Record<string, unknown>): MailSearchQuery {
  return {
    query: optionalString(args.query),
    from: optionalString(args.from),
    to: optionalString(args.to),
    subject: optionalString(args.subject),
    unread: args.unread === true,
    after: optionalString(args.after),
    before: optionalString(args.before),
    label: optionalString(args.label),
    maxResults: typeof args.maxResults === 'number' && Number.isFinite(args.maxResults) ? args.maxResults : undefined,
  }
}

function emailIn(text: unknown): string | null {
  if (typeof text !== 'string') return null
  return text.match(/[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[^\s<>()"',;:]+/)?.[0]?.toLowerCase() ?? null
}

function kindOf(connector: LiveConnectorRow): MailboxKind | null {
  const info = mailboxConnectorInfo(connector)
  if (info) return info.kind
  if (connector.type === 'gmail') return 'google'
  if (isMicrosoft365Connector(connector)) return 'microsoft'
  const config = isRecord(connector.config) ? connector.config : {}
  if (connector.type === 'http_api' && config.provider === AGENTMAIL_PROVIDER) return 'agentmail'
  return null
}

function addressOfConnector(connector: LiveConnectorRow, kind: MailboxKind): string | null {
  return mailboxConnectorInfo(connector)?.address ?? emailIn(connector.name) ?? (kind === 'google' ? null : emailIn(connector.name))
}

export async function listMailAccounts(input: {
  definition: AgentDefinition
  primaryConnectorId?: string | null
  findConnector: (id: string) => Promise<LiveConnectorRow | null>
  findActiveGrants: (input: { tenantId: string; connectorId: string; userId: string }) => Promise<LiveGrantRow[]>
  userId: string
  tenantId: string
}): Promise<MailAccount[]> {
  const accounts: MailAccount[] = []
  for (const row of input.definition.snapshot.connectors) {
    const live = await input.findConnector(row.connectorId)
    if (!live || live.lifecycleState !== 'active' || live.tenantId !== input.tenantId) continue
    const kind = kindOf(live)
    if (!kind) continue
    const access: 'read' | 'write' = row.accessMode === 'write' ? 'write' : 'read'
    const primary = live.id === input.primaryConnectorId
    if (live.type === 'gmail' && live.authMode === 'user_delegated') {
      const grants = await input.findActiveGrants({
        tenantId: input.tenantId,
        connectorId: live.id,
        userId: input.userId,
      })
      if (grants.length === 0) {
        accounts.push({
          account: row.name?.trim() || 'gmail',
          address: null,
          kind,
          access,
          primary: false,
          connectorId: live.id,
        })
        continue
      }
      for (const grant of grants) {
        const handle = linkedAccountHandle({
          id: grant.id,
          accountLabel: grant.accountLabel ?? null,
          nickname: grant.nickname ?? null,
        })
        accounts.push({
          account: handle,
          address: grant.accountLabel ?? null,
          kind,
          access,
          primary: false,
          connectorId: live.id,
          grantId: grant.id,
        })
      }
      continue
    }
    const address = addressOfConnector(live, kind)
    accounts.push({
      account: address || row.name?.trim() || live.id,
      address,
      kind,
      access,
      primary,
      connectorId: live.id,
    })
  }
  return accounts
}

export function mailAccountChoices(accounts: MailAccount[]): LinkedAccountChoice[] {
  return accounts.map((row) => ({
    account: row.account,
    email: row.address,
    nickname: row.account !== row.address ? row.account : null,
  }))
}

function matchesAccount(row: MailAccount, query: string): boolean {
  if (row.account.trim().toLowerCase() === query) return true
  if (row.address?.trim().toLowerCase() === query) return true
  return false
}

export type ResolveMailResult =
  | { ok: true; accounts: MailAccount[] }
  | { ok: false; reason: 'account_required' | 'unknown_account' | 'mailbox_read_only' | 'missing_mailbox'; accounts: LinkedAccountChoice[] }

export function resolveMailAccounts(
  accounts: MailAccount[],
  accountArg: unknown,
  opts: { allAllowed?: boolean; write?: boolean; primaryConnectorId?: string | null },
): ResolveMailResult {
  const choices = mailAccountChoices(accounts)
  if (accounts.length === 0) {
    return { ok: false, reason: 'missing_mailbox', accounts: choices }
  }
  const requested = typeof accountArg === 'string' ? accountArg.trim().toLowerCase() : ''
  const needWrite = opts.write === true

  const ensureWrite = (picked: MailAccount[]): ResolveMailResult => {
    if (!needWrite) return { ok: true, accounts: picked }
    const writable = picked.filter((row) => row.access === 'write')
    if (writable.length === 0) {
      return { ok: false, reason: 'mailbox_read_only', accounts: mailAccountChoices(picked) }
    }
    return { ok: true, accounts: writable }
  }

  if (requested === 'all') {
    if (!opts.allAllowed) return { ok: false, reason: 'account_required', accounts: choices }
    return ensureWrite(accounts)
  }

  if (requested) {
    const hits = accounts.filter((row) => matchesAccount(row, requested))
    if (hits.length === 1) return ensureWrite(hits)
    return {
      ok: false,
      reason: hits.length === 0 ? 'unknown_account' : 'account_required',
      accounts: choices,
    }
  }

  const primary =
    accounts.find((row) => row.primary) ??
    accounts.find((row) => row.connectorId === opts.primaryConnectorId)
  if (primary) return ensureWrite([primary])
  if (accounts.length === 1) return ensureWrite(accounts)
  return { ok: false, reason: 'account_required', accounts: choices }
}

export function publicMailAccount(row: MailAccount) {
  return {
    account: row.account,
    address: row.address,
    kind: row.kind,
    access: row.access,
    primary: row.primary,
  }
}

export function withAccount<T extends Record<string, unknown>>(row: T, account: string): T & { account: string } {
  return { ...row, account }
}
