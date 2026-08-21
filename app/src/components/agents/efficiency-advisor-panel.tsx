'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { applyEfficiencyHint } from '@/app/actions/efficiency-advisor'
import { Card } from '@/components/ui/shell'
import {
  describeEfficiencyHint,
  describeEfficiencyPattern,
  describeEfficiencyStatus,
  type EfficiencyAdvisorView,
  type EfficiencyHintKind,
  type EfficiencyPatternKind,
} from '@/domain/agent/efficiency-advisor'

function formatTokens(n: number): string {
  return Math.round(n).toLocaleString('hu-HU')
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

function linkLabel(link: 'prompt_cache' | 'tool_narrowing'): string {
  return link === 'prompt_cache' ? 'Gondolkodási motor megnyitása' : 'Kapcsolatok megnyitása'
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
  const [pendingKind, setPendingKind] = useState<EfficiencyHintKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const { card, applied } = view
  const submit = (kind: EfficiencyHintKind, revert: boolean) => {
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
            <dt className="text-xs text-ink-faint">Cache-ből</dt>
            <dd className="font-medium text-ink">
              {card.cacheDataStatus === 'missing'
                ? 'nincs adat'
                : `${formatTokens(card.breakdown.cached)} token`}
            </dd>
          </div>
        </dl>
      )}

      {card.coarseOnly ? (
        <p className="mt-3 text-xs text-ink-faint">
          A régebbi hívásokhoz nincs forduló-kötés, ezért a bontás durvább (beszélgetés/ticket szintű).
        </p>
      ) : null}

      <ul className="mt-4 space-y-3">
        {card.patterns.map((pattern) => {
          const hintKinds = pattern.suggestion.hintKinds ?? []
          return (
            <li key={pattern.kind} className="rounded-lg border border-line bg-night-2 px-3 py-3">
              <p className="text-sm font-medium text-ink">{patternTitle(pattern.kind)}</p>
              <p className="mt-1 text-sm text-ink-soft">{describeEfficiencyPattern(pattern.kind)}</p>
              {pattern.savingsTokens ? (
                <p className="mt-2 text-xs text-ink-faint">
                  Becsült megtakarítás: {formatTokens(pattern.savingsTokens.low)}–
                  {formatTokens(pattern.savingsTokens.high)} token.
                </p>
              ) : null}
              {typeof pattern.metric.toolName === 'string' && pattern.metric.toolName ? (
                <p className="mt-1 text-xs text-ink-faint">Eszköz: {pattern.metric.toolName}</p>
              ) : null}

              {canApply && pattern.suggestion.applicable && hintKinds.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {hintKinds.map((hint) => {
                    const isApplied = Boolean(applied[hint])
                    return (
                      <button
                        key={hint}
                        type="button"
                        disabled={pending}
                        onClick={() => submit(hint, isApplied)}
                        className="rounded-md border border-line bg-panel px-3 py-1.5 text-sm text-ink hover:border-coral disabled:opacity-50"
                      >
                        {pendingKind === hint
                          ? 'Mentés…'
                          : isApplied
                            ? `Visszavonás: ${describeEfficiencyHint(hint)}`
                            : `Alkalmazom: ${describeEfficiencyHint(hint)}`}
                      </button>
                    )
                  })}
                </div>
              ) : !pattern.suggestion.applicable && pattern.suggestion.href ? (
                <p className="mt-2 text-xs text-ink-faint">
                  Itt nincs kapcsoló.{' '}
                  <Link href={pattern.suggestion.href} className="underline hover:text-ink">
                    {pattern.suggestion.link
                      ? linkLabel(pattern.suggestion.link)
                      : 'Kapcsolódó felület'}
                  </Link>
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>

      {error ? <p className="mt-3 text-sm text-coral">{error}</p> : null}
      {!canApply ? (
        <p className="mt-3 text-xs text-ink-faint">
          A javaslatok alkalmazásához tenant admin jogosultság kell.
        </p>
      ) : null}
    </Card>
  )
}
