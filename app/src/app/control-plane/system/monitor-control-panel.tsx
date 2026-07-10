'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { Card } from '@/components/ui/shell'
import { setMonitorControls } from '@/app/actions/monitor'
import type { WorkerProcessesStatus } from '@/app/actions/platform'
import { isSafetyNetAutoOn } from './automation-status'

export type MonitorControlsView = {
  killSwitch: boolean
  maxConcurrent: number
  updatedById: string | null
  updatedAt: string | null
}

export function MonitorControlPanel({
  initial,
  workerStatus,
  canEdit,
}: {
  initial: MonitorControlsView
  workerStatus?: WorkerProcessesStatus
  canEdit: boolean
}) {
  const [controls, setControls] = useState(initial)
  const [maxConcurrent, setMaxConcurrent] = useState(initial.maxConcurrent)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function apply(next: { killSwitch?: boolean; maxConcurrent?: number }) {
    setMessage(null)
    startTransition(async () => {
      const res = await setMonitorControls(next)
      if (res.success) {
        setControls(res.data)
        setMaxConcurrent(res.data.maxConcurrent)
        setMessage({ tone: 'ok', text: 'Mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  const active = !controls.killSwitch
  const scheduler = workerStatus?.scheduler ?? { available: false as const, error: 'Nincs betöltve' }
  const local = workerStatus?.local ?? { available: false as const }
  const safetyNetAutoOn = isSafetyNetAutoOn(scheduler, local)
  const effectivelySweeping = active && safetyNetAutoOn

  return (
    <Card title="Proaktív monitor (a biztonsági háló 3. lépése)">
      <div className="space-y-5">
        <p className="text-xs text-ink-soft">
          A <strong>monitor definíciók</strong> (
          <Link href="/control-plane/monitors" className="text-accent hover:underline">
            Monitorok
          </Link>
          ) határozzák meg, mit figyel (határidő, board-elakadás, postafiók) és milyen küszöbnél nyit
          ticketet. Ez a panel csak a söprés-lépés globális kapcsolóit állítja: be/ki és hány monitor
          fér bele egy körbe.
        </p>
        <p className="text-xs text-ink-soft">
          A söprés <strong>nem külön folyamat</strong> — a biztonsági háló körének harmadik lépése. Ha a
          Cloud Scheduler szünetel és a lokális worker sem fut, itt „engedélyezve” állapot mellett sem
          történik söprés.
        </p>

        <div className="rounded-lg border border-line/40 bg-surface/20 px-4 py-2.5 text-xs">
          <p className="font-medium text-ink">Effektív állapot</p>
          <p className="mt-1 text-ink-soft">
            {effectivelySweeping
              ? 'A következő automatikus biztonsági háló körben a söprés lefut (ha van esedékes monitor).'
              : !active
                ? 'Kill-switch — a söprés-lépés kimarad minden körből.'
                : !scheduler.available
                  ? workerStatus
                    ? 'Kill-switch ki, de a Scheduler állapota ismeretlen — a söprés csak akkor fut, ha a GCP-ben a job aktív vagy a lokális worker fut.'
                    : 'Kill-switch ki. A Scheduler állapotához nyisd meg a Rendszer → Üzemeltetés oldalt.'
                  : 'Kill-switch ki, de nincs automatikus kör (Scheduler szünetel, lokális worker sem fut). Kézi „Ciklus futtatása most” továbbra is söpör.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex h-2.5 w-2.5 rounded-full ${
                effectivelySweeping ? 'bg-emerald-400' : active ? 'bg-amber-400' : 'bg-red-400'
              }`}
            />
            <div>
              <p className="text-sm font-semibold">
                {effectivelySweeping
                  ? 'Söprés aktív — a következő kör söpörni fog'
                  : active
                    ? 'Engedélyezve, de nincs automatikus ütemező'
                    : 'Kill-switch — söprés kimarad'}
              </p>
              <p className="text-xs text-ink-soft">
                {effectivelySweeping
                  ? 'A jelgyűjtés nem használ LLM-et. Ticket/folyamat csak küszöbön túl, a monitor definíció szerint.'
                  : active
                    ? 'Szüneteltesd a kill-switch-et, és kapcsold be a Cloud Schedulert (vagy indíts lokális workert), hogy automatikusan söpörjön.'
                    : 'Nem gyűjt jeleket, nem nyit magától ticketet. A monitor definíciók megmaradnak; a biztonsági háló többi lépése fut tovább.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={!canEdit || pending}
            onClick={() => apply({ killSwitch: !controls.killSwitch })}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              active ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'
            }`}
          >
            {active ? '⏸ Kill-switch' : '▶ Újraindítás'}
          </button>
        </div>

        <div className="border-t border-line/40 pt-4">
          <div>
            <label className="block text-sm font-medium">Söprések száma egy körben</label>
            <p className="mb-2 text-xs text-ink-soft">
              Egy körben legfeljebb ennyi esedékes monitort dolgoz fel, egymás után — nem
              párhuzamosan. Ami nem fért bele, az a következő körre marad. Ez tehát az átbocsátás
              korlátja: 5-ös értéknél és kétperces ütemnél kétpercenként legfeljebb öt monitor fut
              le. A kör saját darabszám-korlátja (<span className="font-mono">DISPATCHER_BATCH_LIMIT</span>,
              alapból 10) ezt még leszoríthatja, ezért a fölé állított érték jellemzően nem hoz többet.
            </p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={20}
                value={maxConcurrent}
                disabled={!canEdit || pending}
                onChange={(e) => setMaxConcurrent(Number(e.target.value))}
                className="w-20 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-ink disabled:opacity-50"
              />
              <button
                type="button"
                disabled={!canEdit || pending || maxConcurrent === controls.maxConcurrent}
                onClick={() => apply({ maxConcurrent })}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
              >
                Mentés
              </button>
            </div>
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

        {!canEdit ? (
          <p className="text-xs text-ink-soft">Módosításhoz admin jogosultság szükséges.</p>
        ) : null}

        <p className="text-xs text-ink-soft">
          Utoljára módosítva:{' '}
          {controls.updatedAt
            ? new Date(controls.updatedAt).toLocaleString('hu-HU')
            : '— (alapértelmezett)'}
        </p>
      </div>
    </Card>
  )
}
