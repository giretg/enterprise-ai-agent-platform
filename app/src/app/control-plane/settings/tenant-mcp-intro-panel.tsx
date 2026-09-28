'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { getTenantMcpIntro, setTenantMcpIntro } from '@/app/actions/tenant-mcp-intro'
import { Card } from '@/components/ui/shell'

export function TenantMcpIntroPanel({
  initialIntro,
  canEdit,
}: {
  initialIntro: string
  canEdit: boolean
}) {
  const t = useTranslations('ControlPlane.settings')
  const common = useTranslations('Common')
  const [intro, setIntro] = useState(initialIntro)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  function save() {
    if (!canEdit || pending) return
    startTransition(async () => {
      const res = await setTenantMcpIntro({ mcpIntro: intro })
      if (res.success) {
        setIntro(res.data.mcpIntro)
        setMessage({ tone: 'ok', text: t('mcpIntroSaved') })
      } else {
        setMessage({ tone: 'error', text: res.error })
      }
    })
  }

  return (
    <Card title={t('mcpIntroTitle')}>
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">{t('mcpIntroBody')}</p>
        <textarea
          value={intro}
          onChange={(event) => setIntro(event.target.value)}
          disabled={!canEdit || pending}
          rows={8}
          maxLength={4000}
          placeholder={t('mcpIntroPlaceholder')}
          className="w-full rounded-xl border border-line bg-panel px-4 py-3 text-sm text-ink outline-none transition focus:border-coral/50 disabled:opacity-60"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={!canEdit || pending}
            className="rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-coral-deep disabled:opacity-50"
          >
            {common('save')}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              startTransition(async () => {
                const res = await getTenantMcpIntro()
                if (res.success) {
                  setIntro(res.data.mcpIntro)
                  setMessage({ tone: 'ok', text: t('reloaded') })
                } else {
                  setMessage({ tone: 'error', text: res.error })
                }
              })
            }}
            className="rounded-full border border-line bg-card px-4 py-2 text-sm font-medium text-ink-soft transition hover:border-coral/40 hover:text-ink disabled:opacity-50"
          >
            {t('reload')}
          </button>
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
