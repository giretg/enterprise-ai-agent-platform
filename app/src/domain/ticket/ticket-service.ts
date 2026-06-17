import type { Prisma, TicketState } from '@prisma/client'
import type { AuditRepository, TicketRepository, TransitionActor } from '@/repositories/interfaces'
import { appendWikiFollowUpNote, clearWikiAnswerFields } from '@/lib/wiki-ticket-payload'
import type { PlaybookService } from '../playbook/playbook-service'

type TransitionRule = {
  from: TicketState
  to: TicketState
  allowed: 'system' | 'agent' | 'approver' | 'operator' | 'admin' | 'system_or_operator'
}

const TRANSITIONS: TransitionRule[] = [
  { from: 'backlog', to: 'ready', allowed: 'system_or_operator' },
  { from: 'ready', to: 'in_progress', allowed: 'system' },
  { from: 'ready', to: 'rejected', allowed: 'operator' },
  { from: 'in_progress', to: 'awaiting_human', allowed: 'system' },
  { from: 'in_progress', to: 'done', allowed: 'system' },
  { from: 'in_progress', to: 'rejected', allowed: 'operator' },
  { from: 'awaiting_human', to: 'approved', allowed: 'approver' },
  { from: 'awaiting_human', to: 'rejected', allowed: 'operator' },
  { from: 'approved', to: 'done', allowed: 'system' },
  { from: 'done', to: 'rejected', allowed: 'operator' },
  { from: 'rejected', to: 'ready', allowed: 'operator' },
]

function actorMatchesRule(actor: TransitionActor, allowed: TransitionRule['allowed']): boolean {
  if (allowed === 'system') return actor.type === 'system' || actor.type === 'agent'
  if (allowed === 'agent') return actor.type === 'agent' || actor.type === 'system'
  if (allowed === 'admin') return actor.type === 'human' && actor.role === 'admin'
  if (allowed === 'approver') {
    return actor.type === 'human' && (actor.role === 'approver' || actor.role === 'admin')
  }
  if (allowed === 'operator') {
    return (
      actor.type === 'human' &&
      (actor.role === 'operator' || actor.role === 'approver' || actor.role === 'admin')
    )
  }
  if (allowed === 'system_or_operator') {
    return actor.type === 'system' || actorMatchesRule(actor, 'operator')
  }
  return false
}

export class TicketService {
  constructor(
    private tickets: TicketRepository,
    private audit: AuditRepository,
    private playbooks?: PlaybookService,
    private resolveAgentRole?: (agentId: string | null) => Promise<'worker' | 'orchestrator'>,
  ) {}

  canTransition(from: TicketState, to: TicketState, actor: TransitionActor): boolean {
    const rule = TRANSITIONS.find((t) => t.from === from && t.to === to)
    if (!rule) return false
    return actorMatchesRule(actor, rule.allowed)
  }

  async transition(params: {
    ticketId: string
    toState: TicketState
    actor: TransitionActor
    note?: string
    agentVersion?: number
  }) {
    const ticket = await this.tickets.findById(params.ticketId)
    if (!ticket) throw new Error('Ticket not found')

    const actorType =
      params.actor.type === 'human' ? 'human' : params.actor.type === 'agent' ? 'agent' : 'system'
    const actorId =
      params.actor.type === 'human'
        ? params.actor.userId
        : params.actor.type === 'agent'
          ? params.actor.agentId
          : null

    if (!this.canTransition(ticket.state, params.toState, params.actor)) {
      await this.audit.append({
        actorType,
        actorId,
        agentVersion: params.agentVersion ?? null,
        action: 'ticket.transition.denied',
        targetType: 'ticket',
        targetId: ticket.id,
        modelUsed: null,
        inputRef: ticket.state,
        outputRef: params.toState,
        policyDecision: 'denied',
        metadata: params.note ? { note: params.note } : null,
      })
      throw new Error(`Transition not allowed: ${ticket.state} → ${params.toState}`)
    }

    if (this.playbooks && ticket.playbookRef) {
      const spec = await this.playbooks.resolveSpec(ticket.playbookRef)
      const agentRole = this.resolveAgentRole
        ? await this.resolveAgentRole(ticket.agentId)
        : 'worker'
      const gate = this.playbooks.checkTransition({
        ticket,
        from: ticket.state,
        to: params.toState,
        agentRole,
        spec,
      })
      if (gate.blocked) {
        await this.audit.append({
          actorType,
          actorId,
          agentVersion: params.agentVersion ?? null,
          action: 'ticket.transition.denied',
          targetType: 'ticket',
          targetId: ticket.id,
          modelUsed: null,
          inputRef: ticket.state,
          outputRef: params.toState,
          policyDecision: gate.reason ?? 'playbook_gate',
          metadata: { playbookRef: ticket.playbookRef, note: params.note ?? null },
        })
        throw new Error(`Playbook gate blocked: ${ticket.state} → ${params.toState}`)
      }
    }

    const payloadRecord =
      typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)
        ? (ticket.payload as Record<string, unknown>)
        : null

    let payload: Prisma.JsonValue = ticket.payload

    if (params.toState === 'rejected' && params.note && payloadRecord) {
      payload = appendWikiFollowUpNote(payloadRecord, params.note) as Prisma.JsonValue
    } else if (params.note && payloadRecord) {
      payload = { ...payloadRecord, transitionNote: params.note } as Prisma.JsonValue
    }

    if (params.toState === 'ready' && ticket.state === 'rejected' && payloadRecord) {
      payload = clearWikiAnswerFields(
        typeof payload === 'object' && payload !== null && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : payloadRecord,
      ) as Prisma.JsonValue
    }

    if (params.toState === 'rejected' && ticket.state === 'in_progress' && ticket.lockToken) {
      await this.tickets.releaseDispatchLock(ticket.id, ticket.lockToken)
    }

    const updated = await this.tickets.update(params.ticketId, {
      state: params.toState,
      payload,
      ...(params.toState === 'rejected' && ticket.state === 'in_progress'
        ? { lockToken: null, lockedAt: null }
        : {}),
    })

    await this.tickets.recordTransition({
      ticketId: ticket.id,
      fromState: ticket.state,
      toState: params.toState,
      actorType,
      actorId,
      agentVersion: params.agentVersion ?? null,
      note: params.note ?? null,
    })

    await this.audit.append({
      actorType,
      actorId,
      agentVersion: params.agentVersion ?? null,
      action: 'ticket.transition',
      targetType: 'ticket',
      targetId: ticket.id,
      modelUsed: null,
      inputRef: ticket.state,
      outputRef: params.toState,
      policyDecision: 'allowed',
      metadata: params.note ? { note: params.note } : null,
    })

    return updated
  }
}
