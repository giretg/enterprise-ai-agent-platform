import { Card } from '@/components/ui/shell'
import type { getContractObservabilityDashboard } from '@/app/actions/platform'

type Dashboard = Awaited<ReturnType<typeof getContractObservabilityDashboard>>
type DashboardData = Extract<Dashboard, { success: true }>['data']

function StatBox({
  label,
  value,
  hint,
}: {
  label: string
  value: string | number
  hint?: string
}) {
  return (
    <div className="rounded-lg border border-line/60 bg-panel/40 p-3 text-center">
      <p className="text-xs text-ink-faint">{label}</p>
      <p className="mt-1 text-lg font-semibold text-ink">{value}</p>
      {hint ? <p className="mt-1 text-[11px] leading-snug text-ink-soft">{hint}</p> : null}
    </div>
  )
}

function pct(rate: number | null): string {
  if (rate == null) return '—'
  return `${Math.round(rate * 100)}%`
}

export function ContractObservabilityPanel({ data }: { data: DashboardData }) {
  const {
    sinceHours,
    totalEvaluations,
    firstPassCount,
    repairedCount,
    failedCount,
    firstPassRate,
    repairRate,
    repairCostEstimate,
    stepReasonBreakdown,
    outcomeLabels,
  } = data

  return (
    <Card title="Strukturált kimenet — megfigyelhetőség">
      <div className="space-y-6">
        <p className="text-xs text-ink-soft">
          Utolsó {sinceHours >= 24 ? `${Math.round(sinceHours / 24)} nap` : `${sinceHours} óra`}{' '}
          — mennyire sikerül az agent lépéseinek a várt formátumot (JSON mezők, kötelező kulcsok)
          elsőre kiadnia.
          <br />
          <span className="mt-1 block">
            Példa: egy lépés „összeg” és „deviza” mezőt vár. Ha a modell helyesen adja vissza →
            elsőre siker. Ha rossz a szerkezet, a rendszer automatikusan javít (ez költség) — ha
            az sem elég, emberi felülvizsgálatra kerül a folyamat.
          </span>
        </p>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Kimeneti szerkezet értékelései
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatBox
              label={outcomeLabels.first_pass.label}
              value={totalEvaluations > 0 ? pct(firstPassRate) : '—'}
              hint={`${firstPassCount} / ${totalEvaluations || 0} · ${outcomeLabels.first_pass.hint}`}
            />
            <StatBox
              label="Javítási arány"
              value={totalEvaluations > 0 ? pct(repairRate) : '—'}
              hint={`${repairedCount} javított · ${outcomeLabels.repaired.hint}`}
            />
            <StatBox
              label="Javítás modellköltsége"
              value={
                repairCostEstimate > 0
                  ? `${repairCostEstimate.toFixed(4)} €`
                  : totalEvaluations > 0
                    ? '0 €'
                    : '—'
              }
              hint="Az automatikus formázó javító hívások becsült költsége."
            />
            <StatBox
              label={outcomeLabels.failed.label}
              value={failedCount}
              hint={outcomeLabels.failed.hint}
            />
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Emberi felülvizsgálat — lépés és ok
          </p>
          {stepReasonBreakdown.length === 0 ? (
            <p className="text-xs text-ink-faint">
              Ebben az időszakban nem került folyamat emberi kapura hiányzó vagy hibás kimeneti mező
              miatt.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-ink-faint">
                    <th className="pb-1 pr-4">Lépés</th>
                    <th className="pb-1 pr-4">Ok</th>
                    <th className="pb-1">Darab</th>
                  </tr>
                </thead>
                <tbody>
                  {stepReasonBreakdown.slice(0, 15).map((row) => (
                    <tr
                      key={`${row.stepId}:${row.reasonCode}`}
                      className="border-t border-line/30"
                    >
                      <td className="py-1 pr-4 font-mono text-ink-faint">{row.stepId}</td>
                      <td className="py-1 pr-4 text-ink">{row.reasonLabel}</td>
                      <td className="py-1 text-ink">{row.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}
