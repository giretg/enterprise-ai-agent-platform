'use client'

import { useState } from 'react'
import { asTranslate } from '@/i18n/translate'
import { useTranslations } from 'next-intl'
import {
  CONTENT_FILTER_CATEGORIES,
  CONTENT_FILTER_KEYS,
  CONTENT_FILTER_MODES,
  CONTENT_FILTER_MODE_KEY,
  contentFilterLevels,
} from '@/domain/client-policy/capabilities'
import type { DryRunResult } from '@/domain/model-gateway/content-filter'

const MODE_TONE: Record<string, string> = {
  off: 'border-line bg-card text-ink-soft',
  observe: 'border-sky-500/40 bg-sky-500/10',
  enforce: 'border-coral/50 bg-coral/10 text-coral-deep',
}

/**
 * Adatvédelmi szűrő (#747): főkapcsoló (ki / csak figyel / bekapcsolva), kategóriánkénti szint és próba.
 * A kategória-szintek csak bekapcsolt szűrőnél hatnak, ezért alapból összecsukva.
 */
export function ContentFilterSection({ id, overrides, inheritedOf, inheritLabel, onChange, allowDryRun }: {
  id: string
  overrides: Record<string, unknown>
  inheritedOf: (key: string) => string | undefined
  /** „Örökölt” vagy „Nincs további korlát” (agent-plafon). */
  inheritLabel: string
  onChange: (key: string, value: string) => void
  allowDryRun: boolean
}) {
  const t = asTranslate(useTranslations('ClientPolicy.filter'))
  const own = (key: string) => (typeof overrides[key] === 'string' ? (overrides[key] as string) : '')
  const effective = (key: string) => own(key) || inheritedOf(key)
  const mode = effective(CONTENT_FILTER_MODE_KEY)
  const [sample, setSample] = useState('')
  const [result, setResult] = useState<DryRunResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState('')

  async function tryIt() {
    setTesting(true)
    setTestError('')
    setResult(null)
    try {
      const capabilities = Object.fromEntries(CONTENT_FILTER_KEYS.flatMap((key) => (effective(key) ? [[key, effective(key)]] : [])))
      const response = await fetch('/api/client-policy/dry-run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: sample, capabilities }),
      })
      if (!response.ok) throw new Error(String(response.status))
      setResult(await response.json())
    } catch { setTestError(t('tryFailed')) }
    finally { setTesting(false) }
  }

  return (
    <section aria-labelledby={`${id}-filter-title`} className="space-y-4 rounded-2xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`${id}-filter-title`} className="font-semibold">{t('title')}</h3>
          <p className="mt-1 text-sm text-ink-soft">{t('intro')}</p>
        </div>
        {mode ? <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${MODE_TONE[mode] ?? ''}`}>{t(`modes.${mode}.title`)}</span> : null}
      </div>

      <fieldset>
        <legend className="text-sm font-semibold">{t('modeLegend')}</legend>
        <div className="mt-2 grid gap-2 md:grid-cols-3">
          {[...CONTENT_FILTER_MODES].reverse().map((value) => (
            <label key={value} className="flex cursor-pointer gap-2 rounded-xl border border-line p-3 has-checked:border-coral/60 has-checked:bg-coral/5">
              <input type="radio" name={`${id}-filter-mode`} value={value} checked={own(CONTENT_FILTER_MODE_KEY) === value}
                onChange={() => onChange(CONTENT_FILTER_MODE_KEY, value)} className="mt-1 accent-coral" />
              <span>
                <span className="block text-sm font-semibold">{t(`modes.${value}.title`)}{value === 'observe' ? <span className="ml-1 text-xs font-normal text-ink-soft">{t('recommended')}</span> : null}</span>
                <span className="mt-1 block text-xs text-ink-soft">{t(`modes.${value}.help`)}</span>
              </span>
            </label>
          ))}
        </div>
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
          <input type="radio" name={`${id}-filter-mode`} value="" checked={!own(CONTENT_FILTER_MODE_KEY)}
            onChange={() => onChange(CONTENT_FILTER_MODE_KEY, '')} className="accent-coral" />
          {inheritLabel}{inheritedOf(CONTENT_FILTER_MODE_KEY) ? `: ${t(`modes.${inheritedOf(CONTENT_FILTER_MODE_KEY)}.title`)}` : ''}
        </label>
      </fieldset>

      {mode === 'enforce' ? <p role="note" className="rounded-xl border border-coral/40 bg-coral/5 p-3 text-sm">{t('enforceWarning')}</p> : null}

      <details className="rounded-xl border border-line p-3" open={mode === 'enforce'}>
        <summary className="cursor-pointer text-sm font-semibold">{t('categoriesTitle')}</summary>
        <p className="mt-2 text-xs text-ink-soft">{t(mode === 'enforce' ? 'categoriesHelp' : 'categoriesInactive')}</p>
        <ul className="mt-3 divide-y divide-line">
          {CONTENT_FILTER_CATEGORIES.map((category) => {
            const key = `content_filter.${category}`
            const inherited = inheritedOf(key)
            const level = effective(key)
            return (
              <li key={category} className="grid gap-2 py-3 sm:grid-cols-[1fr_16rem] sm:items-center">
                <div className="min-w-0">
                  <label htmlFor={`${id}-${key}`} className="text-sm font-semibold">{t(`categories.${category}.label`)}</label>
                  <p className="text-xs text-ink-faint">{t(`categories.${category}.example`)}</p>
                </div>
                <div>
                  <select id={`${id}-${key}`} value={own(key)} onChange={(e) => onChange(key, e.target.value)}
                    className={`w-full rounded-lg border bg-card px-2 py-2 text-sm ${own(key) ? 'border-coral/50' : 'border-line'}`}>
                    <option value="">{inheritLabel}{inherited ? `: ${t(`levels.${inherited}`)}` : ''}</option>
                    {contentFilterLevels(category).map((l) => <option key={l} value={l}>{t(`levels.${l}`)}</option>)}
                  </select>
                  {level ? <p className="mt-1 text-xs text-ink-soft">{t(`levelHelp.${level}`)}</p> : null}
                </div>
              </li>
            )
          })}
        </ul>
        <p className="mt-2 text-xs text-ink-faint">{t('limits')}</p>
      </details>

      {allowDryRun ? (
        <details className="rounded-xl border border-line p-3">
          <summary className="cursor-pointer text-sm font-semibold">{t('tryTitle')}</summary>
          <p className="mt-2 text-xs text-ink-soft">{t('tryHelp')}</p>
          <label htmlFor={`${id}-sample`} className="sr-only">{t('tryLabel')}</label>
          <textarea id={`${id}-sample`} value={sample} onChange={(e) => { setSample(e.target.value); setResult(null) }} rows={4} maxLength={20_000}
            placeholder={t('tryPlaceholder')} className="mt-2 w-full rounded-lg border border-line bg-card px-3 py-2 text-sm" />
          <button type="button" onClick={tryIt} disabled={testing || !sample.trim()}
            className="mt-2 rounded-full border border-line px-4 py-1.5 text-sm font-semibold disabled:opacity-50">{t(testing ? 'trying' : 'tryButton')}</button>
          {testError ? <p role="alert" className="mt-2 text-sm text-coral-deep">{testError}</p> : null}
          {result ? (
            <div aria-live="polite" className="mt-3 space-y-3 text-sm">
              <p className={`rounded-xl border p-3 font-semibold ${result.outcome === 'blocked' || result.outcome === 'private_only' ? 'border-coral/50 bg-coral/10' : 'border-line bg-card'}`}>
                {t(`outcomes.${result.outcome}`)}
              </p>
              {result.message ? <p className="text-ink-soft"><span className="font-semibold text-ink">{t('userSees')}</span> {result.message}</p> : null}
              {result.outcome !== 'off' ? (
                result.findings.length === 0 ? <p className="text-ink-soft">{t('nothingFound')}</p> : (
                  <ul className="space-y-1">
                    {result.findings.map((f) => (
                      <li key={f.category} className="flex flex-wrap justify-between gap-2 rounded-lg border border-line px-3 py-1.5">
                        <span>{t(`categories.${f.category}.label`)} <span className="text-ink-faint">× {f.count}</span></span>
                        <span className="text-ink-soft">{t(result.outcome === 'observed' ? 'wouldDo' : 'does', { action: t(`levels.${f.level}`) })}</span>
                      </li>
                    ))}
                  </ul>
                )
              ) : null}
              {result.outcome !== 'blocked' ? (
                <div>
                  <p className="font-semibold">{t('modelSees')}</p>
                  <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-line bg-card p-3 font-mono text-xs">{result.modelText}</pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </details>
      ) : null}
    </section>
  )
}
