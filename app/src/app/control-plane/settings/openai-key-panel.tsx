'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { setOpenAiApiKey } from '@/app/actions/model-config'
import { Badge, Card } from '@/components/ui/shell'

export function OpenAiKeyPanel({
  configured: initialConfigured,
  canEdit,
}: {
  configured: boolean
  canEdit: boolean
}) {
  const t = useTranslations('ControlPlane.settings')
  const [configured, setConfigured] = useState(initialConfigured)
  const [editing, setEditing] = useState(canEdit && !initialConfigured)
  const [apiKey, setApiKey] = useState('')
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  function save() {
    if (!canEdit || pending) return
    startTransition(async () => {
      setMessage(null)
      const res = await setOpenAiApiKey({ apiKey })
      if (res.success) {
        setApiKey('')
        setConfigured(true)
        setEditing(false)
        setMessage({ tone: 'ok', text: t('openaiSaved') })
      } else {
        setMessage({
          tone: 'error',
          text:
            res.error === 'invalid_key'
              ? t('openaiInvalid')
              : res.error === 'INSUFFICIENT_ROLE'
                ? t('openaiNeedAdmin')
                : res.error === 'save_failed' || res.error === 'load_failed'
                  ? t('openaiSaveFailed')
                  : res.error,
        })
      }
    })
  }

  return (
    <Card title={t('openaiTitle')}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl space-y-2 text-sm text-ink-soft">
            <p>{t('openaiBody')}</p>
            <p>{t('openaiBilling')}</p>
            {configured ? null : <p>{t('openaiEmpty')}</p>}
          </div>
          {configured ? (
            <Badge tone="success">{t('openaiConfigured')}</Badge>
          ) : (
            <Badge tone="warning">{t('openaiMissing')}</Badge>
          )}
        </div>

        {canEdit && editing ? (
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block font-semibold">{t('openaiField')}</span>
              <input
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('openaiPlaceholder')}
                className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending || !apiKey.trim()}
                onClick={save}
                className="rounded-lg bg-coral/20 px-4 py-2 text-sm font-semibold text-coral disabled:opacity-40"
              >
                {t('openaiSave')}
              </button>
              {configured ? (
                <button
                  type="button"
                  onClick={() => {
                    setApiKey('')
                    setEditing(false)
                    setMessage(null)
                  }}
                  className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft"
                >
                  {t('openaiCancel')}
                </button>
              ) : null}
            </div>
          </div>
        ) : canEdit ? (
          <button
            type="button"
            onClick={() => {
              setApiKey('')
              setEditing(true)
              setMessage(null)
            }}
            className="text-sm font-semibold text-coral hover:text-coral-deep"
          >
            {t('openaiReplace')}
          </button>
        ) : (
          <p className="text-xs text-ink-soft">{t('openaiNeedAdmin')}</p>
        )}

        {message ? (
          <p className={`text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>{message.text}</p>
        ) : null}
      </div>
    </Card>
  )
}
