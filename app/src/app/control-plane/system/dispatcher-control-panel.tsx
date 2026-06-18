'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { setDispatcherControls } from '@/app/actions/platform'

export type DispatcherControlsView = {
  enabled: boolean
  pollIntervalMs: number
  updatedById: string | null
  updatedAt: string | null
}

export function DispatcherControlPanel({
  initial,
  canEdit,
}: {
  initial: DispatcherControlsView
  canEdit: boolean
}) {
  const [controls, setControls] = useState(initial)
  const [intervalSec, setIntervalSec] = useState(Math.round(initial.pollIntervalMs / 1000))
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function apply(next: { enabled?: boolean; pollIntervalSeconds?: number }) {
    setMessage(null)
    startTransition(async () => {
      const res = await setDispatcherControls(next)
      if (res.success) {
        setControls(res.data)
        setIntervalSec(Math.round(res.data.pollIntervalMs / 1000))
        setMessage({ tone: 'ok', text: 'Mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <Card title="Dispatcher (agent-indítás)">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex h-2.5 w-2.5 rounded-full ${
                controls.enabled ? 'bg-emerald-400' : 'bg-red-400'
              }`}
            />
            <div>
              <p className="text-sm font-semibold">
                {controls.enabled ? 'Aktív — automatikusan indítja az agenteket' : 'Szüneteltetve — nem indít agentet'}
              </p>
              <p className="text-xs text-ink-soft">
                {controls.enabled
                  ? 'A ready ticketeket a dispatcher feldolgozza (token-fogyás lehetséges).'
                  : 'A ready ticketek várnak; nulla LLM-token fogy a dispatcheren.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={!canEdit || pending}
            onClick={() => apply({ enabled: !controls.enabled })}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              controls.enabled ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'
            }`}
          >
            {controls.enabled ? '⏸ Leállítás' : '▶ Indítás'}
          </button>
        </div>

        <div className="border-t border-line/40 pt-4">
          <label className="block text-sm font-medium">Cron safety-net intervallum</label>
          <p className="mb-2 text-xs text-ink-soft">
            Milyen gyakran pásztázza a ready ticketeket (5–600 mp). Új ticketnél a Postgres
            LISTEN/NOTIFY amúgy is azonnal triggerel — ez csak a biztonsági háló üteme.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={5}
              max={600}
              value={intervalSec}
              disabled={!canEdit || pending}
              onChange={(e) => setIntervalSec(Number(e.target.value))}
              className="w-28 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-ink disabled:opacity-50"
            />
            <span className="text-sm text-ink-soft">másodperc</span>
            <button
              type="button"
              disabled={!canEdit || pending || intervalSec === Math.round(controls.pollIntervalMs / 1000)}
              onClick={() => apply({ pollIntervalSeconds: intervalSec })}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              Mentés
            </button>
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
          {controls.updatedAt ? new Date(controls.updatedAt).toLocaleString('hu-HU') : '— (alapértelmezett)'}
          {' · '}a változás ~1 ciklus alatt él a felhős workeren.
        </p>
      </div>
    </Card>
  )
}
