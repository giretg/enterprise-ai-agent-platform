'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { suggestHireDraftAction } from '@/app/actions/tenant-agent-settings'
import { Spinner } from '@/components/ui/spinner'
import type { HireDraftFailure } from '@/domain/agent-hire-draft'
import { asTranslate } from '@/i18n/translate'
import { agentDisplayName } from '@/lib/agent-persona'
import { HIRE_SAMPLES, matchHireSample, type HireDraft, type HireLocale, type HireSample } from '@/lib/agent-hire'

export type HireStartPath = 'describe' | 'sample' | 'clone' | 'blank'

const PATH_ICON: Record<HireStartPath, string> = {
  describe: '💡',
  sample: '🗂️',
  clone: '👯',
  blank: '📝',
}

const INPUT = 'mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm'

/**
 * 0. lépés: négy út kártyákon (#957). A „Mondd el” a céges alapmodellel ír
 * vázlatot (D1, napi keretből); ha nem sikerül, a hozzá illő mintát és az üres
 * lapot ajánlja magyarázattal.
 */
export function StartPaths({
  locale,
  path,
  onPathChange,
  describeText,
  onDescribeTextChange,
  hireDraftQuota,
  onDescribeDraft,
  onSample,
  cloneableAgents,
  cloneSourceId,
  onCloneSource,
  cloneLoading,
  cloneLoadedName,
  onBlank,
}: {
  locale: HireLocale
  path: HireStartPath | null
  onPathChange: (path: HireStartPath) => void
  describeText: string
  onDescribeTextChange: (text: string) => void
  /** Ma még kérhető javaslatok; null = nem sikerült lekérdezni (a szerver úgyis ellenőriz). */
  hireDraftQuota: { limit: number; remaining: number } | null
  onDescribeDraft: (draft: HireDraft) => void
  onSample: (sample: HireSample) => void
  cloneableAgents: Array<{ id: string; name: string }>
  cloneSourceId: string
  onCloneSource: (id: string) => void
  cloneLoading: boolean
  cloneLoadedName: string | null
  onBlank: () => void
}) {
  const t = asTranslate(useTranslations('AgentCreate'))
  const [touched, setTouched] = useState(false)
  const [drafting, startDrafting] = useTransition()
  const [failure, setFailure] = useState<HireDraftFailure | 'error' | null>(null)
  const [remaining, setRemaining] = useState(hireDraftQuota?.remaining ?? null)
  const paths: HireStartPath[] = ['describe', 'sample', 'clone', 'blank']
  const aiUnavailable = remaining === 0
  const unavailableReason: HireDraftFailure = hireDraftQuota?.limit === 0 ? 'disabled' : 'budget_exhausted'
  const fallbackSample = failure || aiUnavailable ? matchHireSample(describeText) : null

  function describe() {
    startDrafting(async () => {
      setFailure(null)
      const res = await suggestHireDraftAction({ description: describeText, locale })
      if (!res.success) {
        setFailure('error')
        return
      }
      setRemaining(res.data.remaining)
      if (res.data.ok) onDescribeDraft(res.data.draft)
      else setFailure(res.data.reason)
    })
  }

  return (
    <div className="space-y-4">
      <ul className="grid gap-3 sm:grid-cols-2">
        {paths.map((option) => {
          const active = path === option
          const disabled = option === 'clone' && cloneableAgents.length === 0
          return (
            <li key={option}>
              <button
                type="button"
                aria-pressed={active}
                disabled={disabled}
                onClick={() => (option === 'blank' ? onBlank() : onPathChange(option))}
                className={`h-full w-full rounded-xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  active ? 'border-coral/50 bg-coral/8' : 'border-ink/12 bg-paper hover:border-coral/30'
                }`}
              >
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <span aria-hidden className="text-lg">{PATH_ICON[option]}</span>
                  {t(`start.${option}.title`)}
                  {option === 'describe' ? (
                    <span className="rounded-full bg-coral/15 px-2 py-0.5 text-[10px] font-semibold text-coral-deep">
                      {t('start.recommended')}
                    </span>
                  ) : null}
                </span>
                <span className="mt-1 block text-xs text-ink-soft">{t(`start.${option}.body`)}</span>
              </button>
            </li>
          )
        })}
      </ul>

      {path === 'describe' ? (
        <div className="animate-hire-pop space-y-2 rounded-xl border border-ink/12 bg-paper px-4 py-3">
          <label className="block text-sm">
            <span className="text-ink-soft">{t('start.describe.label')}</span>
            <textarea
              value={describeText}
              onChange={(event) => onDescribeTextChange(event.target.value)}
              onBlur={() => setTouched(true)}
              rows={3}
              maxLength={1000}
              className={INPUT}
              placeholder={t('start.describe.placeholder')}
            />
          </label>
          <p className="text-xs text-ink-faint">{t('start.describe.hint')}</p>
          {touched && !describeText.trim() ? (
            <p className="text-xs text-coral">{t('start.describe.required')}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!describeText.trim() || drafting || aiUnavailable}
              onClick={describe}
              className="inline-flex items-center gap-2 rounded-full bg-coral px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {drafting ? <Spinner size="sm" /> : null}
              {drafting ? t('start.describe.drafting') : t('start.describe.cta')}
            </button>
            {remaining !== null && remaining > 0 && remaining <= 5 ? (
              <span className="text-xs text-ink-faint">{t('start.describe.remaining', { count: remaining })}</span>
            ) : null}
          </div>
          {failure || aiUnavailable ? (
            <div className="space-y-2 rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-xs text-ink">
              <p>{t(`start.describe.failure.${failure && failure !== 'empty' ? failure : unavailableReason}`)}</p>
              <div className="flex flex-wrap gap-2">
                {fallbackSample ? (
                  <button
                    type="button"
                    onClick={() => onSample(fallbackSample)}
                    className="rounded-full border border-line bg-paper px-3 py-1 font-semibold text-ink hover:border-coral/40"
                  >
                    {t('start.describe.useSample', { name: fallbackSample.name[locale] })}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => onPathChange('sample')}
                  className="rounded-full border border-line bg-paper px-3 py-1 font-semibold text-ink hover:border-coral/40"
                >
                  {t('start.describe.browseSamples')}
                </button>
                <button
                  type="button"
                  onClick={onBlank}
                  className="rounded-full border border-line bg-paper px-3 py-1 font-semibold text-ink hover:border-coral/40"
                >
                  {t('start.describe.blank')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {path === 'sample' ? (
        <ul className="animate-hire-pop grid gap-3 sm:grid-cols-2">
          {HIRE_SAMPLES.map((sample) => (
            <li key={sample.id}>
              <button
                type="button"
                onClick={() => onSample(sample)}
                className="h-full w-full rounded-xl border border-ink/12 bg-paper px-4 py-3 text-left hover:border-coral/40"
              >
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <span aria-hidden className="text-lg">{sample.emoji}</span>
                  {sample.name[locale]}
                </span>
                <span className="mt-1 block text-xs text-ink-soft">{sample.description[locale]}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {path === 'clone' ? (
        <div className="animate-hire-pop space-y-2 rounded-xl border border-ink/12 bg-paper px-4 py-3">
          <label className="block text-sm">
            <span className="text-ink-soft">{t('start.clone.select')}</span>
            <select
              value={cloneSourceId}
              onChange={(event) => onCloneSource(event.target.value)}
              disabled={cloneLoading}
              className={INPUT}
            >
              <option value="">{t('start.clone.none')}</option>
              {cloneableAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agentDisplayName(agent.name)}
                </option>
              ))}
            </select>
          </label>
          {cloneLoading ? (
            <p className="inline-flex items-center gap-2 text-xs text-ink-soft">
              <Spinner size="sm" />
              {t('start.clone.loading')}
            </p>
          ) : null}
          {cloneLoadedName ? (
            <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-ink">
              <span className="font-semibold text-sage">{t('start.clone.loaded', { name: cloneLoadedName })}</span>
              <span className="mt-1 block text-ink-soft">{t('start.clone.copied')}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
