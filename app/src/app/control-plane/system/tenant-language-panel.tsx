'use client'

import { useState, useTransition } from 'react'
import { setTenantLanguage } from '@/app/actions/tenant-language'
import { Card } from '@/components/ui/shell'
import {
  TENANT_LANGUAGE_OPTIONS,
  type TenantLanguage,
} from '@/lib/tenant-language'

/**
 * Tenant kimeneti nyelv — a Skill Distiller és a Playbook Author agentek
 * ezen a nyelven írják a skill / folyamat promptokat és egyéb emberi szövegeket.
 */
export function TenantLanguagePanel({
  initialLanguage,
  canEdit,
}: {
  initialLanguage: TenantLanguage
  canEdit: boolean
}) {
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
          TENANT_LANGUAGE_OPTIONS.find((o) => o.value === res.data.language)?.label ?? res.data.language
        setMessage({
          tone: 'ok',
          text: `A tenant nyelve mostantól: ${label}. A skill- és folyamat-promptok ezen a nyelven készülnek.`,
        })
      } else {
        setMessage({ tone: 'error', text: res.error })
      }
    })
  }

  return (
    <Card title="Tenant nyelv">
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">
          A képesség-készítő és a folyamat-definiáló (Playbook Author) agent ezen a
          nyelven írja a képesség- és folyamat-promptokat, valamint a kapcsolódó emberi
          szövegeket (név, leírás, instrukciók). A JSON kulcsok angolul maradnak.
        </p>
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
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300'
            }`}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </Card>
  )
}
