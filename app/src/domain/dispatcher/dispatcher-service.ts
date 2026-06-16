import { randomUUID } from 'crypto'
import type { Ticket } from '@prisma/client'
import type { AuditRepository, ModelCallRepository, TicketRepository } from '@/repositories/interfaces'

export type DispatchBudget = {
  maxCallsPerDay: number
  maxTokensPerDay: number
}

export type HarnessLauncher = {
  readonly mode: string
  launch(input: {
    ticketId: string
    agentId: string
    lockToken: string
  }): Promise<{ jobId: string; executionName?: string }>
}

export class DispatcherService {
  constructor(
    private tickets: TicketRepository,
    private audit: AuditRepository,
    private modelCalls: ModelCallRepository,
    private launcher: HarnessLauncher,
    private budget: DispatchBudget = { maxCallsPerDay: 100, maxTokensPerDay: 100_000 },
  ) {}

  async dispatchReadyBatch(limit = 10, now = new Date()) {
    const readyTickets = await this.tickets.findReadyForDispatch(now, limit)
    const results: Array<{ ticketId: string; status: 'started' | 'skipped' | 'budget_blocked' }> = []

    for (const ticket of readyTickets) {
      results.push(await this.dispatchReadyTicket(ticket, now))
    }

    return results
  }

  async dispatchTicket(ticketId: string, now = new Date()) {
    const ticket = await this.tickets.findById(ticketId)
    if (!ticket) return { ticketId, status: 'skipped' as const }
    if (ticket.state !== 'ready') return { ticketId, status: 'skipped' as const }
    if (ticket.executeAfter && ticket.executeAfter > now) return { ticketId, status: 'skipped' as const }
    return this.dispatchReadyTicket(ticket, now)
  }

  private async dispatchReadyTicket(
    ticket: Ticket,
    now: Date,
  ): Promise<{ ticketId: string; status: 'started' | 'skipped' | 'budget_blocked' }> {
    if (!ticket.agentId) {
      return { ticketId: ticket.id, status: 'skipped' }
    }

    const since = new Date(now)
    since.setHours(0, 0, 0, 0)
    const usage = await this.modelCalls.getUsageForAgentSince(ticket.agentId, since)
    if (usage.calls >= this.budget.maxCallsPerDay || usage.tokens >= this.budget.maxTokensPerDay) {
      await this.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'dispatch.budget_blocked',
        targetType: 'ticket',
        targetId: ticket.id,
        modelUsed: null,
        inputRef: ticket.agentId,
        outputRef: null,
        policyDecision: 'budget_blocked',
        metadata: usage,
      })
      return { ticketId: ticket.id, status: 'budget_blocked' }
    }

    const lockToken = randomUUID()
    const lockedTicket = await this.tickets.acquireDispatchLock(ticket.id, lockToken, now)
    if (!lockedTicket) {
      return { ticketId: ticket.id, status: 'skipped' }
    }

    const started = await this.tickets.update(ticket.id, { state: 'in_progress' })
    await this.tickets.recordTransition({
      ticketId: ticket.id,
      fromState: 'ready',
      toState: 'in_progress',
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      note: 'dispatcher start',
    })

    let job: { jobId: string; executionName?: string }
    try {
      job = await this.launcher.launch({
        ticketId: started.id,
        agentId: ticket.agentId,
        lockToken,
      })
    } catch (error) {
      await this.tickets.releaseDispatchLock(ticket.id, lockToken)
      await this.tickets.update(ticket.id, { state: 'ready' })
      await this.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'dispatch.error',
        targetType: 'ticket',
        targetId: ticket.id,
        modelUsed: null,
        inputRef: ticket.agentId,
        outputRef: null,
        policyDecision: 'error',
        metadata: { error: error instanceof Error ? error.message : String(error) },
      })
      throw error
    }

    await this.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: 'ticket.transition',
      targetType: 'ticket',
      targetId: ticket.id,
      modelUsed: null,
      inputRef: 'ready',
      outputRef: 'in_progress',
      policyDecision: 'allowed',
      metadata: { source: 'dispatcher' },
    })

    await this.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: 'dispatch.start',
      targetType: 'ticket',
      targetId: ticket.id,
      modelUsed: null,
      inputRef: ticket.agentId,
      outputRef: job.jobId,
      policyDecision: 'started',
      metadata: {
        lockToken,
        launcherMode: this.launcher.mode,
        executionName: job.executionName ?? null,
      },
    })
    return { ticketId: ticket.id, status: 'started' }
  }
}
