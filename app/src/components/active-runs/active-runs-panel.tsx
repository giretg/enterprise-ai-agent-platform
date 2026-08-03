'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { RunRow, RunsSummaryChips } from '@/components/active-runs/run-row'
import { activeRunKey, type ActiveRun } from '@/lib/active-runs'
import {
  composeRunsPanel,
  runsSummaryChips,
  summarizeRuns,
  type ComposedRun,
} from '@/lib/active-runs-compose'
import { loadSeenRunKeys, markRunSeen, pruneSeenRunKeys } from '@/lib/active-runs-seen'

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

  const chips = runsSummaryChips(summarizeRuns(runs))

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
            className="absolute right-0 top-full z-50 mt-2 w-[min(23rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-line bg-card shadow-[0_20px_50px_-24px_rgba(15,23,42,0.45)]"
          >
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-ink">Futások</p>
                {chips.length > 0 ? (
                  <div className="mt-1">
                    <RunsSummaryChips chips={chips} />
                  </div>
                ) : (
                  <p className="text-[11px] text-ink-faint">Chat-válaszaid és feladataid</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Bezár"
                className="shrink-0 rounded-full p-1 text-ink-faint transition-colors hover:bg-night-2 hover:text-ink"
              >
                <svg viewBox="0 0 16 16" fill="none" aria-hidden className="h-3.5 w-3.5">
                  <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="max-h-[min(20rem,55vh)] overflow-y-auto p-1.5">
              {loading && runs.length === 0 ? (
                <p className="px-2 py-3 text-xs text-ink-faint">Betöltés…</p>
              ) : error && runs.length === 0 ? (
                <p className="px-2 py-3 text-xs text-coral">{error}</p>
              ) : runs.length === 0 ? (
                <p className="px-2 py-3 text-xs text-ink-faint">
                  Most nincs futó ügyed. Ha elindítasz egy chatet vagy feladatot, itt követheted.
                </p>
              ) : (
                <ul className="divide-y divide-line/50">
                  {runs.map((run) => (
                    <li key={activeRunKey(run)}>
                      <RunRow
                        run={run}
                        dense
                        stopping={stoppingId === run.id}
                        onOpen={openRun}
                        onStop={(target) => void stopRun(target)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {error && runs.length > 0 && (
              <p className="border-t border-line px-3 py-1.5 text-[11px] text-coral">{error}</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
