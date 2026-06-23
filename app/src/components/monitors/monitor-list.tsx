'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { pauseMonitor, resumeMonitor, revokeMonitor } from '@/app/actions/monitor'

const KIND_LABEL: Record<string, string> = {
  board_backlog: 'Board elakadás',
  deadline: 'Határidő',
  connector_count: 'Connector-számlálás',
  composite: 'Összetett',
}

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-300',
  paused: 'bg-yellow-500/15 text-yellow-300',
  revoked: 'bg-red-500/15 text-red-400',
}


export type MonitorListView = {
  id: string
  title: string
  kind: string
  status: string
  nextSweepAt: string | null
  lastSweepAt: string | null
  intervalSeconds: number
  escalateAgentId: string | null
}

export function MonitorList({
  monitors,
  canEdit,
}: {
  monitors: MonitorListView[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function toggle(monitor: MonitorListView) {
    setMessage(null)
    startTransition(async () => {
      const action = monitor.status === 'active' ? pauseMonitor : resumeMonitor
      const res = await action({ id: monitor.id })
      if (res.success) {
        router.refresh()
        setMessage({ tone: 'ok', text: `Monitor ${monitor.status === 'active' ? 'szüneteltetve' : 'újraindítva'}.` })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  function revoke(monitor: MonitorListView) {
    if (!confirm(`Biztosan visszavonod a(z) "${monitor.title}" monitort? Ez visszafordíthatatlan.`)) return
    setMessage(null)
    startTransition(async () => {
      const res = await revokeMonitor({ id: monitor.id })
      if (res.success) {
        router.refresh()
        setMessage({ tone: 'ok', text: 'Monitor visszavonva.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  if (monitors.length === 0) {
    return (
      <div className="rounded-xl border border-line/60 bg-panel px-6 py-12 text-center">
        <p className="text-sm text-ink-soft">Még nincs monitor-definíció.</p>
        {canEdit && (
          <Link
            href="/control-plane/monitors/new"
            className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            + Új monitor
          </Link>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
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

      <div className="overflow-hidden rounded-xl border border-line/60">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line/40 bg-panel/60">
              <th className="px-4 py-3 text-left font-medium text-ink-soft">Monitor</th>
              <th className="px-4 py-3 text-left font-medium text-ink-soft">Kind</th>
              <th className="px-4 py-3 text-left font-medium text-ink-soft">Státusz</th>
              <th className="px-4 py-3 text-left font-medium text-ink-soft">Következő söprés</th>
              <th className="px-4 py-3 text-left font-medium text-ink-soft">Intervallum</th>
              {canEdit && <th className="px-4 py-3" />}
            </tr>
          </thead>
          <tbody>
            {monitors.map((m) => (
              <tr key={m.id} className="border-b border-line/30 last:border-0 hover:bg-panel/40">
                <td className="px-4 py-3">
                  <Link
                    href={`/control-plane/monitors/${m.id}`}
                    className="font-medium hover:text-accent"
                  >
                    {m.title}
                  </Link>
                  {m.escalateAgentId && (
                    <span className="ml-2 inline-flex rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent">
                      LLM
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-ink-soft">{KIND_LABEL[m.kind] ?? m.kind}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[m.status] ?? ''}`}
                  >
                    {m.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-ink-soft">
                  {m.nextSweepAt ? new Date(m.nextSweepAt).toLocaleString('hu-HU') : '—'}
                </td>
                <td className="px-4 py-3 text-ink-soft">
                  {m.intervalSeconds >= 3600
                    ? `${Math.round(m.intervalSeconds / 3600)}h`
                    : `${Math.round(m.intervalSeconds / 60)}p`}
                </td>
                {canEdit && (
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 justify-end">
                      <Link
                        href={`/control-plane/monitors/${m.id}`}
                        className="rounded px-2 py-1 text-xs text-ink-soft hover:text-ink"
                      >
                        Részletek
                      </Link>
                      {m.status !== 'revoked' && (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => toggle(m)}
                          className="rounded px-2 py-1 text-xs text-ink-soft hover:text-ink disabled:opacity-40"
                        >
                          {m.status === 'active' ? 'Szünet' : 'Indítás'}
                        </button>
                      )}
                      {m.status !== 'revoked' && (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => revoke(m)}
                          className="rounded px-2 py-1 text-xs text-red-400 hover:text-red-300 disabled:opacity-40"
                        >
                          Visszavonás
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
