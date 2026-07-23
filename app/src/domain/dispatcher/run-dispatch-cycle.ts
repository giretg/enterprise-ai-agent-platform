import { services } from '@/domain'
import { reclaimStaleAgentTurns } from '@/domain/agent/agent-turn-watchdog'
import { ensureActiveDatabaseMode } from '@/lib/db'
import { repositories } from '@/repositories/postgres'

const DEFAULT_BATCH_LIMIT = Number(process.env.DISPATCHER_BATCH_LIMIT ?? 10)

export type DispatchCycleSummary = {
  /** Igaz, ha egy másik ciklus még folyamatban volt ugyanebben a process-ben (nincs átfedés). */
  skipped: boolean
  reclaimedDispatches: number
  reclaimedScheduledTasks: number
  /** Watchdog: elavult heartbeatű chat-fordulók lezárása (issue #64 / D10). */
  reclaimedAgentTurns: number
  materializedScheduledTasks: number
  monitorSweep: { ran: boolean; escalated: number; openedTickets: number }
  workspacePurge: { purgedTickets: number; deletedObjects: number }
  /** A worker MÁSODIK munkatípusa (D8): feldolgozott Telegram-csatorna-fordulók száma. */
  channelTurns: { processed: number }
  dispatch: {
    scanned: number
    started: number
    budgetBlocked: number
    skipped: number
    paused: boolean
    /**
     * Kihagyás-indokok darabszáma (`process_terminal`, `lock_lost`, …). E nélkül egy be nem
     * induló ticketnél a felületen nem látszott, melyik kapu fogta meg.
     */
    skipReasons: Record<string, number>
    /** Csak input.ticketId esetén: a konkrét ticket dispatch-eredménye. */
    ticketStatus?: 'started' | 'skipped' | 'budget_blocked' | 'paused' | 'blocked'
    /** Csak input.ticketId esetén: a `skipped`/`budget_blocked`/`blocked` indoklása. */
    ticketReason?: string
  }
}

const EMPTY_SUMMARY: DispatchCycleSummary = {
  skipped: true,
  reclaimedDispatches: 0,
  reclaimedScheduledTasks: 0,
  reclaimedAgentTurns: 0,
  materializedScheduledTasks: 0,
  monitorSweep: { ran: false, escalated: 0, openedTickets: 0 },
  workspacePurge: { purgedTickets: 0, deletedObjects: 0 },
  channelTurns: { processed: 0 },
  dispatch: { scanned: 0, started: 0, budgetBlocked: 0, skipped: 0, paused: false, skipReasons: {} },
}

let cycleInFlight = false

export type DispatchCycleTrigger = 'worker' | 'scheduler' | 'manual'

/**
 * A dispatcher egy ciklusa (§5.7): stale-reclaim (ticket + ütemezett task +
 * chat AgentTurn watchdog), ütemezett task materializálás, proaktív monitor
 * söprés, workspace-purge, majd a ready ticketek (vagy egy adott ticket)
 * dispatchelése.
 *
 * Ugyanez a logika hívható egy hosszan futó workerből (LISTEN/NOTIFY + belső cron —
 * lásd `scripts/dispatcher-worker.ts`), egyetlen stateless HTTP-hívásból (Cloud
 * Scheduler → `/api/v1/internal/dispatch-cycle`), ÉS egy admin-vezérelt kézi
 * futtatásból (control-plane/system) is — nincs perzisztens kapcsolat vagy
 * végtelen loop-függőség ahhoz, hogy a biztonsági háló lefusson. Minden lefutás
 * (siker vagy hiba) a `platform_settings` táblába íródik (`recordDispatchCycleRun`),
 * így az admin UI-n mindig látszik az utolsó futás, függetlenül a forrástól.
 */
export async function runDispatchCycle(
  input: { ticketId?: string; batchLimit?: number; triggeredBy?: DispatchCycleTrigger } = {},
): Promise<DispatchCycleSummary> {
  if (cycleInFlight) return EMPTY_SUMMARY
  cycleInFlight = true
  const triggeredBy = input.triggeredBy ?? 'worker'
  try {
    await ensureActiveDatabaseMode()
    const batchLimit = input.batchLimit ?? DEFAULT_BATCH_LIMIT

    const reclaimed = await services.dispatcher.reclaimStaleDispatches()
    const reclaimedDispatches = reclaimed.filter((r) => r.status === 'reclaimed').length

    const reclaimedTasks = await services.scheduledTasks.reclaimStaleMaterializations()
    const reclaimedScheduledTasks = reclaimedTasks.filter((r) => r.status === 'reclaimed').length

    // Chat AgentTurn watchdog (D10 / #64): crash/deploy alatt elvágott fordulók
    // ne maradjanak örökre „gépel" állapotban. A küszöb: AGENT_TURN_STALE_MS (~120s).
    const reclaimedTurns = await reclaimStaleAgentTurns({
      turns: repositories.agentTurns,
      conversations: services.conversations,
    })
    const reclaimedAgentTurns = reclaimedTurns.filter((r) => r.status === 'reclaimed').length

    const materialized = await services.scheduledTasks.materializeDue(new Date(), batchLimit)
    const materializedScheduledTasks = materialized.filter((r) => r.status === 'materialized').length

    // Proaktív monitor: nem-LLM söprés (1. lépcső). A drága LLM csak küszöböt átlépő
    // jelnél, az eszkalált ticketen át indul (a meglévő dispatch-budget alatt).
    //
    // Nincs ciklus-szintű throttle: melyik monitor esedékes, azt a saját `nextSweepAt`-je
    // dönti el (`findDue`), monitoronként külön `intervalSeconds` alapján. Egy globális
    // időzár csak késleltetné az esedékes monitorokat a saját beállításuk ellenére.
    // Kill-switch alatt nem írunk körönkénti audit sort: minden `audit.append` globális
    // advisory lockot vesz a hash-láncra, tehát percenkénti „nem történt semmi” bejegyzés
    // zajjal tölti a láncot és sorosítja az írásokat. A nyom így sem vész el: a ki/be
    // kapcsolást a `monitor.paused`/`monitor.resumed` esemény rögzíti (actorral), az
    // egyes körök pedig a `monitorSweepRan: false` mezőt kapják a ciklus-lenyomatban.
    const monitorControls = await services.platformSettings.getMonitorControls()
    let monitorSweep: DispatchCycleSummary['monitorSweep'] = { ran: false, escalated: 0, openedTickets: 0 }
    if (!monitorControls.killSwitch) {
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

    // A worker MÁSODIK munkatípusa (D8): a bejövő Telegram-csatorna-fordulók feldolgozása. Best-
    // effort — egy csatorna-hiba NEM buktathatja el a ticket-dispatch-et (a forduló újrapróbálható).
    let channelTurns: DispatchCycleSummary['channelTurns'] = { processed: 0 }
    try {
      channelTurns = await services.channelTurns.processQueued({ limit: batchLimit })
    } catch {
      // A hiba a soron marad (`markRetry`/`markFailed` a szolgáltatásban) — a ciklus megy tovább.
    }

    let dispatch: DispatchCycleSummary['dispatch']
    if (input.ticketId) {
      const result = await services.dispatcher.dispatchTicket(input.ticketId)
      dispatch = {
        // A `paused` sentinel nem egy megvizsgált ticket — ne számoljuk annak.
        scanned: result.status === 'paused' ? 0 : 1,
        started: result.status === 'started' ? 1 : 0,
        budgetBlocked: result.status === 'budget_blocked' ? 1 : 0,
        skipped: result.status === 'skipped' || result.status === 'blocked' ? 1 : 0,
        paused: result.status === 'paused',
        skipReasons:
          (result.status === 'skipped' || result.status === 'blocked') && result.reason
            ? { [result.reason]: 1 }
            : {},
        ticketStatus: result.status,
        ticketReason: result.reason,
      }
    } else {
      const results = await services.dispatcher.dispatchReadyBatch(batchLimit)
      const paused = results.some((r) => r.status === 'paused')
      const skipReasons: Record<string, number> = {}
      for (const r of results) {
        if ((r.status !== 'skipped' && r.status !== 'blocked') || !r.reason) continue
        skipReasons[r.reason] = (skipReasons[r.reason] ?? 0) + 1
      }
      dispatch = {
        scanned: paused ? 0 : results.length,
        started: results.filter((r) => r.status === 'started').length,
        budgetBlocked: results.filter((r) => r.status === 'budget_blocked').length,
        skipped: results.filter((r) => r.status === 'skipped' || r.status === 'blocked').length,
        paused,
        skipReasons,
      }
    }

    const summary: DispatchCycleSummary = {
      skipped: false,
      reclaimedDispatches,
      reclaimedScheduledTasks,
      reclaimedAgentTurns,
      materializedScheduledTasks,
      monitorSweep,
      workspacePurge,
      channelTurns,
      dispatch,
    }
    await services.platformSettings
      .recordDispatchCycleRun({
        triggeredBy,
        ok: true,
        error: null,
        reclaimedDispatches,
        reclaimedScheduledTasks,
        reclaimedAgentTurns,
        materializedScheduledTasks,
        monitorSweepRan: monitorSweep.ran,
        monitorEscalated: monitorSweep.escalated,
        workspacePurgedTickets: workspacePurge.purgedTickets,
        dispatchScanned: dispatch.scanned,
        dispatchStarted: dispatch.started,
        dispatchBudgetBlocked: dispatch.budgetBlocked,
      })
      .catch(() => {})
    return summary
  } catch (error) {
    await services.platformSettings
      .recordDispatchCycleRun({
        triggeredBy,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        reclaimedDispatches: 0,
        reclaimedScheduledTasks: 0,
        reclaimedAgentTurns: 0,
        materializedScheduledTasks: 0,
        monitorSweepRan: false,
        monitorEscalated: 0,
        workspacePurgedTickets: 0,
        dispatchScanned: 0,
        dispatchStarted: 0,
        dispatchBudgetBlocked: 0,
      })
      .catch(() => {})
    throw error
  } finally {
    cycleInFlight = false
  }
}
