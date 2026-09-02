'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RunRow, RunsSummaryChips } from '@/components/active-runs/run-row'
import {
  requestActiveRunsRefresh,
  useActiveRunsFeed,
} from '@/components/active-runs/active-runs-feed-store'
import { useTicketDispatch } from '@/components/tickets/ticket-dispatch-client'
import { activeRunKey, type ActiveRun } from '@/lib/active-runs'
import { composeRunsPanel, runsSummaryChips, summarizeRuns } from '@/lib/active-runs-compose'
import { loadSeenRunKeys, markRunSeen, pruneSeenRunKeys } from '@/lib/active-runs-seen'

export function ActiveRunsPanel() {
  const router = useRouter()
  const dispatchTicket = useTicketDispatch()
  const [open, setOpen] = useState(false)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [startingId, setStartingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // A futáslistát a munkatárs-sáv poll-ja szállítja (közös `rail-state` válasz),
  // így ennek a panelnek nincs saját `/api/v1/active-runs` pollútja.
  const feed = useActiveRunsFeed()
  const loading = feed.receivedAt === null
  const error = actionError ?? feed.error

  // A sáv minden sikeres poll-ja új `feed.runs` tömböt ad → ez a helyes
  // újraszámítási jel; a „látott” kulcsokat ilyenkor olvassuk localStorage-ból.
  const composed = useMemo(
    () => composeRunsPanel({ runs: feed.runs, seenKeys: loadSeenRunKeys() }),
    [feed.runs],
  )
  const runs = composed.runs
  const badgeCount = composed.badgeCount

  useEffect(() => {
    if (feed.receivedAt === null) return
    pruneSeenRunKeys(new Set(feed.runs.map((run) => activeRunKey(run))))
  }, [feed.runs, feed.receivedAt])

  // Egy futás leállítása / indítása / a panel megnyitása után azonnali
  // sáv-poll-t kérünk — a válasz ugyanezen a store-on át frissíti a listát.
  const refresh = useCallback(async () => {
    setActionError(null)
    requestActiveRunsRefresh()
  }, [])

  const stopRun = async (run: ActiveRun) => {
    if (!run.canStop || stoppingId || startingId) return
    setStoppingId(run.id)
    try {
      const response =
        run.kind === 'chat_turn'
          ? await fetch(`/api/v1/agent-chat/turns/${run.id}/cancel`, { method: 'POST' })
          : await fetch(`/api/v1/tickets/${run.id}/cancel`, { method: 'POST' })
      if (!response.ok) {
        setActionError(
          response.status === 404 || response.status === 409
            ? 'A futás már nem aktív.'
            : 'Leállítás sikertelen.',
        )
      }
      await refresh()
    } catch {
      setActionError('Leállítás sikertelen.')
    } finally {
      setStoppingId(null)
    }
  }

  const startRun = async (run: ActiveRun) => {
    if (!run.canStart || run.kind !== 'ticket' || startingId || stoppingId) return
    setStartingId(run.id)
    try {
      const result = await dispatchTicket(run.id)
      if (!result.success) {
        setActionError(result.error || 'Indítás sikertelen.')
      } else {
        setActionError(null)
      }
      await refresh()
    } catch {
      setActionError('Indítás sikertelen.')
    } finally {
      setStartingId(null)
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
                        starting={startingId === run.id}
                        onOpen={openRun}
                        onStop={(target) => void stopRun(target)}
                        onStart={(target) => void startRun(target)}
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
