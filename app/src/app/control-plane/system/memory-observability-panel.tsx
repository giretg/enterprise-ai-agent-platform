import { Card } from '@/components/ui/shell'
import type { getMemoryObservabilityDashboard } from '@/app/actions/platform'

type Dashboard = Awaited<ReturnType<typeof getMemoryObservabilityDashboard>>
type DashboardData = Extract<Dashboard, { success: true }>['data']

const STATUS_LABELS: Record<string, string> = {
  proposed: 'javasolt',
  modified: 'módosított',
  approved: 'jóváhagyott',
  ticketed: 'ticketelt',
  rejected: 'elutasított',
}

function StatBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-line/60 bg-panel/40 p-3 text-center">
      <p className="text-xs text-ink-faint">{label}</p>
      <p className="mt-1 text-lg font-semibold text-ink">{value}</p>
    </div>
  )
}

function Sparkline({ points }: { points: { at: string; activeCount: number }[] }) {
  if (points.length === 0) return <span className="text-xs text-ink-faint">—</span>
  const max = Math.max(...points.map((p) => p.activeCount), 1)
  const width = 160
  const height = 28
  const step = points.length > 1 ? width / (points.length - 1) : 0
  const coords = points
    .map((p, i) => `${(i * step).toFixed(1)},${(height - (p.activeCount / max) * height).toFixed(1)}`)
    .join(' ')
  return (
    <svg width={width} height={height} className="text-coral">
      <polyline points={coords} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  )
}

export function MemoryObservabilityPanel({ data }: { data: DashboardData }) {
  const {
    sinceHours,
    candidatesByStatus,
    decisionThroughput,
    inlineVsTicket,
    conflicts,
    chunksActiveByProject,
    chunkTrend,
    userFeedback,
    retrieval,
  } = data

  const totalDecided = inlineVsTicket.inlineApproved + inlineVsTicket.ticketed
  const trendByProject = new Map(chunkTrend.map((t) => [t.projectKey, t.points]))

  return (
    <Card title="Memória — megfigyelhetőség (§14)">
      <div className="space-y-6">
        <p className="text-xs text-ink-soft">
          Utolsó {sinceHours >= 24 ? `${Math.round(sinceHours / 24)} nap` : `${sinceHours} óra`} — candidate-átfutás,
          jóváhagyási elágazás, memória-méret és retrieval-jelek.
        </p>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">Javaslat-átfutás</p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {candidatesByStatus.map((s) => (
              <StatBox key={s.status} label={STATUS_LABELS[s.status] ?? s.status} value={s.count} />
            ))}
            <StatBox
              label="Átlagos döntési idő"
              value={decisionThroughput.avgMinutes != null ? `${decisionThroughput.avgMinutes} perc` : '—'}
            />
            <StatBox label="Függőben" value={decisionThroughput.pendingCount} />
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Inline / ticket arány
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatBox label="Inline jóváhagyott" value={inlineVsTicket.inlineApproved} />
            <StatBox label="Ticketelt" value={inlineVsTicket.ticketed} />
            <StatBox
              label="Inline arány"
              value={totalDecided > 0 ? `${Math.round((inlineVsTicket.inlineApproved / totalDecided) * 100)}%` : '—'}
            />
            <StatBox label="Konfliktus (retrieval / publish)" value={`${conflicts.retrieval} / ${conflicts.publish}`} />
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Retrieval és user-feedback
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatBox label="Átlag token / retrieval" value={retrieval.avgTokens ?? '—'} />
            <StatBox label="Átlag latency (ms)" value={retrieval.avgLatencyMs ?? '—'} />
            <StatBox label="Minta (retrieval)" value={retrieval.sampleCount} />
            <StatBox
              label="Hasznos / javított arány"
              value={userFeedback.ratio != null ? `${Math.round(userFeedback.ratio * 100)}%` : '—'}
            />
          </div>
        </div>

        {chunksActiveByProject.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
              Memória-méret projektenként
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-ink-faint">
                    <th className="pb-1 pr-4">Projekt</th>
                    <th className="pb-1 pr-4">Aktív chunk</th>
                    <th className="pb-1">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {chunksActiveByProject.map((row) => (
                    <tr key={row.projectKey} className="border-t border-line/30">
                      <td className="py-1 pr-4 font-mono text-ink-faint">{row.projectKey}</td>
                      <td className="py-1 pr-4 text-ink">{row.count}</td>
                      <td className="py-1">
                        <Sparkline points={trendByProject.get(row.projectKey) ?? []} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
