import { randomUUID } from 'crypto'
import type { Prisma, ProcessStepStatus, Ticket } from '@prisma/client'
import type {
  AgentRepository,
  AuditRepository,
  ModelCallRepository,
  ProcessRepository,
  TenantRepository,
  TicketRepository,
} from '@/repositories/interfaces'
import {
  evaluateTenantOperationGate,
  resolveWorkOwnerTenantId,
} from '@/lib/tenant-operation-gate'
import {
  ADVANCEABLE_PROCESS_STATUSES,
  TERMINAL_PROCESS_STATUSES,
} from '@/lib/playbook-v2/process-status'
import { parseAgentModelConfig } from '@/lib/harness-model-config'
import { isRunAsAuthorized, readRunAsUserId } from '@/lib/run-as-payload'
import { wikiSearchQuery } from '@/lib/wiki-ticket-payload'
import { logger, dispatchTotal, dispatchLagMs } from '@/lib/observability'
import { exceedsHardCap, type BudgetEngine, type BudgetUsage } from '@/domain/gateway/budget-engine'
import { guardrailFromEnv } from '@/domain/gateway/model-gateway'
import {
  TICKET_CALL_CAP_ERROR_CODE,
  formatTicketCallCapUserMessage,
  isTicketCallCapErrorMessage,
  ticketCallCapReason,
} from '@/lib/ticket-call-cap'
import type { DispatchAlertNotifier } from './dispatch-alert-notifier'

export type DispatchBudget = {
  maxCallsPerDay: number
  maxTokensPerDay: number
}

/**
 * Végső mentsvár, ha egyetlen `model_budgets` sor sem vonatkozik az agentre. Nem szabad
 * fail-openre váltani: keret nélkül egy hurokba került agent egy éjszaka alatt elégeti a
 * havi model-költséget. Aki tágabb keretet akar, vegyen fel egy tenant- vagy agent-szintű
 * budgetet az admin felületen (vagy állítsa a `DISPATCH_MAX_*` env-változókat).
 */
export const DEFAULT_DISPATCH_BUDGET: DispatchBudget = {
  maxCallsPerDay: 100,
  maxTokensPerDay: 100_000,
}

/** Miért nem indult el egy egyébként ready ticket. Audit + admin UI közös szótára. */
export type DispatchSkipReason =
  | 'no_agent'
  | 'agent_inactive'
  | 'tenant_inactive'
  | 'process_terminal'
  | 'lock_lost'

export type DispatchOutcome = {
  ticketId: string
  status: 'started' | 'skipped' | 'budget_blocked' | 'paused' | 'blocked'
  /** `skipped` esetén a konkrét ág; `budget_blocked`/`blocked` esetén a keret vagy hiba indoklása. */
  reason?: DispatchSkipReason | string
}

const DEFAULT_HARNESS_MAX_RETRIES = 3
const DEFAULT_HARNESS_DISPATCH_TIMEOUT_MS = 1_800_000

/**
 * Lépés-állapotok, amelyeknél a step döntése már megszületett — sem a stale-dispatch
 * reclaim, sem egy késő/duplikált ready-poll nem futtathatja újra az agentet.
 * `awaiting_gate`-et a runtime kapura VÁRÁSRA és a WP-7 await_human hard-blokkra is
 * használja (process-service.ts advance() await_gate/await_human ága) — mindkettőnél
 * a lépés lezárult a dispatcher szemszögéből, csak emberi/gate-döntésre vár.
 */
const STEP_DISPATCH_TERMINAL_STATUSES: ReadonlySet<ProcessStepStatus> = new Set([
  'completed',
  'awaiting_gate',
  'failed',
  'skipped',
])

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
    isTicketCallCapErrorMessage(error) ||
    /\b4\d\d\b/.test(error) ||
    /agent mismatch/i.test(error) ||
    /not assigned/i.test(error) ||
    /missing scope/i.test(error) ||
    /missing harness env/i.test(error) ||
    /unauthorized/i.test(error) ||
    /forbidden/i.test(error) ||
    /budget.?blocked/i.test(error) ||
    // Konfig-/policy-hiba: retry magától sosem oldja meg (pl. LACI board_write grant hiány).
    /capability_not_allowed/i.test(error) ||
    /board_write denied/i.test(error) ||
    /TRANSITION_NOT_ALLOWED/i.test(error)
  ) {
    return 'permanent'
  }

  return 'transient'
}

function withTicketCallCapPayload(
  payload: Prisma.JsonValue,
  message: string,
): Prisma.JsonValue {
  const base = ticketPayloadObject(payload)
  base.error = {
    code: TICKET_CALL_CAP_ERROR_CODE,
    reason: 'max_calls_per_ticket',
    message,
  }
  base.outcome = {
    status: 'blocked',
    reason: 'ticket_call_cap',
    message,
  }
  return base as Prisma.JsonObject
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
    private processes?: ProcessRepository,
    /**
     * A `model_budgets` táblán alapuló, hatókör-helyes keretek (tenant-összesített + per-agent).
     * Ha hiányzik, vagy egyetlen keret sem vonatkozik az agentre, a `budget` env-alapú
     * per-agent kerete dönt.
     */
    private budgetEngine?: BudgetEngine,
    /**
     * A tenant-státusz kapuhoz (§7.3). Ha hiányzik ÉS a munkának van
     * tulajdonos-tenantja, a kapu fail-closed tilt (nem engedi át a lyukat).
     */
    private tenants?: TenantRepository,
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

  async dispatchReadyBatch(limit = 10, now = new Date()): Promise<DispatchOutcome[]> {
    const results: DispatchOutcome[] = []

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

  async dispatchTicket(ticketId: string, now = new Date()): Promise<DispatchOutcome> {
    if (!(await this.isDispatchEnabled(this.launcher.mode))) return { ticketId, status: 'paused' }
    const ticket = await this.tickets.findById(ticketId)
    if (!ticket) return { ticketId, status: 'skipped', reason: 'no_agent' }
    if (ticket.state !== 'ready') return { ticketId, status: 'skipped', reason: 'not_ready' }
    if (ticket.executeAfter && ticket.executeAfter > now) {
      return { ticketId, status: 'skipped', reason: 'scheduled_later' }
    }
    if (await this.shouldSkipProcessTicketDispatch(ticket)) {
      return this.skip(ticket, 'process_terminal')
    }
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
      const reclaimToDone = await this.shouldFinalizeProcessTicketAfterStaleDispatch(ticket)
      const updated = await this.tickets.update(ticket.id, {
        state: reclaimToDone ? 'done' : 'ready',
        payload: withDispatchPayload(ticket.payload, { ephemeralKeyId: undefined }),
      })
      await this.tickets.recordTransition({
        ticketId: ticket.id,
        fromState: 'in_progress',
        toState: reclaimToDone ? 'done' : 'ready',
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        note: reclaimToDone
          ? `dispatch timeout on completed process step — ticket finalized as done`
          : `dispatch timeout after ${timeoutMs}ms`,
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
      const failed = await this.applyDispatchFailure({
        ticket: unlocked,
        fromState: unlocked.state,
        error: input.error,
        errorCategory: input.errorCategory,
        noteKind: 'harness',
        jobId: input.jobId,
        executionName: input.executionName,
      })
      final = failed.ticket
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

  /**
   * Local-wiki (és hasonló fire-and-forget) háttérfutás hibája: a ticket már
   * `in_progress`, a launch sync catch nem futott. Ugyanaz a retry/block politika,
   * mint a harness complete failed ágon — ne vakon `ready`-re tegye vissza.
   */
  async recoverLaunchFailure(input: {
    ticketId: string
    lockToken: string
    error: unknown
  }): Promise<{ ticketId: string; blocked: boolean }> {
    const current = await this.tickets.findById(input.ticketId)
    if (!current) return { ticketId: input.ticketId, blocked: false }

    const keyId = dispatchPayload(ticketPayloadObject(current.payload)).ephemeralKeyId
    if (keyId && this.agents?.revokeKey) {
      await this.agents.revokeKey(keyId)
    }
    await this.tickets.releaseDispatchLock(input.ticketId, input.lockToken)
    if (current.state !== 'in_progress') {
      return { ticketId: input.ticketId, blocked: false }
    }

    const error = input.error instanceof Error ? input.error.message : String(input.error)
    const result = await this.applyDispatchFailure({
      ticket: current,
      fromState: 'in_progress',
      error,
      noteKind: 'launch',
    })
    return { ticketId: input.ticketId, blocked: result.blocked }
  }

  /**
   * Közös retry/block politika launch- és harness-hibákra.
   * Permanent vagy max-retry után → `awaiting_human` + `dispatch.blocked` + notify.
   */
  private async applyDispatchFailure(input: {
    ticket: Ticket
    fromState: Ticket['state']
    error?: string
    errorCategory?: HarnessErrorCategory
    noteKind: 'harness' | 'launch'
    jobId?: string
    executionName?: string
  }): Promise<{
    ticket: Ticket
    blocked: boolean
    category: HarnessErrorCategory
    failureCount: number
    maxRetries: number
  }> {
    const category = classifyHarnessError(input)
    const currentDispatch = dispatchPayload(ticketPayloadObject(input.ticket.payload))
    const previousFailureCount =
      typeof currentDispatch.failureCount === 'number' && currentDispatch.failureCount > 0
        ? Math.floor(currentDispatch.failureCount)
        : 0
    const failureCount = previousFailureCount + 1
    const maxRetries = readPositiveInt(process.env.HARNESS_MAX_RETRIES, DEFAULT_HARNESS_MAX_RETRIES)
    const blocked = category === 'permanent' || failureCount >= maxRetries
    const toState = blocked ? 'awaiting_human' : 'ready'

    let nextPayload: Prisma.JsonValue = withDispatchPayload(input.ticket.payload, {
      ephemeralKeyId: undefined,
      failureCount,
    })
    if (isTicketCallCapErrorMessage(input.error)) {
      const usage = await this.modelCalls.getUsageForTicket(input.ticket.id)
      const maxCalls = guardrailFromEnv().maxCallsPerTicket
      nextPayload = withTicketCallCapPayload(
        nextPayload,
        formatTicketCallCapUserMessage({ calls: usage.calls, maxCalls }),
      )
    }

    const updated = await this.tickets.update(input.ticket.id, {
      state: toState,
      payload: nextPayload,
    })

    const noteBase =
      input.noteKind === 'launch' ? 'dispatcher launch failed' : 'harness failed'
    await this.tickets.recordTransition({
      ticketId: input.ticket.id,
      fromState: input.fromState,
      toState,
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      note: input.error
        ? `${noteBase} (${category}, attempt ${failureCount}/${maxRetries}): ${input.error}`
        : `${noteBase} (${category}, attempt ${failureCount}/${maxRetries})`,
    })
    await this.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: 'dispatch.error',
      targetType: 'ticket',
      targetId: input.ticket.id,
      modelUsed: null,
      inputRef: input.jobId ?? input.executionName ?? input.ticket.agentId,
      outputRef: toState,
      policyDecision: blocked ? 'blocked' : 'failed',
      metadata: {
        ...this.completionMetadata({
          status: 'failed',
          jobId: input.jobId,
          executionName: input.executionName,
          error: input.error,
          errorCategory: category,
        }),
        category,
        failureCount,
        maxRetries,
        noteKind: input.noteKind,
        keyId: currentDispatch.ephemeralKeyId ?? null,
      },
      tenantId: input.ticket.tenantId,
      ticketId: input.ticket.id,
    })

    if (blocked) {
      await this.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'dispatch.blocked',
        targetType: 'ticket',
        targetId: input.ticket.id,
        modelUsed: null,
        inputRef: input.jobId ?? input.executionName ?? input.ticket.agentId,
        outputRef: toState,
        policyDecision: 'blocked',
        metadata: {
          category,
          failureCount,
          maxRetries,
          error: input.error ?? null,
          noteKind: input.noteKind,
          keyId: currentDispatch.ephemeralKeyId ?? null,
        },
        tenantId: input.ticket.tenantId,
        ticketId: input.ticket.id,
      })
      await this.notifyDispatchBlocked({
        ticket: updated,
        category,
        failureCount,
        maxRetries,
        error: input.error ?? null,
        jobId: input.jobId,
        executionName: input.executionName,
      })
    }

    return { ticket: updated, blocked, category, failureCount, maxRetries }
  }

  private async blockForTicketCallCap(
    ticket: Ticket,
    usage: { calls: number; tokens: number },
    maxCalls: number,
  ): Promise<DispatchOutcome> {
    const message = formatTicketCallCapUserMessage({ calls: usage.calls, maxCalls })
    const reason = ticketCallCapReason(usage.calls, maxCalls)
    const fromState = ticket.state
    const keyId = dispatchPayload(ticketPayloadObject(ticket.payload)).ephemeralKeyId ?? null
    const nextPayload = withTicketCallCapPayload(
      withDispatchPayload(ticket.payload, { ephemeralKeyId: undefined }),
      message,
    )

    let updated = ticket
    if (ticket.state === 'ready' || ticket.state === 'in_progress') {
      updated = await this.tickets.update(ticket.id, {
        state: 'awaiting_human',
        payload: nextPayload,
      })
      await this.tickets.recordTransition({
        ticketId: ticket.id,
        fromState,
        toState: 'awaiting_human',
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        note: `ticket call cap reached (${usage.calls}/${maxCalls})`,
      })
    } else {
      updated = await this.tickets.update(ticket.id, { payload: nextPayload })
    }

    await this.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: 'dispatch.budget_blocked',
      targetType: 'ticket',
      targetId: ticket.id,
      modelUsed: null,
      inputRef: ticket.agentId,
      outputRef: 'ticket_call_cap',
      policyDecision: 'budget_blocked',
      metadata: {
        scope: 'ticket_call_cap',
        reason,
        calls: usage.calls,
        tokens: usage.tokens,
        maxCallsPerTicket: maxCalls,
      },
      tenantId: ticket.tenantId,
      ticketId: ticket.id,
    })
    await this.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: 'dispatch.blocked',
      targetType: 'ticket',
      targetId: ticket.id,
      modelUsed: null,
      inputRef: ticket.agentId,
      outputRef: 'awaiting_human',
      policyDecision: 'blocked',
      metadata: {
        category: 'permanent',
        scope: 'ticket_call_cap',
        reason,
        calls: usage.calls,
        maxCallsPerTicket: maxCalls,
        keyId,
      },
      tenantId: ticket.tenantId,
      ticketId: ticket.id,
    })
    dispatchTotal.inc({ result: 'budget_blocked' })
    logger.warn(
      {
        event: 'dispatch',
        result: 'budget_blocked',
        ticketId: ticket.id,
        agentId: ticket.agentId,
        scope: 'ticket_call_cap',
        reason,
      },
      'dispatch ticket call cap blocked',
    )
    await this.notifyDispatchBlocked({
      ticket: updated,
      category: 'permanent',
      failureCount: usage.calls,
      maxRetries: maxCalls,
      error: message,
    })
    return { ticketId: ticket.id, status: 'budget_blocked', reason }
  }

  /**
   * Minden kihagyás hagyjon nyomot. Korábban a `process_terminal` és a `lock_lost` ág
   * némán tűnt el — se log, se metrika, se audit —, így egy be nem induló ticketnél nem
   * lehetett megmondani, melyik kapu fogta meg. A `silent` csak a metrikát hallgattatja el
   * ott, ahol a hívó már saját, beszédesebb metrikát növelt.
   */
  private skip(
    ticket: Ticket,
    reason: DispatchSkipReason,
    opts?: { silent?: boolean },
  ): DispatchOutcome {
    if (!opts?.silent) dispatchTotal.inc({ result: 'skipped' })
    logger.info(
      { event: 'dispatch', result: 'skipped', reason, ticketId: ticket.id, agentId: ticket.agentId },
      'dispatch skipped',
    )
    return { ticketId: ticket.id, status: 'skipped', reason }
  }

  /**
   * A napi keret két kapuja: a tenant összesített kerete és a per-agent keret (a
   * `model_budgets` sorok hatóköre dönti el, melyik van egyáltalán beállítva). Ha egyetlen
   * keret sem vonatkozik erre az agentre, az env-alapú per-agent mentsvár marad — sosem
   * esünk keret nélküli állapotba.
   */
  private async checkBudget(
    ticket: Ticket,
    tenantId: string | null,
    now: Date,
  ): Promise<{ scope: string; reason: string; usage: BudgetUsage } | null> {
    const agentId = ticket.agentId
    if (!agentId) return null

    if (this.budgetEngine) {
      const statuses = await this.budgetEngine.statuses({ tenantId, agentId, ticketType: ticket.type })
      if (statuses.length > 0) {
        const hit = statuses.find((s) => s.exhausted)
        if (!hit) return null
        return {
          scope: hit.budget.scope,
          reason: exceedsHardCap(hit.budget, hit.usage) ?? 'budget exhausted',
          usage: hit.usage,
        }
      }
    }

    const since = new Date(now)
    since.setHours(0, 0, 0, 0)
    const usage = await this.modelCalls.getUsageForAgentSince(agentId, since)
    if (usage.calls >= this.budget.maxCallsPerDay) {
      return {
        scope: 'env_default',
        reason: `Call limit exceeded: ${usage.calls}/${this.budget.maxCallsPerDay} per day (scope=env_default)`,
        usage,
      }
    }
    if (usage.tokens >= this.budget.maxTokensPerDay) {
      return {
        scope: 'env_default',
        reason: `Token limit exceeded: ${usage.tokens}/${this.budget.maxTokensPerDay} per day (scope=env_default)`,
        usage,
      }
    }
    return null
  }

  private async dispatchReadyTicket(ticket: Ticket, now: Date): Promise<DispatchOutcome> {
    if (!ticket.agentId) {
      return this.skip(ticket, 'no_agent')
    }
    if (await this.shouldSkipProcessTicketDispatch(ticket)) {
      return this.skip(ticket, 'process_terminal')
    }

    // I1 (§8): kizárólag `active` agent dispatchelhető. A draft/suspended/retired
    // agentre érkező dispatch-kísérletet auditáljuk és kihagyjuk — így egy menet
    // közben felfüggesztett/nyugdíjazott agent halasztott ticketje sem fut le.
    const agent = this.agents ? await this.agents.findById(ticket.agentId) : null
    if (this.agents && (!agent || agent.status !== 'active')) {
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
      dispatchTotal.inc({ result: 'denied_inactive' })
      return this.skip(ticket, 'agent_inactive', { silent: true })
    }

    // I2 (§7.3): a tenant-státusz kapu az AUTOMATA úton is érvényes. A
    // `tenantStatusAllowsOperations` eddig csak az emberi guardokban élt
    // (`requireTenantRole` / `requireTenantPermission`), a dispatcher megkerülte —
    // így egy felfüggesztett/offboardolt tenant agentjei tovább futottak, tovább
    // égették a modell-keretet és tovább hívták a connectorokat.
    //
    // A kapu a MUNKA tulajdonosára kulcsol, nem az agent tulajdonosára: egy
    // megosztott, platform-szintű agent (`tenantId === null`) az
    // `isAgentReachableFromTenant` szerint MINDEN tenantból elérhető, így az
    // agentre kulcsolás lyukat hagyna — a felfüggesztett tenant tickete egy közös
    // agenthez rendelve simán lefutna, a tenant adatán dolgozva. Csak akkor nincs
    // kapu, ha maga a ticket is platform-szintű. Ha van tulajdonos-tenant, de a
    // tenant-repo nincs bekötve → fail-closed tiltás.
    const gateTenantId = resolveWorkOwnerTenantId(ticket.tenantId, agent?.tenantId)
    const tenantGate = await evaluateTenantOperationGate({
      tenants: this.tenants,
      gateTenantId,
    })
    if (!tenantGate.allowed) {
      await this.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'dispatch.tenant_inactive',
        targetType: 'ticket',
        targetId: ticket.id,
        modelUsed: null,
        inputRef: ticket.agentId,
        outputRef: tenantGate.tenantStatus,
        policyDecision: 'denied',
        metadata: {
          ticketId: ticket.id,
          tenantId: tenantGate.tenantId,
          tenantStatus: tenantGate.tenantStatus,
        },
        tenantId: tenantGate.tenantId,
      })
      dispatchTotal.inc({ result: 'denied_tenant_inactive' })
      return this.skip(ticket, 'tenant_inactive', { silent: true })
    }

    const breach = await this.checkBudget(ticket, agent?.tenantId ?? null, now)
    if (breach) {
      await this.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'dispatch.budget_blocked',
        targetType: 'ticket',
        targetId: ticket.id,
        modelUsed: null,
        inputRef: ticket.agentId,
        outputRef: breach.scope,
        policyDecision: 'budget_blocked',
        metadata: { ...breach.usage, scope: breach.scope, reason: breach.reason },
      })
      dispatchTotal.inc({ result: 'budget_blocked' })
      logger.warn(
        {
          event: 'dispatch',
          result: 'budget_blocked',
          ticketId: ticket.id,
          agentId: ticket.agentId,
          scope: breach.scope,
          reason: breach.reason,
        },
        'dispatch budget blocked',
      )
      return { ticketId: ticket.id, status: 'budget_blocked', reason: breach.reason }
    }

    // Ticketenkénti modellhívás-plafon (Gateway guardrail) — élettartam, nem napi.
    // Ha már kimerült, ne induljon Ready↔Feldolgozás ping-pong.
    const maxCallsPerTicket = guardrailFromEnv().maxCallsPerTicket
    const ticketUsage = await this.modelCalls.getUsageForTicket(ticket.id)
    if (ticketUsage.calls >= maxCallsPerTicket) {
      return this.blockForTicketCallCap(ticket, ticketUsage, maxCallsPerTicket)
    }

    const lockToken = randomUUID()
    const lockedTicket = await this.tickets.acquireDispatchLock(ticket.id, lockToken, now)
    if (!lockedTicket) {
      return this.skip(ticket, 'lock_lost')
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
      const errorMessage = error instanceof Error ? error.message : String(error)

      if (started) {
        const current = (await this.tickets.findById(ticket.id)) ?? started
        const failed = await this.applyDispatchFailure({
          ticket: current.state === 'in_progress' ? current : { ...current, state: 'in_progress' },
          fromState: 'in_progress',
          error: errorMessage,
          noteKind: 'launch',
        })
        dispatchTotal.inc({ result: 'error' })
        logger.error(
          {
            event: 'dispatch',
            result: 'error',
            ticketId: ticket.id,
            agentId: ticket.agentId,
            error: errorMessage,
            blocked: failed.blocked,
          },
          'dispatch failed',
        )
        if (failed.blocked) {
          return {
            ticketId: ticket.id,
            status: isTicketCallCapErrorMessage(errorMessage) ? 'budget_blocked' : 'blocked',
            reason: isTicketCallCapErrorMessage(errorMessage)
              ? ticketCallCapReason(
                  (await this.modelCalls.getUsageForTicket(ticket.id)).calls,
                  guardrailFromEnv().maxCallsPerTicket,
                )
              : errorMessage,
          }
        }
        throw error
      }

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
          error: errorMessage,
          keyId: ephemeralKey?.id ?? null,
        },
      })
      dispatchTotal.inc({ result: 'error' })
      logger.error(
        {
          event: 'dispatch',
          result: 'error',
          ticketId: ticket.id,
          agentId: ticket.agentId,
          error: errorMessage,
        },
        'dispatch failed',
      )
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

    // WP-6 (O2): dispatch-lag (a ticket utolsó frissítése óta a launchig) + kimenet.
    const readyAt = ticket.updatedAt instanceof Date ? ticket.updatedAt.getTime() : null
    const lagMs = readyAt !== null ? Math.max(0, now.getTime() - readyAt) : null
    dispatchTotal.inc({ result: 'started' })
    if (lagMs !== null) dispatchLagMs.observe(lagMs, { launcher: launcher?.mode ?? 'unknown' })
    logger.info(
      {
        event: 'dispatch',
        result: 'started',
        ticketId: ticket.id,
        agentId: ticket.agentId,
        launcherMode: launcher?.mode ?? 'unknown',
        jobId: job.jobId,
        lagMs,
      },
      'dispatch started',
    )
    return { ticketId: ticket.id, status: 'started' }
  }

  /**
   * Playbook-lépés ticket: ne indítsunk újra futást, ha a Futás már terminális
   * vagy a lépés instance már lezárult (késő harness / dupla dispatch). A
   * `completed`-en kívül az `awaiting_gate` (kapura VAGY emberi felülvizsgálatra
   * váró, §7.3/WP-7 await_human ág) és a `failed`/`skipped` is ilyen — ezekben az
   * állapotokban a step döntése már megszületett, újra-dispatch csak duplikált
   * agent-futást és (advance() újrahívásán át) a Futás státuszának felülírását
   * okozná (lásd [[process-config-slot-stuck-running]]).
   */
  private async shouldSkipProcessTicketDispatch(ticket: Ticket): Promise<boolean> {
    if (!ticket.processInstanceId || !this.processes) return false

    const proc = await this.processes.findProcess(ticket.tenantId, ticket.processInstanceId)
    if (proc && TERMINAL_PROCESS_STATUSES.has(proc.status)) return true
    if (proc && !ADVANCEABLE_PROCESS_STATUSES.has(proc.status)) return true

    if (ticket.playbookStepId) {
      const step = await this.processes.findStep(ticket.processInstanceId, ticket.playbookStepId)
      if (step && STEP_DISPATCH_TERMINAL_STATUSES.has(step.status)) return true
    }
    return false
  }

  /** Stale dispatch reclaim: terminális / már lezárt lépés ticket ne kerüljön vissza ready-be. */
  private async shouldFinalizeProcessTicketAfterStaleDispatch(ticket: Ticket): Promise<boolean> {
    if (!ticket.processInstanceId || !this.processes) return false

    const proc = await this.processes.findProcess(ticket.tenantId, ticket.processInstanceId)
    if (proc && TERMINAL_PROCESS_STATUSES.has(proc.status)) return true

    if (ticket.playbookStepId) {
      const step = await this.processes.findStep(ticket.processInstanceId, ticket.playbookStepId)
      if (step && STEP_DISPATCH_TERMINAL_STATUSES.has(step.status)) return true
    }
    return false
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
