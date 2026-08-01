'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { activeRunKey, type ActiveRun } from '@/lib/active-runs'
import { composeRunsPanel, type ComposedRun } from '@/lib/active-runs-compose'
import { loadSeenRunKeys, markRunSeen, pruneSeenRunKeys } from '@/lib/active-runs-seen'

function formatStartedAt(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
}

function kindLabel(kind: ActiveRun['kind']): string {
  return kind === 'chat_turn' ? 'Chat' : 'Ticket'
}

function statusLabel(run: ActiveRun): string | null {
  if (run.phase === 'active') {
    if (run.status === 'cancelling') return 'Leállítás…'
    if (run.status === 'awaiting_human') return 'Döntésre vár'
    if (run.status === 'needs_info') return 'Információra vár'
    return null
  }
  switch (run.status) {
    case 'completed':
    case 'done':
      return 'Kész'
    case 'cancelled':
      return 'Leállítva'
    case 'failed':
    case 'exhausted':
      return 'Sikertelen'
    case 'rejected':
      return 'Elutasítva'
    default:
      return 'Lefutott'
  }
}

export function ActiveRunsPanel() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [runs, setRuns] = useState<ComposedRun[]>([])
  const [badgeCount, setBadgeCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const applyRuns = useCallback((raw: ActiveRun[]) => {
    const seenKeys = loadSeenRunKeys()
    const composed = composeRunsPanel({ runs: raw, seenKeys })
    setRuns(composed.runs)
    setBadgeCount(composed.badgeCount)
    pruneSeenRunKeys(new Set(raw.map((run) => activeRunKey(run))))
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/v1/active-runs')
      if (!res.ok) {
        setError('Nem sikerült betölteni a futásokat.')
        return
      }
      const data = (await res.json()) as { runs: ActiveRun[] }
      applyRuns(data.runs ?? [])
    } catch {
      setError('Hálózati hiba a futások lekérésekor.')
    } finally {
      setLoading(false)
    }
  }, [applyRuns])

  useEffect(() => {
    // Szándékos: felcsatoláskor azonnal töltünk, majd 2,5 mp-enként pollozunk. A `refresh`
    // elején a betöltés-jelző beállítása a mount-kori adatlekérés természetes velejárója.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  const openRun = (run: ActiveRun) => {
    // A panel bezárásakor a link rögtön lecsatolódhat. Explicit navigációval a
    // „Megnyitás” kattintás nem függ az anchor alapértelmezett viselkedésétől.
    if (run.phase === 'completed') {
      markRunSeen(run)
    }
    setOpen(false)
    router.push(run.href)
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v)
          void refresh()
        }}
        className={`relative inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
          badgeCount > 0
            ? 'border-sky/40 bg-sky/10 text-sky hover:border-sky/60'
            : 'border-line bg-card text-ink-faint hover:border-coral/40 hover:text-ink-soft'
        }`}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        Futások
        {badgeCount > 0 && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-sky px-1.5 text-[10px] font-bold text-card">
            {badgeCount}
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
            aria-label="Futások"
            className="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-line bg-card shadow-[0_20px_50px_-24px_rgba(15,23,42,0.45)]"
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-ink">Futások</p>
                <p className="text-[11px] text-ink-faint">
                  Aktív és frissen lefutott chat-válaszok és ticketek
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
                <p className="px-2 py-4 text-xs text-ink-faint">Nincs aktív vagy új lefutott futás.</p>
              ) : (
                <ul className="space-y-1.5">
                  {runs.map((run) => {
                    const label = statusLabel(run)
                    const completed = run.phase === 'completed'
                    const highlightUnseen = completed && !run.seen
                    const cardClass = `rounded-xl border px-3 py-2.5 text-left transition-colors ${
                      highlightUnseen
                        ? 'border-sky/35 bg-sky/5'
                        : 'border-line/80 bg-night/20'
                    } ${completed ? 'w-full cursor-pointer hover:border-coral/40' : ''}`
                    const meta = (
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                            {kindLabel(run.kind)}
                          </span>
                          {label && (
                            <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] font-semibold text-ink-faint">
                              {label}
                            </span>
                          )}
                          <span className="text-[10px] text-ink-faint">
                            {formatStartedAt(run.finishedAt ?? run.startedAt)}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-sm font-medium text-ink">{run.title}</p>
                        {!completed && run.latestActivity && (
                          <p className="mt-0.5 line-clamp-2 text-[11px] text-ink-faint">
                            {run.latestActivity}
                          </p>
                        )}
                      </div>
                    )
                    return (
                      <li key={activeRunKey(run)}>
                        {completed ? (
                          <button
                            type="button"
                            onClick={() => openRun(run)}
                            className={cardClass}
                          >
                            {meta}
                          </button>
                        ) : (
                          <div className={cardClass}>
                            {meta}
                            <div className="mt-2 flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => openRun(run)}
                                className="rounded-full border border-line bg-card px-2.5 py-1 text-[11px] font-semibold text-ink-soft hover:border-coral/40 hover:text-coral-deep"
                              >
                                Megnyitás
                              </button>
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
                          </div>
                        )}
                      </li>
                    )
                  })}
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
