/**
 * #1032 szolgáltatói kliensek a bejövő levelekhez: csak fejléc-adatot kérnek le (a törzset nem),
 * és kezelik a push-feliratkozásokat. A `fetch` injektálható (tesztben nincs hálózat).
 */
import type { InboundMailHeaders } from './inbound-mail'

type Fetch = typeof fetch
const TIMEOUT_MS = 10_000
/** Ennyi levelet nézünk meg egy polling-lekérdezésben. */
export const RECENT_LIMIT = 25

export class MailProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'MailProviderHttpError'
  }
}

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

function dateOf(value: unknown, fallback: Date): Date {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN
  const d = Number.isFinite(n) ? new Date(n) : typeof value === 'string' ? new Date(value) : fallback
  return Number.isNaN(d.getTime()) ? fallback : d
}

const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value)

function headerMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(value)) {
    for (const row of value) {
      if (!isRecord(row)) continue
      const name = str(row.name).toLowerCase()
      if (name) out[name] = clip(str(row.value), 500)
    }
  } else if (isRecord(value)) {
    for (const [name, v] of Object.entries(value)) out[name.toLowerCase()] = clip(str(v), 500)
  }
  return out
}

function headers(input: {
  messageId: string
  threadId: string
  from: string
  subject: string
  receivedAt: Date
  labels: string[]
  headers: Record<string, string>
}): InboundMailHeaders {
  return {
    messageId: clip(input.messageId, 500),
    threadId: input.threadId ? clip(input.threadId, 500) : null,
    from: clip(input.from, 320),
    subject: clip(input.subject, 500),
    receivedAt: input.receivedAt,
    labels: input.labels.slice(0, 30).map((label) => clip(label, 100)),
    headers: input.headers,
  }
}

async function http(fetchImpl: Fetch, url: string, init: RequestInit & { token: string }): Promise<unknown> {
  const { token, ...rest } = init
  const res = await fetchImpl(url, {
    ...rest,
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
    },
  })
  if (res.status === 204) return null
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const message = isRecord(body) ? str(isRecord(body.error) ? body.error.message : body.message ?? body.error) : ''
    throw new MailProviderHttpError(res.status, message || `HTTP ${res.status}`)
  }
  return body
}

// --- AgentMail ---

export function agentMailMessageHeaders(raw: unknown, now = new Date()): InboundMailHeaders | null {
  if (!isRecord(raw)) return null
  const messageId = str(raw.message_id ?? raw.messageId ?? raw.id)
  if (!messageId) return null
  return headers({
    messageId,
    threadId: str(raw.thread_id ?? raw.threadId),
    from: str(raw.from),
    subject: str(raw.subject),
    receivedAt: dateOf(raw.timestamp ?? raw.created_at, now),
    labels: Array.isArray(raw.labels) ? raw.labels.map(str).filter(Boolean) : [],
    headers: headerMap(raw.headers),
  })
}

/** AgentMail webhook (`message.received`): a postafiók azonosítója és a levél fejléce. */
export function parseAgentMailEvent(body: unknown, now = new Date()): { inboxId: string; mail: InboundMailHeaders } | null {
  if (!isRecord(body)) return null
  const type = str(body.event_type ?? body.type)
  if (type !== 'message.received') return null
  const message = isRecord(body.message) ? body.message : null
  const mail = agentMailMessageHeaders(message, now)
  const inboxId = str(message?.inbox_id ?? message?.inboxId)
  return mail && inboxId ? { inboxId, mail } : null
}

export const agentMail = {
  /** A postafiók legutóbbi levelei (csak fejléc), a postafiók szűk kulcsával. */
  async listRecent(fetchImpl: Fetch, inboxBaseUrl: string, inboxKey: string, now = new Date()): Promise<InboundMailHeaders[]> {
    const body = await http(fetchImpl, `${inboxBaseUrl}/messages?limit=${RECENT_LIMIT}`, { method: 'GET', token: inboxKey })
    const rows = isRecord(body) && Array.isArray(body.messages) ? body.messages : Array.isArray(body) ? body : []
    return rows.map((row) => agentMailMessageHeaders(row, now)).filter((row): row is InboundMailHeaders => Boolean(row))
  },
  async getHeaders(fetchImpl: Fetch, inboxBaseUrl: string, inboxKey: string, messageId: string, now = new Date()): Promise<InboundMailHeaders | null> {
    const body = await http(fetchImpl, `${inboxBaseUrl}/messages/${encodeURIComponent(messageId)}`, { method: 'GET', token: inboxKey })
    return agentMailMessageHeaders(body, now)
  },
  /** Webhook a szervezeti kulccsal, egy postafiókra szűkítve. A válasz `secret`-je nélkül nem használható. */
  async createWebhook(
    fetchImpl: Fetch,
    apiBase: string,
    orgKey: string,
    input: { url: string; inboxId: string; clientId: string },
  ): Promise<{ webhookId: string; secret: string }> {
    const body = await http(fetchImpl, `${apiBase}/webhooks`, {
      method: 'POST',
      token: orgKey,
      body: JSON.stringify({
        url: input.url,
        event_types: ['message.received'],
        inbox_ids: [input.inboxId],
        client_id: input.clientId,
      }),
    })
    const webhookId = isRecord(body) ? str(body.webhook_id ?? body.id) : ''
    const secret = isRecord(body) ? str(body.secret) : ''
    if (!webhookId || !secret) throw new MailProviderHttpError(502, 'agentmail_webhook_without_secret')
    return { webhookId, secret }
  },
}

// --- Gmail ---

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
/** Csak ezek a fejlécek kellenek (feladó, tárgy + a hurok-őr jelölői). */
export const GMAIL_METADATA_HEADERS = [
  'From',
  'Subject',
  'Date',
  'Auto-Submitted',
  'Precedence',
  'X-Autoreply',
  'X-Autorespond',
  'X-Auto-Response-Suppress',
  'List-Id',
]

export function gmailMessageHeaders(raw: unknown, now = new Date()): InboundMailHeaders | null {
  if (!isRecord(raw)) return null
  const messageId = str(raw.id)
  if (!messageId) return null
  const payload = isRecord(raw.payload) ? raw.payload : {}
  const h = headerMap(payload.headers)
  return headers({
    messageId,
    threadId: str(raw.threadId),
    from: h.from ?? '',
    subject: h.subject ?? '',
    receivedAt: dateOf(raw.internalDate, now),
    labels: Array.isArray(raw.labelIds) ? raw.labelIds.map(str).filter(Boolean) : [],
    headers: h,
  })
}

/** Pub/Sub push törzse: `message.data` = base64 JSON `{ emailAddress, historyId }`. */
export function decodeGmailPush(body: unknown): { emailAddress: string; historyId: string } | null {
  if (!isRecord(body) || !isRecord(body.message) || typeof body.message.data !== 'string') return null
  try {
    const data: unknown = JSON.parse(Buffer.from(body.message.data, 'base64').toString('utf8'))
    if (!isRecord(data)) return null
    const emailAddress = str(data.emailAddress).toLowerCase()
    const historyId = str(data.historyId)
    return emailAddress && /^\d+$/.test(historyId) ? { emailAddress, historyId } : null
  } catch {
    return null
  }
}

export const gmail = {
  async getHeaders(fetchImpl: Fetch, token: string, id: string, now = new Date()): Promise<InboundMailHeaders | null> {
    const url = new URL(`${GMAIL}/messages/${encodeURIComponent(id)}`)
    url.searchParams.set('format', 'metadata')
    for (const name of GMAIL_METADATA_HEADERS) url.searchParams.append('metadataHeaders', name)
    return gmailMessageHeaders(await http(fetchImpl, url.toString(), { method: 'GET', token }), now)
  },
  /** A beérkező mappa legutóbbi levelei (csak azonosítók). */
  async listRecentIds(fetchImpl: Fetch, token: string): Promise<string[]> {
    const url = new URL(`${GMAIL}/messages`)
    url.searchParams.set('q', 'in:inbox newer_than:2d')
    url.searchParams.set('maxResults', String(RECENT_LIMIT))
    const body = await http(fetchImpl, url.toString(), { method: 'GET', token })
    const rows = isRecord(body) && Array.isArray(body.messages) ? body.messages : []
    return rows.map((row) => (isRecord(row) ? str(row.id) : '')).filter(Boolean)
  },
  /**
   * Új levelek a `startHistoryId` óta (csak beérkezett mappa). `expired` = a kurzor túl régi (404),
   * ilyenkor a hívó a legutóbbi levelekre esik vissza.
   */
  async historySince(
    fetchImpl: Fetch,
    token: string,
    startHistoryId: string,
  ): Promise<{ ids: string[]; historyId: string | null; expired: boolean }> {
    const url = new URL(`${GMAIL}/history`)
    url.searchParams.set('startHistoryId', startHistoryId)
    url.searchParams.set('historyTypes', 'messageAdded')
    url.searchParams.set('labelId', 'INBOX')
    url.searchParams.set('maxResults', '100')
    try {
      const ids = new Set<string>()
      let historyId: string | null = null
      let pageToken = ''
      do {
        if (pageToken) url.searchParams.set('pageToken', pageToken)
        const body = await http(fetchImpl, url.toString(), { method: 'GET', token })
        const history = isRecord(body) && Array.isArray(body.history) ? body.history : []
        for (const row of history) {
          const added = isRecord(row) && Array.isArray(row.messagesAdded) ? row.messagesAdded : []
          for (const entry of added) {
            const id = isRecord(entry) && isRecord(entry.message) ? str(entry.message.id) : ''
            if (id) ids.add(id)
          }
        }
        historyId = isRecord(body) ? str(body.historyId) || null : null
        pageToken = isRecord(body) ? str(body.nextPageToken) : ''
      } while (pageToken)
      return { ids: [...ids], historyId, expired: false }
    } catch (error) {
      if (error instanceof MailProviderHttpError && error.status === 404) return { ids: [], historyId: null, expired: true }
      throw error
    }
  },
  async watch(fetchImpl: Fetch, token: string, topicName: string): Promise<{ historyId: string; expiresAt: Date }> {
    const body = await http(fetchImpl, `${GMAIL}/watch`, {
      method: 'POST',
      token,
      body: JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterBehavior: 'include' }),
    })
    const historyId = isRecord(body) ? str(body.historyId) : ''
    const expiration = isRecord(body) ? Number(str(body.expiration)) : NaN
    if (!historyId || !Number.isFinite(expiration)) throw new MailProviderHttpError(502, 'gmail_watch_invalid_response')
    return { historyId, expiresAt: new Date(expiration) }
  },
}

// --- Microsoft Graph ---

const GRAPH = 'https://graph.microsoft.com/v1.0'
export const GRAPH_INBOX_RESOURCE = "me/mailFolders('inbox')/messages"
const GRAPH_SELECT = 'id,conversationId,from,subject,receivedDateTime,internetMessageHeaders'
/** A levél-feliratkozás max. élettartama ~70 óra; 2 naponként megújítjuk. */
export const GRAPH_SUBSCRIPTION_TTL_MS = 2 * 24 * 60 * 60 * 1000

export function graphMessageHeaders(raw: unknown, now = new Date()): InboundMailHeaders | null {
  if (!isRecord(raw)) return null
  const messageId = str(raw.id)
  if (!messageId) return null
  return headers({
    messageId,
    threadId: str(raw.conversationId),
    from: str(raw.from),
    subject: str(raw.subject),
    receivedAt: dateOf(raw.receivedDateTime, now),
    labels: [],
    headers: headerMap(raw.internetMessageHeaders),
  })
}

export type GraphNotification = { subscriptionId: string; clientState: string | null; messageId: string }

/** Graph change-notification törzse (`value[]`); a lifecycle-értesítéseket kihagyjuk. */
export function parseGraphNotifications(body: unknown): GraphNotification[] {
  if (!isRecord(body) || !Array.isArray(body.value)) return []
  return body.value.flatMap((row) => {
    if (!isRecord(row) || row.lifecycleEvent) return []
    const subscriptionId = str(row.subscriptionId)
    const resourceData = isRecord(row.resourceData) ? row.resourceData : {}
    const messageId = str(resourceData.id) || (/messages\/([^/]+)$/i.exec(str(row.resource))?.[1] ?? '')
    if (!subscriptionId || !messageId) return []
    return [{ subscriptionId, clientState: typeof row.clientState === 'string' ? row.clientState : null, messageId }]
  })
}

export const graph = {
  async getHeaders(fetchImpl: Fetch, token: string, id: string, now = new Date()): Promise<InboundMailHeaders | null> {
    const body = await http(fetchImpl, `${GRAPH}/me/messages/${encodeURIComponent(id)}?$select=${GRAPH_SELECT}`, { method: 'GET', token })
    return graphMessageHeaders(body, now)
  },
  async listRecent(fetchImpl: Fetch, token: string, now = new Date()): Promise<InboundMailHeaders[]> {
    const params = new URLSearchParams({ $top: String(RECENT_LIMIT), $orderby: 'receivedDateTime desc', $select: GRAPH_SELECT })
    const body = await http(fetchImpl, `${GRAPH}/${GRAPH_INBOX_RESOURCE}?${params.toString()}`, { method: 'GET', token })
    const rows = isRecord(body) && Array.isArray(body.value) ? body.value : []
    return rows.map((row) => graphMessageHeaders(row, now)).filter((row): row is InboundMailHeaders => Boolean(row))
  },
  async createSubscription(
    fetchImpl: Fetch,
    token: string,
    input: { notificationUrl: string; clientState: string; expiresAt: Date },
  ): Promise<{ subscriptionId: string; expiresAt: Date }> {
    const body = await http(fetchImpl, `${GRAPH}/subscriptions`, {
      method: 'POST',
      token,
      body: JSON.stringify({
        changeType: 'created',
        notificationUrl: input.notificationUrl,
        resource: GRAPH_INBOX_RESOURCE,
        expirationDateTime: input.expiresAt.toISOString(),
        clientState: input.clientState,
      }),
    })
    const subscriptionId = isRecord(body) ? str(body.id) : ''
    if (!subscriptionId) throw new MailProviderHttpError(502, 'graph_subscription_invalid_response')
    return { subscriptionId, expiresAt: dateOf(isRecord(body) ? body.expirationDateTime : null, input.expiresAt) }
  },
  async renewSubscription(fetchImpl: Fetch, token: string, subscriptionId: string, expiresAt: Date): Promise<Date> {
    const body = await http(fetchImpl, `${GRAPH}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify({ expirationDateTime: expiresAt.toISOString() }),
    })
    return dateOf(isRecord(body) ? body.expirationDateTime : null, expiresAt)
  },
}
