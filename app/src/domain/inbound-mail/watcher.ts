/**
 * #1032 postafiók-figyelés: push-feliratkozás (AgentMail webhook, Gmail watch, Graph subscription)
 * létrehozása és megújítása, a beérkező push-értesítések feldolgozása, és tartalék polling
 * (modellhívás nélkül, csak fejlécek). Minden külső függőség injektált.
 */
import type { InboundMailHeaders } from './inbound-mail'
import {
  agentMail,
  gmail,
  graph,
  GRAPH_SUBSCRIPTION_TTL_MS,
  MailProviderHttpError,
  parseAgentMailEvent,
  parseGraphNotifications,
} from './providers'
import type { InboundMailService, InboundMailStore, WatchedMailbox } from './service'
import { clientStateMatches, verifySvixSignature } from './webhook-auth'

export type WatchState = {
  connectorId: string
  provider: string
  externalId: string | null
  cursor: string | null
  expiresAt: Date | null
  lastError?: string | null
  lastPolledAt: Date | null
  createdAt: Date
}

export type WatchPatch = Partial<Pick<WatchState, 'externalId' | 'cursor' | 'expiresAt' | 'lastPolledAt'>> & {
  lastEventAt?: Date | null
  lastError?: string | null
}

export type WatcherDeps = {
  service: InboundMailService
  store: Pick<InboundMailStore, 'knownMessageIds'>
  watches: {
    find(connectorId: string): Promise<WatchState | null>
    findByExternalId(provider: string, externalId: string): Promise<WatchState | null>
    listByProvider(provider: string): Promise<WatchState[]>
    upsert(input: { tenantId: string; connectorId: string; provider: string } & WatchPatch): Promise<WatchState>
    update(connectorId: string, patch: WatchPatch): Promise<unknown>
  }
  loadMailbox(connectorId: string): Promise<WatchedMailbox | null>
  /** Figyelt postafiókok (opcionálisan egy cégé). */
  listMailboxes(tenantId?: string): Promise<WatchedMailbox[]>
  credentials: {
    agentMailInbox(connectorId: string): Promise<{ baseUrl: string; inboxId: string; inboxKey: string } | null>
    agentMailOrg(tenantId: string): Promise<{ apiBase: string; orgKey: string } | null>
    /** Tenant-postafiók (Gmail / M365) OAuth access tokenje. */
    oauthToken(mailbox: WatchedMailbox): Promise<string>
  }
  secrets: {
    save(connectorId: string, secret: string): Promise<void>
    load(connectorId: string): Promise<string | null>
  }
  config: {
    /** Nyilvános https origin a webhook-címekhez; null = csak polling (pl. helyi fejlesztés). */
    publicOrigin: string | null
    /** Gmail push Pub/Sub topic (`projects/…/topics/…`); null = Gmailnél csak polling. */
    gmailTopic: string | null
  }
  fetchImpl?: typeof fetch
  now?: () => Date
  randomSecret?: () => string
}

/** Lejárat előtt ennyivel újítunk (Gmail 7 nap, Graph ~3 nap). */
export const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000

const MAX_DETAIL_FETCH = 10

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

export class MailboxWatcher {
  constructor(private readonly deps: WatcherDeps) {}

  private now() {
    return (this.deps.now ?? (() => new Date()))()
  }

  private get fetchImpl() {
    return this.deps.fetchImpl ?? fetch
  }

  private webhookUrl(provider: string, connectorId?: string): string | null {
    const origin = this.deps.config.publicOrigin
    if (!origin || !origin.startsWith('https://')) return null
    return `${origin}/api/webhooks/mail/${provider}${connectorId ? `?c=${encodeURIComponent(connectorId)}` : ''}`
  }

  /** A figyelés állapota (első alkalommal létrehozva: ettől az időponttól fogadunk levelet). */
  private async state(mailbox: WatchedMailbox): Promise<WatchState> {
    return (
      (await this.deps.watches.find(mailbox.connectorId)) ??
      (await this.deps.watches.upsert({ tenantId: mailbox.tenantId, connectorId: mailbox.connectorId, provider: mailbox.provider }))
    )
  }

  /**
   * Csak a figyelés kezdete utáni levelek számítanak: a bekötéskor már meglévő levelekből nem lesz
   * (tömeges) esemény. 1 perc tűrés az óra-eltérésre.
   */
  private fresh(state: WatchState, mails: InboundMailHeaders[]): InboundMailHeaders[] {
    const since = state.createdAt.getTime() - 60_000
    return mails.filter((mail) => mail.receivedAt.getTime() >= since)
  }

  private async ingest(mailbox: WatchedMailbox, state: WatchState, mails: InboundMailHeaders[], source: string) {
    const fresh = this.fresh(state, mails)
    if (fresh.length === 0) return []
    const outcomes = await this.deps.service.ingest(mailbox, fresh, source)
    await this.deps.watches.update(mailbox.connectorId, { lastEventAt: this.now() })
    return outcomes
  }

  /** Push-feliratkozás létrehozása / megújítása. Hibánál csak polling marad (és naplózzuk). */
  async ensureWatch(mailbox: WatchedMailbox): Promise<'push' | 'poll'> {
    const state = await this.state(mailbox)
    const now = this.now()
    try {
      if (mailbox.provider === 'agentmail') {
        if (state.externalId) return 'push'
        const url = this.webhookUrl('agentmail', mailbox.connectorId)
        const org = url ? await this.deps.credentials.agentMailOrg(mailbox.tenantId) : null
        const inbox = org ? await this.deps.credentials.agentMailInbox(mailbox.connectorId) : null
        if (!url || !org || !inbox) return 'poll'
        const hook = await agentMail.createWebhook(this.fetchImpl, org.apiBase, org.orgKey, {
          url,
          inboxId: inbox.inboxId,
          clientId: `platform-inbound-${mailbox.connectorId}`,
        })
        await this.deps.secrets.save(mailbox.connectorId, hook.secret)
        await this.deps.watches.update(mailbox.connectorId, { externalId: hook.webhookId, lastError: null })
        return 'push'
      }
      if (mailbox.provider === 'google') {
        const topic = this.deps.config.gmailTopic
        if (!topic) return 'poll'
        if (state.externalId && state.expiresAt && state.expiresAt.getTime() - now.getTime() > RENEW_BEFORE_MS) return 'push'
        const token = await this.deps.credentials.oauthToken(mailbox)
        const watch = await gmail.watch(this.fetchImpl, token, topic)
        // Megújításnál a régi kurzor marad: a két hívás között érkezett levél se vesszen el.
        await this.deps.watches.update(mailbox.connectorId, {
          externalId: 'gmail-watch',
          cursor: state.cursor ?? watch.historyId,
          expiresAt: watch.expiresAt,
          lastError: null,
        })
        return 'push'
      }
      const url = this.webhookUrl('microsoft')
      if (!url) return 'poll'
      if (state.externalId && state.expiresAt && state.expiresAt.getTime() - now.getTime() > RENEW_BEFORE_MS) return 'push'
      const token = await this.deps.credentials.oauthToken(mailbox)
      const expiresAt = new Date(now.getTime() + GRAPH_SUBSCRIPTION_TTL_MS)
      if (state.externalId) {
        try {
          const renewed = await graph.renewSubscription(this.fetchImpl, token, state.externalId, expiresAt)
          await this.deps.watches.update(mailbox.connectorId, { expiresAt: renewed, lastError: null })
          return 'push'
        } catch (error) {
          if (!(error instanceof MailProviderHttpError && error.status === 404)) throw error
        }
      }
      const clientState = (this.deps.randomSecret ?? defaultSecret)()
      await this.deps.secrets.save(mailbox.connectorId, clientState)
      const sub = await graph.createSubscription(this.fetchImpl, token, { notificationUrl: url, clientState, expiresAt })
      await this.deps.watches.update(mailbox.connectorId, { externalId: sub.subscriptionId, expiresAt: sub.expiresAt, lastError: null })
      return 'push'
    } catch (error) {
      await this.deps.watches.update(mailbox.connectorId, { lastError: errorText(error) })
      return 'poll'
    }
  }

  /** Tartalék: a legutóbbi levelek fejlécei, csak az új (még nem látott) levelekre kérünk részletet. */
  async poll(mailbox: WatchedMailbox) {
    const state = await this.state(mailbox)
    const fetchImpl = this.fetchImpl
    let mails: InboundMailHeaders[] = []
    if (mailbox.provider === 'agentmail') {
      const inbox = await this.deps.credentials.agentMailInbox(mailbox.connectorId)
      if (!inbox) return []
      const recent = await agentMail.listRecent(fetchImpl, inbox.baseUrl, inbox.inboxKey, this.now())
      const known = await this.deps.store.knownMessageIds(mailbox.connectorId, recent.map((m) => m.messageId))
      const unseen = this.fresh(state, recent.filter((m) => !known.has(m.messageId))).slice(0, MAX_DETAIL_FETCH)
      // A lista nem hoz fejlécet: a hurok-őrhöz egyenként kérjük le az új leveleket.
      for (const mail of unseen) {
        const detail = await agentMail.getHeaders(fetchImpl, inbox.baseUrl, inbox.inboxKey, mail.messageId, this.now())
        if (!detail) throw new Error('agentmail_missing_headers')
        mails.push(detail)
      }
    } else if (mailbox.provider === 'google') {
      const token = await this.deps.credentials.oauthToken(mailbox)
      const ids = await gmail.listRecentIds(fetchImpl, token)
      const known = await this.deps.store.knownMessageIds(mailbox.connectorId, ids)
      for (const id of ids.filter((x) => !known.has(x)).slice(0, MAX_DETAIL_FETCH)) {
        const mail = await gmail.getHeaders(fetchImpl, token, id, this.now())
        if (mail) mails.push(mail)
      }
    } else {
      const token = await this.deps.credentials.oauthToken(mailbox)
      const recent = await graph.listRecent(fetchImpl, token, this.now())
      const known = await this.deps.store.knownMessageIds(mailbox.connectorId, recent.map((m) => m.messageId))
      mails = recent.filter((m) => !known.has(m.messageId))
    }
    await this.deps.watches.update(mailbox.connectorId, { lastPolledAt: this.now() })
    return this.ingest(mailbox, state, mails, 'poll')
  }

  /** AgentMail webhook: 401, ha az aláírás nem stimmel (ilyenkor esemény sem keletkezik). */
  async handleAgentMailWebhook(input: {
    connectorId: string | null
    body: string
    svixId: string | null
    svixTimestamp: string | null
    svixSignature: string | null
  }): Promise<{ status: number; created: number }> {
    if (!input.connectorId) return { status: 401, created: 0 }
    const secret = await this.deps.secrets.load(input.connectorId)
    const valid =
      Boolean(secret) &&
      verifySvixSignature({
        secret: secret!,
        id: input.svixId,
        timestamp: input.svixTimestamp,
        signature: input.svixSignature,
        body: input.body,
        nowSeconds: Math.floor(this.now().getTime() / 1000),
      })
    if (!valid) return { status: 401, created: 0 }
    let payload: unknown
    try {
      payload = JSON.parse(input.body)
    } catch {
      return { status: 400, created: 0 }
    }
    const event = parseAgentMailEvent(payload, this.now())
    if (!event) return { status: 200, created: 0 } // más eseménytípus: nyugtázzuk, ne küldje újra
    const mailbox = await this.deps.loadMailbox(input.connectorId)
    const inbox = mailbox ? await this.deps.credentials.agentMailInbox(input.connectorId) : null
    if (!mailbox || !inbox || inbox.inboxId !== event.inboxId) return { status: 200, created: 0 }
    const state = await this.state(mailbox)
    const outcomes = await this.ingest(mailbox, state, [event.mail], 'webhook')
    return { status: 200, created: outcomes.filter((o) => o.created).length }
  }

  /** Gmail Pub/Sub push (az OIDC-ellenőrzés a route-ban): a kurzor óta érkezett levelek. */
  async handleGmailPush(input: { emailAddress: string; historyId: string }): Promise<number> {
    let created = 0
    for (const state of await this.deps.watches.listByProvider('google')) {
      const mailbox = await this.deps.loadMailbox(state.connectorId)
      if (!mailbox || mailbox.address?.toLowerCase() !== input.emailAddress.toLowerCase()) continue
      const token = await this.deps.credentials.oauthToken(mailbox)
      let ids: string[] = []
      let nextCursor: string | null = input.historyId
      if (state.cursor) {
        const history = await gmail.historySince(this.fetchImpl, token, state.cursor)
        if (history.expired) ids = await gmail.listRecentIds(this.fetchImpl, token)
        else {
          ids = history.ids
          nextCursor = history.historyId ?? input.historyId
        }
      } else {
        ids = await gmail.listRecentIds(this.fetchImpl, token)
      }
      const known = await this.deps.store.knownMessageIds(mailbox.connectorId, ids)
      const unseen = ids.filter((x) => !known.has(x))
      // A fejléc-lekérést és a befogadást kötegenként váltogatjuk (a kurzor a végén lép csak előre).
      // Egy nagy levél-dömpingnél (sok történeti levél egy push-ban) így a feldolgozás menet közbeni
      // megszakadása (pl. a push ack-határidejének túllépése) is TARTÓS előrehaladást hagy: az
      // újraküldött push a már rögzített leveleket a `knownMessageIds` szűrővel kihagyja, és a
      // maradékon halad tovább. Köteges rögzítés nélkül egyetlen rögzítés sem történne a dömping
      // végéig, így az újraküldés elölről kezdené — és soha be nem fejeződő, erőforrás-pazarló hurok.
      for (let i = 0; i < unseen.length; i += MAX_DETAIL_FETCH) {
        const mails: InboundMailHeaders[] = []
        for (const id of unseen.slice(i, i + MAX_DETAIL_FETCH)) {
          const mail = await gmail.getHeaders(this.fetchImpl, token, id, this.now())
          if (mail) mails.push(mail)
        }
        const outcomes = await this.ingest(mailbox, state, mails, 'push')
        created += outcomes.filter((o) => o.created).length
      }
      // Csak előre léptetjük a kurzort (az értesítések sorrendje nem garantált). A megszakadt
      // feldolgozásnál ez nem fut le → a kurzor marad, a hátralévőket a következő push behúzza.
      if (nextCursor && (!state.cursor || BigInt(nextCursor) > BigInt(state.cursor))) {
        await this.deps.watches.update(mailbox.connectorId, { cursor: nextCursor })
      }
    }
    return created
  }

  /** Graph change-notification: a clientState-et feliratkozásonként ellenőrizzük. */
  async handleGraphNotifications(body: unknown): Promise<{ valid: number; invalid: number; created: number }> {
    const counts = { valid: 0, invalid: 0, created: 0 }
    for (const n of parseGraphNotifications(body)) {
      const state = await this.deps.watches.findByExternalId('microsoft', n.subscriptionId)
      const secret = state ? await this.deps.secrets.load(state.connectorId) : null
      if (!state || !clientStateMatches(secret, n.clientState)) {
        counts.invalid++
        continue
      }
      counts.valid++
      const mailbox = await this.deps.loadMailbox(state.connectorId)
      if (!mailbox) continue
      const known = await this.deps.store.knownMessageIds(mailbox.connectorId, [n.messageId])
      if (known.has(n.messageId)) continue
      const token = await this.deps.credentials.oauthToken(mailbox)
      const mail = await graph.getHeaders(this.fetchImpl, token, n.messageId, this.now())
      if (!mail) continue
      const outcomes = await this.ingest(mailbox, state, [mail], 'push')
      counts.created += outcomes.filter((o) => o.created).length
    }
    return counts
  }

  /**
   * Napi karbantartás (a meglévő napi ütemezett hívásban): push-feliratkozás létrehozása és megújítása
   * (Gmail 7 nap, Graph ~3 nap — lejárat előtt 1 nappal), biztonsági lekérdezés minden postafióknál,
   * és a futó feldolgozások állapotának átvétele.
   */
  async runDaily(input: { deadline: Date }) {
    const summary = { mailboxes: 0, push: 0, polled: 0, created: 0, errors: 0, reconciled: { processed: 0, failed: 0, running: 0 } }
    for (const mailbox of await this.deps.listMailboxes()) {
      if (this.now() > input.deadline) break
      summary.mailboxes++
      try {
        if ((await this.ensureWatch(mailbox)) === 'push') summary.push++
        const outcomes = await this.poll(mailbox)
        summary.polled++
        summary.created += outcomes.filter((o) => o.created).length
      } catch (error) {
        summary.errors++
        await this.deps.watches.update(mailbox.connectorId, { lastError: errorText(error) }).catch(() => {})
      }
    }
    if (this.now() <= input.deadline) summary.reconciled = await this.deps.service.reconcileClaimed(50)
    return summary
  }

  /**
   * Push nélküli postafiókok lekérdezése, ha a cég beállított gyakorisága szerint esedékes.
   * Push-os postafiókot itt nem kérdezünk le (arra a push + a napi biztonsági lekérdezés elég).
   * Hívója: a platform használata közben (oldalbetöltés), vagy opcionálisan egy gyakori ütemezett hívás.
   */
  async pollDue(input: { deadline: Date; tenantId?: string; intervalMs: (tenantId: string) => Promise<number> }) {
    const summary = { checked: 0, polled: 0, created: 0, errors: 0 }
    const intervals = new Map<string, number>()
    for (const mailbox of await this.deps.listMailboxes(input.tenantId)) {
      if (this.now() > input.deadline) break
      const state = await this.deps.watches.find(mailbox.connectorId)
      if (state?.externalId && !state.lastError && (!state.expiresAt || state.expiresAt > this.now())) continue
      summary.checked++
      if (!intervals.has(mailbox.tenantId)) intervals.set(mailbox.tenantId, await input.intervalMs(mailbox.tenantId))
      const interval = intervals.get(mailbox.tenantId)!
      if (interval <= 0) continue
      if (state?.lastPolledAt && this.now().getTime() - state.lastPolledAt.getTime() < interval) continue
      try {
        const outcomes = await this.poll(mailbox)
        summary.polled++
        summary.created += outcomes.filter((o) => o.created).length
      } catch (error) {
        summary.errors++
        await this.deps.watches.update(mailbox.connectorId, { lastError: errorText(error), lastPolledAt: this.now() }).catch(() => {})
      }
    }
    return summary
  }
}

function defaultSecret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
}
