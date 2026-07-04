'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { setDispatcherControls } from '@/app/actions/platform'

export type DispatcherControlsView = {
  enabled: boolean
  pollIntervalMs: number
  blockedNotifyChannel: string
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
  const [notifyEnabled, setNotifyEnabled] = useState(initial.blockedNotifyChannel.startsWith('chat:'))
  const [notifyKey, setNotifyKey] = useState(
    initial.blockedNotifyChannel.startsWith('chat:')
      ? initial.blockedNotifyChannel.slice('chat:'.length)
      : '',
  )
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function apply(next: { enabled?: boolean; pollIntervalSeconds?: number; blockedNotifyChannel?: string }) {
    setMessage(null)
    startTransition(async () => {
      const res = await setDispatcherControls(next)
      if (res.success) {
        setControls(res.data)
        setIntervalSec(Math.round(res.data.pollIntervalMs / 1000))
        setNotifyEnabled(res.data.blockedNotifyChannel.startsWith('chat:'))
        setNotifyKey(
          res.data.blockedNotifyChannel.startsWith('chat:')
            ? res.data.blockedNotifyChannel.slice('chat:'.length)
            : '',
        )
        setMessage({ tone: 'ok', text: 'Mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  const trimmedNotifyKey = notifyKey.trim()
  const desiredNotifyChannel =
    notifyEnabled && trimmedNotifyKey ? `chat:${trimmedNotifyKey}` : 'audit-only:dispatch-blocked'
  const notifyChanged = desiredNotifyChannel !== controls.blockedNotifyChannel
  const notifyEnvName = trimmedNotifyKey
    ? `MONITOR_NOTIFY_WEBHOOK_${trimmedNotifyKey.toUpperCase().replace(/-/g, '_')}`
    : 'MONITOR_NOTIFY_WEBHOOK_<KULCS>'

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

        <div className="border-t border-line/40 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <label className="block text-sm font-medium">Blokkolt dispatch értesítés</label>
              <p className="text-xs text-ink-soft">
                `dispatch.blocked` esetén webhook értesítés küldhető egy szerveroldalon allowlistolt chat csatornára.
              </p>
            </div>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={notifyEnabled}
                disabled={!canEdit || pending}
                onChange={(e) => setNotifyEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-line bg-panel"
              />
              Chat webhook
            </label>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <input
                type="text"
                value={notifyKey}
                disabled={!canEdit || pending || !notifyEnabled}
                onChange={(e) => setNotifyKey(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
                placeholder="ops"
                className="w-full rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-ink disabled:opacity-50"
              />
              <p className="mt-1 text-xs text-ink-soft">
                Aktuális: <span className="font-mono">{controls.blockedNotifyChannel}</span>
                {notifyEnabled ? (
                  <>
                    {' · '}env: <span className="font-mono">{notifyEnvName}</span>
                  </>
                ) : null}
              </p>
            </div>
            <button
              type="button"
              disabled={
                !canEdit ||
                pending ||
                !notifyChanged ||
                (notifyEnabled && trimmedNotifyKey.length === 0)
              }
              onClick={() => apply({ blockedNotifyChannel: desiredNotifyChannel })}
              className="h-9 rounded-lg bg-accent px-3 text-sm text-white disabled:opacity-40"
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
