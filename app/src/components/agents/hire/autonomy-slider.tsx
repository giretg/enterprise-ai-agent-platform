'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { updateAgentWriteApprovalModes } from '@/app/actions/platform'
import { asTranslate } from '@/i18n/translate'
import {
  AUTONOMY_LEVELS,
  autonomyForWriteModes,
  autonomySliderIndex,
  writeModesForAutonomy,
  type AutonomyLevel,
} from '@/lib/agent-autonomy'
import type { AgentWriteApprovalModes } from '@/lib/write-approval-modes'

const LEVEL_ICON: Record<AutonomyLevel, string> = {
  trainee: '🌱',
  trusted: '🤝',
  autonomous: '🚀',
}

/**
 * Önállósági csúszka (#957 WP-3). A szint a négy írási módot állítja be
 * ugyanazzal a művelettel, mint az adatlap „Írások” űrlapja; a jóváhagyót nem
 * írja felül.
 */
export function AutonomySlider({
  agentId,
  modes,
  onChanged,
}: {
  agentId: string
  modes: AgentWriteApprovalModes
  onChanged: () => void
}) {
  const t = asTranslate(useTranslations('AgentCreate'))
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [optimistic, setOptimistic] = useState<AgentWriteApprovalModes | null>(null)
  const current = optimistic ?? modes
  const level = autonomyForWriteModes(current)
  const index = autonomySliderIndex(current)

  function choose(next: AutonomyLevel) {
    if (next === level) return
    const nextModes = writeModesForAutonomy(next)
    setOptimistic(nextModes)
    start(async () => {
      setError(null)
      const res = await updateAgentWriteApprovalModes({
        agentId,
        memoryWriteMode: nextModes.memory,
        httpApiWriteMode: nextModes.httpApi,
        gmailWriteMode: nextModes.gmail,
        driveWriteMode: nextModes.drive,
      })
      if (!res.success) {
        setOptimistic(null)
        setError(res.error)
        return
      }
      setOptimistic(null)
      onChanged()
    })
  }

  return (
    <div className="space-y-4">
      <div className="px-1">
        <input
          type="range"
          min={0}
          max={AUTONOMY_LEVELS.length - 1}
          step={1}
          value={index}
          disabled={pending}
          onChange={(event) => choose(AUTONOMY_LEVELS[Number(event.target.value)])}
          aria-label={t('autonomy.sliderAria')}
          aria-valuetext={t(`autonomy.levels.${AUTONOMY_LEVELS[index]}.title`)}
          className="w-full accent-coral"
        />
      </div>
      <ul className="grid gap-3 sm:grid-cols-3">
        {AUTONOMY_LEVELS.map((option) => {
          const active = level === option
          return (
            <li key={option}>
              <button
                type="button"
                disabled={pending}
                aria-pressed={active}
                onClick={() => choose(option)}
                className={`h-full w-full rounded-xl border px-3 py-3 text-left transition-colors disabled:opacity-70 ${
                  active ? 'border-coral/50 bg-coral/8' : 'border-ink/12 bg-paper hover:border-coral/30'
                }`}
              >
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <span aria-hidden>{LEVEL_ICON[option]}</span>
                  {t(`autonomy.levels.${option}.title`)}
                  {option === 'trainee' ? (
                    <span className="rounded-full bg-wash px-2 py-0.5 text-[10px] font-semibold text-ink-soft">
                      {t('autonomy.default')}
                    </span>
                  ) : null}
                </span>
                <span className="mt-1 block text-xs text-ink-soft">{t(`autonomy.levels.${option}.body`)}</span>
              </button>
            </li>
          )
        })}
      </ul>
      {level === 'custom' ? (
        <p className="rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-xs text-ink">
          {t('autonomy.custom')}
        </p>
      ) : null}
      <p className="text-xs text-ink-faint">{t('autonomy.alwaysGates')}</p>
      {pending ? <p className="text-xs text-ink-soft">{t('saving')}</p> : null}
      {error ? <p className="text-sm text-coral">{error}</p> : null}
    </div>
  )
}
