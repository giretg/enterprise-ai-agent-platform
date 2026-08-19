'use client'

import { useEffect, useState } from 'react'
import { startConnectorOAuth } from '@/app/actions/connector-grants'
import { delegatedConnectorLabel } from '@/domain/connector-grant/delegated-oauth-registry'
import { isScopeNotGrantedReason } from '@/domain/connector-grant/connector-grant-needed'

export type ConnectorGrantNeededView = {
  connectorId: string
  connectorType: string
  connectorName: string
  toolName: string
  reason: string
  scopes?: string[]
  config?: unknown
}

/**
 * „Hozzáférés megadása" kártya — bármelyik delegált (per-user OAuth) connectorra.
 *
 * A kliens NEM dönt scope-ról: csak az elakadt eszköz nevét küldi, a szerver a
 * provider-regiszterből és a connector configjából oldja fel a legkisebb
 * szükséges jogosultságot. Így egy új OAuth-connector ugyanezt a gombot kapja,
 * a panel módosítása nélkül.
 */
export function ConnectorGrantNeededPanel({
  cards,
  returnTo,
  onBusy,
  onBeforeRedirect,
}: {
  cards: ConnectorGrantNeededView[]
  returnTo?: { kind: 'conversation' | 'ticket'; id: string; agentId?: string; originPath?: string }
  onBusy?: (busy: boolean) => void
  /** OAuth full-page redirect előtt (tálca + session persist). */
  onBeforeRedirect?: () => void
}) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const err = new URLSearchParams(window.location.search).get('error')
    if (err) setError(err)
  }, [])

  if (cards.length === 0) return null

  const connect = async (card: ConnectorGrantNeededView) => {
    setError(null)
    setPendingId(card.connectorId)
    onBusy?.(true)
    try {
      const originPath =
        typeof window !== 'undefined' ? window.location.pathname : undefined
      const res = await startConnectorOAuth({
        connectorId: card.connectorId,
        toolName: card.toolName,
        ...(returnTo
          ? {
              returnTo: {
                ...returnTo,
                ...(originPath ? { originPath } : {}),
              },
            }
          : {}),
      })
      if (!res.success) {
        setError(res.error)
        return
      }
      if ('url' in res.data && typeof res.data.url === 'string') {
        onBeforeRedirect?.()
        // A stub-ág is URL-t ad vissza (a visszatérési útvonalat), tehát mindkét
        // esetben navigálunk — `assign`, nem `location.href` írása.
        window.location.assign(res.data.url)
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

  const targets = [...new Set(cards.map((card) => delegatedConnectorLabel(card.connectorType, card.connectorName)))]

  return (
    <div className="mt-3 rounded-xl border border-coral/35 bg-coral/8 p-3">
      <p className="text-sm font-semibold text-ink">Hozzáférés kell a folytatáshoz</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-soft">
        Az agentnek a saját {targets.join(', ')} fiókodhoz kell hozzáférés. Add meg a hozzáférést —
        OAuth után a feladat magától folytatódik.
      </p>
      {error && <p className="mt-2 text-xs text-coral">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {cards.map((card) => {
          const label = delegatedConnectorLabel(card.connectorType, card.connectorName)
          const extra = isScopeNotGrantedReason(card.reason) ? ' (bővebb jogosultság)' : ''
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
