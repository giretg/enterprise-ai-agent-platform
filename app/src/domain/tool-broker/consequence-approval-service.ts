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
} from '@/repositories/interfaces'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'
import type { ToolBrokerInvokeInput } from './tool-broker-types'
import type { ToolBrokerService } from './tool-broker-service'

export const CONSEQUENCE_APPROVAL_TTL_MS = 60 * 60 * 1000

/**
 * Meddig mutatjuk még a MÁR LEJÁRT függő jóváhagyást a beszélgetésben?
 *
 * Nem a döntés miatt (lejárt kártyát nem lehet jóváhagyni), hanem hogy a
 * felhasználó megértse, miért nem történt semmi. Ennél régebbi lejárt sor már
 * csak zaj lenne a szálban.
 */
export const CONSEQUENCE_APPROVAL_VISIBILITY_MS = 24 * 60 * 60 * 1000

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
  /**
   * A szerver órája szerint lejárt-e. A kliens órájára nem bízzuk: egy elállított
   * gép „még él" gombot mutatna egy halott jóváhagyáshoz.
   */
  expired?: boolean
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

function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  const path = typeof args.path === 'string' ? args.path : null
  if (path) return `${toolName} → ${path}`
  const to = typeof args.to === 'string' ? args.to : null
  if (to) return `${toolName} → ${to}`
  const title = typeof args.title === 'string' ? args.title : null
  if (title) return `${toolName}: ${title}`
  return toolName
}

/** A broker eredményéből rövid, olvasható szöveg (a `resultMeta` tetszőleges JSON). */
function describeResult(result: unknown): string {
  if (result === null || result === undefined) return 'kész'
  if (typeof result === 'string') return result.trim() || 'kész'
  let text: string
  try {
    text = JSON.stringify(result)
  } catch {
    return 'kész'
  }
  if (!text || text === '{}' || text === 'null') return 'kész'
  return text.length > CONTINUATION_RESULT_MAX_CHARS
    ? `${text.slice(0, CONTINUATION_RESULT_MAX_CHARS)}… (rövidítve)`
    : text
}

/** A `resultMeta`-ból (perzisztált végállapot) ugyanaz a szöveg, mint frissen futtatva. */
function describeResultMeta(resultMeta: unknown): string {
  if (resultMeta && typeof resultMeta === 'object' && 'result' in resultMeta) {
    return describeResult((resultMeta as { result: unknown }).result)
  }
  return describeResult(resultMeta)
}

export class ConsequenceApprovalService {
  constructor(
    private readonly approvals: ConsequenceApprovalRepository,
    private readonly conversations: ConversationRepository,
    private readonly agents: AgentRepository,
    private readonly audit: AuditRepository,
    private readonly toolBroker: ToolBrokerService,
  ) {}

  async createFromBlocked(input: {
    invoke: ToolBrokerInvokeInput
    tenantId?: string | null
    blockedToolCallId?: string | null
  }): Promise<ConsequenceApprovalCard> {
    const conversationId = input.invoke.conversationId
    if (!conversationId) {
      throw new Error('consequence_approval_requires_conversation')
    }
    const expiresAt = new Date(Date.now() + CONSEQUENCE_APPROVAL_TTL_MS)
    const row = await this.approvals.create({
      conversationId,
      agentId: input.invoke.agentId,
      agentVersion: input.invoke.agentVersion,
      tenantId: input.tenantId ?? null,
      actingUserId: input.invoke.actingUserId ?? null,
      ticketId: input.invoke.ticketId ?? null,
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
      targetType: 'conversation',
      targetId: conversationId,
      modelUsed: null,
      inputRef: input.invoke.tool,
      outputRef: row.id,
      policyDecision: 'consequence_gate_external_content',
      metadata: {
        approval_id: row.id,
        tool: input.invoke.tool,
        expires_at: expiresAt.toISOString(),
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
    const rows = await this.approvals.listPendingByConversation(
      conversationId,
      new Date(now - CONSEQUENCE_APPROVAL_VISIBILITY_MS),
    )

    const cards: ConsequenceApprovalCard[] = []
    for (const row of rows) {
      // Defense-in-depth: az agentnek is elérhetőnek kell lennie a néző tenantjából.
      const agent = await this.agents.findById(row.agentId)
      if (!agent || !isAgentReachableFromTenant(agent.tenantId, actor.tenantId)) continue
      cards.push({
        approvalId: row.id,
        toolName: row.toolName,
        summary: summarizeArgs(row.toolName, (row.args ?? {}) as Record<string, unknown>),
        expiresAt: row.expiresAt.toISOString(),
        expired: row.expiresAt.getTime() <= now,
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

    if (row.status === 'approved') {
      return {
        ok: true,
        outcome: 'approved',
        result: row.resultMeta,
        resultSummary: describeResultMeta(row.resultMeta),
      }
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

    const claimed = await this.approvals.casUpdateStatus(row.id, 'pending', {
      status: 'approved',
      approvedBy: actor.id,
      approvedAt: new Date(),
    })
    if (!claimed) return { ok: false, reason: 'approval_already_decided' }

    const invokeInput = {
      agentId: row.agentId,
      agentVersion: row.agentVersion,
      conversationId: row.conversationId,
      ...(row.ticketId ? { ticketId: row.ticketId } : {}),
      ...(row.actingUserId ? { actingUserId: row.actingUserId } : {}),
      tool: row.toolName,
      args: row.args,
    } as ToolBrokerInvokeInput

    const result = await this.toolBroker.invoke(invokeInput)
    const resultMeta = result.denied
      ? { denied: true, reason: result.reason ?? 'denied' }
      : { denied: false, result: result.result }

    await this.approvals.casUpdateStatus(row.id, 'approved', {
      status: 'approved',
      resultMeta,
    })

    await this.audit.append({
      actorType: 'human',
      actorId: actor.id,
      agentVersion: row.agentVersion,
      action: 'consequence.approval.approved',
      targetType: 'conversation',
      targetId: row.conversationId,
      modelUsed: null,
      inputRef: row.toolName,
      outputRef: row.id,
      policyDecision: result.denied ? 'invoke_denied' : 'invoke_ok',
      metadata: {
        approval_id: row.id,
        tool: row.toolName,
        denied: result.denied,
        reason: result.denied ? result.reason : undefined,
      },
    })

    if (result.denied) {
      return { ok: false, reason: result.reason ?? 'invoke_denied' }
    }
    return {
      ok: true,
      outcome: 'approved',
      result: result.result,
      resultSummary: describeResult(result.result),
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

      // Egy folytatás EGY beszélgetést visz tovább — kevert szál nem értelmezhető.
      if (conversationId && conversationId !== row.conversationId) {
        return { ok: false, reason: 'approval_conversation_mismatch' }
      }
      conversationId = row.conversationId
      agentId = row.agentId

      const resultMeta = row.resultMeta as { denied?: boolean; reason?: string } | null
      const outcome = resultMeta?.denied
        ? `NEM futott le (${resultMeta.reason ?? 'denied'})`
        : `lefutott — eredmény: ${describeResultMeta(row.resultMeta)}`
      lines.push(
        `- ${summarizeArgs(row.toolName, (row.args ?? {}) as Record<string, unknown>)} → ${outcome}`,
      )
    }

    if (!conversationId || !agentId) return { ok: false, reason: 'approval_not_found' }

    const prompt =
      `[Jóváhagyás a felületen] Jóváhagytam az alábbi műveletet, a platform le is futtatta:\n${lines.join('\n')}\n\n` +
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

    await this.audit.append({
      actorType: 'human',
      actorId: actor.id,
      agentVersion: row.agentVersion,
      action: 'consequence.approval.rejected',
      targetType: 'conversation',
      targetId: row.conversationId,
      modelUsed: null,
      inputRef: row.toolName,
      outputRef: row.id,
      policyDecision: 'rejected',
      metadata: { approval_id: row.id, tool: row.toolName },
    })

    return { ok: true, outcome: 'rejected' }
  }

  private async assertActorCanDecide(
    row: ConsequenceApproval,
    actor: ConsequenceApprovalActor,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const access = await this.assertActorCanAccessConversation(row.conversationId, actor)
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
}
