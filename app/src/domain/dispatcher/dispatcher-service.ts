import { randomUUID } from 'crypto'
import type { Prisma, Ticket } from '@prisma/client'
import type {
  AgentRepository,
  AuditRepository,
  ModelCallRepository,
  TicketRepository,
} from '@/repositories/interfaces'
import { parseAgentModelConfig } from '@/lib/harness-model-config'
import { isRunAsAuthorized, readRunAsUserId } from '@/lib/run-as-payload'
import { wikiSearchQuery } from '@/lib/wiki-ticket-payload'
import type { DispatchAlertNotifier } from './dispatch-alert-notifier'

export type DispatchBudget = {
  maxCallsPerDay: number
  maxTokensPerDay: number
}

export const DEFAULT_DISPATCH_BUDGET: DispatchBudget = {
  maxCallsPerDay: 100,
  maxTokensPerDay: 100_000,
}

const DEFAULT_HARNESS_MAX_RETRIES = 3
const DEFAULT_HARNESS_DISPATCH_TIMEOUT_MS = 1_800_000

type HarnessErrorCategory = 'permanent' | 'transient'

type DispatchPayload = {
  ephemeralKeyId?: string
  failureCount?: number
}

type TicketPayloadObject = Record<string, unknown>

export function dispatchBudgetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DispatchBudget {
  const maxCallsPerDay = Number(
    env.DISPATCH_MAX_CALLS_PER_DAY ?? DEFAULT_DISPATCH_BUDGET.maxCallsPerDay,
  )
  const maxTokensPerDay = Number(
    env.DISPATCH_MAX_TOKENS_PER_DAY ?? DEFAULT_DISPATCH_BUDGET.maxTokensPerDay,
  )
  return {
    maxCallsPerDay:
      Number.isFinite(maxCallsPerDay) && maxCallsPerDay > 0
        ? Math.round(maxCallsPerDay)
        : DEFAULT_DISPATCH_BUDGET.maxCallsPerDay,
    maxTokensPerDay:
      Number.isFinite(maxTokensPerDay) && maxTokensPerDay > 0
        ? Math.round(maxTokensPerDay)
        : DEFAULT_DISPATCH_BUDGET.maxTokensPerDay,
  }
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
    gooseModel?: string
    harnessAgentApiKey?: string
    ephemeralKeyId?: string
  }): Promise<{ jobId: string; executionName?: string }>
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function ticketPayloadObject(payload: Prisma.JsonValue): TicketPayloadObject {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? { ...(payload as TicketPayloadObject) }
    : {}
}

function dispatchPayload(payload: TicketPayloadObject): DispatchPayload {
  const dispatch = payload.dispatch
  if (typeof dispatch !== 'object' || dispatch === null || Array.isArray(dispatch)) return {}
  const raw = dispatch as Record<string, unknown>
  return {
    ephemeralKeyId: typeof raw.ephemeralKeyId === 'string' ? raw.ephemeralKeyId : undefined,
    failureCount: typeof raw.failureCount === 'number' ? raw.failureCount : undefined,
  }
}

function withDispatchPayload(
  payload: Prisma.JsonValue,
  patch: DispatchPayload,
): Prisma.JsonValue {
  const base = ticketPayloadObject(payload)
  const current =
    typeof base.dispatch === 'object' && base.dispatch !== null && !Array.isArray(base.dispatch)
      ? { ...(base.dispatch as Record<string, unknown>) }
      : {}
  const nextDispatch: Record<string, unknown> = { ...current, ...patch }

  for (const [key, value] of Object.entries(nextDispatch)) {
    if (value === undefined || value === null) delete nextDispatch[key]
  }

  if (Object.keys(nextDispatch).length === 0) {
    delete base.dispatch
  } else {
    base.dispatch = nextDispatch
  }

  return base as Prisma.JsonObject
}

function classifyHarnessError(input: {
  error?: string
  errorCategory?: HarnessErrorCategory
}): HarnessErrorCategory {
  if (input.errorCategory) return input.errorCategory

  const error = input.error ?? ''
  if (
    /\b4\d\d\b/.test(error) ||
    /agent mismatch/i.test(error) ||
    /not assigned/i.test(error) ||
    /missing scope/i.test(error) ||
    /missing harness env/i.test(error) ||
    /unauthorized/i.test(error) ||
    /forbidden/i.test(error)
  ) {
    return 'permanent'
  }

  return 'transient'
}

export class DispatcherService {
  constructor(
    private tickets: TicketRepository,
    private audit: AuditRepository,
    private modelCalls: ModelCallRepository,
    private resolveLauncher: HarnessLauncher | (() => HarnessLauncher),
    private budget: DispatchBudget = DEFAULT_DISPATCH_BUDGET,
    /** Mode-specifikus engedélyezettség (§5.7). Ha hiányzik, a dispatch mindig engedélyezett. */
    private isDispatchEnabled: (mode: string) => Promise<boolean> = async () => true,
    private agents?: AgentRepository,
    private alertNotifier?: DispatchAlertNotifier,
  ) {}

  private async resolveHarnessGooseModel(
    agentId: string,
    agentVersion?: number,
  ): Promise<string | undefined> {
    if (!this.agents) return undefined

    if (agentVersion != null) {
      const snapshot = await this.agents.findVersionSnapshot(agentId, agentVersion)
      if (snapshot?.model) {
        return parseAgentModelConfig(snapshot.model).model
      }
    }

    const agent = await this.agents.findById(agentId)
    if (!agent) return undefined
    return parseAgentModelConfig(agent.modelConfig).model
  }

  private get launcher(): HarnessLauncher {
    return typeof this.resolveLauncher === 'function' ? this.resolveLauncher() : this.resolveLauncher
  }

  async dispatchReadyBatch(limit = 10, now = new Date()) {
    const results: Array<{ ticketId: string; status: 'started' | 'skipped' | 'budget_blocked' | 'paused' }> = []

    // Kill-switch: kikapcsolva (vagy a mód nincs az allowedModes-ban) egyetlen agentet sem indítunk.
    if (!(await this.isDispatchEnabled(this.launcher.mode))) {
      return [{ ticketId: '*', status: 'paused' as const }]
    }

    const readyTickets = await this.tickets.findReadyForDispatch(now, limit)
    for (const ticket of readyTickets) {
      results.push(await this.dispatchReadyTicket(ticket, now))
    }

    return results
  }

  async dispatchTicket(ticketId: string, now = new Date()) {
    if (!(await this.isDispatchEnabled(this.launcher.mode))) return { ticketId, status: 'paused' as const }
    const ticket = await this.tickets.findById(ticketId)
    if (!ticket) return { ticketId, status: 'skipped' as const }
    if (ticket.state !== 'ready') return { ticketId, status: 'skipped' as const }
    if (ticket.executeAfter && ticket.executeAfter > now) return { ticketId, status: 'skipped' as const }
    return this.dispatchReadyTicket(ticket, now)
  }

  async reclaimStaleDispatches(now = new Date()) {
    const timeoutMs = readPositiveInt(
      process.env.HARNESS_DISPATCH_TIMEOUT_MS,
      DEFAULT_HARNESS_DISPATCH_TIMEOUT_MS,
    )
    const cutoff = new Date(now.getTime() - timeoutMs)
    const stale = await this.tickets.findStaleInProgressDispatches(cutoff, 20)
    const results: Array<{ ticketId: string; status: 'reclaimed' | 'skipped' }> = []

    for (const ticket of stale) {
      if (!ticket.lockToken) {
        results.push({ ticketId: ticket.id, status: 'skipped' })
        continue
      }

      const keyId = dispatchPayload(ticketPayloadObject(ticket.payload)).ephemeralKeyId
      if (keyId && this.agents?.revokeKey) {
        await this.agents.revokeKey(keyId)
      }

      await this.tickets.releaseDispatchLock(ticket.id, ticket.lockToken)
      const updated = await this.tickets.update(ticket.id, {
        state: 'ready',
        payload: withDispatchPayload(ticket.payload, { ephemeralKeyId: undefined }),
      })
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
          keyId: keyId ?? null,
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
    errorCategory?: HarnessErrorCategory
  }): Promise<{ ticketId: string; status: 'completed' | 'already_completed' }> {
    const before = await this.tickets.findById(input.ticketId)
    if (!before) throw new Error('Ticket not found')
    const beforeDispatch = dispatchPayload(ticketPayloadObject(before.payload))

    if (!before.lockToken) {
      if (beforeDispatch.ephemeralKeyId && this.agents?.revokeKey) {
        await this.agents.revokeKey(beforeDispatch.ephemeralKeyId)
        await this.tickets.update(input.ticketId, {
          payload: withDispatchPayload(before.payload, { ephemeralKeyId: undefined }),
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
    const unlockedDispatch = dispatchPayload(ticketPayloadObject(unlocked.payload))
    const keyId = unlockedDispatch.ephemeralKeyId
    if (keyId && this.agents?.revokeKey) {
      await this.agents.revokeKey(keyId)
    }

    if (input.status === 'succeeded') {
      final = await this.tickets.update(input.ticketId, {
        payload: withDispatchPayload(unlocked.payload, {
          ephemeralKeyId: undefined,
          failureCount: undefined,
        }),
      })
    } else if (input.status === 'failed' && unlocked.state === 'in_progress') {
      const category = classifyHarnessError(input)
      const previousFailureCount =
        typeof unlockedDispatch.failureCount === 'number' && unlockedDispatch.failureCount > 0
          ? Math.floor(unlockedDispatch.failureCount)
          : 0
      const failureCount = previousFailureCount + 1
      const maxRetries = readPositiveInt(process.env.HARNESS_MAX_RETRIES, DEFAULT_HARNESS_MAX_RETRIES)
      const blocked = category === 'permanent' || failureCount >= maxRetries
      const toState = blocked ? 'awaiting_human' : 'ready'

      final = await this.tickets.update(input.ticketId, {
        state: toState,
        payload: withDispatchPayload(unlocked.payload, {
          ephemeralKeyId: undefined,
          failureCount,
        }),
      })
      await this.tickets.recordTransition({
        ticketId: input.ticketId,
        fromState: unlocked.state,
        toState,
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        note: input.error
          ? `harness failed (${category}, attempt ${failureCount}/${maxRetries}): ${input.error}`
          : `harness failed (${category}, attempt ${failureCount}/${maxRetries})`,
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
        outputRef: toState,
        policyDecision: blocked ? 'blocked' : 'failed',
        metadata: {
          ...this.completionMetadata(input),
          category,
          failureCount,
          maxRetries,
          keyId: keyId ?? null,
        },
      })

      if (blocked) {
        await this.audit.append({
          actorType: 'system',
          actorId: null,
          agentVersion: null,
          action: 'dispatch.blocked',
          targetType: 'ticket',
          targetId: input.ticketId,
          modelUsed: null,
          inputRef: input.jobId ?? input.executionName ?? null,
          outputRef: toState,
          policyDecision: 'blocked',
          metadata: {
            ...this.completionMetadata(input),
            category,
            failureCount,
            maxRetries,
            keyId: keyId ?? null,
          },
        })
        await this.notifyDispatchBlocked({
          ticket: final,
          category,
          failureCount,
          maxRetries,
          error: input.error ?? null,
          jobId: input.jobId,
          executionName: input.executionName,
        })
      }
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

    // I1 (§8): kizárólag `active` agent dispatchelhető. A draft/suspended/retired
    // agentre érkező dispatch-kísérletet auditáljuk és kihagyjuk — így egy menet
    // közben felfüggesztett/nyugdíjazott agent halasztott ticketje sem fut le.
    if (this.agents) {
      const agent = await this.agents.findById(ticket.agentId)
      if (!agent || agent.status !== 'active') {
        await this.audit.append({
          actorType: 'system',
          actorId: null,
          agentVersion: null,
          action: 'agent.dispatch_denied_inactive',
          targetType: 'agent',
          targetId: ticket.agentId,
          modelUsed: null,
          inputRef: ticket.id,
          outputRef: agent?.status ?? 'missing',
          policyDecision: 'denied',
          metadata: { ticketId: ticket.id, status: agent?.status ?? 'missing' },
        })
        return { ticketId: ticket.id, status: 'skipped' }
      }
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

    const payload = ticketPayloadObject(ticket.payload)
    const agentVersion =
      typeof payload.agentVersion === 'number' ? payload.agentVersion : undefined
    const searchQuery = wikiSearchQuery(payload).trim()
    const question = searchQuery || undefined
    const actingUserId = isRunAsAuthorized(payload) ? (readRunAsUserId(payload) ?? undefined) : undefined

    let started: Ticket | null = null
    let launcher: HarnessLauncher | null = null
    let gooseModel: string | undefined
    let job: { jobId: string; executionName?: string }
    let ephemeralKey: { id: string; rawKey: string; scopes: string[] } | null = null
    try {
      launcher = this.launcher
      gooseModel = await this.resolveHarnessGooseModel(ticket.agentId, agentVersion)

      if (launcher.mode !== 'local-wiki') {
        if (!this.agents?.issueEphemeralKey) {
          throw new Error(
            'Docker/Cloud Run harness indításhoz efemer agent API-kulcs kell — indítsd újra a dispatcher workert a friss kóddal.',
          )
        }
        ephemeralKey = await this.agents.issueEphemeralKey(ticket.agentId, {
          ttlMs: readPositiveInt(
            process.env.HARNESS_DISPATCH_TIMEOUT_MS,
            DEFAULT_HARNESS_DISPATCH_TIMEOUT_MS,
          ),
        })
      }

      started = await this.tickets.update(ticket.id, {
        state: 'in_progress',
        payload: ephemeralKey
          ? withDispatchPayload(lockedTicket.payload, { ephemeralKeyId: ephemeralKey.id })
          : lockedTicket.payload,
      })
      await this.tickets.recordTransition({
        ticketId: ticket.id,
        fromState: 'ready',
        toState: 'in_progress',
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        note: 'dispatcher start',
      })

      job = await launcher.launch({
        ticketId: started.id,
        agentId: ticket.agentId,
        lockToken,
        agentVersion,
        actingUserId,
        question,
        gooseModel,
        harnessAgentApiKey: ephemeralKey?.rawKey,
        ephemeralKeyId: ephemeralKey?.id,
      })
    } catch (error) {
      if (ephemeralKey && this.agents?.revokeKey) {
        await this.agents.revokeKey(ephemeralKey.id)
      }
      await this.tickets.releaseDispatchLock(ticket.id, lockToken)
      await this.tickets.update(ticket.id, {
        state: 'ready',
        payload: withDispatchPayload(lockedTicket.payload, { ephemeralKeyId: undefined }),
      })
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
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          keyId: ephemeralKey?.id ?? null,
        },
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
        launcherMode: launcher?.mode ?? 'unknown',
        executionName: job.executionName ?? null,
        actingUserId: actingUserId ?? null,
        keyId: ephemeralKey?.id ?? null,
      },
    })
    return { ticketId: ticket.id, status: 'started' }
  }

  private completionMetadata(input: {
    status: 'succeeded' | 'failed'
    jobId?: string
    executionName?: string
    error?: string
    errorCategory?: HarnessErrorCategory
  }): Prisma.JsonObject {
    return {
      status: input.status,
      jobId: input.jobId ?? null,
      executionName: input.executionName ?? null,
      error: input.error ?? null,
      errorCategory: input.errorCategory ?? null,
    }
  }

  private async notifyDispatchBlocked(input: {
    ticket: Ticket
    category: HarnessErrorCategory
    failureCount: number
    maxRetries: number
    error: string | null
    jobId?: string
    executionName?: string
  }) {
    if (!this.alertNotifier) return

    try {
      const result = await this.alertNotifier.dispatchBlocked({
        tenantId: input.ticket.tenantId,
        ticketId: input.ticket.id,
        ticketTitle: input.ticket.title,
        category: input.category,
        failureCount: input.failureCount,
        maxRetries: input.maxRetries,
        error: input.error,
      })
      await this.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'dispatch.notify.sent',
        targetType: 'ticket',
        targetId: input.ticket.id,
        modelUsed: null,
        inputRef: input.jobId ?? input.executionName ?? null,
        outputRef: result.messageId ?? result.provider,
        policyDecision: 'sent',
        metadata: {
          channel: result.channel,
          provider: result.provider,
          messageId: result.messageId ?? null,
          category: input.category,
          failureCount: input.failureCount,
          maxRetries: input.maxRetries,
        },
      })
    } catch (error) {
      await this.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'dispatch.notify.failed',
        targetType: 'ticket',
        targetId: input.ticket.id,
        modelUsed: null,
        inputRef: input.jobId ?? input.executionName ?? null,
        outputRef: null,
        policyDecision: 'failed',
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          category: input.category,
          failureCount: input.failureCount,
          maxRetries: input.maxRetries,
        },
      })
    }
  }
}
