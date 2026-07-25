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
}

export type ConsequenceApprovalResult =
  | { ok: true; outcome: 'approved'; result: unknown }
  | { ok: true; outcome: 'rejected' }
  | { ok: false; reason: string }

function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  const path = typeof args.path === 'string' ? args.path : null
  if (path) return `${toolName} → ${path}`
  const to = typeof args.to === 'string' ? args.to : null
  if (to) return `${toolName} → ${to}`
  const title = typeof args.title === 'string' ? args.title : null
  if (title) return `${toolName}: ${title}`
  return toolName
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

  async approve(
    approvalId: string,
    actor: ConsequenceApprovalActor,
  ): Promise<ConsequenceApprovalResult> {
    const row = await this.approvals.findById(approvalId)
    if (!row) return { ok: false, reason: 'approval_not_found' }
    const access = await this.assertActorCanDecide(row, actor)
    if (!access.ok) return access

    if (row.status === 'approved') {
      return { ok: true, outcome: 'approved', result: row.resultMeta }
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
    return { ok: true, outcome: 'approved', result: result.result }
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
    // TENANT-HATÁR — ez az ELSŐ kapu, és szándékosan a beszélgetésre néz, nem az agentre.
    // Az agent-elérhetőség önmagában NEM elég: egy PLATFORM-SZINTŰ agent (tenantId === null)
    // minden tenantból elérhető, így pusztán arra támaszkodva egy „B" szervezet operátora
    // jóváhagyhatná az „A" szervezet beszélgetésében függő mellékhatást — és a jóváhagyás
    // szerveroldalon LE IS FUTTATJA a toolt (levélküldés, fájlírás) az „A" kontextusával.
    // A tenant-szűkített keresés a nem-egyező tenantot „nincs ilyen"-né olvasztja, így a
    // pending jóváhagyás LÉTEZÉSE sem szivárog ki (IDOR-próbálgatás ellen).
    const conversation = await this.conversations.findByIdForTenant(
      row.conversationId,
      actor.tenantId,
    )
    if (!conversation) return { ok: false, reason: 'conversation_not_found' }

    // Defense-in-depth: az agent is elérhető kell legyen a döntéshozó tenantjából.
    const agent = await this.agents.findById(row.agentId)
    if (!agent) return { ok: false, reason: 'agent_not_found' }
    if (!isAgentReachableFromTenant(agent.tenantId, actor.tenantId)) {
      return { ok: false, reason: 'tenant_mismatch' }
    }

    // A beszélgetés létrehozója vagy operator+ dönthet — a chat user a tipikus döntéshozó.
    const isCreator = conversation.createdById === actor.id
    const isElevated = actor.role === 'admin' || actor.role === 'approver' || actor.role === 'operator'
    if (!isCreator && !isElevated) {
      return { ok: false, reason: 'forbidden' }
    }
    return { ok: true }
  }
}
