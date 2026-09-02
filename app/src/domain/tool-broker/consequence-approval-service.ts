/**
 * Következmény-kapu jóváhagyás (issue #97).
 *
 * Külső, nem megbízható tartalom után a mellékhatásos toolok nem futnak automatikusan.
 * Ez a szolgáltatás:
 *  1. pending rekordot hoz létre a teljes tool-args-szal,
 *  2. jóváhagyáskor egyszer lefuttatja a toolt a brokeren keresztül (agent újraindítás nélkül),
 *  3. elutasításkor lezárja a pendinget.
 */
import type { ConsequenceApproval, UserRole } from '@prisma/client'
import type {
  AgentRepository,
  AuditRepository,
  ConsequenceApprovalRepository,
  ConversationRepository,
  TicketRepository,
} from '@/repositories/interfaces'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'
import { httpApiRequestArgsError } from '@/domain/tool-broker/consequence-gate-policy'
import { envelopeToolResultForModel } from './tool-result-envelope'
import { describeOutcomeForUi, type SettledToolOutcome } from './tool-output-contract'
import type { ToolBrokerInvokeInput } from './tool-broker-types'
import type { ToolBrokerService } from './tool-broker-service'

/** Chat következmény-kapu: rövid ablak — a felhasználó tipikusan a forduló végén dönt. */
export const CONSEQUENCE_APPROVAL_TTL_MS = 60 * 60 * 1000

/**
 * Ticket következmény-kapu: multi-körös, hosszú feladatok (pl. Föld-szinkron).
 * 1 óra itt zsákutca: a ticket `awaiting_human`-en ragad, a gomb pedig eltűnik.
 */
export const CONSEQUENCE_APPROVAL_TICKET_TTL_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Meddig mutatjuk még a MÁR LEJÁRT függő jóváhagyást a beszélgetésben?
 *
 * Nem a döntés miatt (lejárt kártyát nem lehet jóváhagyni), hanem hogy a
 * felhasználó megértse, miért nem történt semmi. Ennél régebbi lejárt sor már
 * csak zaj lenne a szálban.
 */
export const CONSEQUENCE_APPROVAL_VISIBILITY_MS = 24 * 60 * 60 * 1000

/**
 * Ticket listázási lookback: a még érvényes pendingek (TTL) + a frissen lejártak
 * magyarázata (visibility). Enélkül a 3 napos TTL 24 órán túl láthatatlan lenne.
 */
export const CONSEQUENCE_APPROVAL_TICKET_VISIBILITY_MS =
  CONSEQUENCE_APPROVAL_TICKET_TTL_MS + CONSEQUENCE_APPROVAL_VISIBILITY_MS

export function consequenceApprovalTtlMs(input: {
  ticketId?: string | null
}): number {
  return input.ticketId ? CONSEQUENCE_APPROVAL_TICKET_TTL_MS : CONSEQUENCE_APPROVAL_TTL_MS
}

export type ConsequenceApprovalActor = {
  id: string
  tenantId: string
  role: UserRole
}

export type ConsequenceApprovalCard = {
  approvalId: string
  toolName: string
  summary: string
  expiresAt: string
  /** A művelet már sorban állt — ez a MEGLÉVŐ kártya, nem új sor. */
  deduplicated?: boolean
  /**
   * A szerver órája szerint lejárt-e. A kliens órájára nem bízzuk: egy elállított
   * gép „még él" gombot mutatna egy halott jóváhagyáshoz.
   */
  expired?: boolean
  /**
   * Ha a korábbi jóváhagyás után a tool-hívás elbukott: a hiba kódja. A kártya
   * ebből írja ki, MIÉRT nem futott le a művelet, és emiatt kínál újrapróbálást.
   */
  failedReason?: string
  /**
   * A tool invoke még fut (`invoking` / `retrying`). Nem dönthető újra, de a
   * lista NEM hagyhatja ki — különben a ticket-folytatás „minden kész"-ként
   * indítaná újra az agentet, miközben a mellékhatás még tart / elbukhat.
   */
  inFlight?: boolean
}

export type ConsequenceApprovalResult =
  | {
      ok: true
      outcome: 'approved'
      result: unknown
      /** Rövid, emberi mondat arról, MI futott le — a kártya ezt írja ki. */
      resultSummary: string
    }
  | { ok: true; outcome: 'rejected' }
  | { ok: false; reason: string }

/**
 * A jóváhagyás utáni FOLYTATÁS bemenete: a lefuttatott művelet(ek) eredménye
 * és az a beszélgetés/agent, amelyben a folytatás fordulója elindulhat.
 */
export type ConsequenceApprovalContinuation = {
  conversationId: string
  agentId: string
  /** A folytatás forduló user-üzenete — SZERVER oldalon áll össze, nem a kliens küldi. */
  prompt: string
}

/** Mennyi eredményszöveg mehet vissza a modellnek a folytatáskor. */
const CONTINUATION_RESULT_MAX_CHARS = 600
/** Egy argumentum-részlet (útvonal, címzett, tárgy) maximális hossza a kártyán/promptban. */
const SUMMARY_ARG_MAX_CHARS = 200

/**
 * Hosszkorlát MINDEN modell/kártya felé menő részletre. A tool argumentumai és az
 * eredménye is a modell által, külső tartalomból generált szöveg: korlát nélkül egy
 * több tízezer karakteres „útvonal" vagy eredmény kiszorítaná a folytatás tényleges
 * utasítását a kontextusból (és olvashatatlanná tenné a kártyát).
 */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (rövidítve)` : text
}

function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  const path = typeof args.path === 'string' ? args.path : null
  if (path) return `${toolName} → ${clip(path, SUMMARY_ARG_MAX_CHARS)}`
  const to = typeof args.to === 'string' ? args.to : null
  if (to) return `${toolName} → ${clip(to, SUMMARY_ARG_MAX_CHARS)}`
  const title = typeof args.title === 'string' ? args.title : null
  if (title) return `${toolName}: ${clip(title, SUMMARY_ARG_MAX_CHARS)}`
  return toolName
}

/** A broker eredményéből rövid, olvasható szöveg (a `resultMeta` tetszőleges JSON). */
function describeResult(result: unknown): string {
  if (result === null || result === undefined) return 'kész'
  // A sztring-eredményre UGYANAZ a korlát vonatkozik, mint a JSON-ra: egy hosszú
  // szöveges tool-válasz enélkül teljes egészében a promptba/kártyára kerülne.
  if (typeof result === 'string') return clip(result.trim(), CONTINUATION_RESULT_MAX_CHARS) || 'kész'
  let text: string
  try {
    text = JSON.stringify(result)
  } catch {
    return 'kész'
  }
  if (!text || text === '{}' || text === 'null') return 'kész'
  return clip(text, CONTINUATION_RESULT_MAX_CHARS)
}

/**
 * issue #195 — a kimenetel HÉTKÖZNAPI mondata a nyers eredmény elé. A puszta
 * JSON-kivonat („{path: …}") eddig sikernek látszott akkor is, ha az eszköz
 * 0 sort írt: a kártya és a folytatás-prompt is ezen a szövegen múlik.
 */
function describeToolOutcome(
  outcome: SettledToolOutcome | undefined,
  outcomeReason: string | null | undefined,
  result: unknown,
): string {
  const body = describeResult(result)
  const notice = outcome ? describeOutcomeForUi(outcome, outcomeReason ?? null) : null
  return notice ? `${notice} — ${body}` : body
}

/** A `resultMeta`-ból (perzisztált végállapot) ugyanaz a szöveg, mint frissen futtatva. */
function describeResultMeta(resultMeta: unknown): string {
  if (resultMeta && typeof resultMeta === 'object' && 'result' in resultMeta) {
    const meta = resultMeta as { result: unknown; outcome?: unknown; outcomeReason?: unknown }
    const outcome =
      meta.outcome === 'empty' || meta.outcome === 'partial' || meta.outcome === 'ok'
        ? meta.outcome
        : undefined
    return describeToolOutcome(
      outcome,
      typeof meta.outcomeReason === 'string' ? meta.outcomeReason : null,
      meta.result,
    )
  }
  return describeResult(resultMeta)
}

/** Korábbi approve után a tool invoke denied/exception-nel zárult-e. */
function isFailedInvokeResultMeta(resultMeta: unknown): boolean {
  if (!resultMeta || typeof resultMeta !== 'object' || Array.isArray(resultMeta)) return false
  return (resultMeta as { denied?: unknown }).denied === true
}

/**
 * Átmeneti „folyamatban" jelzők: az első approve `invoking: true`-t ír a
 * pending→approved CAS-szal, a retry `retrying: true`-t a `casClaimRetry`-jal.
 * Ilyenkor a sor státusza `approved`, de a művelet még nem zárult le — nem
 * szabad se „kész"-ként folytatni, se újra lefoglalni.
 */
function isInvokeInFlightResultMeta(resultMeta: unknown): boolean {
  if (!resultMeta || typeof resultMeta !== 'object' || Array.isArray(resultMeta)) return false
  const meta = resultMeta as { retrying?: unknown; invoking?: unknown }
  return meta.retrying === true || meta.invoking === true
}

/**
 * Sikeresen lezárt invoke: `denied === false` (a `invokeApproved` írja).
 * `null` / hiányzó denied / `invoking` → NEM siker — különben párhuzamos
 * kattintás vagy crash utáni üres meta hamis „kész"-et adna.
 */
function isSettledSuccessResultMeta(resultMeta: unknown): boolean {
  if (!resultMeta || typeof resultMeta !== 'object' || Array.isArray(resultMeta)) return false
  return (resultMeta as { denied?: unknown }).denied === false
}

export class ConsequenceApprovalService {
  constructor(
    private readonly approvals: ConsequenceApprovalRepository,
    private readonly conversations: ConversationRepository,
    private readonly agents: AgentRepository,
    private readonly audit: AuditRepository,
    private readonly toolBroker: ToolBrokerService,
    private readonly tickets?: TicketRepository,
  ) {}

  async createFromBlocked(input: {
    invoke: ToolBrokerInvokeInput
    tenantId?: string | null
    blockedToolCallId?: string | null
  }): Promise<ConsequenceApprovalCard> {
    const conversationId = input.invoke.conversationId ?? null
    const ticketId = input.invoke.ticketId ?? null
    if (!conversationId && !ticketId) {
      throw new Error('consequence_approval_requires_conversation_or_ticket')
    }
    if (input.invoke.tool === 'http_api_request') {
      const malformed = httpApiRequestArgsError(
        (input.invoke.args ?? {}) as Record<string, unknown>,
      )
      if (malformed) {
        throw new Error('consequence_approval_malformed_http_api_request')
      }
    }
    // Kártya-dedup: ugyanaz a még el nem döntött művelet ne kapjon második
    // kártyát. Folytatás után a modell a checkpointból újraszámolja a hátralévő
    // tételeket, és a már kártyázott hívást ismét beküldi — a felhasználó
    // ilyenkor ugyanazt a törlést kétszer látja, és egy „Jóváhagyom mind"
    // kétszer futtatná le.
    const existing = await this.approvals.findOpenDuplicate({
      conversationId,
      ticketId,
      toolName: input.invoke.tool,
      args: input.invoke.args,
      now: new Date(),
    })
    if (existing) {
      return {
        approvalId: existing.id,
        toolName: existing.toolName,
        summary: summarizeArgs(existing.toolName, (existing.args ?? {}) as Record<string, unknown>),
        expiresAt: existing.expiresAt.toISOString(),
        deduplicated: true,
      }
    }

    const expiresAt = new Date(Date.now() + consequenceApprovalTtlMs({ ticketId }))
    const row = await this.approvals.create({
      conversationId,
      agentId: input.invoke.agentId,
      agentVersion: input.invoke.agentVersion,
      tenantId: input.tenantId ?? null,
      actingUserId: input.invoke.actingUserId ?? null,
      ticketId,
      toolName: input.invoke.tool,
      args: input.invoke.args as object,
      status: 'pending',
      blockedToolCallId: input.blockedToolCallId ?? null,
      resultMeta: null,
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      expiresAt,
    })

    await this.audit.append({
      actorType: 'agent',
      actorId: input.invoke.agentId,
      agentVersion: input.invoke.agentVersion,
      action: 'consequence.approval.pending',
      targetType: conversationId ? 'conversation' : 'ticket',
      targetId: conversationId ?? ticketId!,
      modelUsed: null,
      inputRef: input.invoke.tool,
      outputRef: row.id,
      policyDecision: 'consequence_gate_risk',
      metadata: {
        approval_id: row.id,
        tool: input.invoke.tool,
        expires_at: expiresAt.toISOString(),
        ticket_id: ticketId,
        conversation_id: conversationId,
      },
    })

    return {
      approvalId: row.id,
      toolName: input.invoke.tool,
      summary: summarizeArgs(input.invoke.tool, input.invoke.args as Record<string, unknown>),
      expiresAt: expiresAt.toISOString(),
    }
  }

  /**
   * Egy beszélgetés függő jóváhagyásai a chat ÚJRATÖLTÉSÉHEZ.
   *
   * A stream-esemény önmagában efemer: a forduló lezárultával (a chat a DB
   * végállapotát tölti újra), lapfrissítéskor és visszacsatlakozáskor a kártya
   * eltűnne, a művelet pedig némán ott ülne lejáratig. Ez a metódus a tartós
   * forrás — ugyanazzal a tenant-határral, mint a döntés maga: idegen tenantból
   * a pending jóváhagyás LÉTEZÉSE sem látszik.
   */
  async listOpenForConversation(
    conversationId: string,
    actor: ConsequenceApprovalActor,
  ): Promise<ConsequenceApprovalCard[]> {
    const access = await this.assertActorCanAccessConversation(conversationId, actor)
    if (!access.ok) return []

    const now = Date.now()
    const rows = await this.approvals.listOpenByConversation(
      conversationId,
      new Date(now - CONSEQUENCE_APPROVAL_VISIBILITY_MS),
    )
    return this.toOpenCards(rows, actor, now)
  }

  /** Task-only ticket függő jóváhagyásai a ticket UI-hoz. */
  async listOpenForTicket(
    ticketId: string,
    actor: ConsequenceApprovalActor,
  ): Promise<ConsequenceApprovalCard[]> {
    const access = await this.assertActorCanAccessTicket(ticketId, actor)
    if (!access.ok) return []

    const now = Date.now()
    const rows = await this.approvals.listOpenByTicket(
      ticketId,
      new Date(now - CONSEQUENCE_APPROVAL_TICKET_VISIBILITY_MS),
    )
    return this.toOpenCards(rows, actor, now)
  }

  private async toOpenCards(
    rows: ConsequenceApproval[],
    actor: ConsequenceApprovalActor,
    now: number,
  ): Promise<ConsequenceApprovalCard[]> {
    const cards: ConsequenceApprovalCard[] = []
    for (const row of rows) {
      const inFlight = isInvokeInFlightResultMeta(row.resultMeta)
      // A sikeresen lefutott jóváhagyás lezárt ügy — nem kérünk rá újra gombot.
      // Az elbukott tool-hívás viszont igen: az emberi döntés megvan, a művelet
      // nem futott le, ezért újratöltés után is kell hozzá „Újrapróbálom".
      // Folyamatban lévő invoke: NEM zárható le „kész"-ként — a ticket-resume
      // és a lista ugyanabból a forrásból dönt (lásd resumeTicketAfterConsequenceApprovals).
      if (
        row.status === 'approved' &&
        !inFlight &&
        !isFailedInvokeResultMeta(row.resultMeta)
      ) {
        continue
      }
      // Defense-in-depth: az agentnek is elérhetőnek kell lennie a néző tenantjából.
      const agent = await this.agents.findById(row.agentId)
      if (!agent || !isAgentReachableFromTenant(agent.tenantId, actor.tenantId)) continue
      const failedReason =
        row.status === 'approved' && !inFlight
          ? ((row.resultMeta as { reason?: unknown } | null)?.reason ?? 'invoke_failed')
          : null
      cards.push({
        approvalId: row.id,
        toolName: row.toolName,
        summary: summarizeArgs(row.toolName, (row.args ?? {}) as Record<string, unknown>),
        expiresAt: row.expiresAt.toISOString(),
        // Egy elbukott hívás akkor is újrafuttatható, ha közben letelt a
        // jóváhagyási ablak: a döntés már megszületett, csak a végrehajtás
        // hiányzik — nem küldjük vissza a felhasználót új kört kérni.
        expired: row.status === 'pending' && row.expiresAt.getTime() <= now,
        ...(failedReason ? { failedReason: String(failedReason) } : {}),
        ...(inFlight ? { inFlight: true } : {}),
      })
    }
    return cards
  }

  async approve(
    approvalId: string,
    actor: ConsequenceApprovalActor,
  ): Promise<ConsequenceApprovalResult> {
    const row = await this.approvals.findById(approvalId)
    if (!row) return { ok: false, reason: 'approval_not_found' }
    const access = await this.assertActorCanDecide(row, actor)
    if (!access.ok) return access

    // Egy MÁR lefoglalt (folyamatban lévő) első invoke / retry: a művelet se nem
    // futott le, se nem bukott — csak fut. NEM szabad se „siker"-ként jelenteni
    // (különben egy futó/soha-le-nem-futott toolt mutatnánk késznek), se újra
    // lefoglalni. A felhasználó egy pillanat múlva újrapróbálhatja.
    if (isInvokeInFlightResultMeta(row.resultMeta)) {
      return { ok: false, reason: 'approval_in_flight' }
    }

    const previouslyFailedInvoke = isFailedInvokeResultMeta(row.resultMeta)

    if (row.status === 'approved' && !previouslyFailedInvoke) {
      // Sikeres invoke utáni ismételt kattintás: ne futtassuk újra a toolt.
      // DE: `resultMeta === null` (régi sor / crash) vagy hiányzó lezárás →
      // NEM siker. Enélkül a párhuzamos második katt az első invoke közben
      // „kész"-ként vinné tovább a szálat, miközben a mellékhatás még fut.
      if (!isSettledSuccessResultMeta(row.resultMeta)) {
        return { ok: false, reason: 'approval_in_flight' }
      }
      return {
        ok: true,
        outcome: 'approved',
        result: row.resultMeta,
        resultSummary: describeResultMeta(row.resultMeta),
      }
    }
    if (row.status === 'approved' && previouslyFailedInvoke) {
      // Emberi jóváhagyás megvan, a tool invoke bukott el — Újrapróbálom újrafuttat.
      // Egyszer-használat a retry úton is: az első jóváhagyást a pending→approved
      // CAS védi, a retry-t a casClaimRetry. Két párhuzamos kattintás közül csak
      // az egyik futtat; a vesztes nem futtat semmit.
      const claimed = await this.approvals.casClaimRetry(row.id)
      if (!claimed) return { ok: false, reason: 'approval_in_flight' }
      return this.invokeApproved(claimed, actor)
    }
    if (row.status !== 'pending') {
      return { ok: false, reason: `approval_${row.status}` }
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.approvals.casUpdateStatus(row.id, 'pending', {
        status: 'expired',
      })
      return { ok: false, reason: 'approval_expired' }
    }

    // Egyszer-használat az ELSŐ úton is: a pending→approved CAS mellé azonnal
    // `invoking: true` kerül. Így a párhuzamos második katt (ami már `approved`
    // sort lát) nem eshet a siker-ágba null meta mellett — ugyanaz a fail-safe,
    // mint a retry `retrying` jelzője.
    const claimed = await this.approvals.casUpdateStatus(row.id, 'pending', {
      status: 'approved',
      approvedBy: actor.id,
      approvedAt: new Date(),
      resultMeta: { invoking: true },
    })
    if (!claimed) return { ok: false, reason: 'approval_already_decided' }

    return this.invokeApproved(claimed, actor)
  }

  /**
   * Már approved sor tool-újrafuttatása (első approve után, vagy sikertelen
   * invoke Újrapróbálom ágán). A döntés (approved) megmarad; csak a resultMeta frissül.
   */
  private async invokeApproved(
    row: ConsequenceApproval,
    actor: ConsequenceApprovalActor,
  ): Promise<ConsequenceApprovalResult> {
    if (row.toolName === 'http_api_request') {
      const malformed = httpApiRequestArgsError((row.args ?? {}) as Record<string, unknown>)
      if (malformed) {
        const reason = 'approval_stored_malformed_request'
        await this.approvals.casUpdateStatus(row.id, 'approved', {
          status: 'approved',
          resultMeta: { denied: true, reason, failed: true },
        })
        const auditTarget = this.auditTargetFor(row)
        await this.audit.append({
          actorType: 'human',
          actorId: actor.id,
          agentVersion: row.agentVersion,
          action: 'consequence.approval.approved',
          targetType: auditTarget.type,
          targetId: auditTarget.id,
          modelUsed: null,
          inputRef: row.toolName,
          outputRef: row.id,
          policyDecision: 'invoke_error',
          metadata: {
            approval_id: row.id,
            tool: row.toolName,
            denied: true,
            reason,
          },
        })
        return { ok: false, reason }
      }
    }

    const invokeInput = {
      agentId: row.agentId,
      agentVersion: row.agentVersion,
      ...(row.conversationId ? { conversationId: row.conversationId } : {}),
      ...(row.ticketId ? { ticketId: row.ticketId } : {}),
      ...(row.actingUserId ? { actingUserId: row.actingUserId } : {}),
      tool: row.toolName,
      args: row.args,
    } as ToolBrokerInvokeInput

    const auditTarget = this.auditTargetFor(row)

    let result: Awaited<ReturnType<ToolBrokerService['invoke']>>
    try {
      result = await this.toolBroker.invoke(invokeInput)
    } catch (error) {
      // A CAS már approved-re állt — ne hagyjuk resultMeta nélkül, különben a
      // második kattintás „sikeresnek" tűnik, miközben a tool soha nem futott.
      const reason = error instanceof Error ? error.message : 'invoke_failed'
      await this.approvals.casUpdateStatus(row.id, 'approved', {
        status: 'approved',
        resultMeta: { denied: true, reason, failed: true },
      })
      await this.audit.append({
        actorType: 'human',
        actorId: actor.id,
        agentVersion: row.agentVersion,
        action: 'consequence.approval.approved',
        targetType: auditTarget.type,
        targetId: auditTarget.id,
        modelUsed: null,
        inputRef: row.toolName,
        outputRef: row.id,
        policyDecision: 'invoke_error',
        metadata: {
          approval_id: row.id,
          tool: row.toolName,
          denied: true,
          reason,
        },
      })
      return { ok: false, reason }
    }

    // issue #195 D1 — a kimenetel a JÓVÁHAGYOTT úton is végigmegy. Épp itt futnak
    // a mellékhatásos eszközök (levélküldés, írás, API-hívás): ha az `empty` /
    // `partial` ítélet itt elveszne, a folytatás-prompt és a kártya „lefutott"-at
    // mondana egy olyan hívásra, ami valójában semmit nem termelt.
    const resultMeta = result.denied
      ? { denied: true, reason: result.reason ?? 'denied' }
      : {
          denied: false,
          result: result.result,
          outcome: result.outcome,
          outcomeReason: result.outcomeReason,
        }

    await this.approvals.casUpdateStatus(row.id, 'approved', {
      status: 'approved',
      resultMeta,
    })

    await this.audit.append({
      actorType: 'human',
      actorId: actor.id,
      agentVersion: row.agentVersion,
      action: 'consequence.approval.approved',
      targetType: auditTarget.type,
      targetId: auditTarget.id,
      modelUsed: null,
      inputRef: row.toolName,
      outputRef: row.id,
      policyDecision: result.denied ? 'invoke_denied' : 'invoke_ok',
      metadata: {
        approval_id: row.id,
        tool: row.toolName,
        denied: result.denied,
        reason: result.denied ? result.reason : undefined,
        tool_outcome: result.denied ? 'failed' : result.outcome,
        tool_outcome_reason: result.denied ? null : result.outcomeReason,
      },
    })

    if (result.denied) {
      return { ok: false, reason: result.reason ?? 'invoke_denied' }
    }
    return {
      ok: true,
      outcome: 'approved',
      result: result.result,
      resultSummary: describeToolOutcome(result.outcome, result.outcomeReason, result.result),
    }
  }

  /**
   * A jóváhagyás utáni FOLYTATÁS forduló bemenete (issue #97 utókövetés).
   *
   * Üzletileg: a gomb megnyomása után a művelet lefut, de a felhasználó eddig
   * ebből SEMMIT nem látott — se agent-választ, se a hátralévő lépéseket (egy
   * xlsx-nél a fájl létrejött, a sorok viszont sosem íródtak be). Ez a metódus
   * adja a folytatás fordulójának a szerver által összeállított szövegét: mi
   * futott le és milyen eredménnyel. A prompt SOSEM a kliens szövege — a
   * kliens csak az azonosítókat küldi.
   *
   * Csak MÁR jóváhagyott, egy beszélgetéshez tartozó sorokat fogad el, és
   * ugyanazon a tenant-kapun megy át, mint maga a döntés.
   */
  async getApprovedContinuation(
    approvalIds: string[],
    actor: ConsequenceApprovalActor,
  ): Promise<{ ok: true; continuation: ConsequenceApprovalContinuation } | { ok: false; reason: string }> {
    const ids = [...new Set(approvalIds)].filter((id) => typeof id === 'string' && id.length > 0)
    if (ids.length === 0) return { ok: false, reason: 'approval_not_found' }

    const lines: string[] = []
    let conversationId: string | null = null
    let agentId: string | null = null

    for (const id of ids) {
      const row = await this.approvals.findById(id)
      if (!row) return { ok: false, reason: 'approval_not_found' }
      const access = await this.assertActorCanDecide(row, actor)
      if (!access.ok) return access
      if (row.status !== 'approved') return { ok: false, reason: `approval_${row.status}` }
      // Folyamatban lévő első invoke / retry, vagy lezáratlan (null) meta: nem
      // szabad „kész"-ként továbbvinni — különben az agent úgy folytatná, mintha
      // a mellékhatás (levél, POST, törlés) már megtörtént volna.
      if (isInvokeInFlightResultMeta(row.resultMeta) || row.resultMeta == null) {
        return { ok: false, reason: 'approval_in_flight' }
      }

      if (!row.conversationId) {
        // Task-only jóváhagyás: a tool a gombbal lefut; chat-folytatás nincs.
        return { ok: false, reason: 'approval_ticket_only_no_chat_continuation' }
      }

      // Egy folytatás EGY beszélgetést visz tovább — kevert szál nem értelmezhető.
      if (conversationId && conversationId !== row.conversationId) {
        return { ok: false, reason: 'approval_conversation_mismatch' }
      }
      conversationId = row.conversationId
      agentId = row.agentId

      const resultMeta = row.resultMeta as { denied?: boolean; reason?: string }
      const outcome = resultMeta.denied
        ? `NEM futott le (${resultMeta.reason ?? 'denied'})`
        : `lefutott — eredmény: ${describeResultMeta(row.resultMeta)}`
      lines.push(
        `- ${summarizeArgs(row.toolName, (row.args ?? {}) as Record<string, unknown>)} → ${outcome}`,
      )
    }

    if (!conversationId || !agentId) return { ok: false, reason: 'approval_not_found' }

    // A sorok tartalma (útvonal, címzett, tárgy, eredmény) a modell által, KÜLSŐ
    // tartalomból generált szöveg — épp azért esett kapura a hívás. Ez a szöveg egy
    // user-szerepű üzenetbe kerül, ami a legmagasabb bizalmi szint: becsomagolás
    // nélkül egy támadó által írt fájlnév/tárgy utasításnak látszana. Ugyanazon az
    // egységes borítékon megy át, mint minden más külső eredmény (issue #97 §2).
    const prompt =
      '[Jóváhagyás a felületen] Jóváhagytam az alábbi műveletet, a platform le is futtatta:\n' +
      `${envelopeToolResultForModel('external_untrusted', lines.join('\n'))}\n\n` +
      'NE futtasd újra ezeket a lépéseket. Folytasd innen a hátralévő lépésekkel, ' +
      'majd foglald össze magyarul, mi készült el és mi maradt hátra. ' +
      'Ha egy hátralévő lépés újra jóváhagyásra vár, mondd el, hogy a chatben megjelenő gombbal engedélyezhető.'

    return { ok: true, continuation: { conversationId, agentId, prompt } }
  }

  async reject(
    approvalId: string,
    actor: ConsequenceApprovalActor,
  ): Promise<ConsequenceApprovalResult> {
    const row = await this.approvals.findById(approvalId)
    if (!row) return { ok: false, reason: 'approval_not_found' }
    const access = await this.assertActorCanDecide(row, actor)
    if (!access.ok) return access

    if (row.status === 'rejected') return { ok: true, outcome: 'rejected' }
    if (row.status !== 'pending') return { ok: false, reason: `approval_${row.status}` }

    const claimed = await this.approvals.casUpdateStatus(row.id, 'pending', {
      status: 'rejected',
      rejectedBy: actor.id,
      rejectedAt: new Date(),
    })
    if (!claimed) return { ok: false, reason: 'approval_already_decided' }

    const auditTarget = this.auditTargetFor(row)
    await this.audit.append({
      actorType: 'human',
      actorId: actor.id,
      agentVersion: row.agentVersion,
      action: 'consequence.approval.rejected',
      targetType: auditTarget.type,
      targetId: auditTarget.id,
      modelUsed: null,
      inputRef: row.toolName,
      outputRef: row.id,
      policyDecision: 'rejected',
      metadata: { approval_id: row.id, tool: row.toolName },
    })

    return { ok: true, outcome: 'rejected' }
  }

  private auditTargetFor(row: ConsequenceApproval): {
    type: 'conversation' | 'ticket'
    id: string
  } {
    if (row.conversationId) return { type: 'conversation', id: row.conversationId }
    if (row.ticketId) return { type: 'ticket', id: row.ticketId }
    return { type: 'ticket', id: row.id }
  }

  private async assertActorCanDecide(
    row: ConsequenceApproval,
    actor: ConsequenceApprovalActor,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const access = row.conversationId
      ? await this.assertActorCanAccessConversation(row.conversationId, actor)
      : row.ticketId
        ? await this.assertActorCanAccessTicket(row.ticketId, actor)
        : { ok: false as const, reason: 'approval_not_found' }
    if (!access.ok) return access

    // Defense-in-depth: az agent is elérhető kell legyen a döntéshozó tenantjából.
    const agent = await this.agents.findById(row.agentId)
    if (!agent) return { ok: false, reason: 'agent_not_found' }
    if (!isAgentReachableFromTenant(agent.tenantId, actor.tenantId)) {
      return { ok: false, reason: 'tenant_mismatch' }
    }
    return { ok: true }
  }

  private async assertActorCanAccessConversation(
    conversationId: string,
    actor: ConsequenceApprovalActor,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    // TENANT-HATÁR — ez az ELSŐ kapu, és szándékosan a beszélgetésre néz, nem az agentre.
    // Az agent-elérhetőség önmagában NEM elég: egy PLATFORM-SZINTŰ agent (tenantId === null)
    // minden tenantból elérhető, így pusztán arra támaszkodva egy „B" szervezet operátora
    // jóváhagyhatná az „A" szervezet beszélgetésében függő mellékhatást — és a jóváhagyás
    // szerveroldalon LE IS FUTTATJA a toolt (levélküldés, fájlírás) az „A" kontextusával.
    // A tenant-szűkített keresés a nem-egyező tenantot „nincs ilyen"-né olvasztja, így a
    // pending jóváhagyás LÉTEZÉSE sem szivárog ki (IDOR-próbálgatás ellen).
    const conversation = await this.conversations.findByIdForTenant(conversationId, actor.tenantId)
    if (!conversation) return { ok: false, reason: 'conversation_not_found' }

    // A beszélgetés létrehozója vagy operator+ dönthet — a chat user a tipikus döntéshozó.
    const isCreator = conversation.createdById === actor.id
    const isElevated = actor.role === 'admin' || actor.role === 'approver' || actor.role === 'operator'
    if (!isCreator && !isElevated) {
      return { ok: false, reason: 'forbidden' }
    }
    return { ok: true }
  }

  private async assertActorCanAccessTicket(
    ticketId: string,
    actor: ConsequenceApprovalActor,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.tickets) return { ok: false, reason: 'ticket_not_found' }
    const ticket = await this.tickets.findById(ticketId)
    if (!ticket) return { ok: false, reason: 'ticket_not_found' }
    // Tenant-határ: idegen tenant ticketje „nincs ilyen".
    if (ticket.tenantId && ticket.tenantId !== actor.tenantId) {
      return { ok: false, reason: 'ticket_not_found' }
    }
    const isCreator = ticket.createdById === actor.id
    const isElevated = actor.role === 'admin' || actor.role === 'approver' || actor.role === 'operator'
    if (!isCreator && !isElevated) {
      return { ok: false, reason: 'forbidden' }
    }
    return { ok: true }
  }
}
