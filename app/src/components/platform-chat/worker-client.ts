/**
 * #1004 D7: a platform UI a chatet CSAK a worker HTTP-API-ján éri el (a chat-domaint nem importálja).
 * A chat-token a `/api/chat/session`-ből jön (Clerk-session), lejárat előtt csendben frissül.
 */

export type ChatSession = { token: string; expiresAt: string; workerUrl: string; tenantSlug: string; adminInsight: boolean }
export type ChatAgent = { agentId: string; name: string; description: string | null }
export type ChatConversation = { id: string; agentId: string; agentName: string; title: string; createdAt: string; lastActivityAt: string; userId?: string }
export type ChatAttachment = { id: string; name: string; mime: string; size: number }
export type ChatMessageView = { id: string; role: 'user' | 'assistant'; content: string; attachments: ChatAttachment[]; createdAt: string }
export type ConversationView = {
  conversation: ChatConversation
  messages: ChatMessageView[]
  activeTurn: { id: string; status: string; pendingApproval: { message: string; createdAt: string } | null } | null
  lastError: { turnId: string; message: string | null } | null
}
export type TurnEvent = { id: number; type: 'delta' | 'status' | 'tool' | 'approval' | 'done' | 'error'; data: Record<string, unknown> }

export class ChatApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const REFRESH_BEFORE_MS = 90_000

export async function fetchChatSession(): Promise<ChatSession> {
  const res = await fetch('/api/chat/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const body = (await res.json().catch(() => ({}))) as Partial<ChatSession> & { error?: string }
  if (!res.ok || !body.token) throw new ChatApiError(res.status, body.error ?? 'session_failed', body.error ?? 'session_failed')
  return body as ChatSession
}

export function createWorkerClient(initial: ChatSession) {
  let session = initial
  let refreshing: Promise<ChatSession> | null = null

  async function current(): Promise<ChatSession> {
    if (Date.parse(session.expiresAt) - Date.now() > REFRESH_BEFORE_MS) return session
    refreshing ??= fetchChatSession().finally(() => {
      refreshing = null
    })
    session = await refreshing
    return session
  }

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const s = await current()
    const res = await fetch(`${s.workerUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${s.token}`,
        ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
    const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string }
    if (!res.ok) throw new ChatApiError(res.status, body.error ?? 'request_failed', body.message ?? body.error ?? 'request_failed')
    return body
  }

  return {
    get adminInsight() {
      return session.adminInsight
    },
    agents: () => call<{ agents: ChatAgent[]; adminInsight: boolean }>('/agents'),
    conversations: (input: { agentId?: string; q?: string }) => {
      const params = new URLSearchParams()
      if (input.agentId) params.set('agentId', input.agentId)
      if (input.q) params.set('q', input.q)
      return call<{ conversations: ChatConversation[] }>(`/conversations?${params}`)
    },
    createConversation: (agentId: string) =>
      call<{ conversation: ChatConversation }>('/conversations', { method: 'POST', body: JSON.stringify({ agentId }) }),
    conversation: (id: string) => call<ConversationView>(`/conversations/${id}`),
    rename: (id: string, title: string) => call(`/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
    remove: (id: string) => call(`/conversations/${id}`, { method: 'DELETE' }),
    send: (id: string, content: string, attachmentIds: string[]) =>
      call<{ turnId: string }>(`/conversations/${id}/turns`, { method: 'POST', body: JSON.stringify({ content, attachmentIds }) }),
    cancel: (turnId: string) => call(`/turns/${turnId}/cancel`, { method: 'POST', body: '{}' }),
    approve: (turnId: string, decision: 'approve' | 'reject') =>
      call<{ outcome: string }>(`/turns/${turnId}/approval`, { method: 'POST', body: JSON.stringify({ decision }) }),
    upload: (id: string, file: File) =>
      call<{ attachment: ChatAttachment }>(`/conversations/${id}/attachments`, {
        method: 'POST',
        body: file,
        headers: { 'x-file-name': encodeURIComponent(file.name), 'content-type': file.type || 'application/octet-stream' },
      }),
    adminConversations: (input: { q?: string }) =>
      call<{ conversations: ChatConversation[] }>(`/admin/conversations${input.q ? `?q=${encodeURIComponent(input.q)}` : ''}`),
    adminConversation: (id: string) => call<ConversationView>(`/admin/conversations/${id}`),

    /**
     * SSE fetch-streammel (a fejlécben a token; EventSource ezt nem tudná). A szerver a forduló
     * végén vagy 2 perc csend után zár; ilyenkor, ha a forduló még fut, `Last-Event-ID`-vel újracsatlakozunk.
     */
    async stream(turnId: string, onEvent: (e: TurnEvent) => void, signal: AbortSignal, after = 0): Promise<number> {
      let lastId = after
      let finished = false
      // Jóváhagyásra váró forduló: a szerver zár, és a kártya gombja indít új streamet.
      let awaitingApproval = false
      while (!finished && !signal.aborted) {
        const s = await current()
        const res = await fetch(`${s.workerUrl}/turns/${turnId}/events`, {
          headers: { authorization: `Bearer ${s.token}`, 'last-event-id': String(lastId) },
          signal,
        })
        if (!res.ok || !res.body) throw new ChatApiError(res.status, 'stream_failed', 'stream_failed')
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let sawEvent = false
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            const id = Number(/^id: (\d+)/m.exec(block)?.[1] ?? 0)
            const type = /^event: (\w+)/m.exec(block)?.[1] as TurnEvent['type'] | undefined
            const data = /^data: (.*)$/m.exec(block)?.[1]
            if (!type || !data) continue
            sawEvent = true
            lastId = Math.max(lastId, id)
            const event = { id, type, data: JSON.parse(data) as Record<string, unknown> }
            if (type === 'approval') awaitingApproval = event.data.phase === 'requested'
            onEvent(event)
            if (type === 'done' || type === 'error') finished = true
          }
        }
        if (awaitingApproval) break
        // Csend miatti zárás (2 perc): újracsatlakozás; ne pörögjön, ha a szerver azonnal zár.
        if (!finished && !sawEvent) await new Promise((r) => setTimeout(r, 1500))
      }
      return lastId
    },
  }
}

export type WorkerClient = ReturnType<typeof createWorkerClient>
