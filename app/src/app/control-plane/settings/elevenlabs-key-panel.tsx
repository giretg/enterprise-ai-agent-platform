'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { setElevenLabsApiKey } from '@/app/actions/model-config'
import { Badge, Card } from '@/components/ui/shell'

export function ElevenLabsKeyPanel({
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
      const res = await setElevenLabsApiKey({ apiKey })
      if (res.success) {
        setApiKey('')
        setConfigured(true)
        setEditing(false)
        setMessage({ tone: 'ok', text: t('elevenlabsSaved') })
      } else {
        setMessage({
          tone: 'error',
          text:
            res.error === 'invalid_key'
              ? t('elevenlabsInvalid')
              : res.error === 'INSUFFICIENT_ROLE'
                ? t('elevenlabsNeedAdmin')
                : res.error === 'save_failed' || res.error === 'load_failed'
                  ? t('elevenlabsSaveFailed')
                  : res.error,
        })
      }
    })
  }

  return (
    <Card title={t('elevenlabsTitle')}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl space-y-2 text-sm text-ink-soft">
            <p>{t('elevenlabsBody')}</p>
            <p>{t('elevenlabsSetup')}</p>
            {configured ? null : <p>{t('elevenlabsEmpty')}</p>}
          </div>
          {configured ? (
            <Badge tone="success">{t('elevenlabsConfigured')}</Badge>
          ) : (
            <Badge tone="warning">{t('elevenlabsMissing')}</Badge>
          )}
        </div>

        {canEdit && editing ? (
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block font-semibold">{t('elevenlabsField')}</span>
              <input
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('elevenlabsPlaceholder')}
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
                {t('elevenlabsSave')}
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
                  {t('elevenlabsCancel')}
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
            {t('elevenlabsReplace')}
          </button>
        ) : (
          <p className="text-xs text-ink-soft">{t('elevenlabsNeedAdmin')}</p>
        )}

        {message ? (
          <p className={`text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>{message.text}</p>
        ) : null}
      </div>
    </Card>
  )
}
