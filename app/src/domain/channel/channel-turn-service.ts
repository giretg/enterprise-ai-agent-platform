/**
 * Bejövő forduló-sor feldolgozó — a worker MÁSODIK munkatípusa (Telegram feature-spec
 * #70/#73, D8/D14).
 *
 * A #72 összekötő szelet után ez a slice a megbízható, ÚJRAPRÓBÁLHATÓ bejövő utat szállítja:
 * a bekötött felhasználó privát üzenete a webhook-időben TARTÓS sorba kerül (`channel_turns`),
 * amit a meglévő dispatcher-worker itt, második munkatípusként lezavar. A forduló TÚLÉLI a
 * webhook-kérést, és ha a feldolgozás elszáll, újrapróbálódik (`attempts` → dead-letter).
 *
 * A védelmi rend (#70: HOZZÁFÉRÉS > kormányzás > tartalom) a feldolgozás kapuja:
 *  - Visszavont / ismeretlen kötés → az agent-futásidő NEM hívódik (fail-closed), a forduló
 *    némán lezárul (a bekötetlen semleges választ a webhook-út adja a KÖVETKEZŐ üzenetnél).
 *  - Bekötött, de agent-engedély NÉLKÜL → érthető „szólj az adminodnak" válasz (nem néma,
 *    nem rejtélyes) — ez a HOZZÁFÉRÉS kapu felhasználó felé látszó része.
 *  - Bekötött + van engedélyezett agent → az agent-futás KÉSŐBBI szelet (#74); itt a forduló
 *    lezárul (a megbízható bejövő út már teljesült).
 *
 * A VARRAT a befecskendezett kimenő átvitel (`ChannelOutboundTransport`) és az audit: a
 * teszt egyetlen bejáraton (sor-feldolgozás) hajtja, és CSAK a rögzített kimenő hívásokat,
 * az audit-hatást és a forduló-állapotot nézi. Minden azonosító ÁLNEVESÍTVE kerül auditba.
 */
import type { ChannelType } from '@prisma/client'
import type {
  AuditRepository,
  ChannelAgentGrantRepository,
  ChannelIdentityRepository,
  ChannelSessionRepository,
  ChannelTurnRepository,
} from '@/repositories/interfaces'
import type { ChannelOutboundTransport } from './channel-outbound-transport'
import { CHANNEL_AUDIT_ACTIONS } from './channel-types'
import { pseudonymFromLookupHash } from './channel-identity-crypto'

/**
 * A bekötött, de agent-engedély nélküli felhasználó válasza (D16 / NFR-1: hétköznapi magyar,
 * önmagát magyarázó — nem néma, nem rejtélyes). Se agent-, se szervezet-, se felhasználónév.
 */
export const NO_AGENT_GRANT_TEXT =
  'A fiókod össze van kötve, de még nincs olyan agent, amelyikkel itt beszélhetnél. ' +
  'Az elérhető agenteket a szervezeted rendszergazdája engedélyezi — szólj neki, és amint ' +
  'engedélyez egyet, folytathatjuk itt.'

/** Egy forduló feldolgozásának kimenete — a teszt ezt és a rögzített kimenő hívásokat nézi. */
export type ChannelTurnOutcome =
  /** A munkamenet eltűnt a sor mögül (elvi eset, FK-kaszkád után) — némán lezárva. */
  | 'orphan'
  /** Visszavont / ismeretlen kötés → agent-futásidő NEM hívódott (fail-closed), némán lezárva. */
  | 'fail_closed'
  /** Bekötött, de agent-engedély nélkül → „szólj az adminodnak" válasz kiment. */
  | 'no_agent_notice'
  /** Bekötött + van engedélyezett agent → agent-futás későbbi szelet (#74); lezárva. */
  | 'linked_no_runtime'
  /** Átmeneti hiba → visszakerült a sorba (újrapróbálható). */
  | 'retry_scheduled'
  /** Kimerült újrapróbák → dead-letter (`failed`), `lastError`-ral. */
  | 'dead_letter'

export type ProcessTurnResult = { turnId: string; outcome: ChannelTurnOutcome }
export type ProcessBatchResult = { claimed: number; results: ProcessTurnResult[] }

export type ChannelTurnServiceDeps = {
  turns: ChannelTurnRepository
  sessions: Pick<ChannelSessionRepository, 'findById'>
  identities: Pick<ChannelIdentityRepository, 'findById'>
  grants: Pick<ChannelAgentGrantRepository, 'listByIdentity' | 'hasAnyGrant'>
  transport: ChannelOutboundTransport
  audit: Pick<AuditRepository, 'append'>
  /** Hány kivétel után megy egy forduló dead-letterbe (alap: 5). */
  maxAttempts?: number
  now?: () => Date
}

const DEFAULT_MAX_ATTEMPTS = 5

export class ChannelTurnService {
  private readonly maxAttempts: number
  private readonly now: () => Date

  constructor(private readonly deps: ChannelTurnServiceDeps) {
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * Crash-watchdog: az elszállt/leállított worker `running` fordulóit visszateszi `queued`-ba,
   * ha a `staleMs`-nál régebben ragadtak be. A visszatett sorok száma.
   */
  async reclaimStale(staleMs: number): Promise<number> {
    const now = this.now()
    return this.deps.turns.reclaimStaleRunning(new Date(now.getTime() - staleMs), now)
  }

  /**
   * Egy adag `queued` forduló lezavarása: atomi kivétel (`FOR UPDATE SKIP LOCKED`), majd
   * feldolgozás. A `limit` a felső korlát; az üres sornál előbb megáll.
   */
  async processQueuedBatch(limit: number): Promise<ProcessBatchResult> {
    const results: ProcessTurnResult[] = []
    for (let i = 0; i < limit; i++) {
      const turn = await this.deps.turns.claimNextQueued(this.now())
      if (!turn) break
      results.push(await this.processClaimed(turn.id, turn.sessionId))
    }
    return { claimed: results.length, results }
  }

  private async processClaimed(turnId: string, sessionId: string): Promise<ProcessTurnResult> {
    try {
      const session = await this.deps.sessions.findById(sessionId)
      if (!session) {
        await this.deps.turns.markDone(turnId, this.now())
        return { turnId, outcome: 'orphan' }
      }

      const identity = session.identityId
        ? await this.deps.identities.findById(session.identityId)
        : null

      // FAIL-CLOSED: visszavont vagy ismeretlen kötés → az agent-futásidő NEM hívódik. A
      // fordulót némán lezárjuk (a semleges „köss össze" választ a webhook-út adja majd a
      // következő bejövő üzenetnél — itt ismételt kimenő hívás csak zaj lenne).
      if (!identity || identity.status !== 'active') {
        await this.deps.turns.markDone(turnId, this.now())
        return { turnId, outcome: 'fail_closed' }
      }

      // HOZZÁFÉRÉS kapu: van-e LEGALÁBB egy engedélyezett agent? Ha nincs → érthető útmutató.
      const hasAgent = await this.deps.grants.hasAnyGrant(identity.id)
      if (!hasAgent) {
        await this.sendToThread(identity.channelType, session.externalThreadId, NO_AGENT_GRANT_TEXT)
        await this.deps.audit.append({
          actorType: 'system',
          actorId: null,
          agentVersion: null,
          action: CHANNEL_AUDIT_ACTIONS.turnNoAgent,
          targetType: 'channel_turn',
          targetId: turnId,
          modelUsed: null,
          inputRef: null,
          outputRef: null,
          policyDecision: 'no_agent_grant',
          metadata: {
            channelType: identity.channelType,
            tenantId: identity.tenantId,
            pseudonym: pseudonymFromLookupHash(identity.lookupHash),
          },
          tenantId: identity.tenantId,
        })
        await this.deps.turns.markDone(turnId, this.now())
        return { turnId, outcome: 'no_agent_notice' }
      }

      // Van engedélyezett agent, DE agent-futásidő MÉG nincs (ez a #74 szelet). A megbízható
      // bejövő út teljesült; a fordulót lezárjuk, a választ a következő szelet adja.
      await this.deps.turns.markDone(turnId, this.now())
      return { turnId, outcome: 'linked_no_runtime' }
    } catch (error) {
      // Feldolgozás elszállt → újrapróba (vagy kimerülésnél dead-letter). A forduló így nem
      // vész el egy átmeneti hibán.
      const message = error instanceof Error ? error.message : String(error)
      const disposition = await this.deps.turns.failOrRequeue(turnId, {
        error: message,
        maxAttempts: this.maxAttempts,
        now: this.now(),
      })
      return {
        turnId,
        outcome: disposition === 'failed' ? 'dead_letter' : 'retry_scheduled',
      }
    }
  }

  private async sendToThread(
    channelType: ChannelType,
    externalThreadId: string,
    text: string,
  ): Promise<void> {
    const res = await this.deps.transport.send({
      channelType,
      method: 'sendMessage',
      payload: { chat_id: externalThreadId, text },
    })
    // Átmeneti kimenő hiba → dobunk, hogy a forduló újrapróbálódjon. A NEM átmeneti eseteket
    // (a felhasználó letiltotta a botot, vagy az egress-őr blokkolt) nem érdemes ismételni —
    // a végtelen újrapróba csak terhelné a sort (D15).
    if (!res.ok && (res.reason === 'transport_error' || res.reason === 'provider_error')) {
      throw new Error(`outbound_${res.reason}${res.detail ? `:${res.detail}` : ''}`)
    }
  }
}
