'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import {
  getWorkerProcessesStatus,
  runDispatchCycleNow,
  setCloudRunDispatcherScale,
  setDispatchSchedulerIntervalMinutes,
  setDispatchSchedulerPaused,
  stopLocalDispatcherWorker,
  type WorkerProcessesStatus,
} from '@/app/actions/platform'

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

const REFRESH_INTERVAL_MS = 20_000

function Dot({ color }: { color: 'emerald' | 'red' | 'amber' }) {
  const cls = {
    emerald: 'bg-emerald-400',
    red: 'bg-red-400',
    amber: 'bg-amber-400',
  }[color]
  return <span className={`inline-flex h-2.5 w-2.5 rounded-full ${cls}`} />
}

export function WorkerProcessesPanel({
  initial,
  canEdit,
}: {
  initial: WorkerProcessesStatus
  canEdit: boolean
}) {
  const [status, setStatus] = useState(initial)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [confirmingCloudRunStop, setConfirmingCloudRunStop] = useState(false)
  const [schedulerIntervalInput, setSchedulerIntervalInput] = useState<number | null>(
    initial.scheduler.available ? parseEveryNMinutes(initial.scheduler.schedule) : null,
  )

  const refresh = useCallback(() => {
    startTransition(async () => {
      const res = await getWorkerProcessesStatus()
      if (res.success) {
        setStatus(res.data)
        if (res.data.scheduler.available) {
          setSchedulerIntervalInput(parseEveryNMinutes(res.data.scheduler.schedule))
        }
      }
    })
  }, [])

  useEffect(() => {
    const id = setInterval(refresh, REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [refresh])

  function stopLocal() {
    setMessage(null)
    startTransition(async () => {
      const res = await stopLocalDispatcherWorker()
      if (res.success) {
        setMessage({ tone: 'ok', text: 'Leállítási kérés elküldve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
      refresh()
    })
  }

  function setCloudRunScale(minScale: 0 | 1) {
    setMessage(null)
    setConfirmingCloudRunStop(false)
    startTransition(async () => {
      const res = await setCloudRunDispatcherScale(minScale)
      if (res.success) {
        setMessage({ tone: 'ok', text: minScale === 0 ? 'Cloud Run leállítva (minScale=0).' : 'Cloud Run indítva (minScale=1).' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
      refresh()
    })
  }

  function runCycleNow() {
    setMessage(null)
    startTransition(async () => {
      const res = await runDispatchCycleNow()
      if (res.success) {
        setMessage({
          tone: 'ok',
          text: `Ciklus lefutott: ${res.data.dispatch.scanned} ticket vizsgálva, ${res.data.dispatch.started} indítva, ${res.data.dispatch.budgetBlocked} budget_blocked.`,
        })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
      refresh()
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
      refresh()
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
      refresh()
    })
  }

  const local = status.local
  const cloudRun = status.cloudRun
  const scheduler = status.scheduler
  const lastCycle = status.lastCycle
  const currentSchedulerInterval = scheduler.available ? parseEveryNMinutes(scheduler.schedule) : null

  return (
    <Card title="Worker-folyamatok (Neon compute forrás)">
      <div className="space-y-4">
        <p className="text-xs text-ink-soft">
          Ezek a folyamatok tartják nyitva a kapcsolatot a production adatbázissal (LISTEN/NOTIFY +
          cron safety-net) — amíg futnak, a Neon compute nem tud lekapcsolni. A fenti dispatcher
          kapcsoló csak az agent-indítást szünetelteti, ezeket nem. A ready ticketek zöme egyébként
          azonnal, a keletkezésük kérésén belül dispatchelődik — ez a három folyamat csak a
          biztonsági hálóhoz (stale-reclaim, ütemezett taskok, monitor-söprés) kell.
        </p>

        {/* Lokális worker */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line/40 px-4 py-3">
          <div className="flex items-center gap-3">
            <Dot
              color={
                !local.available ? 'amber' : local.running ? 'emerald' : 'red'
              }
            />
            <div>
              <p className="text-sm font-medium">Lokális (dispatcher-worker.ts)</p>
              <p className="text-xs text-ink-soft">
                {!local.available
                  ? 'Nem elérhető innen (csak akkor látható, ha ezt a felületet a saját géped lokális szerveréről nyitod meg és a LOCAL_WORKER_CONTROL_URL be van állítva).'
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

        {/* Cloud Run wiki-dispatcher */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line/40 px-4 py-3">
          <div className="flex items-center gap-3">
            <Dot
              color={
                !cloudRun.available ? 'amber' : cloudRun.minScale === 0 ? 'red' : 'emerald'
              }
            />
            <div>
              <p className="text-sm font-medium">Cloud Run (wiki-dispatcher)</p>
              <p className="text-xs text-ink-soft">
                {!cloudRun.available
                  ? `Nem elérhető: ${cloudRun.error}`
                  : `minScale=${cloudRun.minScale ?? '?'} · ${cloudRun.ready ? 'ready' : 'not ready'}${
                      cloudRun.latestReadyRevisionName ? ` · ${cloudRun.latestReadyRevisionName}` : ''
                    }`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {confirmingCloudRunStop ? (
              <>
                <span className="text-xs text-amber-400">Biztos? Ez az éles service-t állítja le.</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setCloudRunScale(0)}
                  className="rounded-lg bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-40"
                >
                  Igen, leállítás
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirmingCloudRunStop(false)}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm"
                >
                  Mégse
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={!canEdit || pending || !cloudRun.available || cloudRun.minScale === 1}
                  onClick={() => setCloudRunScale(1)}
                  className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
                >
                  Indítás
                </button>
                <button
                  type="button"
                  disabled={!canEdit || pending || !cloudRun.available || cloudRun.minScale === 0}
                  onClick={() => setConfirmingCloudRunStop(true)}
                  className="rounded-lg bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-40"
                >
                  Leállítás
                </button>
              </>
            )}
          </div>
        </div>

        {/* Stateless dispatch-ciklus (Cloud Scheduler / kézi) */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line/40 px-4 py-3">
          <div className="flex items-center gap-3">
            <Dot color={!lastCycle ? 'amber' : lastCycle.ok ? 'emerald' : 'red'} />
            <div>
              <p className="text-sm font-medium">Dispatch-ciklus (stateless — /api/v1/internal/dispatch-cycle)</p>
              <p className="text-xs text-ink-soft">
                {!lastCycle
                  ? 'Még nem futott ciklus ezen a csatornán.'
                  : `${lastCycle.ok ? 'OK' : `hiba: ${lastCycle.error}`} · forrás: ${TRIGGER_LABELS[lastCycle.triggeredBy] ?? lastCycle.triggeredBy} · ${new Date(lastCycle.ranAt).toLocaleString('hu-HU')} · ${lastCycle.dispatchScanned} vizsgálva, ${lastCycle.dispatchStarted} indítva, ${lastCycle.dispatchBudgetBlocked} budget_blocked, ${lastCycle.reclaimedDispatches} reclaim`}
              </p>
              <p className="mt-1 text-xs text-ink-soft">
                Nincs hozzá állandó process — GCP Cloud Schedulerrel percenként/N percenként hívva
                kiváltja a fenti Cloud Run service-t (min-instances=1 nélkül is fut a biztonsági háló).
              </p>
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
              <p className="text-sm font-medium">Cloud Scheduler (dispatch-cycle-sweep)</p>
              <p className="text-xs text-ink-soft">
                {!scheduler.available
                  ? `Nem elérhető: ${scheduler.error}`
                  : `${scheduler.state === 'ENABLED' ? 'Fut' : scheduler.state === 'PAUSED' ? 'Szüneteltetve' : 'Ismeretlen állapot'} · ütem: ${scheduler.schedule ?? '?'} (${scheduler.timeZone ?? '?'})${scheduler.lastAttemptStatus ? ` · utolsó futás: ${scheduler.lastAttemptStatus}` : ''}`}
              </p>
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
          <Dot color="amber" />
          <div>
            <p className="text-sm font-medium">Docker (per-ticket harness)</p>
            <p className="text-xs text-ink-soft">
              Nincs állandó folyamat — minden ticketnél új konténer indul, és a futás végén megszűnik.
              Nincs mit leállítani rajta.
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

        <div className="flex items-center justify-between">
          {!canEdit ? (
            <p className="text-xs text-ink-soft">Leállításhoz admin jogosultság szükséges.</p>
          ) : (
            <span />
          )}
          <button
            type="button"
            disabled={pending}
            onClick={refresh}
            className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-40"
          >
            Frissítés
          </button>
        </div>
      </div>
    </Card>
  )
}
