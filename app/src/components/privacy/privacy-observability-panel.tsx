'use client'

import { useMemo, useState } from 'react'
import { Card } from '@/components/ui/shell'
import { PrivacyHighlightedText } from '@/components/privacy/privacy-highlighted-text'
import type { PrivacyTurnChain } from '@/domain/privacy/privacy-observability'
import {
  PRIVACY_OBSERVABILITY_ADMIN_HINT,
  PRIVACY_OBSERVABILITY_EMPTY,
  PRIVACY_OBSERVABILITY_INTRO,
} from '@/domain/privacy/privacy-observability-copy'

export function PrivacyObservabilityPanel({
  chain,
  showAdminDetails = false,
}: {
  chain: PrivacyTurnChain | null
  showAdminDetails?: boolean
}) {
  const [activeStageId, setActiveStageId] = useState<string>('original')
  const activeStage = useMemo(() => {
    if (!chain) return null
    return chain.stages.find((stage) => stage.id === activeStageId) ?? chain.stages[0] ?? null
  }, [activeStageId, chain])

  if (!chain || chain.empty) {
    return (
      <Card title="Adatvédelem — nyomkövetés">
        <div className="space-y-3">
          <p className="text-sm font-medium text-ink">{PRIVACY_OBSERVABILITY_EMPTY.title}</p>
          <p className="text-sm leading-relaxed text-ink-soft">{PRIVACY_OBSERVABILITY_EMPTY.body}</p>
        </div>
      </Card>
    )
  }

  return (
    <Card title="Adatvédelem — nyomkövetés">
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-ink-soft">{PRIVACY_OBSERVABILITY_INTRO}</p>
        {showAdminDetails ? (
          <p className="rounded-lg border border-line bg-night-2 px-3 py-2 text-xs leading-relaxed text-ink-faint">
            {PRIVACY_OBSERVABILITY_ADMIN_HINT}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {chain.stages.map((stage) => (
            <button
              key={stage.id}
              type="button"
              onClick={() => setActiveStageId(stage.id)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                activeStage?.id === stage.id
                  ? 'bg-coral/15 text-coral-deep'
                  : 'border border-line text-ink-soft hover:bg-night-2'
              }`}
            >
              {stage.label}
            </button>
          ))}
        </div>

        {activeStage?.summary ? (
          <p className="rounded-lg border border-honey/35 bg-honey/10 px-3 py-2 text-xs leading-relaxed text-ink-soft">
            {activeStage.summary}
          </p>
        ) : null}

        <div className="rounded-lg border border-line bg-night-2 px-3 py-3">
          {activeStage?.text ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink">
              <PrivacyHighlightedText
                text={activeStage.text}
                markers={activeStage.markers}
                showAdminAlias={showAdminDetails}
              />
            </pre>
          ) : (
            <p className="text-sm text-ink-faint">Ehhez a lépéshez még nincs szöveg.</p>
          )}
        </div>

        <p className="text-[11px] text-ink-faint">
          {chain.markerCount > 0
            ? `${chain.markerCount} védendő adat kiemelve — vigye fölé az egeret a részletekért.`
            : 'Nem találtunk védendő adatot ebben a fordulóban.'}
        </p>
      </div>
    </Card>
  )
}
