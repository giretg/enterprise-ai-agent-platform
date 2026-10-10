'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { setGlobalFallbackChain } from '@/app/actions/model-config'
import { OrderedModelList } from '@/components/agents/ordered-model-list'
import { Card } from '@/components/ui/shell'
import { asTranslate } from '@/i18n/translate'
import { fallbackPreviewSteps } from '@/lib/model-fallback-preview'
import {
  modelCatalog,
  modelDisplayName,
  modelRefKey,
  EMPTY_MODEL_POLICY,
  type ModelRef,
} from '@/lib/model-policy'

const OPTIONS = modelCatalog(EMPTY_MODEL_POLICY)

/** Platform: a közös tartalék-lánc, ami minden munkatárs saját tartaléka UTÁN jön. */
export function FallbackChainPanel({ initial, canEdit }: { initial: ModelRef[]; canEdit: boolean }) {
  const t = asTranslate(useTranslations('ControlPlane.platformSettings'))
  const [saved, setSaved] = useState(initial)
  const [chain, setChain] = useState(initial)
  const [selectedKey, setSelectedKey] = useState('')
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const dirty = JSON.stringify(chain) !== JSON.stringify(saved)
  const preview = fallbackPreviewSteps({
    primary: chain[0] ?? null,
    globalFallbacks: chain.slice(1),
    policy: { enabled: chain },
    maxAttempts: Math.max(chain.length, 1),
  })

  function add() {
    const found = OPTIONS.find((o) => modelRefKey(o) === selectedKey)
    if (!found || chain.some((c) => modelRefKey(c) === selectedKey)) return
    setChain([...chain, { provider: found.provider, model: found.model }])
    setSelectedKey('')
  }

  function save() {
    setMessage(null)
    startTransition(async () => {
      const res = await setGlobalFallbackChain(chain)
      if (res.success) {
        setSaved(res.data)
        setChain(res.data)
        setMessage({ tone: 'ok', text: t('fallbackSaved') })
      } else {
        setMessage({
          tone: 'err',
          text:
            res.error === 'save_failed' || res.error === 'load_failed' ? t('fallbackSaveFailed') : res.error,
        })
      }
    })
  }

  return (
    <Card title={t('fallbackTitle')}>
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">{t('fallbackBody')}</p>
        {chain.length === 0 ? (
          <p className="text-sm text-honey">{t('fallbackEmpty')}</p>
        ) : (
          <OrderedModelList
            items={chain}
            canEdit={canEdit}
            onRemove={(i) => setChain(chain.filter((_, j) => j !== i))}
            removeLabel={t('fallbackRemove')}
          />
        )}
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedKey}
              onChange={(e) => setSelectedKey(e.target.value)}
              className="rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
            >
              <option value="">{t('fallbackPick')}</option>
              {OPTIONS.filter((o) => !chain.some((c) => modelRefKey(c) === modelRefKey(o))).map((o) => (
                <option key={modelRefKey(o)} value={modelRefKey(o)}>
                  {modelDisplayName(o)}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!selectedKey}
              onClick={add}
              className="rounded-full border border-line px-4 py-1.5 text-xs font-medium text-ink disabled:opacity-40"
            >
              {t('fallbackAdd')}
            </button>
            <button
              type="button"
              disabled={pending || !dirty}
              onClick={save}
              className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
            >
              {pending ? t('fallbackSaving') : t('fallbackSave')}
            </button>
          </div>
        ) : (
          <p className="text-xs text-ink-soft">{t('fallbackNeedSuperadmin')}</p>
        )}
        <div className="rounded-lg border border-line/50 bg-night/30 p-3">
          <p className="text-sm font-medium text-ink">{t('fallbackPreviewTitle')}</p>
          {preview.length === 0 ? (
            <p className="mt-1 text-xs text-ink-faint">{t('fallbackPreviewEmpty')}</p>
          ) : (
            <ul className="mt-1 space-y-1 text-xs text-ink-soft">
              {preview.map((step) => (
                <li key={`${modelRefKey(step.from)}>${modelRefKey(step.to)}`}>
                  {t('fallbackPreviewLine', {
                    from: modelDisplayName(step.from),
                    to: modelDisplayName(step.to),
                  })}
                </li>
              ))}
            </ul>
          )}
        </div>
        {message ? (
          <p className={`text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>{message.text}</p>
        ) : null}
      </div>
    </Card>
  )
}
