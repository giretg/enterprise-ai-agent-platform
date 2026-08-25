'use client'

import { useSearchParams } from 'next/navigation'
import type { ReactNode } from 'react'
import type { ChannelLinkView, UserNotificationView } from '@/app/actions/channel-link'
import type { MyChannelAgentsView } from '@/app/actions/channel-agents'
import { TelegramLinkPanel } from '@/components/account/telegram-link-panel'
import {
  ConnectorConnectionCard,
  type LinkedConnectorView,
  type LinkedGrantView,
} from '@/components/account/connector-connection-card'
import { SecurityNotificationsCard } from '@/components/account/security-notifications-card'

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
            <h2
              id={id}
              className="text-sm font-semibold tracking-tight text-ink"
            >
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
  links,
  notifications,
  myAgents,
  connectors,
  grants,
}: {
  links: ChannelLinkView[]
  notifications: UserNotificationView[]
  myAgents: MyChannelAgentsView
  connectors: LinkedConnectorView[]
  grants: LinkedGrantView[]
}) {
  const searchParams = useSearchParams()
  const connected = searchParams.get('connected') === '1'
  const error = searchParams.get('error')
  const telegramConnected = links.some(
    (link) => link.channelType === 'telegram' && link.status === 'active',
  )
  const connectorConnected = (connectorId: string) =>
    grants.some((grant) => grant.connectorId === connectorId && grant.status === 'active')
  const connectedConnectors = connectors.filter((connector) => connectorConnected(connector.id))
  const disconnectedConnectors = connectors.filter(
    (connector) => !connectorConnected(connector.id),
  )
  const connectedCount = connectedConnectors.length + (telegramConnected ? 1 : 0)
  const disconnectedCount = disconnectedConnectors.length + (telegramConnected ? 0 : 1)

  return (
    <div className="space-y-4">
      {connected && (
        <p className="rounded-lg border border-sage/35 bg-sage/10 px-3 py-2 text-sm text-sage">
          Fiók sikeresen összekötve.
        </p>
      )}
      {error && (
        <p className="rounded-lg border border-coral/35 bg-coral/10 px-3 py-2 text-sm text-coral-deep">
          {decodeURIComponent(error)}
        </p>
      )}

      <div className="space-y-8">
        <AccountGroup
          id="connected-accounts-heading"
          title="Összekötött fiókok"
          description="Ezekkel a fiókokkal az AI munkatárs már dolgozhat."
          count={connectedCount}
          emptyText="Még nincs összekötött fiókod. Az elérhető szolgáltatások közül választhatsz lent."
        >
          {telegramConnected ? (
            <TelegramLinkPanel initialLinks={links} myAgents={myAgents} />
          ) : null}
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
          title="További fiókok"
          description="Kösd össze azokat a szolgáltatásokat, amelyeket használni szeretnél."
          count={disconnectedCount}
          emptyText="Minden jelenleg elérhető fiók össze van kötve."
        >
          {!telegramConnected ? (
            <TelegramLinkPanel initialLinks={links} myAgents={myAgents} />
          ) : null}
          {disconnectedConnectors.map((connector) => (
            <ConnectorConnectionCard
              key={connector.id}
              connector={connector}
              grants={grants.filter((grant) => grant.connectorId === connector.id)}
            />
          ))}
        </AccountGroup>

        <SecurityNotificationsCard initialNotifications={notifications} />
      </div>
    </div>
  )
}
