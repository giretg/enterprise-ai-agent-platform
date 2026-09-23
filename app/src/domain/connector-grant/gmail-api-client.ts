/**
 * Gmail REST API thin adapter — a Tool Broker mögött (F2-D).
 * Stub mód acceptance / dev tesztekhez (GMAIL_API_STUB=true).
 */
export type GmailMessageSummary = {
  id: string
  threadId: string
  from: string
  subject: string
  snippet: string
  date: string
}

export type GmailAttachmentInfo = {
  attachmentId: string
  fileName: string
  mimeType: string
  size: number
}

export type GmailMessageDetail = GmailMessageSummary & {
  to: string
  cc: string
  /** RFC 822 Message-ID — a válasz In-Reply-To / References fejléce. */
  messageIdHeader: string
  labelIds: string[]
  body: string
  attachments: GmailAttachmentInfo[]
}

export type GmailLabel = { id: string; name: string; type: string }

export type GmailDraftSummary = {
  draftId: string
  messageId: string
  threadId: string
  to: string
  subject: string
  snippet: string
}

const STUB_MESSAGES: GmailMessageSummary[] = [
  {
    id: 'stub-msg-1',
    threadId: 'stub-thread-1',
    from: 'noreply@example.com',
    subject: 'Platform acceptance stub üzenet',
    snippet: 'Ez egy stub Gmail találat az acceptance teszthez.',
    date: new Date().toISOString(),
  },
]

export class GmailApiAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'GmailApiAuthError'
  }
}

export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'GmailApiError'
  }
}

function gmailApiError(operation: string, status: number): Error {
  if (status === 401 || status === 403) {
    return new GmailApiAuthError(`${operation} auth failed: ${status}`, status)
  }
  return new GmailApiError(`${operation} failed: ${status}`, status)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithBackoff(
  operation: string,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const delays = [250, 750]
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const res = await fetch(input, init)
    if (res.ok || res.status === 401 || res.status === 403) return res
    if (![429, 500, 502, 503, 504].includes(res.status) || attempt === delays.length) {
      return res
    }
    await sleep(delays[attempt])
  }
  throw new Error(`${operation} failed before response`)
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(normalized, 'base64').toString('utf8')
}

function extractHeader(headers: Array<{ name?: string; value?: string }>, name: string): string {
  const hit = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
  return hit?.value ?? ''
}

type GmailPart = {
  mimeType?: string
  filename?: string
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: GmailPart[]
}

function findPartData(part: GmailPart, mimeType: string): string | null {
  if (part.mimeType === mimeType && !part.filename && part.body?.data) return decodeBase64Url(part.body.data)
  for (const child of part.parts ?? []) {
    const hit = findPartData(child, mimeType)
    if (hit !== null) return hit
  }
  return null
}

const HTML_ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }

/** `<tag …>…</tag>` blokkok kivágása (a tartalmuk sem szöveg: CSS/JS). */
function dropBlocks(html: string, tag: string): string {
  let out = html
  for (;;) {
    const lower = out.toLowerCase()
    const open = lower.indexOf(`<${tag}`)
    if (open === -1) return out
    const close = lower.indexOf(`</${tag}`, open)
    const closeEnd = close === -1 ? -1 : lower.indexOf('>', close)
    out = out.slice(0, open) + (closeEnd === -1 ? '' : out.slice(closeEnd + 1))
  }
}

/** Minden `<…>` kihagyása karakterenként; lezáratlan `<` után a maradék is kiesik. */
function stripTags(html: string): string {
  let out = ''
  let inTag = false
  for (const ch of html) {
    if (ch === '<') inTag = true
    else if (ch === '>') inTag = false
    else if (!inTag) out += ch
  }
  return out
}

function htmlToText(html: string): string {
  const text = stripTags(
    dropBlocks(dropBlocks(html, 'script'), 'style').replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n'),
  )
  // Egy menetben dekódolunk: `&amp;lt;` → `&lt;`, nem `<`.
  return text
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_, entity: string) => HTML_ENTITIES[entity] ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** text/plain elsőbbséggel, különben a text/html szövegként — tetszőleges multipart-mélységből. */
function extractBody(payload: GmailPart): string {
  const plain = findPartData(payload, 'text/plain')
  if (plain !== null) return plain
  const html = findPartData(payload, 'text/html')
  return html !== null ? htmlToText(html) : ''
}

function collectAttachments(part: GmailPart, out: GmailAttachmentInfo[] = []): GmailAttachmentInfo[] {
  if (part.filename && part.body?.attachmentId) {
    out.push({
      attachmentId: part.body.attachmentId,
      fileName: part.filename,
      mimeType: part.mimeType ?? 'application/octet-stream',
      size: part.body.size ?? 0,
    })
  }
  for (const child of part.parts ?? []) collectAttachments(child, out)
  return out
}

function parseMessageDetail(raw: Record<string, unknown>): GmailMessageDetail {
  const summary = parseMessageListItem(raw)
  if (!summary) throw new Error('gmail.get_message: invalid payload')
  const payload = (raw.payload as GmailPart & { headers?: Array<{ name?: string; value?: string }> }) ?? {}
  const headers = payload.headers ?? []
  return {
    ...summary,
    to: extractHeader(headers, 'To'),
    cc: extractHeader(headers, 'Cc'),
    messageIdHeader: extractHeader(headers, 'Message-ID'),
    labelIds: Array.isArray(raw.labelIds) ? (raw.labelIds as string[]) : [],
    body: extractBody(payload) || summary.snippet,
    attachments: collectAttachments(payload),
  }
}

function parseMessageListItem(raw: Record<string, unknown>): GmailMessageSummary | null {
  const id = String(raw.id ?? '')
  if (!id) return null
  const payload = (raw.payload as Record<string, unknown>) ?? {}
  const headers = (payload.headers as Array<{ name?: string; value?: string }>) ?? []
  return {
    id,
    threadId: String(raw.threadId ?? ''),
    from: extractHeader(headers, 'From'),
    subject: extractHeader(headers, 'Subject'),
    snippet: String(raw.snippet ?? ''),
    date: extractHeader(headers, 'Date') || new Date().toISOString(),
  }
}

const RFC2047_ENCODED_WORD_MAX = 75

function rfc2047Base64Word(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

/** RFC 2047 encoded-word — UTF-8 karakterhatáron darabol, nem a base64 stringen belül. */
function encodeMimeHeaderValue(value: string): string {
  if (!/[^\x20-\x7E]/.test(value)) return value

  const single = rfc2047Base64Word(value)
  if (single.length <= RFC2047_ENCODED_WORD_MAX) return single

  const words: string[] = []
  let remaining = value

  while (remaining.length > 0) {
    let chunk = remaining
    let word = rfc2047Base64Word(chunk)

    while (word.length > RFC2047_ENCODED_WORD_MAX && chunk.length > 0) {
      chunk = chunk.slice(0, -1)
      word = rfc2047Base64Word(chunk)
    }

    if (chunk.length === 0) {
      throw new Error('encodeMimeHeaderValue: unable to encode header segment')
    }

    words.push(word)
    remaining = remaining.slice(chunk.length)
  }

  return words.join('\r\n ')
}

export type GmailAttachment = {
  fileName: string
  mimeType: string
  /** Nyers bájtok standard base64 kódolva. */
  contentBase64: string
}

function encodeAttachmentFileName(fileName: string): string {
  const safe = fileName.replace(/[\r\n"]/g, '_')
  if (/^[\x20-\x7E]*$/.test(safe) && safe.length > 0) return `"${safe}"`
  const fallback = safe.replace(/[^\x20-\x7E]+/g, '_') || 'attachment.html'
  return `"${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

/** Fejlécérték CR/LF nélkül — fejléc-injekció ellen (pl. `to: "a@b\r\nBcc: x"`). */
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

export function buildRawMessage(params: {
  to?: string
  cc?: string
  bcc?: string
  subject: string
  body: string
  inReplyTo?: string
  references?: string
  attachments?: GmailAttachment[]
}): string {
  const optional = (name: string, value?: string) => (value && headerValue(value) ? [`${name}: ${headerValue(value)}`] : [])
  const headerLines = [
    ...optional('To', params.to),
    ...optional('Cc', params.cc),
    ...optional('Bcc', params.bcc),
    `Subject: ${encodeMimeHeaderValue(headerValue(params.subject))}`,
    ...optional('In-Reply-To', params.inReplyTo),
    ...optional('References', params.references),
    'MIME-Version: 1.0',
  ]
  if (!params.attachments || params.attachments.length === 0) {
    const lines = [
      ...headerLines,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      params.body,
    ]
    return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url')
  }
  const boundary = `platform-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  const lines = [
    ...headerLines,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    'This is a multi-part message in MIME format.',
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    params.body,
    '',
  ]
  for (const attachment of params.attachments) {
    const encodedName = encodeAttachmentFileName(attachment.fileName)
    lines.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name=${encodedName}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename=${encodedName}`,
      '',
      attachment.contentBase64.replace(/\s+/g, '').replace(/(.{76})/g, '$1\r\n'),
      '',
    )
  }
  lines.push(`--${boundary}--`, '')
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url')
}

export class GmailApiClient {
  constructor(private accessToken: string) {}

  private isStub(): boolean {
    return process.env.GMAIL_API_STUB === 'true' || this.accessToken.startsWith('stub-')
  }

  async search(params: { query: string; maxResults?: number; signal?: AbortSignal }): Promise<{ messages: GmailMessageSummary[] }> {
    if (this.isStub()) {
      const q = params.query.toLowerCase()
      const hits = STUB_MESSAGES.filter(
        (m) => m.subject.toLowerCase().includes(q) || m.snippet.toLowerCase().includes(q) || !q,
      )
      return { messages: hits.slice(0, params.maxResults ?? 10) }
    }

    const maxResults = params.maxResults ?? 10
    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
    listUrl.searchParams.set('q', params.query)
    listUrl.searchParams.set('maxResults', String(maxResults))

    const listRes = await fetchWithBackoff('gmail.search', listUrl, {
      headers: { authorization: `Bearer ${this.accessToken}` },
      signal: params.signal,
    })
    if (!listRes.ok) throw gmailApiError('gmail.search', listRes.status)
    const listData = (await listRes.json()) as { messages?: Array<{ id: string }> }
    const ids = (listData.messages ?? []).map((m) => m.id).slice(0, maxResults)

    const messages: GmailMessageSummary[] = []
    for (const id of ids) {
      const summary = await this.getMessageSummary(id, params.signal)
      messages.push(summary)
    }
    return { messages }
  }

  async count(params: { query: string; labelIds?: string[]; includeSpamTrash?: boolean }): Promise<{ count: number }> {
    if (this.isStub()) {
      const q = params.query.toLowerCase()
      const count = STUB_MESSAGES.filter(
        (m) => m.subject.toLowerCase().includes(q) || m.snippet.toLowerCase().includes(q) || !q,
      ).length
      return { count }
    }

    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
    listUrl.searchParams.set('q', params.query)
    listUrl.searchParams.set('maxResults', '1')
    if (params.includeSpamTrash) listUrl.searchParams.set('includeSpamTrash', 'true')
    for (const labelId of params.labelIds ?? []) {
      listUrl.searchParams.append('labelIds', labelId)
    }

    const listRes = await fetchWithBackoff('gmail.count', listUrl, {
      headers: { authorization: `Bearer ${this.accessToken}` },
    })
    if (!listRes.ok) throw gmailApiError('gmail.count', listRes.status)
    const listData = (await listRes.json()) as { resultSizeEstimate?: number; messages?: Array<{ id: string }> }
    return { count: listData.resultSizeEstimate ?? listData.messages?.length ?? 0 }
  }

  private async getMessageSummary(id: string, signal?: AbortSignal): Promise<GmailMessageSummary> {
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`)
    url.searchParams.set('format', 'metadata')
    for (const header of ['From', 'Subject', 'Date']) {
      url.searchParams.append('metadataHeaders', header)
    }

    const res = await fetchWithBackoff('gmail.search.metadata', url, {
      headers: { authorization: `Bearer ${this.accessToken}` },
      signal,
    })
    if (!res.ok) throw gmailApiError('gmail.search.metadata', res.status)
    const raw = (await res.json()) as Record<string, unknown>
    const summary = parseMessageListItem(raw)
    if (!summary) throw new Error('gmail.search: invalid metadata payload')
    return summary
  }

  async getMessage(params: { id: string }): Promise<GmailMessageDetail> {
    if (this.isStub()) {
      const hit = STUB_MESSAGES.find((m) => m.id === params.id) ?? STUB_MESSAGES[0]
      return {
        ...hit,
        to: 'me@example.com',
        cc: '',
        messageIdHeader: `<${hit.id}@example.com>`,
        labelIds: ['INBOX'],
        body: hit.snippet,
        attachments: [],
      }
    }

    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(params.id)}?format=full`
    const res = await fetchWithBackoff('gmail.get_message', url, {
      headers: { authorization: `Bearer ${this.accessToken}` },
    })
    if (!res.ok) throw gmailApiError('gmail.get_message', res.status)
    return parseMessageDetail((await res.json()) as Record<string, unknown>)
  }

  async getThread(params: { threadId: string }): Promise<{ threadId: string; messages: GmailMessageDetail[] }> {
    if (this.isStub()) {
      return { threadId: params.threadId, messages: [await this.getMessage({ id: 'stub-msg-1' })] }
    }
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(params.threadId)}?format=full`
    const res = await fetchWithBackoff('gmail.get_thread', url, {
      headers: { authorization: `Bearer ${this.accessToken}` },
    })
    if (!res.ok) throw gmailApiError('gmail.get_thread', res.status)
    const raw = (await res.json()) as { id?: string; messages?: Array<Record<string, unknown>> }
    return { threadId: raw.id ?? params.threadId, messages: (raw.messages ?? []).map(parseMessageDetail) }
  }

  async listLabels(): Promise<{ labels: GmailLabel[] }> {
    if (this.isStub()) {
      return { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] }
    }
    const res = await fetchWithBackoff('gmail.list_labels', 'https://gmail.googleapis.com/gmail/v1/users/me/labels', {
      headers: { authorization: `Bearer ${this.accessToken}` },
    })
    if (!res.ok) throw gmailApiError('gmail.list_labels', res.status)
    const raw = (await res.json()) as { labels?: Array<{ id?: string; name?: string; type?: string }> }
    return {
      labels: (raw.labels ?? []).map((l) => ({ id: l.id ?? '', name: l.name ?? '', type: l.type ?? 'user' })),
    }
  }

  async listDrafts(params: { maxResults?: number }): Promise<{ drafts: GmailDraftSummary[] }> {
    if (this.isStub()) return { drafts: [] }
    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/drafts')
    listUrl.searchParams.set('maxResults', String(params.maxResults ?? 10))
    const res = await fetchWithBackoff('gmail.list_drafts', listUrl, {
      headers: { authorization: `Bearer ${this.accessToken}` },
    })
    if (!res.ok) throw gmailApiError('gmail.list_drafts', res.status)
    const raw = (await res.json()) as { drafts?: Array<{ id?: string }> }
    const drafts: GmailDraftSummary[] = []
    for (const { id } of raw.drafts ?? []) {
      if (!id) continue
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(id)}`)
      url.searchParams.set('format', 'metadata')
      const draftRes = await fetchWithBackoff('gmail.get_draft', url, {
        headers: { authorization: `Bearer ${this.accessToken}` },
      })
      if (!draftRes.ok) throw gmailApiError('gmail.get_draft', draftRes.status)
      const draft = (await draftRes.json()) as { message?: Record<string, unknown> }
      const message = draft.message ?? {}
      const headers = ((message.payload as Record<string, unknown>)?.headers as Array<{ name?: string; value?: string }>) ?? []
      drafts.push({
        draftId: id,
        messageId: String(message.id ?? ''),
        threadId: String(message.threadId ?? ''),
        to: extractHeader(headers, 'To'),
        subject: extractHeader(headers, 'Subject'),
        snippet: String(message.snippet ?? ''),
      })
    }
    return { drafts }
  }

  async getProfileEmail(): Promise<string> {
    if (this.isStub()) return 'me@example.com'
    const res = await fetchWithBackoff('gmail.profile', 'https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { authorization: `Bearer ${this.accessToken}` },
    })
    if (!res.ok) throw gmailApiError('gmail.profile', res.status)
    return String(((await res.json()) as { emailAddress?: string }).emailAddress ?? '')
  }

  /** Válaszhoz szükséges fejlécek egy meglévő levélből (szál + hivatkozások). */
  async getReplyContext(params: { messageId: string }): Promise<{
    threadId: string
    from: string
    replyTo: string
    to: string
    cc: string
    subject: string
    messageIdHeader: string
    references: string
  }> {
    if (this.isStub()) {
      return {
        threadId: 'stub-thread-1',
        from: 'noreply@example.com',
        replyTo: '',
        to: 'me@example.com',
        cc: '',
        subject: 'Platform acceptance stub üzenet',
        messageIdHeader: '<stub-msg-1@example.com>',
        references: '',
      }
    }
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(params.messageId)}`)
    url.searchParams.set('format', 'metadata')
    for (const header of ['From', 'Reply-To', 'To', 'Cc', 'Subject', 'Message-ID', 'References']) {
      url.searchParams.append('metadataHeaders', header)
    }
    const res = await fetchWithBackoff('gmail.reply_context', url, {
      headers: { authorization: `Bearer ${this.accessToken}` },
    })
    if (!res.ok) throw gmailApiError('gmail.reply_context', res.status)
    const raw = (await res.json()) as Record<string, unknown>
    const headers = ((raw.payload as Record<string, unknown>)?.headers as Array<{ name?: string; value?: string }>) ?? []
    return {
      threadId: String(raw.threadId ?? ''),
      from: extractHeader(headers, 'From'),
      replyTo: extractHeader(headers, 'Reply-To'),
      to: extractHeader(headers, 'To'),
      cc: extractHeader(headers, 'Cc'),
      subject: extractHeader(headers, 'Subject'),
      messageIdHeader: extractHeader(headers, 'Message-ID'),
      references: extractHeader(headers, 'References'),
    }
  }

  async modifyLabels(params: {
    messageId?: string
    threadId?: string
    addLabelIds: string[]
    removeLabelIds: string[]
  }): Promise<{ id: string; labelIds?: string[] }> {
    const target = params.threadId ? `threads/${encodeURIComponent(params.threadId)}` : `messages/${encodeURIComponent(params.messageId ?? '')}`
    if (this.isStub()) return { id: params.threadId ?? params.messageId ?? '' }
    const res = await fetchWithBackoff('gmail.modify_labels', `https://gmail.googleapis.com/gmail/v1/users/me/${target}/modify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ addLabelIds: params.addLabelIds, removeLabelIds: params.removeLabelIds }),
    })
    if (!res.ok) throw gmailApiError('gmail.modify_labels', res.status)
    const raw = (await res.json()) as { id?: string; labelIds?: string[] }
    return { id: raw.id ?? params.threadId ?? params.messageId ?? '', ...(raw.labelIds ? { labelIds: raw.labelIds } : {}) }
  }

  /** Kukába helyezés (30 napig visszaállítható) — végleges törlés szándékosan nincs. */
  async trash(params: { messageId?: string; threadId?: string }): Promise<{ id: string; trashed: true }> {
    const target = params.threadId ? `threads/${encodeURIComponent(params.threadId)}` : `messages/${encodeURIComponent(params.messageId ?? '')}`
    if (this.isStub()) return { id: params.threadId ?? params.messageId ?? '', trashed: true }
    const res = await fetchWithBackoff('gmail.trash', `https://gmail.googleapis.com/gmail/v1/users/me/${target}/trash`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.accessToken}` },
    })
    if (!res.ok) throw gmailApiError('gmail.trash', res.status)
    return { id: params.threadId ?? params.messageId ?? '', trashed: true }
  }

  async createDraft(params: {
    to?: string
    cc?: string
    bcc?: string
    subject: string
    body: string
    threadId?: string
    inReplyTo?: string
    references?: string
    attachments?: GmailAttachment[]
    signal?: AbortSignal
  }): Promise<{ draftId: string }> {
    if (this.isStub()) {
      return { draftId: `stub-draft-${Date.now()}` }
    }

    const message: Record<string, unknown> = { raw: buildRawMessage(params) }
    if (params.threadId) message.threadId = params.threadId

    const res = await fetchWithBackoff('gmail.create_draft', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message }),
      signal: params.signal,
    })
    if (!res.ok) throw gmailApiError('gmail.create_draft', res.status)
    const data = (await res.json()) as { id?: string }
    return { draftId: data.id ?? 'unknown' }
  }

  /**
   * Diagnosztikai próba-írás takarítása: a létrehozott piszkozat azonnali
   * törlése. Stub módban nincs hálózati hívás.
   */
  async deleteDraft(params: { draftId: string; signal?: AbortSignal }): Promise<{ ok: true }> {
    if (this.isStub()) return { ok: true }
    const res = await fetchWithBackoff(
      'gmail.delete_draft',
      `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(params.draftId)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${this.accessToken}` }, signal: params.signal },
    )
    if (!res.ok) throw gmailApiError('gmail.delete_draft', res.status)
    return { ok: true }
  }

  async send(params: {
    draftId?: string
    to?: string
    cc?: string
    bcc?: string
    subject?: string
    body?: string
    threadId?: string
    inReplyTo?: string
    references?: string
  }): Promise<{ messageId: string; threadId?: string }> {
    if (this.isStub()) {
      return { messageId: `stub-sent-${Date.now()}` }
    }

    if (params.draftId) {
      const res = await fetchWithBackoff('gmail.send', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/send', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ id: params.draftId }),
      })
      if (!res.ok) throw gmailApiError('gmail.send', res.status)
      const data = (await res.json()) as { id?: string; threadId?: string }
      return { messageId: data.id ?? 'unknown', ...(data.threadId ? { threadId: data.threadId } : {}) }
    }

    if (!params.to || !params.subject || !params.body) {
      throw new Error('gmail.send requires draftId or to/subject/body')
    }

    const message: Record<string, unknown> = {
      raw: buildRawMessage({
        to: params.to,
        cc: params.cc,
        bcc: params.bcc,
        subject: params.subject,
        body: params.body,
        inReplyTo: params.inReplyTo,
        references: params.references,
      }),
    }
    if (params.threadId) message.threadId = params.threadId

    const res = await fetchWithBackoff('gmail.send', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(message),
    })
    if (!res.ok) throw gmailApiError('gmail.send', res.status)
    const data = (await res.json()) as { id?: string; threadId?: string }
    return { messageId: data.id ?? 'unknown', ...(data.threadId ? { threadId: data.threadId } : {}) }
  }
}
