'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import type { Connector, ConnectorGrant } from '@prisma/client'
import { Card } from '@/components/ui/shell'
import {
  listConnectorGrants,
  listUserDelegatedConnectors,
  revokeConnectorGrant,
  startConnectorOAuth,
} from '@/app/actions/connector-grants'

type GrantRow = ConnectorGrant & {
  connector: { id: string; name: string; type: string }
}

export function ConnectorsPanel() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [grants, setGrants] = useState<GrantRow[]>([])
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (searchParams.get('connected') === '1') setMessage('Fiók sikeresen összekötve.')
    const err = searchParams.get('error')
    if (err) setError(decodeURIComponent(err))
  }, [searchParams])

  useEffect(() => {
    startTransition(async () => {
      const [g, c] = await Promise.all([listConnectorGrants(), listUserDelegatedConnectors()])
      if (g.success) setGrants(g.data)
      if (c.success) setConnectors(c.data)
    })
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Összekötött fiókok</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Per-user delegált connectorok — az agent csak a te engedélyeddel, a te fiókoddal jár el.
        </p>
      </div>

      {message && (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
          {message}
        </p>
      )}
      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}

      <Card title="Elérhető connectorok">
        <ul className="space-y-3">
          {connectors.length === 0 ? (
            <li className="text-sm text-ink-soft">Nincs user_delegated connector konfigurálva.</li>
          ) : (
            connectors.map((connector) => {
              const activeGrant = grants.find(
                (g) => g.connectorId === connector.id && g.status === 'active',
              )
              return (
                <li key={connector.id} className="atelier-soft flex items-center justify-between gap-4 p-3">
                  <div>
                    <p className="font-medium text-ink">{connector.name}</p>
                    <p className="text-xs text-ink-soft">
                      {connector.type} · {connector.authMode}
                    </p>
                    {activeGrant?.accountLabel && (
                      <p className="text-xs text-emerald-300/90">Összekötve: {activeGrant.accountLabel}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {activeGrant ? (
                      <button
                        type="button"
                        disabled={pending}
                        className="rounded-lg border border-line px-3 py-1.5 text-sm text-red-200 hover:bg-red-500/10"
                        onClick={() =>
                          startTransition(async () => {
                            const res = await revokeConnectorGrant({ grantId: activeGrant.id })
                            if (res.success) {
                              setGrants((prev) =>
                                prev.map((g) =>
                                  g.id === activeGrant.id ? { ...g, status: 'revoked' } : g,
                                ),
                              )
                            } else setError(res.error)
                          })
                        }
                      >
                        Visszavonás
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={pending}
                        className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white"
                        onClick={() =>
                          startTransition(async () => {
                            const res = await startConnectorOAuth({ connectorId: connector.id })
                            if (res.success) {
                              if ('stub' in res.data && res.data.stub) {
                                router.refresh()
                                setMessage('Fiók sikeresen összekötve (stub).')
                              } else {
                                window.location.href = res.data.url
                              }
                            } else setError(res.error)
                          })
                        }
                      >
                        Összekötés
                      </button>
                    )}
                  </div>
                </li>
              )
            })
          )}
        </ul>
      </Card>

      <Card title="Grant előzmények">
        <ul className="space-y-2 text-sm">
          {grants.map((grant) => (
            <li key={grant.id} className="flex justify-between border-b border-line/40 py-2">
              <span>
                {grant.connector.name} — {grant.accountLabel ?? '—'} ({grant.status})
              </span>
              <span className="text-ink-soft">{new Date(grant.grantedAt).toLocaleString('hu-HU')}</span>
            </li>
          ))}
        </ul>
      </Card>

      <button type="button" className="text-sm text-ink-soft underline" onClick={() => router.refresh()}>
        Frissítés
      </button>
    </div>
  )
}
