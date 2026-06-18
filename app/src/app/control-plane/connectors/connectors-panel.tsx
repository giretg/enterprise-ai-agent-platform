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

const GMAIL_SCOPE_PROFILES = [
  {
    id: 'modify',
    label: 'Olvasás + írás',
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  },
  {
    id: 'readonly',
    label: 'Csak olvasás',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  },
  {
    id: 'compose',
    label: 'Piszkozat + küldés',
    scopes: ['https://www.googleapis.com/auth/gmail.compose'],
  },
  {
    id: 'send',
    label: 'Csak küldés',
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
  },
  {
    id: 'full',
    label: 'Teljes Gmail',
    scopes: ['https://mail.google.com/'],
  },
] as const

function connectorConfiguredScopes(connector: Connector): string[] {
  const config = connector.config as { oauth?: { scopes?: unknown } } | null
  const scopes = config?.oauth?.scopes
  if (!Array.isArray(scopes)) return [...GMAIL_SCOPE_PROFILES[0].scopes]
  return scopes.filter((scope): scope is string => typeof scope === 'string')
}

function availableScopeProfiles(connector: Connector) {
  const configured = new Set(connectorConfiguredScopes(connector))
  return GMAIL_SCOPE_PROFILES.filter((profile) =>
    profile.scopes.every((scope) => configured.has(scope)),
  )
}

function sameScopes(a: readonly string[], b: readonly string[]) {
  if (a.length !== b.length) return false
  return [...a].sort().every((scope, index) => scope === [...b].sort()[index])
}

function scopeText(scopes: unknown): string {
  if (!Array.isArray(scopes)) return 'nincs scope adat'
  const labels = scopes
    .filter((scope): scope is string => typeof scope === 'string')
    .map((scope) => scope.replace('https://www.googleapis.com/auth/', '').replace('https://', ''))
  return labels.length > 0 ? labels.join(', ') : 'nincs scope adat'
}

export function ConnectorsPanel() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [grants, setGrants] = useState<GrantRow[]>([])
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [selectedScopes, setSelectedScopes] = useState<Record<string, string[]>>({})
  const [error, setError] = useState<string | null>(() => {
    const err = searchParams.get('error')
    return err ? decodeURIComponent(err) : null
  })
  const [message, setMessage] = useState<string | null>(() =>
    searchParams.get('connected') === '1' ? 'Fiók sikeresen összekötve.' : null,
  )

  useEffect(() => {
    startTransition(async () => {
      const [g, c] = await Promise.all([listConnectorGrants(), listUserDelegatedConnectors()])
      if (g.success) setGrants(g.data)
      if (c.success) {
        setConnectors(c.data)
        setSelectedScopes((prev) => {
          const next = { ...prev }
          for (const connector of c.data) {
            next[connector.id] ??= connectorConfiguredScopes(connector)
          }
          return next
        })
      }
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
              const currentScopes = selectedScopes[connector.id] ?? connectorConfiguredScopes(connector)
              const scopeProfiles = availableScopeProfiles(connector)
              const currentProfile =
                scopeProfiles.find((profile) => sameScopes(profile.scopes, currentScopes)) ??
                scopeProfiles[0] ??
                GMAIL_SCOPE_PROFILES[0]
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
                    {activeGrant && (
                      <p className="text-xs text-ink-soft">Scope: {scopeText(activeGrant.scopes)}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
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
                      <>
                        {connector.type === 'gmail' && (
                          <select
                            value={currentProfile.id}
                            disabled={pending}
                            className="rounded-lg border border-line bg-panel px-2 py-1.5 text-sm text-ink"
                            onChange={(event) => {
                              const profile =
                                GMAIL_SCOPE_PROFILES.find((p) => p.id === event.target.value) ??
                                GMAIL_SCOPE_PROFILES[0]
                              setSelectedScopes((prev) => ({ ...prev, [connector.id]: [...profile.scopes] }))
                            }}
                          >
                            {scopeProfiles.map((profile) => (
                              <option key={profile.id} value={profile.id}>
                                {profile.label}
                              </option>
                            ))}
                          </select>
                        )}
                        <button
                          type="button"
                          disabled={pending}
                          className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white"
                          onClick={() =>
                            startTransition(async () => {
                              const res = await startConnectorOAuth({
                                connectorId: connector.id,
                                scopes: connector.type === 'gmail' ? currentScopes : undefined,
                              })
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
                      </>
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
