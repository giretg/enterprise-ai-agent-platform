'use client'

const OUTCOME_CONFIG: Record<
  string,
  { label: string; badge: string }
> = {
  quiet: { label: 'Csendes', badge: 'bg-slate-500/15 text-slate-400' },
  escalated: { label: 'Eszkalált', badge: 'bg-amber-500/15 text-amber-400' },
  suppressed: { label: 'Elnyomva', badge: 'bg-blue-500/15 text-blue-400' },
  skipped: { label: 'Kihagyva', badge: 'bg-slate-500/15 text-slate-400' },
  error: { label: 'Hiba', badge: 'bg-red-500/15 text-red-400' },
}

export type MonitorRunView = {
  id: string
  outcome: string
  startedAt: string
  finishedAt: string | null
  scheduledFor: string
  signalCount: number
  matchedCount: number
  suppressedCount: number
  openedTicketIds: string[]
  llmInvoked: boolean
  costUsd: string | null
  error: string | null
}

export function MonitorRunLog({ runs }: { runs: MonitorRunView[] }) {
  if (runs.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-ink-soft">Még nincs futásnapló-bejegyzés.</p>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line/60">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line/40 bg-panel/60">
            <th className="px-4 py-3 text-left font-medium text-ink-soft">Indítva</th>
            <th className="px-4 py-3 text-left font-medium text-ink-soft">Kimenet</th>
            <th className="px-4 py-3 text-center font-medium text-ink-soft">Jelek</th>
            <th className="px-4 py-3 text-center font-medium text-ink-soft">Egyezés</th>
            <th className="px-4 py-3 text-center font-medium text-ink-soft">Elnyomva</th>
            <th className="px-4 py-3 text-center font-medium text-ink-soft">Ticket</th>
            <th className="px-4 py-3 text-right font-medium text-ink-soft">Költség</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const cfg = OUTCOME_CONFIG[run.outcome] ?? { label: run.outcome, badge: '' }
            return (
              <tr key={run.id} className="border-b border-line/30 last:border-0">
                <td className="px-4 py-3 text-ink-soft">
                  {new Date(run.startedAt).toLocaleString('hu-HU')}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${cfg.badge}`}>
                    {cfg.label}
                  </span>
                  {run.llmInvoked && (
                    <span className="ml-1 inline-flex rounded bg-accent/10 px-1 py-0.5 text-xs text-accent">
                      LLM
                    </span>
                  )}
                  {run.error ? (
                    <span
                      className="ml-1 cursor-help text-red-400"
                      title={run.error}
                    >
                      ⚠
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-center text-ink-soft">{run.signalCount}</td>
                <td className="px-4 py-3 text-center text-ink-soft">{run.matchedCount}</td>
                <td className="px-4 py-3 text-center text-ink-soft">{run.suppressedCount}</td>
                <td className="px-4 py-3 text-center text-ink-soft">{run.openedTicketIds.length}</td>
                <td className="px-4 py-3 text-right text-ink-soft">
                  {run.costUsd ? `$${Number(run.costUsd).toFixed(4)}` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
