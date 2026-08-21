'use client'

import { useState, useTransition } from 'react'
import {
  applyEfficiencyHint,
  getEfficiencyAdvisorCard,
} from '@/app/actions/efficiency-advisor'
import { Card } from '@/components/ui/shell'
import {
  describeEfficiencyCacheDataStatus,
  describeEfficiencyPattern,
  describeEfficiencyStatus,
  EFFICIENCY_ADVISOR_DEFAULT_RANGE,
  EFFICIENCY_ADVISOR_RANGE_LABELS,
  type EfficiencyAdvisorRange,
  type EfficiencyAdvisorView,
  type EfficiencyPattern,
  type EfficiencyPatternKind,
} from '@/domain/agent/efficiency-advisor'
import { formatToolUiName } from '@/lib/tool-ui-labels'

function formatTokens(n: number): string {
  return Math.round(n).toLocaleString('hu-HU')
}

/** A `costEstimate` EUR-ban van (model-gateway); arányos megtakarítás, nem új tarifa. */
function formatCostEur(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 €'
  if (n < 0.01) return `${n.toFixed(4)} €`
  return `${n.toLocaleString('hu-HU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
}

function patternTitle(kind: EfficiencyPatternKind): string {
  switch (kind) {
    case 'repeated_reread':
      return 'Ismétlődő visszaolvasás'
    case 'context_bloat':
      return 'Kontextus-hízás'
    case 'oversized_tool_result':
      return 'Túlméretezett eszköz-kimenet'
    case 'cache_prefix_break':
      return 'A gyorsítótár alig fog'
  }
}

/** Csak számok, eszköznevek, darabszámok — tartalom soha (EFF-10 DoD). */
function patternMetricLines(pattern: EfficiencyPattern): string[] {
  const m = pattern.metric
  const lines: string[] = []
  if (typeof m.toolName === 'string' && m.toolName) {
    lines.push(`Eszköz: ${formatToolUiName(m.toolName)}`)
  }
  if (typeof m.rereadCalls === 'number' && typeof m.readCalls === 'number') {
    lines.push(`Újraolvasás: ${m.rereadCalls} / ${m.readCalls} olvasás`)
  }
  if (typeof m.modelCalls === 'number') {
    lines.push(`Modellhívás: ${formatTokens(m.modelCalls)}`)
  }
  if (typeof m.repeats === 'number') {
    lines.push(`Ismétlés: ${formatTokens(m.repeats)} alkalom`)
  }
  if (typeof m.cacheCalls === 'number') {
    lines.push(`Cache-adatú hívás: ${formatTokens(m.cacheCalls)}`)
  }
  if (typeof m.hitRatio === 'number') {
    lines.push(`Cache-találat: ${Math.round(m.hitRatio * 100)}%`)
  }
  if (typeof m.rereadRatio === 'number') {
    lines.push(`Újraolvasási arány: ${Math.round(m.rereadRatio * 100)}%`)
  }
  if (typeof m.repeatedShare === 'number') {
    lines.push(`Ismételt kontextus aránya: ${Math.round(m.repeatedShare * 100)}%`)
  }
  return lines
}

function SavingsBar({
  low,
  high,
  total,
}: {
  low: number
  high: number
  total: number
}) {
  const denom = Math.max(total, high, 1)
  const lowPct = Math.min(100, Math.round((low / denom) * 100))
  const highPct = Math.min(100, Math.round((high / denom) * 100))
  return (
    <div className="mt-2">
      <p className="text-xs text-ink-faint">
        Becsült megtakarítás: {formatTokens(low)}–{formatTokens(high)} token (becslés).
      </p>
      <div
        className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-ink/10"
        role="img"
        aria-label={`Megtakarítás-sáv: ${formatTokens(low)}–${formatTokens(high)} token a ${formatTokens(total)}-ból`}
      >
        <div className="relative h-full w-full">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-sky/35"
            style={{ width: `${highPct}%` }}
          />
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-sky/70"
            style={{ width: `${lowPct}%` }}
          />
        </div>
      </div>
    </div>
  )
}

function StatusBanner({
  status,
  analyzableRuns,
}: {
  status: EfficiencyAdvisorView['card']['status']
  analyzableRuns: number
}) {
  const tone =
    status === 'ok'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-ink'
      : status === 'findings'
        ? 'border-coral/30 bg-coral/10 text-ink'
        : 'border-line bg-night-2 text-ink-soft'

  return (
    <div className={`rounded-lg border px-3 py-2.5 text-sm ${tone}`}>
      <p className="font-medium">{describeEfficiencyStatus(status)}</p>
      {status === 'insufficient_data' ? (
        <p className="mt-1 text-xs text-ink-faint">
          Elemezhető futás ebben az ablakban: {analyzableRuns}. Legalább három kell a
          megbízható mintához — ez nem hiba, csak még nincs elég mérés.
        </p>
      ) : null}
      {status === 'ok' ? (
        <p className="mt-1 text-xs text-ink-faint">
          Elemezhető futás: {analyzableRuns}. Nincs ismétlődő pazarló minta.
        </p>
      ) : null}
    </div>
  )
}

function TokenBreakdown({ view }: { view: EfficiencyAdvisorView }) {
  const { card } = view
  if (card.status === 'insufficient_data' && card.breakdown.total <= 0) return null

  return (
    <>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-ink-faint">Belépő kontextus</dt>
          <dd className="font-medium text-ink">{formatTokens(card.breakdown.entryContext)} token</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Ismételt kontextus</dt>
          <dd className="font-medium text-ink">{formatTokens(card.breakdown.repeatedContext)} token</dd>
          {card.breakdown.rereadTokensAnnotation > 0 ? (
            <p className="text-xs text-ink-faint">
              ebből ~{formatTokens(card.breakdown.rereadTokensAnnotation)} újraolvasás (becslés)
            </p>
          ) : null}
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Válasz</dt>
          <dd className="font-medium text-ink">{formatTokens(card.breakdown.completion)} token</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Cache-ből (ebből)</dt>
          <dd className="font-medium text-ink">
            {card.cacheDataStatus === 'missing'
              ? 'nincs adat a szolgáltatótól'
              : `${formatTokens(card.breakdown.cached)} token`}
          </dd>
          {card.cacheDataStatus === 'missing' || card.cacheDataStatus === 'mixed' ? (
            <p className="text-xs text-ink-faint">
              {describeEfficiencyCacheDataStatus(card.cacheDataStatus)}
            </p>
          ) : null}
        </div>
      </dl>
      {card.breakdown.costEstimate > 0 ? (
        <p className="mt-2 text-xs text-ink-faint">
          Ablakbeli költség (costEstimate): {formatCostEur(card.breakdown.costEstimate)}
        </p>
      ) : null}
    </>
  )
}

export function EfficiencyAdvisorPanel({
  view: initialView,
  agentId,
  canApply,
}: {
  view: EfficiencyAdvisorView
  agentId: string
  canApply: boolean
}) {
  const [view, setView] = useState(initialView)
  const [range, setRange] = useState<EfficiencyAdvisorRange>(
    initialView.range ?? EFFICIENCY_ADVISOR_DEFAULT_RANGE,
  )
  const [pendingKind, setPendingKind] = useState<EfficiencyPatternKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const { card, applied } = view

  const switchRange = (next: EfficiencyAdvisorRange) => {
    if (next === range && !pending) return
    setRange(next)
    setError(null)
    startTransition(async () => {
      const res = await getEfficiencyAdvisorCard({ agentId, range: next })
      if (res.success) setView(res.data)
      else setError(res.error)
    })
  }

  const submit = (kind: 'repeated_reread' | 'context_bloat', revert: boolean) => {
    startTransition(async () => {
      setError(null)
      setPendingKind(kind)
      const res = await applyEfficiencyHint({ agentId, kind, revert })
      setPendingKind(null)
      if (!res.success) {
        setError(res.error)
        return
      }
      const refreshed = await getEfficiencyAdvisorCard({ agentId, range })
      if (refreshed.success) setView(refreshed.data)
      else setError(refreshed.error)
    })
  }

  const ranges = Object.keys(EFFICIENCY_ADVISOR_RANGE_LABELS) as EfficiencyAdvisorRange[]

  return (
    <Card title="Hatékonyság">
      <p className="mb-4 text-xs text-ink-faint">
        Az utóbbi futásokból nézzük, mire megy el a token, és hol van ismétlődő pazarlás. Ez
        utólagos javaslat — a futást nem állítja le. A megtakarítás becslés. A kártya csak
        számokat és eszközneveket mutat, tartalmat soha.
      </p>

      <nav
        className="mb-4 flex flex-wrap gap-1 rounded-full bg-ink/5 p-1"
        aria-label="Időablak"
      >
        {ranges.map((r) => (
          <button
            key={r}
            type="button"
            disabled={pending}
            onClick={() => switchRange(r)}
            className={`rounded-full px-3 py-1 text-sm font-medium transition-colors disabled:opacity-50 ${
              r === range
                ? 'bg-card text-ink shadow-sm'
                : 'text-ink-faint hover:text-ink-soft'
            }`}
          >
            {EFFICIENCY_ADVISOR_RANGE_LABELS[r]}
          </button>
        ))}
      </nav>

      <StatusBanner status={card.status} analyzableRuns={card.analyzableRuns} />

      <TokenBreakdown view={view} />

      {card.coarseOnly ? (
        <p className="mt-3 text-xs text-ink-faint">
          A régebbi hívásokhoz nincs forduló-kötés, ezért a bontás durvább (beszélgetés/ticket
          szintű).
        </p>
      ) : null}

      {card.status === 'findings' ? (
        <ul className="mt-4 space-y-3">
          {card.patterns.map((pattern) => {
            const isApplied = Boolean(applied[pattern.kind])
            const canToggle =
              canApply &&
              pattern.suggestion.applicable &&
              (pattern.kind === 'repeated_reread' || pattern.kind === 'context_bloat')
            const metricLines = patternMetricLines(pattern)
            return (
              <li key={pattern.kind} className="rounded-lg border border-line bg-night-2 px-3 py-3">
                <p className="text-sm font-medium text-ink">{patternTitle(pattern.kind)}</p>
                <p className="mt-1 text-sm text-ink-soft">{describeEfficiencyPattern(pattern.kind)}</p>
                {metricLines.length > 0 ? (
                  <ul className="mt-2 space-y-0.5 text-xs text-ink-faint">
                    {metricLines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : null}
                {pattern.savingsTokens ? (
                  <SavingsBar
                    low={pattern.savingsTokens.low}
                    high={pattern.savingsTokens.high}
                    total={card.breakdown.total}
                  />
                ) : null}
                {canToggle ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      submit(pattern.kind as 'repeated_reread' | 'context_bloat', isApplied)
                    }
                    className="mt-3 rounded-md border border-line bg-panel px-3 py-1.5 text-sm text-ink hover:border-coral disabled:opacity-50"
                  >
                    {pendingKind === pattern.kind
                      ? 'Mentés…'
                      : isApplied
                        ? 'Visszavonás'
                        : 'Alkalmazom'}
                  </button>
                ) : pattern.suggestion.link === 'prompt_cache' ? (
                  <p className="mt-2 text-xs text-ink-faint">
                    Itt nincs kapcsoló — a prompt-cache beállításokat kell megnézni.
                  </p>
                ) : pattern.suggestion.link === 'tool_narrowing' ? (
                  <p className="mt-2 text-xs text-ink-faint">
                    Itt nincs kapcsoló — a hívást (végpont, mezőlista) kell szűkíteni.
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}

      {pending && !pendingKind ? (
        <p className="mt-3 text-xs text-ink-faint">Időablak frissítése…</p>
      ) : null}

      {error ? <p className="mt-3 text-sm text-coral">{error}</p> : null}
    </Card>
  )
}
