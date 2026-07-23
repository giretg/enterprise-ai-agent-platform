/**
 * Proaktív csatorna-értesítés — a csatorna-szolgáltatás HARMADIK bejárata (Telegram feature-spec
 * #70/#77, D7/D11/D15).
 *
 * A csatornának három belépési pontja van: (1) bejövő Telegram-frissítés, (2) ticket-átmenet,
 * (3) Monitor-riasztás. Ez a modul a (3). A varrat UGYANAZ, mint a másik két bejáraté: minden
 * KIMENŐ hívás az EGYETLEN befecskendezett `ChannelOutboundTransport`-on megy (D11 — a Monitor
 * NEM hívhatja közvetlenül a Telegramot), és minden hatás determinisztikus, ÁLNEVESÍTETT
 * azonosítójú audit-bejegyzést ír (§64). A tesztek ezt a bejáratot ugyanúgy a rögzített kimenő
 * hívásokon és auditokon mérik.
 *
 * A védelmi rend és a best-effort viselkedés (#77 acceptance):
 *  - CSAK regisztrált (összekötött, AKTÍV) címzettnek megy ki, és CSAK a saját szervezetén belül
 *    (D2 — a kötés szervezete rögzített). Nem összekötött / más szervezetű címzett → NINCS küldés.
 *  - A küldési hiba NEM bukja el a hívót (a Monitor-futást): a szolgáltatás sosem dob, csak
 *    `channel.notification.failed` auditot ír, és a Monitor tovább fut.
 *  - Ha a Telegram bot-letiltást jelez (a felhasználó letiltotta a botot), a kötés `blocked`-ra
 *    jelölődik (`channel.identity.blocked`), és a további küldés abbamarad — a `blocked` kötés a
 *    következő értesítésnél már nem AKTÍV, tehát nem regisztrált címzettként elzár (fail-closed).
 *
 * Az értesítés tartalma system-generált (monitor/jel cím + link a részletekre); a `detailUrl`
 * a kimenő üzenetben megy ki (D16 — hétköznapi magyar, önmagát magyarázó, link a részletekre).
 */
import type { ChannelIdentity, ChannelType } from '@prisma/client'
import type { AuditRepository, ChannelIdentityRepository, ChannelBotRepository } from '@/repositories/interfaces'
import type { ChannelOutboundTransport } from './channel-outbound-transport'
import { CHANNEL_AUDIT_ACTIONS } from './channel-types'
import {
  defaultChannelNotifyCryptoPort,
  pseudonymFromLookupHash,
  type ChannelNotifyCryptoPort,
} from './channel-identity-crypto'

const TELEGRAM: ChannelType = 'telegram'

/** Egy proaktív értesítés provider-független, minimál alakja (a Monitor-adapter tölti ki). */
export type ChannelNotifyInput = {
  /** A CÍMZETT platform-felhasználó azonosítója. Csak az ő AKTÍV kötése kaphat üzenetet. */
  recipientUserId: string
  /** A hívó (pl. Monitor) szervezete — a kötés szervezetének EGYEZNIE kell ezzel (D2/§63). */
  tenantId: string | null
  channelType?: ChannelType
  /** Az értesítés fejléce (pl. „Monitor: <cím>"). */
  title: string
  /** Az értesítés törzse (pl. „Jel: <jel> — súlyosság N"). */
  body: string
  /** Link a részletekre — a kimenő üzenetben megy ki (#77 acceptance). `null` → link nélkül. */
  detailUrl: string | null
  /** Audit-korreláció: mi váltotta ki (pl. 'monitor'). Nem megy ki Telegramra. */
  sourceType: string
  /** Audit-korreláció: a kiváltó erőforrás azonosítója (pl. monitorId). */
  sourceId: string
  /** Audit-korreláció: opcionális futás/ticket azonosító (pl. monitorRunId, ticketId). */
  correlationId?: string | null
}

export type ChannelNotifyOutcome =
  /** Kiment az értesítés. */
  | 'sent'
  /** Nincs regisztrált platform-bot erre a csatorna-típusra → nincs küldés. */
  | 'no_bot'
  /** A platform-bot ki van kapcsolva (incidens-kikapcsoló) → nincs küldés. */
  | 'channel_disabled'
  /** A címzett nincs összekötve / nem aktív / más szervezet → nincs küldés (fail-closed). */
  | 'not_registered'
  /** Küldési hiba (best-effort): a hívó futása NEM bukik el; audit keletkezett. */
  | 'send_failed'
  /** A felhasználó letiltotta a botot: a kötés `blocked`, a küldés abbamarad. */
  | 'recipient_blocked'

export type ChannelNotifyResult = {
  outcome: ChannelNotifyOutcome
  providerMessageId?: string | null
}

export type ChannelNotificationDeps = {
  bots: ChannelBotRepository
  identities: ChannelIdentityRepository
  transport: ChannelOutboundTransport
  audit: Pick<AuditRepository, 'append'>
  crypto?: ChannelNotifyCryptoPort
}

export class ChannelNotificationService {
  private readonly crypto: ChannelNotifyCryptoPort

  constructor(private readonly deps: ChannelNotificationDeps) {
    this.crypto = deps.crypto ?? defaultChannelNotifyCryptoPort
  }

  /**
   * A harmadik bejárat: proaktív értesítés kiküldése egy összekötött felhasználónak. Sosem dob —
   * a hívó (Monitor) futása egyetlen ágon sem bukhat el emiatt; minden ág strukturált eredményt
   * és determinisztikus auditot ad vissza.
   */
  async notifyUser(input: ChannelNotifyInput): Promise<ChannelNotifyResult> {
    const channelType = input.channelType ?? TELEGRAM

    // 1) Van-e (aktív) platform-bot? Nélküle nincs mihez küldeni — nincs kimenő hívás.
    const bot = await this.deps.bots.findPlatformBot(channelType)
    if (!bot) {
      await this.auditSkipped(input, channelType, 'no_bot', null)
      return { outcome: 'no_bot' }
    }
    if (bot.status === 'disabled') {
      await this.auditSkipped(input, channelType, 'channel_disabled', null)
      return { outcome: 'channel_disabled' }
    }

    // 2) A címzett AKTÍV kötése — a saját szervezetén belül (D2/§63). Nincs → nincs küldés.
    const identity = await this.resolveActiveRecipient(input.recipientUserId, input.tenantId, channelType)
    if (!identity) {
      await this.auditSkipped(input, channelType, 'not_registered', null)
      return { outcome: 'not_registered' }
    }

    // 3) A kimenő cél a kötés titkosított azonosítójából oldódik fel — sosem tetszőleges címre
    //    (§51). A nyers chat_id csak itt, a hívás pillanatában él; sosem auditáljuk.
    const chatId = this.crypto.decryptExternalId(identity.externalUserIdEnc)
    const pseudonym = pseudonymFromLookupHash(identity.lookupHash)

    const result = await this.deps.transport.send({
      channelType,
      method: 'sendMessage',
      payload: { chat_id: chatId, text: renderNotificationText(input) },
    })

    if (result.ok) {
      await this.audit(CHANNEL_AUDIT_ACTIONS.notificationSent, input, channelType, 'sent', identity, {
        pseudonym,
        providerMessageId: result.providerMessageId ?? null,
      })
      return { outcome: 'sent', providerMessageId: result.providerMessageId ?? null }
    }

    // Bot-letiltás → a kötés jelölődik, és a küldés abbamarad (D15). A `blocked` kötés a
    // következő értesítésnél már nem aktív, tehát fail-closed elzár.
    if (result.reason === 'blocked_by_user') {
      await this.deps.identities.updateStatus(identity.id, 'blocked')
      await this.audit(CHANNEL_AUDIT_ACTIONS.identityBlocked, input, channelType, 'blocked', identity, {
        pseudonym,
        reason: result.reason,
      })
      return { outcome: 'recipient_blocked' }
    }

    // Bármely más küldési hiba: best-effort — NEM dobunk, a Monitor-futás nem bukik el; audit.
    await this.audit(CHANNEL_AUDIT_ACTIONS.notificationFailed, input, channelType, 'failed', identity, {
      pseudonym,
      reason: result.reason,
      detail: result.detail ?? null,
    })
    return { outcome: 'send_failed' }
  }

  /**
   * A címzett AKTÍV csatorna-kötése a saját szervezetén belül. A szerepkör NEM számít (nem is
   * tárolt); az egyetlen kapu, hogy a kötés aktív, a csatorna egyezik, és a szervezet egyezik a
   * hívóéval (D2 — a kötés szervezete rögzített; §63 — szervezetek közti átjárás tiltott).
   */
  private async resolveActiveRecipient(
    userId: string,
    tenantId: string | null,
    channelType: ChannelType,
  ): Promise<ChannelIdentity | null> {
    if (!userId) return null
    const identities = await this.deps.identities.listByUser(userId)
    return (
      identities.find(
        (i) => i.channelType === channelType && i.status === 'active' && i.tenantId === tenantId,
      ) ?? null
    )
  }

  private async auditSkipped(
    input: ChannelNotifyInput,
    channelType: ChannelType,
    reason: string,
    identity: ChannelIdentity | null,
  ): Promise<void> {
    await this.audit(CHANNEL_AUDIT_ACTIONS.notificationSkipped, input, channelType, reason, identity, {
      reason,
    })
  }

  private async audit(
    action: string,
    input: ChannelNotifyInput,
    channelType: ChannelType,
    policyDecision: string,
    identity: ChannelIdentity | null,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action,
      // Az értesítés a kiváltó erőforrásra (pl. monitor) mutat vissza — így az audit-lánc a
      // Monitor-futástól a kézbesítésig végigkövethető.
      targetType: input.sourceType,
      targetId: input.sourceId,
      modelUsed: null,
      inputRef: input.correlationId ?? null,
      outputRef: null,
      policyDecision,
      metadata: {
        channelType,
        tenantId: input.tenantId,
        // Álnevesített címzett-azonosító — a nyers külső id (chat_id) SOHA nem kerül auditba (§64).
        ...(identity ? { pseudonym: pseudonymFromLookupHash(identity.lookupHash) } : {}),
        ...extra,
      },
      tenantId: input.tenantId,
    })
  }
}

/**
 * A kimenő értesítés szövege (D16 — hétköznapi magyar, önmagát magyarázó, LINK a részletekre).
 * A link a részletekre külön sorban, hogy a Telegram automatikusan kattinthatóvá tegye.
 */
export function renderNotificationText(input: ChannelNotifyInput): string {
  const lines = [`🔔 ${input.title}`, input.body]
  if (input.detailUrl) {
    lines.push(`Részletek: ${input.detailUrl}`)
  }
  return lines.filter((l) => l.trim().length > 0).join('\n')
}
