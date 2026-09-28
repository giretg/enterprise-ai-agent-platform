'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { setTenantLanguage } from '@/app/actions/tenant-language'
import { Card } from '@/components/ui/shell'
import {
  TENANT_LANGUAGE_OPTIONS,
  type TenantLanguage,
} from '@/lib/tenant-language'

export function TenantLanguagePanel({
  initialLanguage,
  canEdit,
}: {
  initialLanguage: TenantLanguage
  canEdit: boolean
}) {
  const t = useTranslations('ControlPlane.settings')
  const [language, setLanguage] = useState<TenantLanguage>(initialLanguage)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  function select(next: TenantLanguage) {
    if (next === language || !canEdit || pending) return
    startTransition(async () => {
      const res = await setTenantLanguage({ language: next })
      if (res.success) {
        setLanguage(res.data.language)
        const label =
          TENANT_LANGUAGE_OPTIONS.find((option) => option.value === res.data.language)?.label ??
          res.data.language
        setMessage({ tone: 'ok', text: t('languageSaved', { label }) })
      } else {
        setMessage({ tone: 'error', text: res.error })
      }
    })
  }

  return (
    <Card title={t('languageTitle')}>
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">{t('languageBody')}</p>
        <div className="flex flex-wrap gap-2">
          {TENANT_LANGUAGE_OPTIONS.map((option) => {
            const active = language === option.value
            return (
              <button
                key={option.value}
                type="button"
                disabled={!canEdit || pending}
                onClick={() => select(option.value)}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50 ${
                  active
                    ? 'bg-coral text-white'
                    : 'border border-line bg-panel text-ink hover:border-coral/50'
                }`}
              >
                {option.label}
              </button>
            )
          })}
        </div>
        {message ? (
          <p
            className={`rounded-lg border px-3 py-2 text-sm ${
              message.tone === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800'
                : 'border-coral/35 bg-coral/10 text-coral-deep'
            }`}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </Card>
  )
}
