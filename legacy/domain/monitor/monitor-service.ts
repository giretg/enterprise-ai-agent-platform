import type { Prisma, MonitorDefinition, MonitorRun, MonitorRunOutcome, MonitorSignal, ProcessTrigger } from '@prisma/client'
import type {
  AuditRepository,
  AgentRepository,
  MonitorRepository,
  ProcessDefinitionRepository,
  TicketRepository,
  UpdateMonitorInput,
} from '@/repositories/interfaces'
import type { ProcessService } from '@/domain/playbook/process-service'
import type { AgentAccessService } from '@/domain/agent-access/agent-access-service'
import { randomUUID } from 'crypto'
import type { MonitorCollector, MonitorSignalDraft } from './collectors/types'
import { evaluateFilter } from './filter-eval'
import {
  AuditOnlyMonitorNotifier,
  type MonitorNotifier,
} from '@/lib/notify/monitor-notifier'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'

export type SweepResult = {
  monitorId: string
  outcome: MonitorRunOutcome
  openedTicketIds: string[]
  startedProcessIds: string[]
}

function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

/**
 * A következő söprés időpontja (Feature-spec — Proactive Monitor §4.4): intervallum +
 * catch-up policy (run_late / skip) + jitter a terheléscsúcs simítására.
 */
export function computeNextSweepAt(monitor: MonitorDefinition, now: Date): Date {
  const intervalMs = monitor.intervalSeconds * 1000
  let base = monitor.nextSweepAt.getTime() + intervalMs
  const catchupFloor = now.getTime() - monitor.catchupWindowSec * 1000
  if (base < catchupFloor) {
    if (monitor.catchupPolicy === 'skip') {
      // Igazítsuk az első jövőbeli slotra (a kihagyott ablakokat eldobjuk).
      const slotsBehind = Math.ceil((now.getTime() - base) / intervalMs)
      base = base + slotsBehind * intervalMs
    } else {
      base = now.getTime() // run_late: késve, de egyszer fut
    }
  }
  const jitter = Math.floor(Math.random() * Math.min(intervalMs * 0.1, 30_000))
  return new Date(base + jitter)
}

function renderDedupKey(monitor: MonitorDefinition, signal: MonitorSignalDraft): string {
  const template = monitor.dedupKeyTemplate
  if (template) {
    return template.replace(/\{(\w+)\}/g, (_, key: string) => signal.dedupKeyParts[key] ?? '')
  }
  const parts = Object.keys(signal.dedupKeyParts)
    .sort()
    .map((k) => signal.dedupKeyParts[k])
    .join(':')
  return `${monitor.kind}:${parts}`
}

/**
 * Proaktív monitor söprés-motor (Feature-spec — Proactive Monitor §4).
 *
 * Kétlépcsős, token-takarékos: az 1. lépcső (collect + filter) nulla LLM-token; a
 * drága LLM csak küszöböt átlépő jelnél, a 2. lépcsőben (eszkaláció) indul. Ha a
 * monitornak nincs `escalateAgentId`-ja, a monitor LLM nélkül is teljes értékű —
 * pusztán naplózott, jóváhagyás-köteles tickettet nyit a boardon.
 */
export class MonitorService {
  private collectors: Map<string, MonitorCollector>

  constructor(
    private monitors: MonitorRepository,
    private tickets: TicketRepository,
    private audit: AuditRepository,
    collectors: MonitorCollector[] = [],
    private notifier: MonitorNotifier = new AuditOnlyMonitorNotifier(),
    private processDefinitions?: ProcessDefinitionRepository,
    private processService?: ProcessService,
    private agents?: AgentRepository,
  ) {
    this.collectors = new Map(collectors.map((c) => [c.kind, c]))
  }

  /**
   * #142 — az agent-hozzáférési gráf SHADOW ellenőrzője. A Monitor-cron a definíció
   * jogosítványán fut, ezért az eszkaláció NEM áll meg az ad-hoc gráf deny döntésén;
   * de `agent.access.bypass` eseményt írunk, ha az ad-hoc út elutasítaná. Setter-
   * injektálás, hogy a késői wiring ne bővítse a pozicionális konstruktort.
   */
  private agentAccess?: AgentAccessService

  setAgentAccessService(service: AgentAccessService): void {
    this.agentAccess = service
  }

  async list(tenantId: string) {
    return this.monitors.findMany({ tenantId })
  }

  async getById(id: string, tenantId: string): Promise<MonitorDefinition> {
    return this.requireTenantMonitor(id, tenantId)
  }

  async update(id: string, tenantId: string, data: UpdateMonitorInput): Promise<MonitorDefinition> {
    const monitor = await this.requireTenantMonitor(id, tenantId)
    return this.monitors.update(monitor.id, data)
  }

  async revoke(id: string, tenantId: string): Promise<MonitorDefinition> {
    const monitor = await this.requireTenantMonitor(id, tenantId)
    return this.monitors.revoke(monitor.id)
  }

  async listRuns(monitorId: string, tenantId: string, limit = 20): Promise<MonitorRun[]> {
    const monitor = await this.requireTenantMonitor(monitorId, tenantId)
    return this.monitors.findRuns(monitor.id, limit)
  }

  async listSignals(monitorId: string, tenantId: string, limit = 50): Promise<MonitorSignal[]> {
    const monitor = await this.requireTenantMonitor(monitorId, tenantId)
    return this.monitors.findSignalsByMonitor(monitor.id, limit)
  }

  /**
   * Dry-run (PM-E §9): lefuttatja az 1. lépcsőt, szűrőt és cooldown-ellenőrzést, de
   * nem nyit ticketet, nem hív LLM-et, nem ír adatbázisba. Az eredmény a szerkesztő
   * hangolásához mutatja meg, mi lenne eszkalálva / elnyomva.
   */
  async dryRun(monitorId: string, tenantId: string, now = new Date()) {
    const monitor = await this.requireTenantMonitor(monitorId, tenantId)

    const collector = this.collectors.get(monitor.kind)
    const signals = collector
      ? await collector.collect({
          tenantId: monitor.tenantId,
          config: jsonObject(monitor.collectorConfig),
          now,
          monitor,
        })
      : []

    const results = await Promise.all(
      signals.map(async (signal) => {
        const filterResult = evaluateFilter(monitor.filterConfig, signal, now)
        let cooldownStatus: 'would_escalate' | 'suppressed' | 'new' = 'new'
        if (filterResult.matched) {
          const dedupKey = renderDedupKey(monitor, signal)
          const existing = await this.monitors
            .findSignalsByMonitor(monitorId, 200)
            .then((all) => all.find((s) => s.dedupKey === dedupKey))
          if (existing?.lastEscalatedAt) {
            const age = now.getTime() - existing.lastEscalatedAt.getTime()
            cooldownStatus = age < monitor.cooldownSeconds * 1000 ? 'suppressed' : 'would_escalate'
          } else {
            cooldownStatus = 'would_escalate'
          }
        }
        return { signal, filterResult, cooldownStatus }
      }),
    )

    const wouldEscalate = results.filter((r) => r.cooldownStatus === 'would_escalate').length
    const suppressed = results.filter((r) => r.cooldownStatus === 'suppressed').length
    const filtered = results.filter((r) => !r.filterResult.matched).length

    return { signals: results, summary: { total: signals.length, wouldEscalate, suppressed, filtered } }
  }

  /** Nem-LLM söprés: minden esedékes monitor lockolása + futtatása (a worker hívja). */
  async sweepDue(now = new Date(), limit = 10): Promise<SweepResult[]> {
    const due = await this.monitors.findDue(now, limit)
    const results: SweepResult[] = []
    for (const monitor of due) {
      const lockToken = randomUUID()
      const claimed = await this.monitors.claim(monitor.id, lockToken, now)
      if (!claimed) continue // másik worker megelőzött (dupla-fire védelem)
      try {
        results.push(await this.runSweep(claimed, now))
      } finally {
        await this.monitors.release(claimed.id, lockToken, {
          nextSweepAt: computeNextSweepAt(claimed, now),
          lastSweepAt: now,
        })
      }
    }
    return results
  }

  /** Stale lock visszavétel (crash a release előtt) — a worker reclaim-ciklusa hívja. */
  async reclaimStaleLocks(staleAfterMs = 300_000, limit = 10): Promise<number> {
    const cutoff = new Date(Date.now() - staleAfterMs)
    const stale = await this.monitors.findStaleLocked(cutoff, limit)
    for (const monitor of stale) {
      await this.monitors.releaseLock(monitor.id)
      await this.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'monitor.lock_reclaimed',
        targetType: 'monitor',
        targetId: monitor.id,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: 'reclaimed',
        metadata: { lockedAt: monitor.lockedAt?.toISOString() ?? null },
      })
    }
    return stale.length
  }

  private async runSweep(monitor: MonitorDefinition, now: Date): Promise<SweepResult> {
    const scheduledFor = monitor.nextSweepAt
    // Idempotencia: ha erre a periódusra már van run, kilépünk (§4.11.7 dupla-fire).
    const run = await this.monitors.createRun(monitor.id, scheduledFor)
    if (!run) {
      return { monitorId: monitor.id, outcome: 'skipped', openedTicketIds: [], startedProcessIds: [] }
    }

    let outcome: MonitorRunOutcome = 'quiet'
    let signalCount = 0
    let matchedCount = 0
    let suppressedCount = 0
    const openedTicketIds: string[] = []
    const startedProcessIds: string[] = []
    let escalationAgentId: string | null = null

    try {
      // ---- 1. LÉPCSŐ (nulla LLM-token) ----
      const collector = this.collectors.get(monitor.kind)
      const signals = collector
        ? await collector.collect({
            tenantId: monitor.tenantId,
            config: jsonObject(monitor.collectorConfig),
            now,
            monitor,
          })
        : []
      signalCount = signals.length

      const matched = signals.filter((s) => evaluateFilter(monitor.filterConfig, s, now).matched)
      matchedCount = matched.length

      if (matched.length === 0) {
        outcome = 'quiet' // CSENDES alapállapot — a feature lényege
      } else {
        // Agent-feloldás csak tényleges eszkaláció előtt kell. Egy hibás agent
        // konfiguráció vagy átmeneti lookup-hiba ezért nem tesz hibássá csendes sweepet.
        escalationAgentId = await this.resolveEscalationAgentId(monitor)
        // A monitor_cron triggerek a sweep alatt változatlanok — egyszer töltjük be,
        // nem jelenként (különben N illeszkedő jel = N azonos lekérdezés).
        const cronTriggers =
          this.processDefinitions && this.processService
            ? await this.processDefinitions.listActiveMonitorCronTriggers(monitor.tenantId, monitor.id)
            : []
        // ---- cooldown / dedup ----
        for (const signal of matched) {
          const dedupKey = renderDedupKey(monitor, signal)
          const sig = await this.monitors.upsertSignal(monitor.id, dedupKey, {
            severity: signal.severity,
            payload: signal.payload as Prisma.InputJsonValue,
            now,
          })
          const cooledDown =
            sig.lastEscalatedAt !== null &&
            now.getTime() - sig.lastEscalatedAt.getTime() < monitor.cooldownSeconds * 1000
          if (cooledDown) {
            suppressedCount += 1
            continue
          }

          // ---- 2. LÉPCSŐ — eszkaláció Futássá vagy legacy ticketté ----
          const processIds = await this.startMonitorCronProcesses(
            monitor,
            signal,
            run.id,
            dedupKey,
            now,
            cronTriggers,
          )
          if (processIds.length > 0) {
            startedProcessIds.push(...processIds)
            await this.monitors.markSignalEscalated(sig.id, null, now)
          } else if (monitor.kind === 'deadline') {
            // TODO(deadline-email): Ide kell majd e-mail figyelmeztetést küldeni az
            // érintett (eredeti) ticket `dueBy` határidőjéről — pl. a létrehozónak /
            // assignee-nak, a jel payloadjában lévő `ticketId` + `ticketTitle` + `dueBy`
            // alapján. Második `monitor_alert` ticketet szándékosan NEM nyitunk: egy
            // párhuzamos figyelmeztető kártyának a boardon nincs értelme.
            suppressedCount += 1
            continue
          } else {
            const ticketId = await this.openTicket(
              monitor,
              signal,
              run.id,
              dedupKey,
              escalationAgentId,
            )
            openedTicketIds.push(ticketId)
            await this.monitors.markSignalEscalated(sig.id, ticketId, now)
            await this.notifyEscalation(monitor, signal, run.id, dedupKey, ticketId, now)
          }
        }
        outcome = openedTicketIds.length > 0 || startedProcessIds.length > 0 ? 'escalated' : 'suppressed'
      }
    } catch (error) {
      outcome = 'error'
      await this.monitors.updateRun(run.id, {
        outcome: 'error',
        finishedAt: new Date(),
        signalCount,
        matchedCount,
        suppressedCount,
        openedTicketIds,
        llmInvoked: false,
        error: error instanceof Error ? error.message : String(error),
      })
      await this.auditSweep(monitor, 'monitor.sweep.error', outcome, { signalCount, matchedCount, startedProcessIds })
      return { monitorId: monitor.id, outcome, openedTicketIds, startedProcessIds }
    }

    await this.monitors.updateRun(run.id, {
      outcome,
      finishedAt: new Date(),
      signalCount,
      matchedCount,
      suppressedCount,
      openedTicketIds,
      llmInvoked: Boolean(escalationAgentId) && openedTicketIds.length > 0,
    })
    await this.auditSweep(monitor, `monitor.sweep.${outcome}`, outcome, {
      signalCount,
      matchedCount,
      suppressedCount,
      openedTicketIds,
      startedProcessIds,
    })
    return { monitorId: monitor.id, outcome, openedTicketIds, startedProcessIds }
  }

  /**
   * Folyamat-feature-spec §4.4/§4.5: a Monitor-cron nem új scheduler, hanem a
   * meglévő monitor-sweepből induló trigger. Ha a monitorhoz aktív Folyamat-trigger
   * tartozik, a jelből `inputPayload` lesz és a Futás a háttérben, ticket-gráfban fut.
   */
  private async startMonitorCronProcesses(
    monitor: MonitorDefinition,
    signal: MonitorSignalDraft,
    monitorRunId: string,
    dedupKey: string,
    now: Date,
    triggers: ProcessTrigger[],
  ): Promise<string[]> {
    if (!this.processService || triggers.length === 0) return []

    const startedProcessIds: string[] = []
    for (const trigger of triggers) {
      const inputPayload = resolveMonitorCronInputPayload(trigger.inputMap, {
        monitor,
        signal,
        monitorRunId,
        dedupKey,
        now,
      })
      try {
        const process = await this.processService.startProcess({
          tenantId: monitor.tenantId,
          processDefinitionId: trigger.processDefinitionId,
          triggerType: 'monitor_cron',
          inputPayload,
          startedBy: { type: 'system' },
        })
        startedProcessIds.push(process.id)
        await this.auditProcessTrigger(monitor, 'monitor.process_trigger.started', process.id, {
          triggerId: trigger.id,
          processDefinitionId: trigger.processDefinitionId,
          monitorRunId,
          dedupKey,
          inputKeys: Object.keys(inputPayload),
        })
      } catch (error) {
        await this.auditProcessTrigger(monitor, 'monitor.process_trigger.failed', trigger.processDefinitionId, {
          triggerId: trigger.id,
          processDefinitionId: trigger.processDefinitionId,
          monitorRunId,
          dedupKey,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return startedProcessIds
  }

  /**
   * Eszkaláció a meglévő Ticket-entitásra (source=system). Ha van escalateAgentId,
   * a ticket `ready` állapotban, agenthez rendelve jön létre → a meglévő dispatcher
   * automatikusan felveszi (a budget cap alatt). Ha nincs, `backlog` → emberi feldolgozás.
   */
  private async openTicket(
    monitor: MonitorDefinition,
    signal: MonitorSignalDraft,
    monitorRunId: string,
    dedupKey: string,
    escalationAgentId: string | null,
  ): Promise<string> {
    const hasAgent = Boolean(escalationAgentId)
    // #142 — SHADOW ellenőrzés: auditál, nem blokkol. A Monitor-definíciót csak szűk,
    // dedikált jogosultsággal lehet szerkeszteni, ezért az eszkaláció a definíció
    // jogán fut; de ha a monitor létrehozója ad hoc nem szólíthatná meg ezt az
    // agentet, azt a compliance-felelősnek látnia kell.
    if (escalationAgentId && this.agentAccess && monitor.tenantId) {
      try {
        await this.agentAccess.recordProcessBypass({
          subject: { kind: 'user', userId: monitor.createdById, tenantId: monitor.tenantId },
          targetAgentId: escalationAgentId,
          verb: 'address',
          monitorDefinitionId: monitor.id,
        })
      } catch {
        // Szándékosan néma: a shadow-audit sosem akadályozhatja meg az eszkalációt.
      }
    }
    const ticket = await this.tickets.create({
      tenantId: monitor.tenantId,
      type: monitor.openTicketType,
      title: signal.title,
      state: hasAgent ? 'ready' : 'backlog',
      assigneeType: hasAgent ? 'agent' : null,
      assigneeId: escalationAgentId,
      agentId: escalationAgentId,
      payload: {
        ...signal.payload,
        tenantId: monitor.tenantId,
        monitorId: monitor.id,
        monitorRunId,
        monitorKind: monitor.kind,
        dedupKey,
        source: 'monitor',
      } as Prisma.JsonObject,
      sourceDocumentId: null,
      executeAfter: null,
      dueBy: signal.dueBy ?? null,
      createdById: monitor.createdById,
      source: 'system',
    })
    return ticket.id
  }

  private async notifyEscalation(
    monitor: MonitorDefinition,
    signal: MonitorSignalDraft,
    monitorRunId: string,
    dedupKey: string,
    ticketId: string,
    now: Date,
  ): Promise<void> {
    if (!monitor.notifyChannel) return

    try {
      const result = await this.notifier.send({
        channel: monitor.notifyChannel,
        tenantId: monitor.tenantId,
        monitorId: monitor.id,
        monitorTitle: monitor.title,
        monitorKind: monitor.kind,
        monitorRunId,
        dedupKey,
        ticketId,
        signalTitle: signal.title,
        severity: signal.severity,
        dueBy: signal.dueBy ?? null,
        payload: signal.payload,
        createdAt: now,
      })
      await this.auditNotification(monitor, 'monitor.notify.sent', ticketId, {
        ...this.notificationMetadata(monitor, signal, monitorRunId, dedupKey, ticketId),
        provider: result.provider,
        messageId: result.messageId ?? null,
      })
    } catch (error) {
      await this.auditNotification(monitor, 'monitor.notify.failed', ticketId, {
        ...this.notificationMetadata(monitor, signal, monitorRunId, dedupKey, ticketId),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private notificationMetadata(
    monitor: MonitorDefinition,
    signal: MonitorSignalDraft,
    monitorRunId: string,
    dedupKey: string,
    ticketId: string,
  ): Record<string, unknown> {
    return {
      tenantId: monitor.tenantId,
      monitorRunId,
      dedupKey,
      ticketId,
      notifyChannel: monitor.notifyChannel,
      signalTitle: signal.title,
      severity: signal.severity,
      dueBy: signal.dueBy?.toISOString() ?? null,
    }
  }

  private async auditNotification(
    monitor: MonitorDefinition,
    action: string,
    ticketId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action,
      targetType: 'monitor',
      targetId: monitor.id,
      modelUsed: null,
      inputRef: monitor.notifyChannel,
      outputRef: ticketId,
      policyDecision: action.endsWith('.sent') ? 'sent' : 'failed',
      metadata: metadata as Prisma.JsonValue,
    })
  }

  private async auditProcessTrigger(
    monitor: MonitorDefinition,
    action: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action,
      targetType: 'monitor',
      targetId,
      modelUsed: null,
      inputRef: monitor.id,
      outputRef: action.endsWith('.started') ? targetId : null,
      policyDecision: action.endsWith('.started') ? 'started' : 'failed',
      metadata: metadata as Prisma.JsonValue,
    })
  }

  private async auditSweep(
    monitor: MonitorDefinition,
    action: string,
    outcome: MonitorRunOutcome,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action,
      targetType: 'monitor',
      targetId: monitor.id,
      modelUsed: null,
      inputRef: monitor.kind,
      outputRef: outcome,
      policyDecision: outcome,
      metadata: metadata as Prisma.JsonValue,
    })
  }

  /**
   * A monitor admin-műveletek a kiválasztott tenant szerepével azonosítják a hívót.
   * A globális UUID önmagában nem jogosultság: más tenant monitorának állapota, jelei
   * és futásnaplója üzleti és operatív adatot tartalmazhat.
   */
  private async requireTenantMonitor(id: string, tenantId: string): Promise<MonitorDefinition> {
    const monitor = await this.monitors.findById(id)
    if (!monitor || monitor.tenantId !== tenantId) throw new Error('Monitor not found')
    return monitor
  }

  /**
   * Régi vagy közvetlenül betöltött konfiguráció sem indíthat más tenant agentjét.
   * A monitorozás ettől még nem áll le: a jel emberi backlog ticketként marad meg.
   */
  private async resolveEscalationAgentId(monitor: MonitorDefinition): Promise<string | null> {
    if (!monitor.escalateAgentId || !this.agents) return monitor.escalateAgentId
    try {
      const agent = await this.agents.findById(monitor.escalateAgentId)
      if (!agent || !isAgentReachableFromTenant(agent.tenantId, monitor.tenantId)) {
        return null
      }
      return agent.id
    } catch {
      return null
    }
  }
}

type MonitorCronResolutionContext = {
  monitor: MonitorDefinition
  signal: MonitorSignalDraft
  monitorRunId: string
  dedupKey: string
  now: Date
}

export function resolveMonitorCronInputPayload(
  inputMap: Prisma.JsonValue,
  ctx: MonitorCronResolutionContext,
): Record<string, unknown> {
  const map = jsonObject(inputMap)
  const contextMap = jsonObject((map as { contextMap?: Prisma.JsonValue }).contextMap ?? null)
  const payload: Record<string, unknown> = {}
  for (const [slotName, expr] of Object.entries(contextMap)) {
    payload[slotName] = resolveMonitorCronExpression(expr, ctx)
  }
  return payload
}

function resolveMonitorCronExpression(expr: unknown, ctx: MonitorCronResolutionContext): unknown {
  if (expr === 'now()') return ctx.now.toISOString()
  if (typeof expr !== 'string') return expr
  if (expr === 'monitorRunId') return ctx.monitorRunId
  if (expr === 'dedupKey') return ctx.dedupKey
  if (expr === 'signal.title') return ctx.signal.title
  if (expr === 'signal.severity') return ctx.signal.severity
  if (expr === 'signal.dueBy') return ctx.signal.dueBy?.toISOString() ?? null
  if (expr === 'monitor.id') return ctx.monitor.id
  if (expr === 'monitor.title') return ctx.monitor.title
  if (expr.startsWith('payload.')) return getPath(ctx.signal.payload, expr.slice('payload.'.length))
  if (expr.startsWith('dedupKeyParts.')) return getPath(ctx.signal.dedupKeyParts, expr.slice('dedupKeyParts.'.length))
  if (Object.prototype.hasOwnProperty.call(ctx.signal.payload, expr)) return ctx.signal.payload[expr]
  if (Object.prototype.hasOwnProperty.call(ctx.signal.dedupKeyParts, expr)) return ctx.signal.dedupKeyParts[expr]
  return expr
}

function getPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (typeof acc === 'object' && acc !== null && key in acc) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, value)
}
