'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { decideHandoffAction, type HandoffInboxRow } from '@/app/actions/handoff'
import { asTranslate } from '@/i18n/translate'
import { operationErrorLabel } from './labels'

function formatWhen(iso: string, locale: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(locale === 'en' ? 'en-GB' : 'hu-HU')
}

export function HandoffsPanel({ handoffs }: { handoffs: HandoffInboxRow[] }) {
  const t = asTranslate(useTranslations('ControlPlane.operations'))
  const locale = useLocale()
  const [message, setMessage] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function onDecide(handoffId: string, decision: 'accepted' | 'done' | 'rejected') {
    setBusyId(handoffId)
    setMessage(null)
    const result = await decideHandoffAction({ handoffId, decision })
    setBusyId(null)
    if (!result.success) {
      setMessage(operationErrorLabel(result.error, t))
      return
    }
    setMessage(t('handoffDecided', { status: result.data.status }))
  }

  if (handoffs.length === 0) return null

  return (
    <div className="space-y-4">
      <h2 className="font-display text-xl font-semibold">{t('handoffsTitle')}</h2>
      {message ? (
        <p className="rounded-lg border border-ink/10 bg-white/40 px-3 py-2 text-sm text-ink">{message}</p>
      ) : null}
      <ul className="space-y-3">
        {handoffs.map((row) => {
          const busy = busyId === row.id
          return (
            <li key={row.id} className="rounded-xl border border-ink/10 bg-white/50 p-4 shadow-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium text-ink">{row.title}</p>
                <p className="text-xs text-ink-faint">{formatWhen(row.createdAt, locale)}</p>
              </div>
              <p className="mt-1 text-sm text-ink-soft">
                {row.fromAgentName} · {row.projectKey} · {row.status}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{row.summary}</p>
              {row.links ? (
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-soft">{row.links}</p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {(['accepted', 'done', 'rejected'] as const).map((decision) => (
                  <button
                    key={decision}
                    type="button"
                    disabled={busy}
                    onClick={() => void onDecide(row.id, decision)}
                    className="rounded-md border border-ink/20 px-3 py-1.5 text-sm text-ink disabled:opacity-50"
                  >
                    {t(`handoff_${decision}`)}
                  </button>
                ))}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
