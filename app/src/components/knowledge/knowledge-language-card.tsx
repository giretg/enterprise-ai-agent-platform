'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { setKnowledgeCatalogLanguage } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'
import { KB_LANGUAGE_OPTIONS, type KbLanguage } from '@/lib/kb-language'

/**
 * #717 F3: a katalógus-tár keresési nyelve — üzleti nyelven
 * („Magyar" / „English"), technikai kód (`regconfig`, `hungarian`) nélkül.
 */
export function KnowledgeLanguageCard({
  initialLanguage,
  tenantLanguage,
  canManage,
}: {
  initialLanguage: KbLanguage
  tenantLanguage: KbLanguage
  canManage: boolean
}) {
  const t = useTranslations('Knowledge')
  const [language, setLanguage] = useState<KbLanguage>(initialLanguage)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  function select(next: KbLanguage) {
    if (next === language || !canManage || pending) return
    startTransition(async () => {
      const res = await setKnowledgeCatalogLanguage({ kbLanguage: next })
      if (res.success) {
        setLanguage(res.data.kbLanguage)
        const label = KB_LANGUAGE_OPTIONS.find((option) => option.value === res.data.kbLanguage)?.label
        setMessage({ tone: 'ok', text: t('languageSaved', { label: label ?? res.data.kbLanguage }) })
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
          {KB_LANGUAGE_OPTIONS.map((option) => {
            const active = language === option.value
            return (
              <button
                key={option.value}
                type="button"
                disabled={!canManage || pending}
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
        <p className="text-xs text-ink-faint">
          {t('languageTenantNote', {
            label:
              KB_LANGUAGE_OPTIONS.find((option) => option.value === tenantLanguage)?.label ??
              tenantLanguage,
          })}
        </p>
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
