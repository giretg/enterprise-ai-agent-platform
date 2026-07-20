'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import type { ActiveRun } from '@/lib/active-runs'

function formatStartedAt(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
}

function kindLabel(kind: ActiveRun['kind']): string {
  return kind === 'chat_turn' ? 'Chat' : 'Ticket'
}

export function ActiveRunsPanel() {
  const [open, setOpen] = useState(false)
  const [runs, setRuns] = useState<ActiveRun[]>([])
  const [loading, setLoading] = useState(false)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/v1/active-runs')
      if (!res.ok) {
        setError('Nem sikerült betölteni az aktív futásokat.')
        return
      }
      const data = (await res.json()) as { runs: ActiveRun[] }
      setRuns(data.runs ?? [])
    } catch {
      setError('Hálózati hiba az aktív futások lekérésekor.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, 2500)
    return () => window.clearInterval(timer)
  }, [refresh])

  const stopRun = async (run: ActiveRun) => {
    if (!run.canStop || stoppingId) return
    setStoppingId(run.id)
    try {
      const response =
        run.kind === 'chat_turn'
          ? await fetch(`/api/v1/agent-chat/turns/${run.id}/cancel`, { method: 'POST' })
          : await fetch(`/api/v1/tickets/${run.id}/cancel`, { method: 'POST' })
      if (!response.ok) {
        setError(
          response.status === 404 || response.status === 409
            ? 'A futás már nem aktív.'
            : 'Leállítás sikertelen.',
        )
      }
      await refresh()
    } catch {
      setError('Leállítás sikertelen.')
    } finally {
      setStoppingId(null)
    }
  }

  const count = runs.length

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v)
          void refresh()
        }}
        className={`relative inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
          count > 0
            ? 'border-sky/40 bg-sky/10 text-sky hover:border-sky/60'
            : 'border-line bg-card text-ink-faint hover:border-coral/40 hover:text-ink-soft'
        }`}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        Futások
        {count > 0 && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-sky px-1.5 text-[10px] font-bold text-card">
            {count}
          </span>
        )}
      </button>

      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default bg-night/20"
            aria-label="Panel bezárása"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-label="Aktív futások"
            className="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-line bg-card shadow-[0_20px_50px_-24px_rgba(15,23,42,0.45)]"
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-ink">Aktív futások</p>
                <p className="text-[11px] text-ink-faint">
                  Háttérben dolgozó chat-válaszok és ticketek
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full px-2 py-1 text-xs text-ink-faint hover:bg-night-2 hover:text-ink"
              >
                Bezár
              </button>
            </div>

            <div className="max-h-[min(24rem,60vh)] overflow-y-auto p-2">
              {loading && runs.length === 0 ? (
                <p className="px-2 py-4 text-xs text-ink-faint">Betöltés…</p>
              ) : error && runs.length === 0 ? (
                <p className="px-2 py-4 text-xs text-coral">{error}</p>
              ) : runs.length === 0 ? (
                <p className="px-2 py-4 text-xs text-ink-faint">Most nincs futó folyamat.</p>
              ) : (
                <ul className="space-y-1.5">
                  {runs.map((run) => (
                    <li
                      key={`${run.kind}:${run.id}`}
                      className="rounded-xl border border-line/80 bg-night/20 px-3 py-2.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                              {kindLabel(run.kind)}
                            </span>
                            <span className="text-[10px] text-ink-faint">
                              {formatStartedAt(run.startedAt)}
                            </span>
                          </div>
                          <p className="mt-1 truncate text-sm font-medium text-ink">{run.title}</p>
                          {run.latestActivity && (
                            <p className="mt-0.5 line-clamp-2 text-[11px] text-ink-faint">
                              {run.latestActivity}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <Link
                          href={run.href}
                          onClick={() => setOpen(false)}
                          className="rounded-full border border-line bg-card px-2.5 py-1 text-[11px] font-semibold text-ink-soft hover:border-coral/40 hover:text-coral-deep"
                        >
                          Megnyitás
                        </Link>
                        {run.canStop && (
                          <button
                            type="button"
                            disabled={stoppingId === run.id}
                            onClick={() => void stopRun(run)}
                            className="rounded-full border border-coral/35 bg-coral/10 px-2.5 py-1 text-[11px] font-semibold text-coral-deep hover:bg-coral/15 disabled:opacity-50"
                          >
                            {stoppingId === run.id ? 'Leállítás…' : 'Leállítás'}
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {error && runs.length > 0 && (
              <p className="border-t border-line px-4 py-2 text-[11px] text-coral">{error}</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
