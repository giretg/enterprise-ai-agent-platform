'use client'

import { useCallback, useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import {
  getWorkerProcessesStatus,
  runDispatchCycleNow,
  setDispatchSchedulerIntervalMinutes,
  setDispatchSchedulerPaused,
  stopLocalDispatcherWorker,
  type WorkerProcessesStatus,
} from '@/app/actions/platform'
import type { DispatchCycleRunRecord } from '@/domain/platform-settings/platform-settings-service'
import type { MonitorControlsView } from './monitor-control-panel'
import { isSafetyNetAutoOn } from './automation-status'

/** N-percenkénti cron mintából (star-slash-N óra-perc formátum) N-t olvas ki; minden más ütemnél a nyers cron-szöveget mutatjuk, nem szerkeszthető dial-lal. */
function parseEveryNMinutes(schedule: string | null): number | null {
  const match = schedule?.match(/^\*\/(\d+) \* \* \* \*$/)
  if (!match) return null
  const n = Number(match[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

const TRIGGER_LABELS: Record<string, string> = {
  worker: 'lokális worker',
  scheduler: 'Cloud Scheduler',
  manual: 'kézi futtatás',
}

function formatLastCycleDetails(cycle: DispatchCycleRunRecord): string {
  const monitorPart = cycle.monitorSweepRan
    ? cycle.monitorEscalated > 0
      ? `monitor: ${cycle.monitorEscalated} eszkalált`
      : 'monitor: söpört, csendes'
    : 'monitor: nem söpört (kill-switch vagy kimaradt lépés)'
  return [
    `${cycle.reclaimedDispatches} elakadt futás visszavéve`,
    `${cycle.reclaimedScheduledTasks} ütemezett task reclaim`,
    `${cycle.reclaimedAgentTurns} chat-forduló watchdog-lezárás`,
    `${cycle.materializedScheduledTasks} ütemezett task materializálva`,
    monitorPart,
    `${cycle.workspacePurgedTickets} workspace takarítva`,
    `${cycle.dispatchScanned} ticket vizsgálva, ${cycle.dispatchStarted} agent indítva, ${cycle.dispatchBudgetBlocked} budget-blokk`,
  ].join(' · ')
}

/** Gépi kihagyás-indok → magyar mondat. Ismeretlen kulcsot változatlanul mutatunk. */
const SKIP_REASON_LABELS: Record<string, string> = {
  no_agent: 'nincs agent hozzárendelve',
  agent_inactive: 'az agent nem aktív',
  process_terminal: 'a folyamat/lépés már lezárult',
  lock_lost: 'a ticketet közben más vitte el',
  not_ready: 'a ticket nem ready állapotban van',
  scheduled_later: 'későbbre van ütemezve',
  schedule_series: 'rendszeres sablon, nem fut önmagában',
}

function formatSkipReasons(skipReasons: Record<string, number>): string | null {
  const parts = Object.entries(skipReasons).map(
    ([reason, count]) => `${count} ${SKIP_REASON_LABELS[reason] ?? reason}`,
  )
  return parts.length > 0 ? `kihagyva: ${parts.join(', ')}` : null
}

/**
 * A dispatch-eredmény mind a négy kimenetét ki kell írni. Korábban csak a `scanned` és a
 * `started` szerepelt, így a „szüneteltetve", a „budget-blokk" és a „kihagyva" ág azonos
 * szöveget adott („1 ticket vizsgálva, 0 indítva") — nem lehetett megkülönböztetni őket.
 */
function formatCycleRunMessage(summary: {
  reclaimedDispatches: number
  reclaimedAgentTurns: number
  chatTurnLaunches: { scanned: number; launched: number; failed: number; waiting?: number }
  materializedScheduledTasks: number
  monitorSweep: { ran: boolean; escalated: number; openedTickets: number }
  workspacePurge: { purgedTickets: number }
  conversationRetention: { sweptConversations: number; deletedMessages: number }
  dispatch: {
    scanned: number
    started: number
    budgetBlocked: number
    skipped: number
    paused: boolean
    skipReasons: Record<string, number>
  }
}): string {
  const monitorPart = summary.monitorSweep.ran
    ? summary.monitorSweep.escalated > 0
      ? `monitor: ${summary.monitorSweep.escalated} eszkalált, ${summary.monitorSweep.openedTickets} ticket`
      : 'monitor: söpört'
    : 'monitor: nem söpört'

  const dispatchPart = summary.dispatch.paused
    ? 'agent-indítás szünetel — egyetlen ticketet sem vizsgált'
    : [
        `${summary.dispatch.scanned} ticket vizsgálva, ${summary.dispatch.started} indítva`,
        summary.dispatch.budgetBlocked > 0 ? `${summary.dispatch.budgetBlocked} budget-blokk` : null,
        formatSkipReasons(summary.dispatch.skipReasons),
      ]
        .filter(Boolean)
        .join(' · ')

  return [
    `${summary.reclaimedDispatches} elakadt futás visszavéve`,
    `${summary.reclaimedAgentTurns} chat-forduló watchdog-lezárás`,
    summary.chatTurnLaunches.launched + summary.chatTurnLaunches.failed + (summary.chatTurnLaunches.waiting ?? 0) > 0
      ? `${summary.chatTurnLaunches.launched} chat-indítás, ${summary.chatTurnLaunches.waiting ?? 0} kapacitásra vár, ${summary.chatTurnLaunches.failed} végleges indítási hiba`
      : null,
    `${summary.materializedScheduledTasks} ütemezett task materializálva`,
    monitorPart,
    `${summary.workspacePurge.purgedTickets} workspace takarítva`,
    `megőrzés: ${summary.conversationRetention.sweptConversations} beszélgetés ürítve (${summary.conversationRetention.deletedMessages} üzenet)`,
    dispatchPart,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** `slate` = szándékosan kikapcsolt folyamat (nem hiba), szemben a `red` = váratlanul áll. */
function Dot({ color }: { color: 'emerald' | 'red' | 'amber' | 'slate' }) {
  const cls = {
    emerald: 'bg-emerald-400',
    red: 'bg-red-400',
    amber: 'bg-amber-400',
    slate: 'bg-ink-soft/40',
  }[color]
  return <span className={`inline-flex h-2.5 w-2.5 rounded-full ${cls}`} />
}

export function WorkerProcessesPanel({
  initial,
  monitor,
  canEdit,
}: {
  initial: WorkerProcessesStatus
  monitor: MonitorControlsView
  canEdit: boolean
}) {
  const [status, setStatus] = useState(initial)
  // A gombokat CSAK a felhasználó által indított művelet tilthatja le; a frissítésnek külön
  // jelzője van. Közös `useTransition`-ön osztozva a frissítés kiszürkítené a gombokat.
  const [pending, startTransition] = useTransition()
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [schedulerIntervalInput, setSchedulerIntervalInput] = useState<number | null>(
    initial.scheduler.available ? parseEveryNMinutes(initial.scheduler.schedule) : null,
  )

  /**
   * Szándékosan nincs periodikus poll. A `getWorkerProcessesStatus` egy Server Action, és a
   * Next minden hívása után újrarendereli a route RSC-fáját — a teljes `SystemPage`-et, annak
   * minden lekérdezésével. Egy háttérben ketyegő poll így körönként felébresztené a Neon
   * computeot és hívná a Cloud Scheduler API-t, pusztán attól, hogy nyitva van a fül. A panel
   * adatai ritkán változnak: kézi „Frissítés”, illetve minden művelet után magától frissül.
   */
  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await getWorkerProcessesStatus()
      if (res.success) {
        setStatus(res.data)
        if (res.data.scheduler.available) {
          setSchedulerIntervalInput(parseEveryNMinutes(res.data.scheduler.schedule))
        }
      }
    } finally {
      setRefreshing(false)
    }
  }, [])

  function stopLocal() {
    setMessage(null)
    startTransition(async () => {
      const res = await stopLocalDispatcherWorker()
      if (res.success) {
        setMessage({ tone: 'ok', text: 'Leállítási kérés elküldve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
      await refresh()
    })
  }

  function runCycleNow() {
    setMessage(null)
    startTransition(async () => {
      const res = await runDispatchCycleNow()
      if (res.success) {
        setMessage({
          tone: 'ok',
          text: `Ciklus lefutott: ${formatCycleRunMessage(res.data)}.`,
        })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
      await refresh()
    })
  }

  function toggleSchedulerPaused(paused: boolean) {
    setMessage(null)
    startTransition(async () => {
      const res = await setDispatchSchedulerPaused(paused)
      if (res.success) {
        setMessage({ tone: 'ok', text: paused ? 'Cloud Scheduler szüneteltetve.' : 'Cloud Scheduler folytatva.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
      await refresh()
    })
  }

  function saveSchedulerInterval() {
    if (schedulerIntervalInput === null) return
    setMessage(null)
    startTransition(async () => {
      const res = await setDispatchSchedulerIntervalMinutes(schedulerIntervalInput)
      if (res.success) {
        setMessage({ tone: 'ok', text: `Cloud Scheduler intervallum mentve: ${res.data.available ? res.data.schedule : ''}` })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
      await refresh()
    })
  }

  const local = status.local
  const scheduler = status.scheduler
  const lastCycle = status.lastCycle
  const currentSchedulerInterval = scheduler.available ? parseEveryNMinutes(scheduler.schedule) : null

  const safetyNetAutoOn = isSafetyNetAutoOn(scheduler, local)
  const monitorWouldSweep = !monitor.killSwitch && safetyNetAutoOn

  return (
    <Card title="Biztonsági háló (háttérfolyamatok)">
      <div className="space-y-4">
        <p className="text-xs text-ink-soft">
          Egy <strong>kör</strong> öt lépést fut le sorban: elakadt futások visszavétele → ütemezett
          taskok esedékessé tétele → monitor-söprés → workspace-takarítás → ready ticketek
          agent-indítása (ha a dispatcher be van kapcsolva). A ready ticketek zöme ettől függetlenül
          azonnal indul keletkezéskor.
        </p>
        <p className="text-xs text-ink-soft">
          <strong>Neon-költség:</strong> minden automatikus kör felébreszti az adatbázist. A lokális
          worker ennél rosszabb: folyamatosan nyitva tartja a kapcsolatot. Teszt/üresjárathoz a fenti
          „Üresjárat mód” vagy a Scheduler szüneteltetése a leghatékonyabb.
        </p>

        <div className="rounded-lg border border-line/40 bg-surface/20 px-4 py-2.5 text-xs text-ink-soft">
          <strong>Monitor-söprés most:</strong>{' '}
          {monitorWouldSweep
            ? 'futni fog a következő automatikus körben (kill-switch ki, Scheduler vagy lokális worker aktív).'
            : !monitor.killSwitch
              ? 'engedélyezve, de nincs automatikus kör — a Scheduler szünetel és a lokális worker sem fut.'
              : 'kill-switch miatt kimarad (a kör többi lépése lefuthat).'}
        </div>

        {/* Lokális worker */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line/40 px-4 py-3">
          <div className="flex items-center gap-3">
            <Dot color={!local.available ? 'slate' : local.running ? 'emerald' : 'red'} />
            <div>
              <p className="text-sm font-medium">Lokális worker (fejlesztéshez)</p>
              <p className="text-xs text-ink-soft">
                {!local.available
                  ? 'Nem látható innen. Ez a sor csak akkor él, ha a felületet a saját gépeden futó szerverről nyitod meg. Éles környezetben nincs ilyen folyamat.'
                  : local.running
                    ? `Fut · ${local.cycles} ciklus · utolsó: ${local.lastCycleAt ? new Date(local.lastCycleAt).toLocaleTimeString('hu-HU') : '—'}${local.lastCycleError ? ` · hiba: ${local.lastCycleError}` : ''}`
                    : 'Nem fut.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={!canEdit || pending || !local.available || !local.running}
            onClick={stopLocal}
            className="rounded-lg bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-40"
          >
            Leállítás
          </button>
        </div>

        {/* Stateless dispatch-ciklus (Cloud Scheduler / kézi) */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line/40 px-4 py-3">
          <div className="flex items-center gap-3">
            <Dot color={!lastCycle ? 'amber' : lastCycle.ok ? 'emerald' : 'red'} />
            <div>
              <p className="text-sm font-medium">Biztonsági háló egy körének lefutása</p>
              <p className="text-xs text-ink-soft">
                Nincs hozzá állandó folyamat. A lenti Cloud Scheduler N percenként meghívja a webapp{' '}
                <span className="font-mono">/api/v1/internal/dispatch-cycle</span> végpontját: a
                webapp felébred, lefuttat egy kört, majd visszaskálázódhat nullára. Ugyanez a kör fut
                le a „Ciklus futtatása most” gombra is.
              </p>
              <p className="mt-1 text-xs text-ink-soft">
                <strong>Utolsó lefutás:</strong>{' '}
                {!lastCycle
                  ? 'még nem futott.'
                  : `${lastCycle.ok ? 'sikeres' : `hiba: ${lastCycle.error}`} · indította: ${TRIGGER_LABELS[lastCycle.triggeredBy] ?? lastCycle.triggeredBy} · ${new Date(lastCycle.ranAt).toLocaleString('hu-HU')}`}
              </p>
              {lastCycle ? (
                <p className="mt-1 text-xs text-ink-soft font-mono leading-relaxed">
                  {formatLastCycleDetails(lastCycle)}
                </p>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            disabled={!canEdit || pending}
            onClick={runCycleNow}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            Ciklus futtatása most
          </button>
        </div>

        {/* Cloud Scheduler — a stateless ciklus időzítője */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line/40 px-4 py-3">
          <div className="flex items-center gap-3">
            <Dot
              color={
                !scheduler.available ? 'amber' : scheduler.state === 'ENABLED' ? 'emerald' : 'red'
              }
            />
            <div>
              <p className="text-sm font-medium">Cloud Scheduler — a biztonsági háló ütemezője</p>
              <p className="text-xs text-ink-soft">
                Ez indítja az automatikus kört élesben. Ha szünetel, a ticketek továbbra is elindulhatnak
                keletkezéskor, de az elakadt futások, ütemezett taskok, monitor-söprés és workspace-takarítás
                kimarad — <strong>és a Neon nem ébred ütemezetten</strong>.
              </p>
              <p className="mt-1 text-xs text-ink-soft">
                {!scheduler.available
                  ? `Állapot nem lekérdezhető innen: ${scheduler.error}. A GCP-ben a job ettől még futhat — ellenőrizd a Cloud Scheduler konzolt, vagy állítsd le ott is teszteléshez.`
                  : `${scheduler.state === 'ENABLED' ? 'Fut' : scheduler.state === 'PAUSED' ? 'Szüneteltetve' : 'Ismeretlen állapot'} · ütem: ${scheduler.schedule ?? '?'} (${scheduler.timeZone ?? '?'})${scheduler.lastAttemptStatus ? ` · utolsó GCP-futás: ${scheduler.lastAttemptStatus}` : ''}`}
              </p>
              {scheduler.available && scheduler.state === 'PAUSED' ? (
                <p className="mt-1 text-xs text-amber-400">
                  Jelenleg szünetel — a biztonsági háló nem fut. Ez tudatos döntés lehet (így a Neon
                  compute lekapcsolhat), csak tudni kell róla.
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {scheduler.available && currentSchedulerInterval !== null ? (
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={2}
                  max={59}
                  value={schedulerIntervalInput ?? ''}
                  disabled={!canEdit || pending}
                  onChange={(e) => setSchedulerIntervalInput(Number(e.target.value))}
                  className="w-16 rounded-lg border border-line bg-panel px-2 py-1.5 text-sm text-ink disabled:opacity-50"
                />
                <span className="text-xs text-ink-soft">perc</span>
                <button
                  type="button"
                  disabled={
                    !canEdit ||
                    pending ||
                    schedulerIntervalInput === null ||
                    schedulerIntervalInput === currentSchedulerInterval
                  }
                  onClick={saveSchedulerInterval}
                  className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
                >
                  Mentés
                </button>
              </div>
            ) : null}
            <button
              type="button"
              disabled={!canEdit || pending || !scheduler.available || scheduler.state !== 'ENABLED'}
              onClick={() => toggleSchedulerPaused(true)}
              className="rounded-lg bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-40"
            >
              Szüneteltetés
            </button>
            <button
              type="button"
              disabled={!canEdit || pending || !scheduler.available || scheduler.state !== 'PAUSED'}
              onClick={() => toggleSchedulerPaused(false)}
              className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
            >
              Folytatás
            </button>
          </div>
        </div>

        {/* Docker per-ticket harness */}
        <div className="flex items-center gap-3 rounded-lg border border-line/40 px-4 py-3">
          <Dot color="slate" />
          <div>
            <p className="text-sm font-medium">Docker (fejlesztéshez)</p>
            <p className="text-xs text-ink-soft">
              Nincs állandó folyamat: minden ticketnél új konténer indul, és a futás végén megszűnik.
              Nincs rajta mit leállítani, és adatbázis-kapcsolatot sem tart nyitva.
            </p>
          </div>
        </div>

        {message ? (
          <p
            className={`rounded-lg border px-3 py-2 text-sm ${
              message.tone === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300'
            }`}
          >
            {message.text}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-ink-soft">
            Az adatok pillanatképek — magától nem frissül.
            {!canEdit ? ' Leállításhoz admin jogosultság szükséges.' : ''}
          </p>
          <button
            type="button"
            disabled={pending || refreshing}
            onClick={() => void refresh()}
            className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-40"
          >
            {refreshing ? 'Frissítés…' : 'Frissítés'}
          </button>
        </div>
      </div>
    </Card>
  )
}
