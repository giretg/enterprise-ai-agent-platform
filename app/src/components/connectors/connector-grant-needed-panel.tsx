'use client'

import { useState } from 'react'
import { startConnectorOAuth } from '@/app/actions/connector-grants'
import { extractGmailScopesFromConfig } from '@/lib/agent-delegated-connectors'
import { connectorFriendlyLabel } from '@/lib/agent-delegated-connectors'
import { mergeOauthScopes, scopesSuggestedForGrantNeeded } from '@/domain/connector-grant/connector-grant-needed'

const ALLOWED_OAUTH_SCOPES = new Set([
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
])

export type ConnectorGrantNeededView = {
  connectorId: string
  connectorType: string
  connectorName: string
  toolName: string
  reason: string
  scopes?: string[]
  config?: unknown
}

export function ConnectorGrantNeededPanel({
  cards,
  returnTo,
  onBusy,
}: {
  cards: ConnectorGrantNeededView[]
  returnTo?: { kind: 'conversation' | 'ticket'; id: string; agentId?: string }
  onBusy?: (busy: boolean) => void
}) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (cards.length === 0) return null

  const connect = async (card: ConnectorGrantNeededView) => {
    setError(null)
    setPendingId(card.connectorId)
    onBusy?.(true)
    try {
      const scopes = mergeOauthScopes(
        card.scopes,
        extractGmailScopesFromConfig(card.config),
        scopesSuggestedForGrantNeeded(card.toolName),
      )
        .filter((scope) => ALLOWED_OAUTH_SCOPES.has(scope))
        .slice(0, 3)
      const res = await startConnectorOAuth({
        connectorId: card.connectorId,
        ...(scopes.length > 0
          ? { scopes: scopes as [string, ...string[]] as Parameters<typeof startConnectorOAuth>[0]['scopes'] }
          : {}),
        ...(returnTo ? { returnTo } : {}),
      })
      if (!res.success) {
        setError(res.error)
        return
      }
      if ('url' in res.data && typeof res.data.url === 'string') {
        window.location.href = res.data.url
        return
      }
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'A hozzáférés indítása sikertelen.')
    } finally {
      setPendingId(null)
      onBusy?.(false)
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-coral/35 bg-coral/8 p-3">
      <p className="text-sm font-semibold text-ink">Hozzáférés kell a folytatáshoz</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-soft">
        Az agentnek Gmail/delegált fiók-hozzáférés kell. Add meg a hozzáférést — OAuth után a
        feladat magától folytatódik.
      </p>
      {error && <p className="mt-2 text-xs text-coral">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {cards.map((card) => {
          const label = connectorFriendlyLabel(card.connectorType, card.connectorName)
          const extra = card.reason === 'gmail_scope_not_granted' ? ' (bővebb jogosultság)' : ''
          return (
            <button
              key={`${card.connectorId}:${card.reason}`}
              type="button"
              disabled={pendingId !== null}
              onClick={() => void connect(card)}
              className="rounded-full bg-coral px-4 py-2 text-sm font-semibold text-white shadow-sm hover:brightness-95 disabled:opacity-50"
            >
              {pendingId === card.connectorId ? 'Átirányítás…' : `Hozzáférés megadása — ${label}${extra}`}
            </button>
          )
        })}
      </div>
    </div>
  )
}
