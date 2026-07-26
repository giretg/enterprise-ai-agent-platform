/**
 * Befecskendezhető kimenő átviteli kapu (Telegram feature-spec #70/#71, D8/D10/D11).
 *
 * A csatorna-réteg VARRATA a kimenő oldalon: minden Telegram Bot API-hívás EGYETLEN
 * helyen megy ki, ezért a tesztek egyetlen dublőrt tesznek ide, és onnan olvassák le,
 * milyen kimenő hívások keletkeztek — vagy nem keletkeztek (#70 Testing Decisions).
 *
 * A ticket-állapotgép és a Monitor NEM hívhatja közvetlenül a Telegramot (D11): csak a
 * csatorna-szolgáltatáson át, ami ezt a befecskendezett kaput használja. Így nincs
 * második, dublőrözhetetlen kijárat.
 *
 * Az egress deny-by-default (D10): a valós adapter minden hívás előtt átfuttatja a cél-URL-t
 * a közös egress-őrön, és CSAK a Telegram API hostot engedi. A séma: `https`, host-egyezés,
 * nincs privát/reserved IP.
 */

import type { ChannelType } from '@prisma/client'
import { guardEgressUrl } from '@/domain/net/egress-guard'
import { CHANNEL_EGRESS_ALLOWLIST_HOSTS, TELEGRAM_API_HOST } from './channel-types'

/** Egy kimenő csatorna-hívás — provider-független alak (method + payload). */
export type ChannelOutboundCall = {
  channelType: ChannelType
  /** A provider metódusa, pl. Telegramnál `sendMessage`, `sendChatAction`. */
  method: string
  /** A metódus törzse, pl. `{ chat_id, text }`. Nyers JSON-ként megy ki. */
  payload: Record<string, unknown>
}

export type ChannelOutboundResult =
  | {
      ok: true
      providerMessageId: string | null
      /**
       * A provider válaszának nyers `result` mezője. A ÜZENETKÜLDŐ utak nem használják (nekik a
       * `providerMessageId` elég), de a BEÜZEMELŐ hívások (`getMe`, `setWebhook`,
       * `getWebhookInfo`) ebből tudják megmondani a platform-adminnak, hogy a bot tényleg
       * válaszol-e és tényleg a mi végpontunkra van-e bekötve. Opcionális: a teszt-dublőr és a
       * régi hívók változatlanul működnek.
       */
      result?: unknown
    }
  | { ok: false; reason: ChannelOutboundBlockReason; detail?: string }

export type ChannelOutboundBlockReason =
  | 'egress_blocked'
  | 'transport_error'
  | 'provider_error'
  | 'blocked_by_user'

/**
 * A kimenő átviteli kapu absztrakciója. A csatorna-szolgáltatás ezen keresztül küld;
 * a valós implementáció a Telegram Bot API-t hívja, a teszt-dublőr csak rögzít.
 */
export interface ChannelOutboundTransport {
  send(call: ChannelOutboundCall): Promise<ChannelOutboundResult>
}

/**
 * Teszt-dublőr: rögzíti a kimenő hívásokat, nem megy hálózatra (#70 Testing — a varrat
 * dublőrje). A visszatérési értéket a teszt előre beállíthatja (alapból siker), így a
 * "bot letiltva" / provider-hiba utak is dublőrizhetők.
 */
export class RecordingChannelTransport implements ChannelOutboundTransport {
  readonly calls: ChannelOutboundCall[] = []
  private nextResults: ChannelOutboundResult[] = []
  private defaultResult: ChannelOutboundResult

  constructor(defaultResult?: ChannelOutboundResult) {
    this.defaultResult = defaultResult ?? { ok: true, providerMessageId: null }
  }

  /** A soron következő `send()` hívások eredményének előre-beállítása (FIFO). */
  queueResults(...results: ChannelOutboundResult[]): void {
    this.nextResults.push(...results)
  }

  /** Az utolsó rögzített kimenő hívás, vagy `null` ha még nem volt. */
  get lastCall(): ChannelOutboundCall | null {
    return this.calls.length > 0 ? this.calls[this.calls.length - 1] : null
  }

  reset(): void {
    this.calls.length = 0
    this.nextResults.length = 0
  }

  async send(call: ChannelOutboundCall): Promise<ChannelOutboundResult> {
    // Mély másolat, hogy a hívó későbbi mutációja ne írja át a rögzített hívást.
    this.calls.push({
      channelType: call.channelType,
      method: call.method,
      payload: structuredClone(call.payload),
    })
    return this.nextResults.shift() ?? this.defaultResult
  }
}

export type TelegramOutboundTransportDeps = {
  /**
   * A bot hozzáférési kulcsának feloldása a titok-referenciából — SZERVEROLDALON, rövid
   * élettartamra. A nyers token csak itt, a hívás pillanatában jelenik meg; sosem
   * naplózzuk és sosem tesszük a hibaüzenetbe.
   */
  resolveBotToken: () => Promise<string>
  /** Injektálható fetch (teszt/wiring). Alapból a globális `fetch`. */
  fetchFn?: typeof fetch
  /** Az engedélyezett cél-hostok. Alapból CSAK a Telegram API host (deny-by-default). */
  allowlistHosts?: Iterable<string>
  /** Feloldás-utáni privát/reserved IP re-check (DNS-rebinding). Élesben a node dns rétege. */
  resolveHostIps?: (host: string) => Promise<string[]>
  timeoutMs?: number
}

/**
 * A valós Telegram kimenő adapter. Minden hívás előtt átfuttatja a cél-URL-t a közös
 * egress-őrön (deny-by-default, CSAK a Telegram host), majd JSON POST-tal hívja a Bot
 * API-t. A `bot<token>` a path-ban van; a token SOHA nem kerül audit/hiba/napló szövegbe.
 */
export class TelegramOutboundTransport implements ChannelOutboundTransport {
  private readonly allowlistHosts: string[]

  constructor(private readonly deps: TelegramOutboundTransportDeps) {
    this.allowlistHosts = [...(deps.allowlistHosts ?? CHANNEL_EGRESS_ALLOWLIST_HOSTS)]
  }

  async send(call: ChannelOutboundCall): Promise<ChannelOutboundResult> {
    const token = await this.deps.resolveBotToken()
    const url = `https://${TELEGRAM_API_HOST}/bot${token}/${encodeURIComponent(call.method)}`

    // Deny-by-default egress-őr a hálózati hívás ELŐTT (D10). A `detail` a hostot hordozza,
    // nem a teljes URL-t — a token így nem szivárog ki a blokk-okból sem.
    const guard = await guardEgressUrl({
      url,
      allowlistHosts: this.allowlistHosts,
      resolveHostIps: this.deps.resolveHostIps,
    })
    if (!guard.ok) {
      return { ok: false, reason: 'egress_blocked', detail: guard.reason }
    }

    const fetchFn = this.deps.fetchFn ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? 5000)
    try {
      const res = await fetchFn(guard.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(call.payload),
        signal: controller.signal,
      })
      const body = (await res.json().catch(() => null)) as TelegramApiEnvelope | null
      if (!res.ok || !body?.ok) {
        // A felhasználó letiltotta a botot → a küldés abbamarad, nem próbálkozik vég nélkül
        // (D15). A Telegram ezt 403 + "bot was blocked by the user"-rel jelzi.
        if (res.status === 403) {
          return { ok: false, reason: 'blocked_by_user', detail: `status_${res.status}` }
        }
        return { ok: false, reason: 'provider_error', detail: `status_${res.status}` }
      }
      return { ok: true, providerMessageId: extractMessageId(body), result: body.result }
    } catch (error) {
      return {
        ok: false,
        reason: 'transport_error',
        detail: error instanceof Error ? error.name : 'unknown',
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

// A `result` alakja metódusonként más (üzenetnél objektum, `setWebhook`-nál `true`), ezért
// `unknown`; az üzenet-azonosítót óvatosan, típusvetéssel emeljük ki belőle.
type TelegramApiEnvelope = { ok?: boolean; result?: unknown }

function extractMessageId(body: TelegramApiEnvelope): string | null {
  const result = body.result
  if (typeof result !== 'object' || result === null) return null
  const id = (result as { message_id?: unknown }).message_id
  return typeof id === 'number' ? String(id) : null
}
