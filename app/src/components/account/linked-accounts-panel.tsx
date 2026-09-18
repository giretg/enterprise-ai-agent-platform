'use client'

import { useSearchParams } from 'next/navigation'
import type { ReactNode } from 'react'
import {
  ConnectorConnectionCard,
  type LinkedConnectorView,
  type LinkedGrantView,
} from '@/components/account/connector-connection-card'

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
      <div className="mb-3 px-1">
        <h2 id={id} className="text-sm font-semibold tracking-tight text-ink">
          {title}
        </h2>
        <p className="mt-0.5 text-xs text-ink-soft">{description}</p>
      </div>
      {count > 0 ? (
        <div className="space-y-4">{children}</div>
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
}: {
  links?: unknown[]
  notifications?: unknown[]
  myAgents?: unknown
  connectors: LinkedConnectorView[]
  grants: LinkedGrantView[]
  isAdmin?: boolean
  drivePickerConfigured?: boolean
}) {
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
          Fiók sikeresen összekötve.
        </p>
      ) : null}
      {error ? (
        <p className="rounded-lg border border-coral/35 bg-coral/10 px-3 py-2 text-sm text-coral-deep">
          {error}
        </p>
      ) : null}
      <AccountGroup
        id="connected-accounts-heading"
        title="Összekötött fiókok"
        description="Delegált Google Drive (és későbbi) kötések."
        count={connectedConnectors.length}
        emptyText="Még nincs összekötött fiókod."
      >
        {connectedConnectors.map((connector) => (
          <ConnectorConnectionCard
            key={connector.id}
            connector={connector}
            grants={grants.filter((grant) => grant.connectorId === connector.id)}
          />
        ))}
      </AccountGroup>
      <AccountGroup
        id="available-accounts-heading"
        title="Elérhető szolgáltatások"
        description="Ezeket a konnektorokat még nem kötötted."
        count={disconnectedConnectors.length}
        emptyText="Minden elérhető szolgáltatás össze van kötve."
      >
        {disconnectedConnectors.map((connector) => (
          <ConnectorConnectionCard
            key={connector.id}
            connector={connector}
            grants={grants.filter((grant) => grant.connectorId === connector.id)}
          />
        ))}
      </AccountGroup>
    </div>
  )
}
