/**
 * #1030 MailProvider implementációk: GmailApiClient, AgentMail http_api, Graph.
 * IMAP: #1033.
 */
import { GmailApiClient } from '@/domain/connector-grant/gmail-api-client'
import {
  sendMicrosoftMail,
} from '@/domain/connector-grant/microsoft-mail-client'
import {
  HttpApiClient,
  parseHttpApiConfig,
  resolveConnectorApiKey,
} from '@/domain/connector/http-api-client'
import { mailboxConnectorInfo } from '@/domain/agent-mailbox/agent-mailbox'
import { isMicrosoft365Connector } from '@/domain/connector-grant/tenant-mailbox'
import type { LiveConnectorRow } from '@/domain/enterprise-tools/authorize-tool-call'
import {
  composeFromReply,
  composeNew,
  gmailSearchQuery,
  type MailCompose,
  type MailMessage,
  type MailProvider,
  type MailSearchQuery,
} from './mail'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) return value.map(str).filter(Boolean).join(', ')
  if (isRecord(value)) {
    if (typeof value.email === 'string') return value.email
    if (typeof value.address === 'string') return value.address
    if (isRecord(value.emailAddress) && typeof value.emailAddress.address === 'string') {
      const name = typeof value.emailAddress.name === 'string' ? value.emailAddress.name : ''
      return name ? `${name} <${value.emailAddress.address}>` : value.emailAddress.address
    }
  }
  return ''
}

function labelsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === 'string' && value ? [value] : []
  return value.map((row) => (typeof row === 'string' ? row : str(row))).filter(Boolean)
}

function unsupported(action: string, kind: string): never {
  throw new Error(`${action} is not supported on this ${kind} mailbox`)
}

function gmailMessage(account: string, raw: {
  id: string
  threadId: string
  from: string
  to?: string
  cc?: string
  subject: string
  snippet: string
  date: string
  labelIds?: string[]
  body?: string
  attachments?: Array<{ attachmentId: string; fileName: string; mimeType: string; size: number }>
}): MailMessage {
  const attachments = raw.attachments ?? []
  return {
    account,
    messageId: raw.id,
    threadId: raw.threadId,
    from: raw.from,
    to: raw.to ?? '',
    cc: raw.cc ?? '',
    subject: raw.subject,
    date: raw.date,
    snippet: raw.snippet,
    labels: raw.labelIds ?? [],
    hasAttachments: attachments.length > 0,
    ...(raw.body !== undefined ? { body: raw.body } : {}),
    ...(attachments.length ? { attachments } : {}),
  }
}

function gmailProvider(accessToken: string, account: string): MailProvider {
  const gmail = new GmailApiClient(accessToken)
  const asCompose = async (input: MailCompose): Promise<MailCompose> => {
    if (input.draftId || !input.replyToMessageId) return input
    const original = await gmail.getReplyContext({ messageId: input.replyToMessageId })
    const me = await gmail.getProfileEmail().catch(() => undefined)
    return composeFromReply(original, me || undefined, {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      body: input.body,
      replyToMessageId: input.replyToMessageId,
      replyAll: input.replyAll,
    })
  }
  return {
    async search(query) {
      const q = gmailSearchQuery(query)
      const result = await gmail.search({ query: q || 'in:inbox', maxResults: query.maxResults })
      return result.messages.map((row) => gmailMessage(account, row))
    },
    async getMessage(id) {
      return gmailMessage(account, await gmail.getMessage({ id }))
    },
    async getThread(threadId) {
      const result = await gmail.getThread({ threadId })
      return { threadId: result.threadId, messages: result.messages.map((row) => gmailMessage(account, row)) }
    },
    async getAttachment(messageId, attachmentId) {
      return gmail.getAttachment({ messageId, attachmentId })
    },
    async send(input) {
      if (input.draftId) return gmail.send({ draftId: input.draftId })
      const composed = await asCompose(input)
      return gmail.send(composed)
    },
    async createDraft(input) {
      const composed = await asCompose(input)
      return gmail.createDraft(composed)
    },
    async mark(input) {
      const add: string[] = []
      const remove: string[] = []
      if (input.read) remove.push('UNREAD')
      if (input.unread) add.push('UNREAD')
      if (input.archive) remove.push('INBOX')
      if (input.label) add.push(input.label)
      if (add.length === 0 && remove.length === 0) return { ok: true }
      await gmail.modifyLabels({
        messageId: input.messageId,
        threadId: input.threadId,
        addLabelIds: add,
        removeLabelIds: remove,
      })
      return { ok: true }
    },
  }
}

function agentMailMessage(account: string, raw: unknown): MailMessage | null {
  if (!isRecord(raw)) return null
  const messageId = str(raw.message_id ?? raw.messageId ?? raw.id)
  if (!messageId) return null
  const attachmentsRaw = Array.isArray(raw.attachments) ? raw.attachments : []
  const attachments = attachmentsRaw.flatMap((row) => {
    if (!isRecord(row)) return []
    const attachmentId = str(row.attachment_id ?? row.attachmentId ?? row.id)
    if (!attachmentId) return []
    return [{
      attachmentId,
      fileName: str(row.filename ?? row.fileName ?? row.name) || 'attachment',
      mimeType: str(row.content_type ?? row.mimeType) || 'application/octet-stream',
      size: typeof row.size === 'number' ? row.size : undefined,
    }]
  })
  const text = str(raw.text ?? raw.preview ?? raw.snippet)
  return {
    account,
    messageId,
    threadId: str(raw.thread_id ?? raw.threadId) || messageId,
    from: str(raw.from),
    to: str(raw.to),
    cc: str(raw.cc),
    subject: str(raw.subject),
    date: str(raw.timestamp ?? raw.created_at ?? raw.date) || new Date().toISOString(),
    snippet: text.slice(0, 200),
    labels: labelsOf(raw.labels),
    hasAttachments: attachments.length > 0 || raw.has_attachments === true,
    body: str(raw.text ?? raw.html) || undefined,
    ...(attachments.length ? { attachments } : {}),
  }
}

function matchesQuery(message: MailMessage, query: MailSearchQuery): boolean {
  const hay = `${message.from} ${message.to} ${message.cc} ${message.subject} ${message.snippet} ${message.body ?? ''}`.toLowerCase()
  if (query.query && !hay.includes(query.query.toLowerCase())) return false
  if (query.from && !message.from.toLowerCase().includes(query.from.toLowerCase())) return false
  if (query.to && !message.to.toLowerCase().includes(query.to.toLowerCase())) return false
  if (query.subject && !message.subject.toLowerCase().includes(query.subject.toLowerCase())) return false
  if (query.unread && !message.labels.some((label) => label.toLowerCase() === 'unread')) return false
  if (query.label && !message.labels.some((label) => label.toLowerCase() === query.label!.toLowerCase())) return false
  if (query.after && message.date && message.date < query.after) return false
  if (query.before && message.date && message.date > query.before) return false
  return true
}

async function agentMailClient(connector: LiveConnectorRow, accessToken?: string): Promise<HttpApiClient> {
  const config = parseHttpApiConfig(connector.config)
  const apiKey =
    accessToken ||
    (connector.secretAlias ? await resolveConnectorApiKey(connector.secretAlias) : undefined)
  return new HttpApiClient(config, apiKey ?? '')
}

function agentMailProvider(connector: LiveConnectorRow, accessToken: string | undefined, account: string): MailProvider {
  const client = () => agentMailClient(connector, accessToken)
  const listBody = (body: unknown): unknown[] => {
    if (Array.isArray(body)) return body
    if (isRecord(body) && Array.isArray(body.messages)) return body.messages
    if (isRecord(body) && body.stub === true) {
      return [{
        message_id: 'stub-msg-1',
        thread_id: 'stub-thread-1',
        from: 'noreply@example.com',
        to: account,
        subject: querySubject(body),
        preview: 'AgentMail stub',
        timestamp: new Date().toISOString(),
        labels: ['unread'],
      }]
    }
    return []
  }
  return {
    async search(query) {
      const http = await client()
      const labels = [query.unread ? 'unread' : '', query.label ?? ''].filter(Boolean).join(',')
      const result = await http.request({
        method: 'GET',
        path: '/messages',
        query: {
          limit: query.maxResults ?? 20,
          ...(labels ? { labels } : {}),
        },
      })
      const messages = listBody(result.body).map((row) => agentMailMessage(account, row)).filter((row): row is MailMessage => Boolean(row))
      return messages.filter((row) => matchesQuery(row, query)).slice(0, query.maxResults ?? 20)
    },
    async getMessage(id) {
      const http = await client()
      const result = await http.request({ method: 'GET', path: `/messages/${encodeURIComponent(id)}` })
      if (isRecord(result.body) && result.body.stub === true) {
        return agentMailMessage(account, { message_id: id, from: 'noreply@example.com', subject: 'stub', preview: 'stub' })!
      }
      const message = agentMailMessage(account, result.body)
      if (!message) throw new Error('agentmail.get_message: invalid payload')
      return message
    },
    async getThread(threadId) {
      const http = await client()
      const result = await http.request({ method: 'GET', path: `/threads/${encodeURIComponent(threadId)}` })
      const raw = result.body
      const rows = isRecord(raw) && Array.isArray(raw.messages) ? raw.messages : listBody(raw)
      const messages = rows.map((row) => agentMailMessage(account, row)).filter((row): row is MailMessage => Boolean(row))
      return { threadId, messages }
    },
    async getAttachment(messageId, attachmentId) {
      const message = await this.getMessage(messageId)
      const hit = message.attachments?.find((row) => row.attachmentId === attachmentId)
      if (!hit) throw new Error('attachment not found')
      return { fileName: hit.fileName, mimeType: hit.mimeType, text: message.body }
    },
    async send(input) {
      const http = await client()
      if (input.replyToMessageId) {
        const result = await http.request({
          method: 'POST',
          path: `/messages/${encodeURIComponent(input.replyToMessageId)}/reply`,
          body: {
            text: input.body,
            ...(input.replyAll ? { reply_all: true } : {}),
            ...(input.cc ? { cc: input.cc.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
            ...(input.bcc ? { bcc: input.bcc.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
          },
        })
        const id = isRecord(result.body) ? str(result.body.message_id ?? result.body.id) : ''
        return { messageId: id || input.replyToMessageId, threadId: input.threadId }
      }
      const result = await http.request({
        method: 'POST',
        path: '/messages/send',
        body: {
          to: (input.to ?? '').split(',').map((s) => s.trim()).filter(Boolean),
          subject: input.subject,
          text: input.body,
          ...(input.cc ? { cc: input.cc.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
          ...(input.bcc ? { bcc: input.bcc.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        },
      })
      const id = isRecord(result.body) ? str(result.body.message_id ?? result.body.id) : ''
      return { messageId: id || 'sent' }
    },
    async createDraft() {
      unsupported('create_draft', 'AgentMail')
    },
    async mark() {
      unsupported('mark', 'AgentMail')
    },
  }
}

function querySubject(body: Record<string, unknown>): string {
  const query = isRecord(body.query) ? body.query : {}
  return typeof query.labels === 'string' ? query.labels : 'stub'
}

function graphRecipients(value: unknown): string {
  if (!Array.isArray(value)) return str(value)
  return value.map(str).filter(Boolean).join(', ')
}

function graphMessage(account: string, raw: unknown): MailMessage | null {
  if (!isRecord(raw)) return null
  const messageId = str(raw.id)
  if (!messageId) return null
  const from = isRecord(raw.from) ? str(raw.from) : str(raw.from)
  return {
    account,
    messageId,
    threadId: str(raw.conversationId) || messageId,
    from,
    to: graphRecipients(raw.toRecipients),
    cc: graphRecipients(raw.ccRecipients),
    subject: str(raw.subject),
    date: str(raw.receivedDateTime) || new Date().toISOString(),
    snippet: str(raw.bodyPreview),
    labels: [
      raw.isRead === false ? 'unread' : '',
      ...labelsOf(raw.categories),
    ].filter(Boolean),
    hasAttachments: raw.hasAttachments === true,
    body: isRecord(raw.body) ? str(raw.body.content) : undefined,
  }
}

const GRAPH = 'https://graph.microsoft.com/v1.0/me'

async function graphFetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  if (accessToken.startsWith('stub-')) {
    return { stub: true, path, method: init?.method ?? 'GET' }
  }
  const res = await fetchImpl(`${GRAPH}${path}`, {
    ...init,
    redirect: 'manual',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (res.status === 401) throw Object.assign(new Error('Microsoft mailbox authentication failed'), { status: 401 })
  if (res.status === 204) return null
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`microsoft_mail_failed: HTTP ${res.status}`)
  return body
}

function microsoftProvider(accessToken: string, account: string, fetchImpl: typeof fetch = fetch): MailProvider {
  return {
    async search(query) {
      const params = new URLSearchParams()
      params.set('$top', String(query.maxResults ?? 20))
      params.set(
        '$select',
        'id,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,bodyPreview,isRead,hasAttachments,categories',
      )
      const search = [query.query, query.subject, query.from ? `from:${query.from}` : ''].filter(Boolean).join(' ')
      if (search) params.set('$search', `"${search.replace(/"/g, '')}"`)
      else if (query.unread) params.set('$filter', 'isRead eq false')
      const raw = await graphFetch(accessToken, `/messages?${params.toString()}`, undefined, fetchImpl)
      if (isRecord(raw) && raw.stub === true) {
        return [{
          account,
          messageId: 'stub-msg-1',
          threadId: 'stub-thread-1',
          from: 'noreply@example.com',
          to: account,
          cc: '',
          subject: 'Microsoft stub',
          date: new Date().toISOString(),
          snippet: 'stub',
          labels: query.unread ? ['unread'] : [],
          hasAttachments: false,
        }]
      }
      const rows = isRecord(raw) && Array.isArray(raw.value) ? raw.value : []
      return rows.map((row) => graphMessage(account, row)).filter((row): row is MailMessage => Boolean(row))
    },
    async getMessage(id) {
      const raw = await graphFetch(
        accessToken,
        `/messages/${encodeURIComponent(id)}?$select=id,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,bodyPreview,body,isRead,hasAttachments,categories`,
        undefined,
        fetchImpl,
      )
      if (isRecord(raw) && raw.stub === true) {
        return graphMessage(account, { id, subject: 'stub', bodyPreview: 'stub' })!
      }
      const message = graphMessage(account, raw)
      if (!message) throw new Error('microsoft.get_message: invalid payload')
      return message
    },
    async getThread(threadId) {
      const raw = await graphFetch(
        accessToken,
        `/messages?$filter=${encodeURIComponent(`conversationId eq '${threadId.replace(/'/g, "''")}'`)}&$select=id,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,bodyPreview,body,isRead,hasAttachments,categories`,
        undefined,
        fetchImpl,
      )
      const rows = isRecord(raw) && Array.isArray(raw.value) ? raw.value : []
      return {
        threadId,
        messages: rows.map((row) => graphMessage(account, row)).filter((row): row is MailMessage => Boolean(row)),
      }
    },
    async getAttachment(messageId, attachmentId) {
      const raw = await graphFetch(
        accessToken,
        `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
        undefined,
        fetchImpl,
      )
      if (!isRecord(raw)) throw new Error('attachment not found')
      const mimeType = str(raw.contentType) || 'application/octet-stream'
      const fileName = str(raw.name) || 'attachment'
      const content = str(raw.contentBytes)
      if (mimeType.startsWith('text/') || mimeType === 'application/json') {
        return { fileName, mimeType, text: Buffer.from(content, 'base64').toString('utf8') }
      }
      return { fileName, mimeType, contentBase64: content }
    },
    async send(input) {
      if (input.replyToMessageId) {
        await graphFetch(
          accessToken,
          `/messages/${encodeURIComponent(input.replyToMessageId)}/${input.replyAll ? 'replyAll' : 'reply'}`,
          { method: 'POST', body: JSON.stringify({ comment: input.body }) },
          fetchImpl,
        )
        return { messageId: input.replyToMessageId, threadId: input.threadId }
      }
      await sendMicrosoftMail(accessToken, {
        to: input.to ?? '',
        subject: input.subject,
        body: input.body,
      }, fetchImpl)
      return { messageId: 'sent' }
    },
    async createDraft(input) {
      const raw = await graphFetch(
        accessToken,
        '/messages',
        {
          method: 'POST',
          body: JSON.stringify({
            subject: input.subject,
            body: { contentType: 'Text', content: input.body },
            toRecipients: (input.to ?? '').split(',').filter(Boolean).map((address) => ({
              emailAddress: { address: address.trim() },
            })),
          }),
        },
        fetchImpl,
      )
      const id = isRecord(raw) ? str(raw.id) : ''
      return { draftId: id || 'draft' }
    },
    async mark(input) {
      const id = input.messageId
      if (!id) unsupported('mark thread', 'Microsoft 365')
      const patch: Record<string, unknown> = {}
      if (input.read) patch.isRead = true
      if (input.unread) patch.isRead = false
      if (Object.keys(patch).length > 0) {
        await graphFetch(accessToken, `/messages/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        }, fetchImpl)
      }
      return { ok: true }
    },
  }
}

export function mailProviderFor(
  connector: LiveConnectorRow,
  accessToken: string | undefined,
  account: string,
): MailProvider {
  const info = mailboxConnectorInfo(connector)
  if (info?.kind === 'agentmail') return agentMailProvider(connector, accessToken, account)
  if (info?.kind === 'microsoft' || isMicrosoft365Connector(connector)) {
    return microsoftProvider(accessToken ?? '', account)
  }
  if (info?.kind === 'google' || connector.type === 'gmail') {
    return gmailProvider(accessToken ?? '', account)
  }
  const config = isRecord(connector.config) ? connector.config : {}
  if (connector.type === 'http_api' && config.provider === 'agentmail') {
    return agentMailProvider(connector, accessToken, account)
  }
  throw new Error(`unsupported mail connector: ${connector.type}`)
}

export async function executeMailTool(input: {
  toolName: string
  args: Record<string, unknown>
  connector: LiveConnectorRow
  accessToken?: string
  account: string
}): Promise<unknown> {
  const provider = mailProviderFor(input.connector, input.accessToken, input.account)
  const { toolName, args, account } = input
  if (toolName === 'mail_search') {
    return { messages: await provider.search({
      query: typeof args.query === 'string' ? args.query : undefined,
      from: typeof args.from === 'string' ? args.from : undefined,
      to: typeof args.to === 'string' ? args.to : undefined,
      subject: typeof args.subject === 'string' ? args.subject : undefined,
      unread: args.unread === true,
      after: typeof args.after === 'string' ? args.after : undefined,
      before: typeof args.before === 'string' ? args.before : undefined,
      label: typeof args.label === 'string' ? args.label : undefined,
      maxResults: typeof args.maxResults === 'number' ? args.maxResults : undefined,
    }) }
  }
  if (toolName === 'mail_get_message') {
    return provider.getMessage(String(args.id ?? args.messageId ?? ''))
  }
  if (toolName === 'mail_get_thread') {
    return provider.getThread(String(args.threadId ?? ''))
  }
  if (toolName === 'mail_get_attachment') {
    return provider.getAttachment(String(args.messageId ?? ''), String(args.attachmentId ?? ''))
  }
  if (toolName === 'mail_send') {
    const compose = composeNew(args)
    return provider.send(compose)
  }
  if (toolName === 'mail_create_draft') {
    return provider.createDraft(composeNew(args))
  }
  if (toolName === 'mail_mark') {
    return provider.mark({
      messageId: typeof args.messageId === 'string' ? args.messageId : undefined,
      threadId: typeof args.threadId === 'string' ? args.threadId : undefined,
      read: args.read === true,
      unread: args.unread === true,
      archive: args.archive === true,
      label: typeof args.label === 'string' ? args.label : undefined,
    })
  }
  throw new Error(`unsupported mail tool: ${toolName}`)
}

export type { ReplyContext }
