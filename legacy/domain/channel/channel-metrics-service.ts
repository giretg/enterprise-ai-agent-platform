/**
 * Csatorna forgalmi és hibametrikák az üzemeltetésnek (Telegram feature-spec #70/#78, story 59).
 *
 * Üzleti cél (UX): az üzemeltető egy pillantással lássa, „forog-e" a csatorna és „elromlott-e
 * valami" — a forgalom (bejövő összekötés-kísérletek, kimenő üzenetek) és a hibák (elakadt
 * fordulók, blokkolt kimenő üzenetek, letiltott botok, elutasított összekötések) egy helyen,
 * érthető magyar címkékkel.
 *
 * A metrikák KÉT determinisztikus forrásból állnak össze, új nyilvántartás nélkül:
 *  - a MÓDOSÍTHATATLAN audit-láncból (a forgalmi/hiba-események számai időablakra szűrve) —
 *    a csatorna minden hatása már ma auditált (#71/#72), és az azonosítók ott ÁLNEVESÍTVE
 *    vannak (§64), tehát a metrika sem lát nyers külső azonosítót;
 *  - a csatorna-táblák pillanatnyi állapotából (fordulók státusz szerint, munkamenetek,
 *    identitások, a még nem takarított kimenő üzenetek háttere).
 *
 * A szolgáltatás CSAK olvas és aggregál — nincs mellékhatása, nem ír auditot (a megfigyelés
 * nem esemény). A felület (server action) gondoskodik róla, hogy csak platform-admin lássa.
 */

import type { ChannelType } from '@prisma/client'
import type { AuditRepository, ChannelBotRepository } from '@/repositories/interfaces'
import { CHANNEL_AUDIT_ACTIONS } from './channel-types'

/** A csatorna-táblák állapot-olvasásai a metrikákhoz (befecskendezhető, DB-mentesen tesztelhető). */
export interface ChannelMetricsRepository {
  /** Fordulók (worker-sor) darabszáma státuszonként, opcionálisan időablakra szűrve. */
  countTurnsByStatus(since?: Date): Promise<Record<string, number>>
  /** Munkamenetek: összes és a bekötött (van identitása). */
  countSessions(): Promise<{ total: number; linked: number }>
  /** Identitások (kötések) darabszáma státuszonként. */
  countIdentitiesByStatus(): Promise<Record<string, number>>
  /** A még NEM takarított kimenő üzenetek háttere (D4 — takarítási lemaradás). */
  countPendingOutbound(): Promise<{ pending: number; oldestSentAt: Date | null }>
}

export type ChannelTrafficMetrics = {
  /** Kiadott összekötő tokenek (webről indított összekötés-kísérletek). */
  tokensIssued: number
  /** Sikeres összekötések. */
  linksEstablished: number
  /** Elutasított összekötések (lejárt / elhasznált / hamis aláírás / továbbküldött link). */
  linksRejected: number
  /** Bekötetlen küldőnek küldött EGYSZERI semleges válasz. */
  unlinkedNotices: number
  /** Kimenő üzenetek (a bot által elküldve). */
  outboundSent: number
  /** Blokkolt kimenő üzenetek (érzékenységi kapu — nyers szöveg nem ment ki). */
  outboundBlocked: number
  /** Visszavont kötések (saját + admin). */
  revocations: number
  /** Megőrzési horizonton takarított (törölt) kimenő üzenetek. */
  messagesPurged: number
}

export type ChannelErrorMetrics = {
  /** Elakadt (feldolgozásban elbukott) fordulók — újrapróbálhatók, de figyelni kell. */
  turnsFailed: number
  /** Elutasított összekötések (hibás/lejárt link) — magas érték rossz linkkezelésre utal. */
  linksRejected: number
  /** Érzékenységi kapun blokkolt kimenő üzenetek. */
  outboundBlocked: number
  /** Letiltott botú kötések (a felhasználó letiltotta a botot → a küldés abbamaradt, D15). */
  identitiesBlocked: number
}

export type ChannelHealthSnapshot = {
  turns: { queued: number; running: number; done: number; failed: number }
  sessions: { total: number; linked: number }
  identities: { active: number; revoked: number; blocked: number }
  /** A takarítási lemaradás: hány kimenő üzenet vár még törlésre és mióta a legrégebbi. */
  retention: { pendingOutbound: number; oldestPendingSentAt: string | null }
}

export type ChannelOpsMetrics = {
  channelType: ChannelType
  generatedAt: string
  /** Az időablak kezdete (ISO), vagy `null` = teljes előzmény. */
  windowSince: string | null
  bot: {
    registered: boolean
    status: 'active' | 'disabled' | null
    hasWebhookSecret: boolean
  }
  traffic: ChannelTrafficMetrics
  errors: ChannelErrorMetrics
  health: ChannelHealthSnapshot
}

export type ChannelMetricsDeps = {
  audit: Pick<AuditRepository, 'getActionCounts'>
  metrics: ChannelMetricsRepository
  bots: Pick<ChannelBotRepository, 'findPlatformBot'>
  now?: () => Date
}

const TELEGRAM: ChannelType = 'telegram'

/** A forgalmi/hiba-metrikákhoz lekért audit-akciók (egy hívásban, a katalógus nevein). */
const TRAFFIC_ACTIONS: string[] = [
  CHANNEL_AUDIT_ACTIONS.linkTokenIssued,
  CHANNEL_AUDIT_ACTIONS.linkEstablished,
  CHANNEL_AUDIT_ACTIONS.linkRejected,
  CHANNEL_AUDIT_ACTIONS.unlinkedNotice,
  CHANNEL_AUDIT_ACTIONS.messageSent,
  CHANNEL_AUDIT_ACTIONS.messageBlocked,
  CHANNEL_AUDIT_ACTIONS.identityRevoked,
  CHANNEL_AUDIT_ACTIONS.messagePurged,
]

export class ChannelMetricsService {
  private readonly now: () => Date

  constructor(private readonly deps: ChannelMetricsDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * Az üzemeltetői metrika-pillanatkép. `sinceMs` = a forgalmi/hiba-ablak hossza
   * ezredmásodpercben a mostól visszafelé; ha nincs megadva, teljes előzmény.
   */
  async snapshot(input?: { sinceMs?: number; channelType?: ChannelType }): Promise<ChannelOpsMetrics> {
    const channelType = input?.channelType ?? TELEGRAM
    const now = this.now()
    const since =
      input?.sinceMs != null && input.sinceMs > 0
        ? new Date(now.getTime() - input.sinceMs)
        : undefined

    const [actionCounts, turnCounts, sessions, identityCounts, pending, bot] = await Promise.all([
      this.deps.audit.getActionCounts({ actions: TRAFFIC_ACTIONS, since }),
      this.deps.metrics.countTurnsByStatus(since),
      this.deps.metrics.countSessions(),
      this.deps.metrics.countIdentitiesByStatus(),
      this.deps.metrics.countPendingOutbound(),
      this.deps.bots.findPlatformBot(channelType),
    ])

    const a = (action: string): number => actionCounts[action] ?? 0
    const turns = {
      queued: turnCounts.queued ?? 0,
      running: turnCounts.running ?? 0,
      done: turnCounts.done ?? 0,
      failed: turnCounts.failed ?? 0,
    }
    const identities = {
      active: identityCounts.active ?? 0,
      revoked: identityCounts.revoked ?? 0,
      blocked: identityCounts.blocked ?? 0,
    }

    const traffic: ChannelTrafficMetrics = {
      tokensIssued: a(CHANNEL_AUDIT_ACTIONS.linkTokenIssued),
      linksEstablished: a(CHANNEL_AUDIT_ACTIONS.linkEstablished),
      linksRejected: a(CHANNEL_AUDIT_ACTIONS.linkRejected),
      unlinkedNotices: a(CHANNEL_AUDIT_ACTIONS.unlinkedNotice),
      outboundSent: a(CHANNEL_AUDIT_ACTIONS.messageSent),
      outboundBlocked: a(CHANNEL_AUDIT_ACTIONS.messageBlocked),
      revocations: a(CHANNEL_AUDIT_ACTIONS.identityRevoked),
      messagesPurged: a(CHANNEL_AUDIT_ACTIONS.messagePurged),
    }

    const errors: ChannelErrorMetrics = {
      turnsFailed: turns.failed,
      linksRejected: traffic.linksRejected,
      outboundBlocked: traffic.outboundBlocked,
      identitiesBlocked: identities.blocked,
    }

    return {
      channelType,
      generatedAt: now.toISOString(),
      windowSince: since ? since.toISOString() : null,
      bot: {
        registered: bot != null,
        status: bot ? bot.status : null,
        hasWebhookSecret: bot ? bot.webhookSecretRef.trim().length > 0 : false,
      },
      traffic,
      errors,
      health: {
        turns,
        sessions,
        identities,
        retention: {
          pendingOutbound: pending.pending,
          oldestPendingSentAt: pending.oldestSentAt ? pending.oldestSentAt.toISOString() : null,
        },
      },
    }
  }
}
