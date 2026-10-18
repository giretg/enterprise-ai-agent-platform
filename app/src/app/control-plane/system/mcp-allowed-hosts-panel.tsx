'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { Card } from '@/components/ui/shell'
import { asTranslate } from '@/i18n/translate'
import { setMcpHostAllowed } from '@/app/actions/mcp-connectors'

function hostError(t: (key: string) => string, raw: string): string {
  const translated = t(`mcpHostErrors.${raw}`)
  return translated === `mcpHostErrors.${raw}` ? t('mcpHostErrors.unknown') : translated
}

/** #395 D8: mely külső MCP-szolgáltatókhoz köthetnek a cégek connectort. */
export function McpAllowedHostsPanel({ initial, canEdit }: { initial: string[]; canEdit: boolean }) {
  const t = asTranslate(useTranslations('ControlPlane.platformSettings'))
  const [hosts, setHosts] = useState(initial)
  const [host, setHost] = useState('')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function change(target: string, allowed: boolean) {
    if (!allowed && !window.confirm(t('mcpHostsRevokeConfirm', { host: target }))) return
    setError(null)
    startTransition(async () => {
      const res = await setMcpHostAllowed({ host: target, allowed })
      if (res.success) {
        setHosts(res.data.hosts)
        setHost('')
      } else setError(hostError(t, res.error))
    })
  }

  return (
    <Card title={t('mcpHostsTitle')}>
      <div className="space-y-3">
        <p className="text-sm text-ink-soft">{t('mcpHostsBody')}</p>
        {hosts.length === 0 ? (
          <p className="text-sm text-ink-soft">{t('mcpHostsEmpty')}</p>
        ) : (
          <ul className="space-y-1">
            {hosts.map((item) => (
              <li key={item} className="flex items-center justify-between rounded-lg border border-line px-3 py-1.5 text-sm">
                <code>{item}</code>
                {canEdit ? (
                  <button type="button" className="text-xs text-coral-deep" disabled={pending} onClick={() => change(item, false)}>
                    {t('mcpHostsRevoke')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <div className="flex gap-2">
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder={t('mcpHostsPlaceholder')}
              className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm"
            />
            <button
              type="button"
              className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
              disabled={pending || !host.trim()}
              onClick={() => change(host, true)}
            >
              {t('mcpHostsAllow')}
            </button>
          </div>
        ) : (
          <p className="text-sm text-ink-soft">{t('mcpHostsNeedSuperadmin')}</p>
        )}
        {error ? <p className="text-sm text-coral-deep">{error}</p> : null}
      </div>
    </Card>
  )
}
