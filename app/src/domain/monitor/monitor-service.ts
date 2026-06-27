import type { Prisma, MonitorDefinition, MonitorRun, MonitorRunOutcome, MonitorSignal } from '@prisma/client'
import type {
  AuditRepository,
  MonitorRepository,
  TicketRepository,
  UpdateMonitorInput,
} from '@/repositories/interfaces'
import { randomUUID } from 'crypto'
import type { MonitorCollector, MonitorSignalDraft } from './collectors/types'
import { evaluateFilter } from './filter-eval'

export type SweepResult = {
  monitorId: string
  outcome: MonitorRunOutcome
  openedTicketIds: string[]
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
  ) {
    this.collectors = new Map(collectors.map((c) => [c.kind, c]))
  }

  async list(filter?: { tenantId?: string }) {
    return this.monitors.findMany(filter)
  }

  async getById(id: string): Promise<MonitorDefinition | null> {
    return this.monitors.findById(id)
  }

  async update(id: string, data: UpdateMonitorInput): Promise<MonitorDefinition> {
    return this.monitors.update(id, data)
  }

  async revoke(id: string): Promise<MonitorDefinition> {
    return this.monitors.revoke(id)
  }

  async listRuns(monitorId: string, limit = 20): Promise<MonitorRun[]> {
    return this.monitors.findRuns(monitorId, limit)
  }

  async listSignals(monitorId: string, limit = 50): Promise<MonitorSignal[]> {
    return this.monitors.findSignalsByMonitor(monitorId, limit)
  }

  /**
   * Dry-run (PM-E §9): lefuttatja az 1. lépcsőt, szűrőt és cooldown-ellenőrzést, de
   * nem nyit ticketet, nem hív LLM-et, nem ír adatbázisba. Az eredmény a szerkesztő
   * hangolásához mutatja meg, mi lenne eszkalálva / elnyomva.
   */
  async dryRun(monitorId: string, now = new Date()) {
    const monitor = await this.monitors.findById(monitorId)
    if (!monitor) throw new Error('Monitor not found')

    const collector = this.collectors.get(monitor.kind)
    const signals = collector
      ? await collector.collect({
          tenantId: monitor.tenantId,
          config: jsonObject(monitor.collectorConfig),
          now,
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
      return { monitorId: monitor.id, outcome: 'skipped', openedTicketIds: [] }
    }

    let outcome: MonitorRunOutcome = 'quiet'
    let signalCount = 0
    let matchedCount = 0
    let suppressedCount = 0
    const openedTicketIds: string[] = []

    try {
      // ---- 1. LÉPCSŐ (nulla LLM-token) ----
      const collector = this.collectors.get(monitor.kind)
      const signals = collector
        ? await collector.collect({ tenantId: monitor.tenantId, config: jsonObject(monitor.collectorConfig), now })
        : []
      signalCount = signals.length

      const matched = signals.filter((s) => evaluateFilter(monitor.filterConfig, s, now).matched)
      matchedCount = matched.length

      if (matched.length === 0) {
        outcome = 'quiet' // CSENDES alapállapot — a feature lényege
      } else {
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

          // ---- 2. LÉPCSŐ — eszkaláció ticketté ----
          const ticketId = await this.openTicket(monitor, signal)
          openedTicketIds.push(ticketId)
          await this.monitors.markSignalEscalated(sig.id, ticketId, now)
        }
        outcome = openedTicketIds.length > 0 ? 'escalated' : 'suppressed'
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
      await this.auditSweep(monitor, 'monitor.sweep.error', outcome, { signalCount, matchedCount })
      return { monitorId: monitor.id, outcome, openedTicketIds }
    }

    await this.monitors.updateRun(run.id, {
      outcome,
      finishedAt: new Date(),
      signalCount,
      matchedCount,
      suppressedCount,
      openedTicketIds,
      llmInvoked: Boolean(monitor.escalateAgentId) && openedTicketIds.length > 0,
    })
    await this.auditSweep(monitor, `monitor.sweep.${outcome}`, outcome, {
      signalCount,
      matchedCount,
      suppressedCount,
      openedTicketIds,
    })
    return { monitorId: monitor.id, outcome, openedTicketIds }
  }

  /**
   * Eszkaláció a meglévő Ticket-entitásra (source=system). Ha van escalateAgentId,
   * a ticket `ready` állapotban, agenthez rendelve jön létre → a meglévő dispatcher
   * automatikusan felveszi (a budget cap alatt). Ha nincs, `backlog` → emberi feldolgozás.
   */
  private async openTicket(
    monitor: MonitorDefinition,
    signal: MonitorSignalDraft,
  ): Promise<string> {
    const hasAgent = Boolean(monitor.escalateAgentId)
    const ticket = await this.tickets.create({
      tenantId: monitor.tenantId,
      type: monitor.openTicketType,
      title: signal.title,
      state: hasAgent ? 'ready' : 'backlog',
      assigneeType: hasAgent ? 'agent' : null,
      assigneeId: monitor.escalateAgentId ?? null,
      agentId: monitor.escalateAgentId ?? null,
      payload: {
        ...signal.payload,
        tenantId: monitor.tenantId,
        monitorId: monitor.id,
        monitorKind: monitor.kind,
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
}
