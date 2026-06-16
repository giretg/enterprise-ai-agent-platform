import { randomUUID } from 'crypto'
import type {
  AuditRepository,
  ModelCallRepository,
  TicketRepository,
} from '@/repositories/interfaces'

export type DispatchBudget = {
  maxCallsPerDay: number
  maxTokensPerDay: number
}

export type HarnessLauncher = {
  launch(input: {
    ticketId: string
    agentId: string
    lockToken: string
  }): Promise<{ jobId: string }>
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
      if (!ticket.agentId) {
        results.push({ ticketId: ticket.id, status: 'skipped' })
        continue
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
        results.push({ ticketId: ticket.id, status: 'budget_blocked' })
        continue
      }

      const lockToken = randomUUID()
      const lockedTicket = await this.tickets.acquireDispatchLock(ticket.id, lockToken, now)
      if (!lockedTicket) {
        results.push({ ticketId: ticket.id, status: 'skipped' })
        continue
      }

      const started = await this.tickets.update(ticket.id, { state: 'in_progress' })
      const job = await this.launcher.launch({
        ticketId: started.id,
        agentId: ticket.agentId,
        lockToken,
      })

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
        metadata: { lockToken },
      })
      results.push({ ticketId: ticket.id, status: 'started' })
    }

    return results
  }
}
