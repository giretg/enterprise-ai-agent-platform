import { randomUUID } from 'crypto'
import type { Prisma, Ticket } from '@prisma/client'
import type { AuditRepository, ModelCallRepository, TicketRepository } from '@/repositories/interfaces'
import { isRunAsAuthorized, readRunAsUserId } from '@/lib/run-as-payload'
import { wikiSearchQuery } from '@/lib/wiki-ticket-payload'

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
    agentVersion?: number
    actingUserId?: string
    question?: string
  }): Promise<{ jobId: string; executionName?: string }>
}

export class DispatcherService {
  constructor(
    private tickets: TicketRepository,
    private audit: AuditRepository,
    private modelCalls: ModelCallRepository,
    private resolveLauncher: HarnessLauncher | (() => HarnessLauncher),
    private budget: DispatchBudget = { maxCallsPerDay: 100, maxTokensPerDay: 100_000 },
  ) {}

  private get launcher(): HarnessLauncher {
    return typeof this.resolveLauncher === 'function' ? this.resolveLauncher() : this.resolveLauncher
  }

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

  async reclaimStaleDispatches(now = new Date()) {
    const timeoutMs = Number.parseInt(process.env.HARNESS_DISPATCH_TIMEOUT_MS ?? '1800000', 10)
    const cutoff = new Date(now.getTime() - timeoutMs)
    const stale = await this.tickets.findStaleInProgressDispatches(cutoff, 20)
    const results: Array<{ ticketId: string; status: 'reclaimed' | 'skipped' }> = []

    for (const ticket of stale) {
      if (!ticket.lockToken) {
        results.push({ ticketId: ticket.id, status: 'skipped' })
        continue
      }

      await this.tickets.releaseDispatchLock(ticket.id, ticket.lockToken)
      const updated = await this.tickets.update(ticket.id, { state: 'ready' })
      await this.tickets.recordTransition({
        ticketId: ticket.id,
        fromState: 'in_progress',
        toState: 'ready',
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        note: `dispatch timeout after ${timeoutMs}ms`,
      })

      await this.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'dispatch.timeout',
        targetType: 'ticket',
        targetId: ticket.id,
        modelUsed: null,
        inputRef: ticket.lockToken,
        outputRef: updated.state,
        policyDecision: 'reclaimed',
        metadata: {
          lockedAt: ticket.lockedAt?.toISOString() ?? null,
          timeoutMs,
        },
      })

      results.push({ ticketId: ticket.id, status: 'reclaimed' })
    }

    return results
  }

  async completeHarnessRun(input: {
    ticketId: string
    lockToken: string
    status: 'succeeded' | 'failed'
    jobId?: string
    executionName?: string
    error?: string
  }): Promise<{ ticketId: string; status: 'completed' | 'already_completed' }> {
    const before = await this.tickets.findById(input.ticketId)
    if (!before) throw new Error('Ticket not found')

    if (!before.lockToken) {
      await this.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'dispatch.complete',
        targetType: 'ticket',
        targetId: input.ticketId,
        modelUsed: null,
        inputRef: input.jobId ?? input.executionName ?? null,
        outputRef: before.state,
        policyDecision: 'already_completed',
        metadata: this.completionMetadata(input),
      })
      return { ticketId: input.ticketId, status: 'already_completed' }
    }

    const unlocked = await this.tickets.completeDispatchLock(input.ticketId, input.lockToken)
    if (!unlocked) {
      await this.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'dispatch.complete.denied',
        targetType: 'ticket',
        targetId: input.ticketId,
        modelUsed: null,
        inputRef: input.jobId ?? input.executionName ?? null,
        outputRef: null,
        policyDecision: 'lock_mismatch',
        metadata: this.completionMetadata(input),
      })
      throw new Error('Dispatch completion rejected: lock token mismatch')
    }

    let final = unlocked
    if (input.status === 'failed' && unlocked.state === 'in_progress') {
      final = await this.tickets.update(input.ticketId, { state: 'ready' })
      await this.tickets.recordTransition({
        ticketId: input.ticketId,
        fromState: unlocked.state,
        toState: 'ready',
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        note: input.error ? `harness failed: ${input.error}` : 'harness failed',
      })
      await this.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'dispatch.error',
        targetType: 'ticket',
        targetId: input.ticketId,
        modelUsed: null,
        inputRef: input.jobId ?? input.executionName ?? null,
        outputRef: 'ready',
        policyDecision: 'failed',
        metadata: this.completionMetadata(input),
      })
    }

    await this.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: 'dispatch.complete',
      targetType: 'ticket',
      targetId: input.ticketId,
      modelUsed: null,
      inputRef: input.jobId ?? input.executionName ?? null,
      outputRef: final.state,
      policyDecision: input.status,
      metadata: this.completionMetadata(input),
    })

    return { ticketId: input.ticketId, status: 'completed' }
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

    const payload =
      typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)
        ? (ticket.payload as Record<string, unknown>)
        : {}
    const agentVersion =
      typeof payload.agentVersion === 'number' ? payload.agentVersion : undefined
    const question =
      typeof payload.question === 'string' && payload.question.trim()
        ? wikiSearchQuery(payload)
        : undefined
    const actingUserId = isRunAsAuthorized(payload) ? (readRunAsUserId(payload) ?? undefined) : undefined

    let job: { jobId: string; executionName?: string }
    try {
      job = await this.launcher.launch({
        ticketId: started.id,
        agentId: ticket.agentId,
        lockToken,
        agentVersion,
        actingUserId,
        question,
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
        actingUserId: actingUserId ?? null,
      },
    })
    return { ticketId: ticket.id, status: 'started' }
  }

  private completionMetadata(input: {
    status: 'succeeded' | 'failed'
    jobId?: string
    executionName?: string
    error?: string
  }): Prisma.JsonObject {
    return {
      status: input.status,
      jobId: input.jobId ?? null,
      executionName: input.executionName ?? null,
      error: input.error ?? null,
    }
  }
}
