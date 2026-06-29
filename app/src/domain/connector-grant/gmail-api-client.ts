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

export type GmailMessageDetail = GmailMessageSummary & {
  to: string
  body: string
}

const STUB_MESSAGES: GmailMessageSummary[] = [
  {
    id: 'stub-msg-1',
    threadId: 'stub-thread-1',
    from: 'noreply@example.com',
    subject: 'MVP acceptance stub üzenet',
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

function gmailApiError(operation: string, status: number): Error {
  if (status === 401 || status === 403) {
    return new GmailApiAuthError(`${operation} auth failed: ${status}`, status)
  }
  return new Error(`${operation} failed: ${status}`)
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

function buildRawMessage(params: { to: string; subject: string; body: string }): string {
  const lines = [
    `To: ${params.to}`,
    `Subject: ${encodeMimeHeaderValue(params.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    params.body,
  ]
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url')
}

export class GmailApiClient {
  constructor(private accessToken: string) {}

  private isStub(): boolean {
    return process.env.GMAIL_API_STUB === 'true' || this.accessToken.startsWith('stub-')
  }

  async search(params: { query: string; maxResults?: number }): Promise<{ messages: GmailMessageSummary[] }> {
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
    })
    if (!listRes.ok) throw gmailApiError('gmail.search', listRes.status)
    const listData = (await listRes.json()) as { messages?: Array<{ id: string }> }
    const ids = (listData.messages ?? []).map((m) => m.id).slice(0, maxResults)

    const messages: GmailMessageSummary[] = []
    for (const id of ids) {
      const summary = await this.getMessageSummary(id)
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

  private async getMessageSummary(id: string): Promise<GmailMessageSummary> {
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`)
    url.searchParams.set('format', 'metadata')
    for (const header of ['From', 'Subject', 'Date']) {
      url.searchParams.append('metadataHeaders', header)
    }

    const res = await fetchWithBackoff('gmail.search.metadata', url, {
      headers: { authorization: `Bearer ${this.accessToken}` },
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
      return { ...hit, to: 'me@example.com', body: hit.snippet }
    }

    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(params.id)}?format=full`
    const res = await fetchWithBackoff('gmail.get_message', url, {
      headers: { authorization: `Bearer ${this.accessToken}` },
    })
    if (!res.ok) throw gmailApiError('gmail.get_message', res.status)
    const raw = (await res.json()) as Record<string, unknown>
    const summary = parseMessageListItem(raw)
    if (!summary) throw new Error('gmail.get_message: invalid payload')

    const payload = (raw.payload as Record<string, unknown>) ?? {}
    const parts = (payload.parts as Array<Record<string, unknown>>) ?? []
    let body = ''
    const dataPart = parts.find((p) => p.mimeType === 'text/plain') ?? parts[0]
    if (dataPart?.body && typeof dataPart.body === 'object') {
      const bodyData = (dataPart.body as { data?: string }).data
      if (bodyData) body = decodeBase64Url(bodyData)
    } else if (payload.body && typeof payload.body === 'object') {
      const bodyData = (payload.body as { data?: string }).data
      if (bodyData) body = decodeBase64Url(bodyData)
    }

    return {
      ...summary,
      to: extractHeader((payload.headers as Array<{ name?: string; value?: string }>) ?? [], 'To'),
      body: body || summary.snippet,
    }
  }

  async createDraft(params: {
    to: string
    subject: string
    body: string
    threadId?: string
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
    })
    if (!res.ok) throw gmailApiError('gmail.create_draft', res.status)
    const data = (await res.json()) as { id?: string }
    return { draftId: data.id ?? 'unknown' }
  }

  async send(params: { draftId?: string; to?: string; subject?: string; body?: string }): Promise<{ messageId: string }> {
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
      const data = (await res.json()) as { id?: string }
      return { messageId: data.id ?? 'unknown' }
    }

    if (!params.to || !params.subject || !params.body) {
      throw new Error('gmail.send requires draftId or to/subject/body')
    }

    const res = await fetchWithBackoff('gmail.send', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        raw: buildRawMessage({
          to: params.to,
          subject: params.subject,
          body: params.body,
        }),
      }),
    })
    if (!res.ok) throw gmailApiError('gmail.send', res.status)
    const data = (await res.json()) as { id?: string }
    return { messageId: data.id ?? 'unknown' }
  }
}
