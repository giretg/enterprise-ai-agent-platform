import type { TicketState } from '@prisma/client'
import type { AuditRepository, TicketRepository, TransitionActor } from '@/repositories/interfaces'

type TransitionRule = {
  from: TicketState
  to: TicketState
  allowed: 'system' | 'agent' | 'approver' | 'operator' | 'admin'
}

const TRANSITIONS: TransitionRule[] = [
  { from: 'backlog', to: 'in_review', allowed: 'system' },
  { from: 'in_review', to: 'awaiting_human', allowed: 'system' },
  { from: 'awaiting_human', to: 'approved', allowed: 'approver' },
  { from: 'awaiting_human', to: 'rejected', allowed: 'approver' },
  { from: 'approved', to: 'in_progress', allowed: 'system' },
  { from: 'in_progress', to: 'done', allowed: 'system' },
  { from: 'rejected', to: 'in_review', allowed: 'operator' },
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
  return false
}

export class TicketService {
  constructor(
    private tickets: TicketRepository,
    private audit: AuditRepository,
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

    if (!this.canTransition(ticket.state, params.toState, params.actor)) {
      throw new Error(`Transition not allowed: ${ticket.state} → ${params.toState}`)
    }

    const payload =
      params.note && typeof ticket.payload === 'object' && ticket.payload !== null
        ? { ...(ticket.payload as Record<string, unknown>), transitionNote: params.note }
        : ticket.payload

    const updated = await this.tickets.update(params.ticketId, {
      state: params.toState,
      payload,
    })

    await this.audit.append({
      actorType:
        params.actor.type === 'human'
          ? 'human'
          : params.actor.type === 'agent'
            ? 'agent'
            : 'system',
      actorId:
        params.actor.type === 'human'
          ? params.actor.userId
          : params.actor.type === 'agent'
            ? params.actor.agentId
            : null,
      agentVersion: params.agentVersion ?? null,
      action: 'ticket.transition',
      targetType: 'ticket',
      targetId: ticket.id,
      modelUsed: null,
      inputRef: ticket.state,
      outputRef: params.toState,
      policyDecision: 'n/a',
      prevHash: null,
      hash: null,
      metadata: params.note ? { note: params.note } : null,
    })

    return updated
  }
}
