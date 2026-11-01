'use client'

import { useTranslations } from 'next-intl'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { asTranslate } from '@/i18n/translate'
import type { AutonomyLevel } from '@/lib/agent-autonomy'
import type { HireReadinessItem } from '@/lib/agent-hire'
import type { CreateAgentWizardStepId } from '@/lib/create-agent-wizard'

export type HireCardModel = {
  name: string
  description: string
  avatarUrl: string | null
  status: string
  dutyCount: number
  toolCount: number
  connectorCount: number
  skillCount: number
  knowledgeCount: number
  autonomy: AutonomyLevel | 'custom' | null
  live: boolean
}

/**
 * Élő munkatárs-kártya (#957 WP-4): lépésenként töltődik, és a felkészültség-
 * mérő kattintható hiányokkal mutatja, mi van még hátra. Nem blokkol.
 */
export function HireCard({
  model,
  percent,
  missing,
  onGoTo,
  canGoTo,
  compact = false,
}: {
  model: HireCardModel
  percent: number
  missing: HireReadinessItem[]
  onGoTo: (step: CreateAgentWizardStepId) => void
  canGoTo: (step: CreateAgentWizardStepId) => boolean
  compact?: boolean
}) {
  const t = asTranslate(useTranslations('AgentCreate'))
  const name = model.name.trim() || t('card.unnamed')
  const badges = [
    model.dutyCount > 0 ? t('card.duties', { count: model.dutyCount }) : null,
    model.toolCount + model.connectorCount > 0
      ? t('card.access', { count: model.toolCount + model.connectorCount })
      : null,
    model.skillCount > 0 ? t('card.methods', { count: model.skillCount }) : null,
    model.knowledgeCount > 0 ? t('card.knowledge', { count: model.knowledgeCount }) : null,
    model.autonomy ? t(`autonomy.levels.${model.autonomy}.short`) : null,
  ].filter((badge): badge is string => Boolean(badge))

  return (
    <div className="space-y-4 rounded-2xl border border-ink/12 bg-paper p-4 shadow-[0_10px_28px_-22px_rgba(11,11,12,0.55)]">
      <div className="flex items-center gap-3">
        <AgentAvatar
          name={model.name || '?'}
          status={model.live ? 'active' : 'draft'}
          avatarUrl={model.avatarUrl}
          size={compact ? 'sm' : 'md'}
        />
        <div className="min-w-0">
          <p className="truncate font-display text-base font-semibold">{name}</p>
          <p className="text-xs text-ink-soft">
            {model.live ? t('card.statusLive') : t('card.statusNotYet')}
          </p>
        </div>
      </div>
      {model.description.trim() && !compact ? (
        <p className="line-clamp-3 text-xs text-ink">{model.description}</p>
      ) : null}
      {badges.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {badges.map((badge) => (
            <li
              key={badge}
              className="animate-hire-pop rounded-full border border-sage/35 bg-sage/10 px-2 py-0.5 text-[11px] font-semibold text-sage"
            >
              {badge}
            </li>
          ))}
        </ul>
      ) : null}

      <div>
        <div className="flex items-baseline justify-between text-xs">
          <span className="font-semibold text-ink">{t('readiness.title')}</span>
          <span className="font-semibold text-ink">{percent}%</span>
        </div>
        <div
          className="mt-1.5 h-2 overflow-hidden rounded-full bg-wash"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={t('readiness.title')}
        >
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${percent >= 100 ? 'bg-sage' : 'bg-coral'}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        {missing.length > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {missing.slice(0, compact ? 2 : 6).map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={!canGoTo(item.step)}
                  onClick={() => onGoTo(item.step)}
                  className="w-full rounded-md px-2 py-1 text-left text-xs text-ink-soft hover:bg-coral/8 hover:text-ink disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span aria-hidden className="mr-1">{item.required ? '●' : '○'}</span>
                  {t(`readiness.missing.${item.id}`)}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs font-semibold text-sage">{t('readiness.complete')}</p>
        )}
      </div>
    </div>
  )
}
