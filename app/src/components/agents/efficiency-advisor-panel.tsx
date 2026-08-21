'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { applyEfficiencyHint } from '@/app/actions/efficiency-advisor'
import { Card } from '@/components/ui/shell'
import {
  describeEfficiencyCacheDataStatus,
  describeEfficiencyPattern,
  describeEfficiencyStatus,
  type EfficiencyAdvisorView,
  type EfficiencyPatternKind,
} from '@/domain/agent/efficiency-advisor'

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
      return 'Prompt-cache alig fog'
  }
}

export function EfficiencyAdvisorPanel({
  view,
  agentId,
  canApply,
}: {
  view: EfficiencyAdvisorView
  agentId: string
  canApply: boolean
}) {
  const router = useRouter()
  const [pendingKind, setPendingKind] = useState<EfficiencyPatternKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const { card, applied } = view
  const submit = (kind: 'repeated_reread' | 'context_bloat', revert: boolean) => {
    startTransition(async () => {
      setError(null)
      setPendingKind(kind)
      const res = await applyEfficiencyHint({ agentId, kind, revert })
      setPendingKind(null)
      if (res.success) router.refresh()
      else setError(res.error)
    })
  }

  return (
    <Card title="Hatékonyság">
      <p className="mb-4 text-xs text-ink-faint">
        Az utóbbi futásokból nézzük, mire megy el a token, és hol van ismétlődő pazarlás.
        Ez utólagos javaslat — a futást nem állítja le. A megtakarítás becslés.
      </p>

      <p className="text-sm text-ink-soft">{describeEfficiencyStatus(card.status)}</p>

      {card.status === 'insufficient_data' ? (
        <p className="mt-2 text-xs text-ink-faint">
          Elemezhető futás: {card.analyzableRuns}. Legalább három kell a megbízható mintához.
        </p>
      ) : (
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
                  ? 'nincs adat'
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
      )}

      {card.coarseOnly ? (
        <p className="mt-3 text-xs text-ink-faint">
          A régebbi hívásokhoz nincs forduló-kötés, ezért a bontás durvább (beszélgetés/ticket szintű).
        </p>
      ) : null}

      <ul className="mt-4 space-y-3">
        {card.patterns.map((pattern) => {
          const isApplied = Boolean(applied[pattern.kind])
          const canToggle =
            canApply &&
            pattern.suggestion.applicable &&
            (pattern.kind === 'repeated_reread' || pattern.kind === 'context_bloat')
          return (
            <li key={pattern.kind} className="rounded-lg border border-line bg-night-2 px-3 py-3">
              <p className="text-sm font-medium text-ink">{patternTitle(pattern.kind)}</p>
              <p className="mt-1 text-sm text-ink-soft">
                {describeEfficiencyPattern(pattern.kind, pattern.metric)}
              </p>
              {pattern.savingsTokens ? (
                <p className="mt-2 text-xs text-ink-faint">
                  Becsült megtakarítás: {formatTokens(pattern.savingsTokens.low)}–
                  {formatTokens(pattern.savingsTokens.high)} token
                  {pattern.savingsTokens.costHigh > 0
                    ? ` (~${formatCostEur(pattern.savingsTokens.costLow)}–${formatCostEur(pattern.savingsTokens.costHigh)})`
                    : ''}
                  .
                </p>
              ) : null}
              {typeof pattern.metric.toolName === 'string' && pattern.metric.toolName ? (
                <p className="mt-1 text-xs text-ink-faint">Eszköz: {pattern.metric.toolName}</p>
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
                  Itt nincs kapcsoló — a prompt-cache specet kell megnézni.
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

      {error ? <p className="mt-3 text-sm text-coral">{error}</p> : null}
    </Card>
  )
}
