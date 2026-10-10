'use client'

import { useMemo, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { setTenantModelEnabled } from '@/app/actions/model-config'
import { Card } from '@/components/ui/shell'
import { asTranslate } from '@/i18n/translate'
import { MODEL_PROVIDERS } from '@/lib/model-providers'
import { modelCatalog, type ModelPolicy, type ModelRef } from '@/lib/model-policy'

/** Tenant admin: mely modelleket használhatják a munkatársak (költség, adatvédelem). */
export function ModelPolicyPanel({ initial, canEdit }: { initial: ModelPolicy; canEdit: boolean }) {
  const t = asTranslate(useTranslations('ControlPlane.settings'))
  const [policy, setPolicy] = useState(initial)
  const [provider, setProvider] = useState<ModelRef['provider']>(MODEL_PROVIDERS[0]!.value as ModelRef['provider'])
  const [custom, setCustom] = useState('')
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const catalog = useMemo(() => modelCatalog(policy), [policy])

  function setEnabled(ref: ModelRef, enabled: boolean) {
    setMessage(null)
    startTransition(async () => {
      const res = await setTenantModelEnabled({ ...ref, enabled })
      if (res.success) {
        setPolicy(res.data)
        setMessage({ tone: 'ok', text: enabled ? t('modelsEnabled') : t('modelsDisabled') })
      } else {
        setMessage({
          tone: 'err',
          text: res.error === 'save_failed' || res.error === 'load_failed' ? t('modelsSaveFailed') : res.error,
        })
      }
    })
  }

  return (
    <Card title={t('modelsTitle')}>
      <div className="space-y-5">
        <p className="text-sm text-ink-soft">{t('modelsBody')}</p>
        {policy.enabled.length === 0 ? (
          <p className="rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-sm text-honey">{t('modelsEmpty')}</p>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-2">
          {MODEL_PROVIDERS.map((option) => (
            <div key={option.value} className="rounded-lg border border-line/70 bg-panel/40 p-4">
              <p className="text-sm font-semibold text-ink">{option.label}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-faint">{option.hint}</p>
              <div className="mt-3 space-y-2">
                {catalog
                  .filter((entry) => entry.provider === option.value)
                  .map((entry) => (
                    <label
                      key={`${entry.provider}/${entry.model}`}
                      className="flex items-start gap-3 rounded-md border border-line/50 bg-night/40 p-3 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={entry.enabled}
                        disabled={!canEdit || pending}
                        onChange={(e) => setEnabled(entry, e.target.checked)}
                        className="mt-1 h-4 w-4 accent-coral"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium text-ink">{entry.label}</span>
                        <span className="block break-all text-xs text-ink-faint">{entry.model}</span>
                        {entry.description ? (
                          <span className="mt-1 block text-xs text-ink-soft">{entry.description}</span>
                        ) : null}
                      </span>
                    </label>
                  ))}
              </div>
            </div>
          ))}
        </div>

        {canEdit ? (
          <div className="rounded-lg border border-line/70 bg-night/40 p-4">
            <p className="text-sm font-semibold text-ink">{t('modelsCustomTitle')}</p>
            <p className="mt-1 text-xs text-ink-soft">{t('modelsCustomBody')}</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-[220px_1fr_auto]">
              <select
                value={provider}
                disabled={pending}
                onChange={(e) => setProvider(e.target.value as ModelRef['provider'])}
                className="rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink"
              >
                {MODEL_PROVIDERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <input
                value={custom}
                disabled={pending}
                onChange={(e) => setCustom(e.target.value)}
                placeholder={t('modelsCustomPlaceholder')}
                className="rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink"
              />
              <button
                type="button"
                disabled={pending || !custom.trim()}
                onClick={() => {
                  setEnabled({ provider, model: custom.trim() }, true)
                  setCustom('')
                }}
                className="rounded-lg bg-coral/20 px-4 py-2 text-sm font-semibold text-coral disabled:opacity-40"
              >
                {t('modelsEnable')}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-ink-soft">{t('modelsNeedAdmin')}</p>
        )}

        {message ? (
          <p className={`text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>{message.text}</p>
        ) : null}
      </div>
    </Card>
  )
}
