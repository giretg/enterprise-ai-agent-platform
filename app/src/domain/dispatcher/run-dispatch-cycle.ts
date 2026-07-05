import { services } from '@/domain'
import { ensureActiveDatabaseMode } from '@/lib/db'

const DEFAULT_BATCH_LIMIT = Number(process.env.DISPATCHER_BATCH_LIMIT ?? 10)

export type DispatchCycleSummary = {
  /** Igaz, ha egy másik ciklus még folyamatban volt ugyanebben a process-ben (nincs átfedés). */
  skipped: boolean
  reclaimedDispatches: number
  reclaimedScheduledTasks: number
  materializedScheduledTasks: number
  monitorSweep: { ran: boolean; escalated: number; openedTickets: number }
  workspacePurge: { purgedTickets: number; deletedObjects: number }
  dispatch: {
    scanned: number
    started: number
    budgetBlocked: number
    paused: boolean
    /** Csak input.ticketId esetén: a konkrét ticket dispatch-eredménye. */
    ticketStatus?: 'started' | 'skipped' | 'budget_blocked' | 'paused'
  }
}

const EMPTY_SUMMARY: DispatchCycleSummary = {
  skipped: true,
  reclaimedDispatches: 0,
  reclaimedScheduledTasks: 0,
  materializedScheduledTasks: 0,
  monitorSweep: { ran: false, escalated: 0, openedTickets: 0 },
  workspacePurge: { purgedTickets: 0, deletedObjects: 0 },
  dispatch: { scanned: 0, started: 0, budgetBlocked: 0, paused: false },
}

let cycleInFlight = false
let lastMonitorSweepAt = 0

/**
 * A dispatcher egy ciklusa (§5.7): stale-reclaim, ütemezett task materializálás,
 * proaktív monitor söprés, workspace-purge, majd a ready ticketek (vagy egy adott
 * ticket) dispatchelése.
 *
 * Ugyanez a logika hívható egy hosszan futó workerből (LISTEN/NOTIFY + belső cron —
 * lásd `scripts/dispatcher-worker.ts`) ÉS egyetlen stateless HTTP-hívásból (Cloud
 * Scheduler → `/api/v1/internal/dispatch-cycle`) is: nincs perzisztens kapcsolat
 * vagy végtelen loop-függőség ahhoz, hogy a biztonsági háló lefusson.
 */
export async function runDispatchCycle(
  input: { ticketId?: string; batchLimit?: number } = {},
): Promise<DispatchCycleSummary> {
  if (cycleInFlight) return EMPTY_SUMMARY
  cycleInFlight = true
  try {
    await ensureActiveDatabaseMode()
    const batchLimit = input.batchLimit ?? DEFAULT_BATCH_LIMIT

    const reclaimed = await services.dispatcher.reclaimStaleDispatches()
    const reclaimedDispatches = reclaimed.filter((r) => r.status === 'reclaimed').length

    const reclaimedTasks = await services.scheduledTasks.reclaimStaleMaterializations()
    const reclaimedScheduledTasks = reclaimedTasks.filter((r) => r.status === 'reclaimed').length

    const materialized = await services.scheduledTasks.materializeDue(new Date(), batchLimit)
    const materializedScheduledTasks = materialized.filter((r) => r.status === 'materialized').length

    // Proaktív monitor: nem-LLM söprés (1. lépcső). A drága LLM csak küszöböt átlépő
    // jelnél, az eszkalált ticketen át indul (a meglévő dispatch-budget alatt).
    const monitorControls = await services.platformSettings.getMonitorControls()
    const monitorDue = Date.now() - lastMonitorSweepAt >= monitorControls.sweepIntervalSec * 1000
    let monitorSweep: DispatchCycleSummary['monitorSweep'] = { ran: false, escalated: 0, openedTickets: 0 }
    if (monitorControls.killSwitch) {
      await services.platformSettings.auditMonitorSweepSkipped('kill_switch', {
        sweepIntervalSec: monitorControls.sweepIntervalSec,
        maxConcurrent: monitorControls.maxConcurrent,
      })
    } else if (monitorDue) {
      lastMonitorSweepAt = Date.now()
      await services.monitors.reclaimStaleLocks()
      const sweeps = await services.monitors.sweepDue(
        new Date(),
        Math.min(batchLimit, monitorControls.maxConcurrent),
      )
      const escalated = sweeps.filter((s) => s.outcome === 'escalated').length
      const opened = sweeps.reduce((sum, s) => sum + s.openedTicketIds.length, 0)
      monitorSweep = { ran: true, escalated, openedTickets: opened }
    }

    const workspacePurgeResult = await services.workspaceLifecycle.purgeExpiredWorkspaces(batchLimit)
    const workspacePurge = {
      purgedTickets: workspacePurgeResult.purgedTickets,
      deletedObjects: workspacePurgeResult.deletedObjects,
    }

    if (input.ticketId) {
      const result = await services.dispatcher.dispatchTicket(input.ticketId)
      return {
        skipped: false,
        reclaimedDispatches,
        reclaimedScheduledTasks,
        materializedScheduledTasks,
        monitorSweep,
        workspacePurge,
        dispatch: {
          scanned: 1,
          started: result.status === 'started' ? 1 : 0,
          budgetBlocked: result.status === 'budget_blocked' ? 1 : 0,
          paused: result.status === 'paused',
          ticketStatus: result.status,
        },
      }
    }

    const results = await services.dispatcher.dispatchReadyBatch(batchLimit)
    return {
      skipped: false,
      reclaimedDispatches,
      reclaimedScheduledTasks,
      materializedScheduledTasks,
      monitorSweep,
      workspacePurge,
      dispatch: {
        scanned: results.length,
        started: results.filter((r) => r.status === 'started').length,
        budgetBlocked: results.filter((r) => r.status === 'budget_blocked').length,
        paused: results.some((r) => r.status === 'paused'),
      },
    }
  } finally {
    cycleInFlight = false
  }
}
