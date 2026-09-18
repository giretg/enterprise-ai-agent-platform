/**
 * Telegram Monitor-értesítő adapter (Telegram feature-spec #70/#77, D7/D11).
 *
 * A Monitor a `MonitorNotifier` porton át értesít; ez az implementáció a csatorna-szolgáltatás
 * HARMADIK bejáratára (`ChannelNotificationService`) delegál — a Monitor így SOHA nem hívja
 * közvetlenül a Telegramot (D11), a kimenő út egyetlen helyen (a befecskendezett átvitel) marad.
 *
 * Útválasztás: a `RoutingMonitorNotifier` a `notifyChannel` provider-előtagja alapján ide küld
 * (`telegram:<userId>`). A `targetFromChannel` a CÍMZETT platform-felhasználó azonosítóját adja —
 * csak az ő AKTÍV, azonos szervezetű kötése kaphat üzenetet (nem tetszőleges cím, §51). Nincs
 * cél / nem összekötött / más szervezet → nincs küldés (a szolgáltatás elzár).
 *
 * Best-effort (§7/#77): a küldési hiba NEM dob — a Monitor-söprés nem bukik el; a szolgáltatás a
 * `channel.notification.*` auditot írja. A `MonitorService` a `monitor.notify.sent` sorát is
 * megírja, de a KÉZBESÍTÉS igazsága (kiment / kihagyva / hiba / letiltva) a csatorna-auditban van.
 */
import {
  type MonitorNotificationInput,
  type MonitorNotificationResult,
  type MonitorNotifier,
  targetFromChannel,
} from './monitor-notifier'
import type { ChannelNotificationService } from '@/domain/channel/channel-notification-service'
import type { ChannelType } from '@prisma/client'

export class TelegramMonitorNotifier implements MonitorNotifier {
  constructor(
    private readonly deps: {
      notifications: ChannelNotificationService
      /** A részletek-link bázisa; alapból a `NEXT_PUBLIC_APP_URL` env. */
      env?: Record<string, string | undefined>
      channelType?: ChannelType
    },
  ) {}

  /** A board-ticket linkje a részletekhez (mint a WebhookChatNotifier), vagy `null`. */
  private detailUrl(input: MonitorNotificationInput): string | null {
    const base = (this.deps.env ?? process.env).NEXT_PUBLIC_APP_URL?.replace(/\/$/, '')
    if (!base) return null
    return `${base}/control-plane/board?ticket=${encodeURIComponent(input.ticketId)}`
  }

  private title(input: MonitorNotificationInput): string {
    return `Monitor: ${input.monitorTitle}`
  }

  private body(input: MonitorNotificationInput): string {
    const lines = [`Jel: ${input.signalTitle} — súlyosság ${input.severity}`]
    if (input.dueBy) lines.push(`Határidő: ${input.dueBy.toISOString()}`)
    return lines.join('\n')
  }

  async send(input: MonitorNotificationInput): Promise<MonitorNotificationResult> {
    const recipientUserId = targetFromChannel(input.channel)
    const result = await this.deps.notifications.notifyUser({
      recipientUserId,
      tenantId: input.tenantId,
      channelType: this.deps.channelType ?? 'telegram',
      title: this.title(input),
      body: this.body(input),
      detailUrl: this.detailUrl(input),
      sourceType: 'monitor',
      sourceId: input.monitorId,
      correlationId: input.monitorRunId,
    })

    return {
      provider: 'telegram',
      // A `sent` ág valós provider-üzenetazonosítót ad; a nincs-küldés / best-effort hiba ágakon
      // nincs kimenő üzenet, de a kézbesítés kimenetelét (outcome) a messageId hordozza, hogy a
      // `monitor.notify.sent` audit se legyen félrevezető.
      messageId:
        result.outcome === 'sent'
          ? (result.providerMessageId ?? `telegram:${input.monitorRunId}:${input.ticketId}`)
          : `telegram:${result.outcome}:${input.monitorRunId}`,
    }
  }
}
