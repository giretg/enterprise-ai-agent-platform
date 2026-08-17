'use client'

import { useTransition } from 'react'
import type { Connector } from '@prisma/client'
import { startConnectorOAuth } from '@/app/actions/connector-grants'
import {
  connectorFriendlyLabel,
  connectorOAuthScopesFromConfig,
  connectorPossessive,
  connectorWithArticle,
  type AgentDelegatedConnectorRow,
} from '@/lib/agent-delegated-connectors'

export function AgentDelegatedConnectorsBar({
  items,
  variant = 'profile',
}: {
  items: AgentDelegatedConnectorRow[]
  variant?: 'profile' | 'compact' | 'sidebar'
}) {
  const [pending, startTransition] = useTransition()

  if (items.length === 0) return null

  function connect(connector: Pick<Connector, 'id' | 'type' | 'config'>) {
    startTransition(async () => {
      // Nincs eszköz-kontextus (ez a profil-sáv „Összekötés" gombja): a
      // connector configjában konfigurált teljes scope-listát kérjük.
      const configured = connectorOAuthScopesFromConfig(connector.config, connector.type)
      const res = await startConnectorOAuth({
        connectorId: connector.id,
        ...(configured.length > 0 ? { scopes: configured } : {}),
      })
      if (!res.success) return
      if ('stub' in res.data && res.data.stub) {
        window.location.reload()
        return
      }
      if ('url' in res.data && typeof res.data.url === 'string') {
        window.location.href = res.data.url
      } else {
        window.location.reload()
      }
    })
  }

  if (variant === 'compact') {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {items.map(({ connector, grant }) => (
          <ConnectorChip
            key={connector.id}
            connector={connector}
            grant={grant}
            pending={pending}
            onConnect={connect}
          />
        ))}
      </div>
    )
  }

  if (variant === 'sidebar') {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {items.map(({ connector, grant }) => (
          <ConnectorChip
            key={connector.id}
            connector={connector}
            grant={grant}
            pending={pending}
            onConnect={connect}
            dense
          />
        ))}
      </div>
    )
  }

  return (
    <ul className="mt-3 space-y-2">
      {items.map(({ connector, grant }) => {
        const label = connectorFriendlyLabel(connector.type, connector.name)
        const connected = Boolean(grant)
        return (
          <li
            key={connector.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/70 bg-night-2/30 px-3 py-2 text-sm"
          >
            <span className="text-ink-soft">
              {connected ? (
                <>
                  Hozzáférek{' '}
                  <span className="font-medium text-sage">{connectorPossessive(label)}</span>
                  {grant?.accountLabel ? (
                    <span className="text-ink-faint"> ({grant.accountLabel})</span>
                  ) : null}
                  .
                </>
              ) : (
                <>
                  Tudok dolgozni <span className="font-medium text-ink">{connectorWithArticle(label)}</span>
                  {' — '}
                  <span className="text-coral">kapcsolj össze</span>.
                </>
              )}
            </span>
            {!connected ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => connect(connector)}
                className="shrink-0 rounded-full bg-coral/15 px-3 py-1 text-xs font-semibold text-coral hover:bg-coral/25 disabled:opacity-50"
              >
                Összekötés
              </button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function ConnectorChip({
  connector,
  grant,
  pending,
  onConnect,
  dense = false,
}: {
  connector: Pick<Connector, 'id' | 'type' | 'name' | 'config'>
  grant: AgentDelegatedConnectorRow['grant']
  pending: boolean
  onConnect: (connector: Pick<Connector, 'id' | 'type' | 'config'>) => void
  dense?: boolean
}) {
  const label = connectorFriendlyLabel(connector.type, connector.name)
  const connected = Boolean(grant)
  const title = connected
    ? grant?.accountLabel
      ? `${label}: ${grant.accountLabel}`
      : `${label}: hozzáférés aktív`
    : `${label}: összekötés szükséges`

  return (
    <div
      title={title}
      className={`flex max-w-[11rem] items-center gap-1.5 rounded-full border border-line/70 bg-night-2/30 ${
        dense ? 'px-2 py-0.5' : 'px-2.5 py-1'
      }`}
    >
      <span
        className={`shrink-0 rounded-full ${dense ? 'h-1.5 w-1.5' : 'h-2 w-2'} ${
          connected ? 'bg-sage' : 'bg-coral'
        }`}
        aria-hidden
      />
      <span className="truncate text-[10px] font-semibold text-ink-soft">{label}</span>
      {!connected ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onConnect(connector)}
          className="shrink-0 rounded-full bg-coral/15 px-1.5 py-px text-[10px] font-semibold text-coral hover:bg-coral/25 disabled:opacity-50"
        >
          Összekötés
        </button>
      ) : null}
    </div>
  )
}
