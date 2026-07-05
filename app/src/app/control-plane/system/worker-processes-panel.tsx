'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import {
  getWorkerProcessesStatus,
  setCloudRunDispatcherScale,
  stopLocalDispatcherWorker,
  type WorkerProcessesStatus,
} from '@/app/actions/platform'

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

  const refresh = useCallback(() => {
    startTransition(async () => {
      const res = await getWorkerProcessesStatus()
      if (res.success) setStatus(res.data)
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

  const local = status.local
  const cloudRun = status.cloudRun

  return (
    <Card title="Worker-folyamatok (Neon compute forrás)">
      <div className="space-y-4">
        <p className="text-xs text-ink-soft">
          Ezek a folyamatok tartják nyitva a kapcsolatot a production adatbázissal (LISTEN/NOTIFY +
          cron safety-net) — amíg futnak, a Neon compute nem tud lekapcsolni. A fenti dispatcher
          kapcsoló csak az agent-indítást szünetelteti, ezeket nem.
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
