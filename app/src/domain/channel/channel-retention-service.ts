/**
 * A bot saját kimenő üzeneteinek megőrzési takarítása (Telegram feature-spec #70/#78, D4).
 *
 * Üzleti cél (UX/megfelelőség): a hiteles példány a MIÉNK; a Telegram csak kézbesítési
 * csatorna. A megőrzési szabály a mi tárolónkra vonatkozik, de a bot a horizonton túl a
 * SAJÁT kimenő üzeneteit is takarítja a Telegram oldalán — hogy ne maradjon örökké élő
 * másolat egy külső felhőben. Korlát (tudatos félmegoldás): privát chatben a bot CSAK a
 * maga üzeneteit tudja törölni, a felhasználóét nem.
 *
 * A takarítás a csatorna VARRATÁN megy ki: minden törlés a befecskendezett
 * `ChannelOutboundTransport` `deleteMessage` hívása (D11 — nincs második, dublőrözhetetlen
 * kijárat), és minden futás determinisztikus, ÁLNEVESÍTETT azonosítójú audit-bejegyzést ír
 * (§64 — nyers külső azonosító és nyers tartalom SOHA nem kerül auditba).
 *
 * Idempotens: ha a provider szerint az üzenet már nem létezik (a felhasználó törölte, vagy
 * egy korábbi futás már törölte), a sort takarítottnak jelöljük — nem próbálkozik vég nélkül.
 */

import type { ChannelType } from '@prisma/client'
import type {
  AuditRepository,
  ChannelOutboundMessageRepository,
} from '@/repositories/interfaces'
import type { ChannelOutboundTransport } from './channel-outbound-transport'
import { pseudonymFromExternalThreadId } from './channel-identity-crypto'
import {
  CHANNEL_AUDIT_ACTIONS,
  CHANNEL_OUTBOUND_RETENTION_DAYS,
  CHANNEL_RETENTION_SWEEP_LIMIT,
} from './channel-types'

const DAY_MS = 24 * 60 * 60 * 1000
const TELEGRAM: ChannelType = 'telegram'

export type ChannelRetentionDeps = {
  outbound: ChannelOutboundMessageRepository
  transport: ChannelOutboundTransport
  audit: Pick<AuditRepository, 'append'>
  now?: () => Date
}

export type ChannelRetentionResult = {
  /** A horizonton túli, feldolgozott üzenetek száma. */
  scanned: number
  /** Ténylegesen törölt (a providernél sikeres deleteMessage). */
  deleted: number
  /** Már nem létező (provider szerint eltűnt) — takarítottnak jelölve, nem hiba. */
  alreadyGone: number
  /** Átmeneti hiba miatt kihagyott (a következő futás újrapróbálja). */
  failed: number
}

export class ChannelRetentionService {
  private readonly now: () => Date

  constructor(private readonly deps: ChannelRetentionDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * Egy megőrzési-takarító futás. A horizonton túli (sentAt < most − retentionDays), még nem
   * takarított kimenő bot-üzeneteket törli a providernél, és takarítottnak jelöli őket.
   */
  async purgeExpiredOutbound(input?: {
    retentionDays?: number
    limit?: number
    channelType?: ChannelType
  }): Promise<ChannelRetentionResult> {
    const channelType = input?.channelType ?? TELEGRAM
    const retentionDays = input?.retentionDays ?? CHANNEL_OUTBOUND_RETENTION_DAYS
    const limit = input?.limit ?? CHANNEL_RETENTION_SWEEP_LIMIT
    const now = this.now()
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS)

    const expired = await this.deps.outbound.listExpired(cutoff, limit)
    const result: ChannelRetentionResult = { scanned: 0, deleted: 0, alreadyGone: 0, failed: 0 }

    for (const msg of expired) {
      result.scanned++
      const send = await this.deps.transport.send({
        channelType: msg.channelType,
        method: 'deleteMessage',
        payload: { chat_id: msg.externalThreadId, message_id: toMessageId(msg.providerMessageId) },
      })

      if (send.ok) {
        await this.deps.outbound.markPurged(msg.id, now)
        await this.appendPurgeAudit(msg, now, 'deleted')
        result.deleted++
        continue
      }

      // A provider szerint az üzenet már nincs meg (a felhasználó/korábbi futás törölte):
      // takarítottnak jelöljük — a cél (ne maradjon élő másolat) teljesült, nem hiba.
      if (send.reason === 'provider_error') {
        await this.deps.outbound.markPurged(msg.id, now)
        await this.appendPurgeAudit(msg, now, 'already_gone')
        result.alreadyGone++
        continue
      }

      // Átmeneti hiba (hálózat / egress / bot letiltva) → NEM jelöljük takarítottnak, a
      // következő futás újrapróbálja. Nincs kimenő szöveg, nincs audit-zaj soronként.
      result.failed++
    }

    // Egy összegző audit a futásról (nem soronként) — az üzemeltetés ebből látja a takarítást.
    // ÜRES futásra NEM írunk sort: a takarító a worker minden körében lefut, és minden
    // `audit.append` globális advisory lockot vesz a hash-láncra — a percenkénti „nem volt mit
    // takarítani" bejegyzés zajjal töltené a láncot és sorosítaná az írásokat. Ami nem történt,
    // az nem esemény; a takarítási lemaradás a metrika-panel „Takarításra vár" számából látszik.
    if (result.scanned === 0) return result

    await this.deps.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: CHANNEL_AUDIT_ACTIONS.retentionSwept,
      targetType: 'channel',
      targetId: channelType,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'swept',
      metadata: {
        channelType,
        retentionDays,
        cutoff: cutoff.toISOString(),
        scanned: result.scanned,
        deleted: result.deleted,
        alreadyGone: result.alreadyGone,
        failed: result.failed,
      },
    })

    return result
  }

  private async appendPurgeAudit(
    msg: { id: string; sessionId: string; channelType: ChannelType; externalThreadId: string; sentAt: Date },
    now: Date,
    outcome: 'deleted' | 'already_gone',
  ): Promise<void> {
    await this.deps.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: CHANNEL_AUDIT_ACTIONS.messagePurged,
      targetType: 'channel_outbound_message',
      targetId: msg.id,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: outcome,
      metadata: {
        channelType: msg.channelType,
        sessionId: msg.sessionId,
        // ÁLNEVESÍTETT szál-azonosító (nem a nyers chat id, §64) és a kimenő üzenet kora.
        threadPseudonym: pseudonymFromExternalThreadId(msg.channelType, msg.externalThreadId),
        sentAt: msg.sentAt.toISOString(),
        ageDays: Math.round((now.getTime() - msg.sentAt.getTime()) / DAY_MS),
      },
    })
  }
}

/** A Telegram `message_id` szám; a tárolt string azonosítót számmá alakítjuk, ha lehet. */
function toMessageId(providerMessageId: string): number | string {
  const n = Number(providerMessageId)
  return Number.isInteger(n) ? n : providerMessageId
}
