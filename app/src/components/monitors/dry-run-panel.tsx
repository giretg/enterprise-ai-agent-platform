'use client'

import { useState, useTransition } from 'react'
import { dryRunMonitor } from '@/app/actions/monitor'

type DryRunSignal = {
  signal: {
    title: string
    severity: number
    dueBy?: string | null
    dedupKeyParts: Record<string, string>
  }
  filterResult: { matched: boolean; reason: string }
  cooldownStatus: 'would_escalate' | 'suppressed' | 'new'
}

type DryRunResult = {
  signals: DryRunSignal[]
  summary: { total: number; wouldEscalate: number; suppressed: number; filtered: number }
}

export function DryRunPanel({ monitorId }: { monitorId: string }) {
  const [result, setResult] = useState<DryRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function run() {
    setResult(null)
    setError(null)
    startTransition(async () => {
      const res = await dryRunMonitor({ id: monitorId })
      if (res.success) {
        setResult(res.data as DryRunResult)
      } else {
        setError(res.error)
      }
    })
  }

  const cooldownBadge: Record<string, string> = {
    would_escalate: 'bg-amber-500/15 text-amber-400',
    suppressed: 'bg-blue-500/15 text-blue-400',
    new: 'bg-emerald-500/15 text-emerald-400',
  }
  const cooldownLabel: Record<string, string> = {
    would_escalate: 'Eszkalálná',
    suppressed: 'Cooldown (elnyomná)',
    new: 'Első jelzés',
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={run}
          className="rounded-lg border border-accent/50 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/10 disabled:opacity-40"
        >
          {pending ? 'Futás...' : '▶ Próba-futás (dry-run)'}
        </button>
        <p className="text-xs text-ink-soft">
          Lefuttatja az 1. lépcsőt és a szűrőt — ticket és LLM nélkül.
        </p>
      </div>

      {error ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-4 rounded-lg border border-line/40 bg-panel/60 p-4">
            <div className="text-center">
              <p className="text-2xl font-semibold">{result.summary.total}</p>
              <p className="text-xs text-ink-soft">Összesen gyűjtött jel</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-semibold text-amber-400">{result.summary.wouldEscalate}</p>
              <p className="text-xs text-ink-soft">Eszkalálna</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-semibold text-blue-400">{result.summary.suppressed}</p>
              <p className="text-xs text-ink-soft">Cooldown (elnyomna)</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-semibold text-ink-soft">{result.summary.filtered}</p>
              <p className="text-xs text-ink-soft">Szűrő kizárta</p>
            </div>
          </div>

          {result.signals.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-line/60">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line/40 bg-panel/60">
                    <th className="px-4 py-2 text-left font-medium text-ink-soft">Jel</th>
                    <th className="px-4 py-2 text-center font-medium text-ink-soft">Súlyosság</th>
                    <th className="px-4 py-2 text-left font-medium text-ink-soft">Szűrő döntés</th>
                    <th className="px-4 py-2 text-left font-medium text-ink-soft">Cooldown</th>
                  </tr>
                </thead>
                <tbody>
                  {result.signals.map((s, i) => (
                    <tr key={i} className="border-b border-line/30 last:border-0">
                      <td className="px-4 py-2">{s.signal.title}</td>
                      <td className="px-4 py-2 text-center text-ink-soft">{s.signal.severity}</td>
                      <td className="px-4 py-2">
                        <span
                          className={`inline-flex rounded px-2 py-0.5 text-xs ${
                            s.filterResult.matched
                              ? 'bg-emerald-500/15 text-emerald-400'
                              : 'bg-slate-500/15 text-slate-400'
                          }`}
                          title={s.filterResult.reason}
                        >
                          {s.filterResult.matched ? 'Átment' : 'Kiszűrve'}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        {s.filterResult.matched ? (
                          <span
                            className={`inline-flex rounded px-2 py-0.5 text-xs ${cooldownBadge[s.cooldownStatus] ?? ''}`}
                          >
                            {cooldownLabel[s.cooldownStatus] ?? s.cooldownStatus}
                          </span>
                        ) : (
                          <span className="text-xs text-ink-soft">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="py-4 text-center text-sm text-ink-soft">
              A collector nem talált egyetlen jelet sem.
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}
