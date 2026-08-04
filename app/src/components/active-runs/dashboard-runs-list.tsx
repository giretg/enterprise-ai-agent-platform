'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RunRow, RunsSummaryChips } from '@/components/active-runs/run-row'
import { useTicketDispatch } from '@/components/tickets/ticket-dispatch-client'
import { activeRunKey, type ActiveRun } from '@/lib/active-runs'
import {
  composeRunsPanel,
  runsSummaryChips,
  summarizeRuns,
  type ComposedRun,
} from '@/lib/active-runs-compose'
import { runDayLabel } from '@/lib/active-runs-labels'
import { loadSeenRunKeys, markRunSeen, pruneSeenRunKeys } from '@/lib/active-runs-seen'

const POLL_MS = 5000
/** Ennyi sor látszik alapból; a többi egy kattintással nyílik ki. */
const COLLAPSED_LIMIT = 6

function groupByDay(runs: ComposedRun[]): { label: string; runs: ComposedRun[] }[] {
  const groups: { label: string; runs: ComposedRun[] }[] = []
  for (const run of runs) {
    const label = runDayLabel(run.finishedAt ?? run.startedAt)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.runs.push(run)
    else groups.push({ label, runs: [run] })
  }
  return groups
}

export function DashboardRunsList({ initialRuns }: { initialRuns: ActiveRun[] }) {
  const router = useRouter()
  const dispatchTicket = useTicketDispatch()
  const [runs, setRuns] = useState<ComposedRun[]>(() =>
    composeRunsPanel({ runs: initialRuns, seenKeys: loadSeenRunKeys() }).runs,
  )
  const [expanded, setExpanded] = useState(false)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [startingId, setStartingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const applyRuns = useCallback((raw: ActiveRun[]) => {
    const seenKeys = loadSeenRunKeys()
    const composed = composeRunsPanel({ runs: raw, seenKeys })
    setRuns(composed.runs)
    pruneSeenRunKeys(new Set(raw.map((run) => activeRunKey(run))))
  }, [])

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/active-runs')
      if (!res.ok) {
        setError('Nem sikerült frissíteni a futásokat.')
        return
      }
      const data = (await res.json()) as { runs: ActiveRun[] }
      applyRuns(data.runs ?? [])
      setError(null)
    } catch {
      setError('Hálózati hiba a futások lekérésekor.')
    }
  }, [applyRuns])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  const stopRun = async (run: ActiveRun) => {
    if (!run.canStop || stoppingId || startingId) return
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

  const startRun = async (run: ActiveRun) => {
    if (!run.canStart || run.kind !== 'ticket' || startingId || stoppingId) return
    setStartingId(run.id)
    try {
      const result = await dispatchTicket(run.id)
      if (!result.success) {
        setError(result.error || 'Indítás sikertelen.')
      } else {
        setError(null)
      }
      await refresh()
    } catch {
      setError('Indítás sikertelen.')
    } finally {
      setStartingId(null)
    }
  }

  const openRun = (run: ActiveRun) => {
    if (run.phase === 'completed') {
      markRunSeen(run)
    }
    router.push(run.href)
  }

  const chips = useMemo(() => runsSummaryChips(summarizeRuns(runs)), [runs])
  const visible = expanded ? runs : runs.slice(0, COLLAPSED_LIMIT)
  const hiddenCount = runs.length - visible.length
  const groups = useMemo(() => groupByDay(visible), [visible])

  if (runs.length === 0) {
    return (
      <p className="text-sm text-ink-faint">
        Most nincs futó ügyed. Ha elindítasz egy chatet vagy feladatot, itt látod majd a haladását.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      {chips.length > 0 && <RunsSummaryChips chips={chips} />}

      {error && (
        <p className="rounded-xl border border-coral/30 bg-coral/10 px-3 py-1.5 text-xs text-coral">
          {error}
        </p>
      )}

      <div className="-mx-2.5">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="px-2.5 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              {group.label}
            </p>
            <ul className="divide-y divide-line/50">
              {group.runs.map((run) => (
                <li key={activeRunKey(run)}>
                  <RunRow
                    run={run}
                    stopping={stoppingId === run.id}
                    starting={startingId === run.id}
                    onOpen={openRun}
                    onStop={(target) => void stopRun(target)}
                    onStart={(target) => void startRun(target)}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {(hiddenCount > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs font-semibold text-ink-faint transition-colors hover:text-coral-deep"
        >
          {expanded ? 'Kevesebb' : `További ${hiddenCount} ügy`}
        </button>
      )}
    </div>
  )
}
