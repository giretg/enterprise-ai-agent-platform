'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { purgeTenantWorkspaces } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

type WorkspaceOffboardingPanelProps = {
  tenantIds: string[]
}

export function WorkspaceOffboardingPanel({ tenantIds }: WorkspaceOffboardingPanelProps) {
  const t = useTranslations('Offboarding')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [selectedTenant, setSelectedTenant] = useState(tenantIds[0] ?? 'global')
  const [customTenant, setCustomTenant] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const effectiveTenant = customTenant.trim() || selectedTenant

  function handlePurge() {
    setMessage(null)
    setError(null)
    startTransition(async () => {
      const res = await purgeTenantWorkspaces(effectiveTenant)
      if (res.success) {
        setMessage(t('purged', { count: res.data.deletedObjects, tenant: effectiveTenant }))
        setConfirmed(false)
        router.refresh()
      } else {
        setError(res.error ?? t('failed'))
      }
    })
  }

  return (
    <Card title={t('title')}>
      <p className="mb-4 text-sm text-ink-soft">{t('body')}</p>

      <div className="space-y-3">
        <label className="block text-sm text-ink-soft">
          {t('tenant')}
          <select
            value={selectedTenant}
            onChange={(event) => {
              setSelectedTenant(event.target.value)
              setCustomTenant('')
            }}
            disabled={pending}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
          >
            <option value="global">{t('globalOption')}</option>
            {tenantIds.map((tenantId) => (
              <option key={tenantId} value={tenantId}>
                {tenantId}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm text-ink-soft">
          {t('customId')}
          <input
            value={customTenant}
            onChange={(event) => setCustomTenant(event.target.value)}
            placeholder={t('customPlaceholder')}
            disabled={pending}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 font-mono text-sm text-ink"
          />
        </label>

        <label className="flex items-start gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={pending}
            className="mt-1"
          />
          <span>
            {t('confirm', { tenant: effectiveTenant })}
          </span>
        </label>

        <button
          type="button"
          onClick={handlePurge}
          disabled={pending || !confirmed}
          className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? t('purging') : t('purge')}
        </button>
      </div>

      {message && <p className="mt-3 text-sm text-sage">{message}</p>}
      {error && <p className="mt-3 text-sm text-coral">{error}</p>}
    </Card>
  )
}
