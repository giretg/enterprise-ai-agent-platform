'use client'

import { useSearchParams } from 'next/navigation'
import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import {
  ConnectorConnectionCard,
  type LinkedConnectorView,
  type LinkedGrantView,
} from '@/components/account/connector-connection-card'
import { connectorOAuthErrorMessage } from '@/components/account/delegated-oauth-ui'

function AccountGroup({
  id,
  title,
  description,
  count,
  emptyText,
  children,
}: {
  id: string
  title: string
  description: string
  count: number
  emptyText: string
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2 px-1">
        <div>
          <div className="flex items-center gap-2">
            <h2 id={id} className="text-sm font-semibold tracking-tight text-ink">
              {title}
            </h2>
            <span className="rounded-full bg-ink/8 px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
              {count}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-ink-soft">{description}</p>
        </div>
      </div>
      {count > 0 ? (
        <div className="space-y-2.5">{children}</div>
      ) : (
        <div className="rounded-2xl border border-dashed border-line bg-night-2/30 px-5 py-4 text-sm text-ink-soft">
          {emptyText}
        </div>
      )}
    </section>
  )
}

export function LinkedAccountsPanel({
  connectors,
  grants,
  isAdmin = false,
  drivePickerConfigured = false,
}: {
  connectors: LinkedConnectorView[]
  grants: LinkedGrantView[]
  isAdmin?: boolean
  drivePickerConfigured?: boolean
}) {
  const t = useTranslations('Account')
  const searchParams = useSearchParams()
  const connected = searchParams.get('connected') === '1'
  const error = searchParams.get('error')
  const connectorConnected = (connectorId: string) =>
    grants.some((grant) => grant.connectorId === connectorId && grant.status === 'active')
  const connectedConnectors = connectors.filter((connector) => connectorConnected(connector.id))
  const disconnectedConnectors = connectors.filter(
    (connector) => !connectorConnected(connector.id),
  )

  return (
    <div className="space-y-4">
      {connected ? (
        <p className="rounded-lg border border-sage/35 bg-sage/10 px-3 py-2 text-sm text-sage">
          {t('connectedOk')}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-lg border border-coral/35 bg-coral/10 px-3 py-2 text-sm text-coral-deep">
          {connectorOAuthErrorMessage(error, t)}
        </p>
      ) : null}

      <div className="space-y-8">
        <AccountGroup
          id="connected-accounts-heading"
          title={t('connectedTitle')}
          description={t('connectedBody')}
          count={connectedConnectors.length}
          emptyText={t('connectedEmpty')}
        >
          {connectedConnectors.map((connector) => (
            <ConnectorConnectionCard
              key={connector.id}
              connector={connector}
              grants={grants.filter((grant) => grant.connectorId === connector.id)}
              isAdmin={isAdmin}
              drivePickerConfigured={drivePickerConfigured}
            />
          ))}
        </AccountGroup>

        <AccountGroup
          id="available-accounts-heading"
          title={t('availableTitle')}
          description={t('availableBody')}
          count={disconnectedConnectors.length}
          emptyText={t('availableEmpty')}
        >
          {disconnectedConnectors.map((connector) => (
            <ConnectorConnectionCard
              key={connector.id}
              connector={connector}
              grants={grants.filter((grant) => grant.connectorId === connector.id)}
              isAdmin={isAdmin}
              drivePickerConfigured={drivePickerConfigured}
            />
          ))}
        </AccountGroup>
      </div>
    </div>
  )
}
