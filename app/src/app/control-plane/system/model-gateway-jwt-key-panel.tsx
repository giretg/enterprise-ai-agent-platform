'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { setModelGatewayJwtKey } from '@/app/actions/model-config'
import { Badge, Card } from '@/components/ui/shell'

export function ModelGatewayJwtKeyPanel({
  configured: initialConfigured,
  canEdit,
}: {
  configured: boolean
  canEdit: boolean
}) {
  const t = useTranslations('ControlPlane.platformSettings')
  const [configured, setConfigured] = useState(initialConfigured)
  const [editing, setEditing] = useState(canEdit && !initialConfigured)
  const [signingKey, setSigningKey] = useState('')
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  function save(generate: boolean) {
    if (!canEdit || pending) return
    startTransition(async () => {
      setMessage(null)
      const res = await setModelGatewayJwtKey(generate ? { generate: true } : { signingKey })
      if (res.success) {
        setSigningKey('')
        setConfigured(true)
        setEditing(false)
        setMessage({ tone: 'ok', text: t('jwtSaved') })
      } else {
        setMessage({
          tone: 'error',
          text:
            res.error === 'invalid_key'
              ? t('jwtInvalid')
              : res.error === 'INSUFFICIENT_PLATFORM_ROLE' || res.error === 'INSUFFICIENT_ROLE'
                ? t('jwtNeedSuperadmin')
                : res.error === 'save_failed' || res.error === 'load_failed'
                  ? t('jwtSaveFailed')
                  : res.error,
        })
      }
    })
  }

  return (
    <Card title={t('jwtTitle')}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-2xl text-sm text-ink-soft">{t('jwtBody')}</p>
          {configured ? (
            <Badge tone="success">{t('jwtConfigured')}</Badge>
          ) : (
            <Badge tone="warning">{t('jwtMissing')}</Badge>
          )}
        </div>

        {canEdit && editing ? (
          <div className="space-y-3">
            {configured ? <p className="text-xs text-honey">{t('jwtReplaceWarn')}</p> : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => save(true)}
                className="rounded-lg bg-coral/20 px-4 py-2 text-sm font-semibold text-coral disabled:opacity-40"
              >
                {t('jwtGenerate')}
              </button>
            </div>
            <label className="block text-sm">
              <span className="mb-1 block font-semibold">{t('jwtField')}</span>
              <input
                type="password"
                autoComplete="new-password"
                value={signingKey}
                onChange={(e) => setSigningKey(e.target.value)}
                placeholder={t('jwtPlaceholder')}
                className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending || signingKey.trim().length < 32}
                onClick={() => save(false)}
                className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink disabled:opacity-40"
              >
                {t('jwtSave')}
              </button>
              {configured ? (
                <button
                  type="button"
                  onClick={() => {
                    setSigningKey('')
                    setEditing(false)
                    setMessage(null)
                  }}
                  className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft"
                >
                  {t('jwtCancel')}
                </button>
              ) : null}
            </div>
          </div>
        ) : canEdit ? (
          <button
            type="button"
            onClick={() => {
              setSigningKey('')
              setEditing(true)
              setMessage(null)
            }}
            className="text-sm font-semibold text-coral hover:text-coral-deep"
          >
            {t('jwtReplace')}
          </button>
        ) : (
          <p className="text-xs text-ink-soft">{t('jwtNeedSuperadmin')}</p>
        )}

        {message ? (
          <p className={`text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>{message.text}</p>
        ) : null}
      </div>
    </Card>
  )
}
