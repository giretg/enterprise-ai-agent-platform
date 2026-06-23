'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { setMonitorControls } from '@/app/actions/monitor'

export type MonitorControlsView = {
  killSwitch: boolean
  sweepIntervalSec: number
  maxConcurrent: number
  updatedById: string | null
  updatedAt: string | null
}

export function MonitorControlPanel({
  initial,
  canEdit,
}: {
  initial: MonitorControlsView
  canEdit: boolean
}) {
  const [controls, setControls] = useState(initial)
  const [intervalSec, setIntervalSec] = useState(initial.sweepIntervalSec)
  const [maxConcurrent, setMaxConcurrent] = useState(initial.maxConcurrent)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function apply(next: { killSwitch?: boolean; sweepIntervalSec?: number; maxConcurrent?: number }) {
    setMessage(null)
    startTransition(async () => {
      const res = await setMonitorControls(next)
      if (res.success) {
        setControls(res.data)
        setIntervalSec(res.data.sweepIntervalSec)
        setMaxConcurrent(res.data.maxConcurrent)
        setMessage({ tone: 'ok', text: 'Mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  const active = !controls.killSwitch

  return (
    <Card title="Proaktív Monitor (söprés-motor)">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex h-2.5 w-2.5 rounded-full ${
                active ? 'bg-emerald-400' : 'bg-red-400'
              }`}
            />
            <div>
              <p className="text-sm font-semibold">
                {active
                  ? 'Aktív — proaktívan figyeli a határidőket és a boardot'
                  : 'Kill-switch bekapcsolva — minden söprés skipped (audit-nyommal)'}
              </p>
              <p className="text-xs text-ink-soft">
                {active
                  ? 'Az 1. lépcső nulla LLM-token; a 2. lépcső csak küszöböt átlépő jelnél indul.'
                  : 'Nulla söprés fut; a monitor-definíciók megmaradnak, csak nem futnak.'}
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

        <div className="border-t border-line/40 pt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium">Söprés-intervallum</label>
            <p className="mb-2 text-xs text-ink-soft">
              Milyen sűrűn nézi az esedékes monitorokat (10–3600 mp).
            </p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={10}
                max={3600}
                value={intervalSec}
                disabled={!canEdit || pending}
                onChange={(e) => setIntervalSec(Number(e.target.value))}
                className="w-28 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-ink disabled:opacity-50"
              />
              <span className="text-sm text-ink-soft">mp</span>
              <button
                type="button"
                disabled={!canEdit || pending || intervalSec === controls.sweepIntervalSec}
                onClick={() => apply({ sweepIntervalSec: intervalSec })}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
              >
                Mentés
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium">Max. párhuzamos söprés</label>
            <p className="mb-2 text-xs text-ink-soft">
              Egyszerre futó söprések korlátja (1–20).
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
