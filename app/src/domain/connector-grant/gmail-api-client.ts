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

    const listRes = await fetch(listUrl, {
      headers: { authorization: `Bearer ${this.accessToken}` },
    })
    if (!listRes.ok) throw new Error(`gmail.search failed: ${listRes.status}`)
    const listData = (await listRes.json()) as { messages?: Array<{ id: string }> }
    const ids = (listData.messages ?? []).map((m) => m.id).slice(0, maxResults)

    const messages: GmailMessageSummary[] = []
    for (const id of ids) {
      const detail = await this.getMessage({ id })
      messages.push(detail)
    }
    return { messages }
  }

  async getMessage(params: { id: string }): Promise<GmailMessageDetail> {
    if (this.isStub()) {
      const hit = STUB_MESSAGES.find((m) => m.id === params.id) ?? STUB_MESSAGES[0]
      return { ...hit, to: 'me@example.com', body: hit.snippet }
    }

    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(params.id)}?format=full`
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.accessToken}` } })
    if (!res.ok) throw new Error(`gmail.get_message failed: ${res.status}`)
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

    const lines = [
      `To: ${params.to}`,
      `Subject: ${params.subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      params.body,
    ]
    const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url')
    const message: Record<string, unknown> = { raw }
    if (params.threadId) message.threadId = params.threadId

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message }),
    })
    if (!res.ok) throw new Error(`gmail.create_draft failed: ${res.status}`)
    const data = (await res.json()) as { id?: string }
    return { draftId: data.id ?? 'unknown' }
  }

  async send(params: { draftId?: string; to?: string; subject?: string; body?: string }): Promise<{ messageId: string }> {
    if (this.isStub()) {
      return { messageId: `stub-sent-${Date.now()}` }
    }

    if (params.draftId) {
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ id: params.draftId }),
      })
      if (!res.ok) throw new Error(`gmail.send draft failed: ${res.status}`)
      const data = (await res.json()) as { id?: string }
      return { messageId: data.id ?? 'unknown' }
    }

    if (!params.to || !params.subject || !params.body) {
      throw new Error('gmail.send requires draftId or to/subject/body')
    }

    const draft = await this.createDraft({
      to: params.to,
      subject: params.subject,
      body: params.body,
    })
    return this.send({ draftId: draft.draftId })
  }
}
