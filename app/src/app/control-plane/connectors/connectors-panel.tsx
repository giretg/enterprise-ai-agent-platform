'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import type { Connector, ConnectorGrant } from '@prisma/client'
import { Card } from '@/components/ui/shell'
import {
  listConnectorsPanelContext,
  revokeConnectorGrant,
  startConnectorOAuth,
  upsertTenantGoogleOAuth,
} from '@/app/actions/connector-grants'
import { decommissionActiveConnector } from '@/app/actions/provisioning'

type GrantRow = ConnectorGrant & {
  connector: { id: string; name: string; type: string; lifecycleState: string }
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
  const [isAdmin, setIsAdmin] = useState(false)
  const [decommissionTarget, setDecommissionTarget] = useState<string | null>(null)
  const [googleClientId, setGoogleClientId] = useState('')
  const [googleClientSecret, setGoogleClientSecret] = useState('')
  const [googleRedirectUri, setGoogleRedirectUri] = useState('')
  const [googleConfigured, setGoogleConfigured] = useState(false)
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
      const res = await listConnectorsPanelContext()
      if (!res.success) {
        setError(res.error)
        return
      }
      setGrants(res.data.grants as GrantRow[])
      setConnectors(res.data.connectors)
      setIsAdmin(res.data.isAdmin)
      setGoogleConfigured(Boolean(res.data.googleOauth?.configured))
      setGoogleRedirectUri(res.data.googleOauth?.redirectUri ?? '')
      setSelectedScopes((prev) => {
        const next = { ...prev }
        for (const connector of res.data.connectors) {
          next[connector.id] ??= connectorConfiguredScopes(connector)
        }
        return next
      })
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

      {isAdmin ? (
        <Card title="Tenant Google OAuth (admin)">
          <div className="space-y-3">
            <p className="text-sm text-ink-soft">
              Egyszeri tenant-szintű beállítás. Ezt használja minden Google connector, utána a
              felhasználóknak csak a saját OAuth belépés kell.
            </p>
            {googleConfigured ? (
              <p className="text-xs text-emerald-300">
                Beállítva. Új secret mentése felülírja a korábbit.
              </p>
            ) : null}
            <div className="grid gap-3 md:grid-cols-2">
              <input
                value={googleClientId}
                onChange={(e) => setGoogleClientId(e.target.value)}
                placeholder="Google OAuth Client ID"
                className="rounded-lg border border-line bg-panel px-3 py-2 text-sm"
              />
              <input
                type="password"
                value={googleClientSecret}
                onChange={(e) => setGoogleClientSecret(e.target.value)}
                placeholder="Google OAuth Client Secret"
                className="rounded-lg border border-line bg-panel px-3 py-2 text-sm"
              />
            </div>
            <input
              value={googleRedirectUri}
              onChange={(e) => setGoogleRedirectUri(e.target.value)}
              placeholder="Redirect URI (opcionális)"
              className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={pending || !googleClientId.trim() || !googleClientSecret.trim()}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
                onClick={() =>
                  startTransition(async () => {
                    const res = await upsertTenantGoogleOAuth({
                      clientId: googleClientId.trim(),
                      clientSecret: googleClientSecret.trim(),
                      ...(googleRedirectUri.trim() ? { redirectUri: googleRedirectUri.trim() } : {}),
                    })
                    if (res.success) {
                      setGoogleConfigured(true)
                      setGoogleClientSecret('')
                      setMessage('Tenant Google OAuth config mentve.')
                    } else {
                      setError(res.error)
                    }
                  })
                }
              >
                Mentés
              </button>
            </div>
          </div>
        </Card>
      ) : null}

      <Card title="Elérhető connectorok">
        <ul className="space-y-3">
          {connectors.length === 0 ? (
            <li className="text-sm text-ink-soft">Nincs user_delegated connector konfigurálva.</li>
          ) : (
            connectors.map((connector) => {
              const activeGrant = grants.find(
                (g) =>
                  g.connectorId === connector.id &&
                  g.status === 'active' &&
                  g.connector.lifecycleState === 'active',
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
                      {connector.tenantId ? '' : ' · globális'}
                    </p>
                    {activeGrant?.accountLabel && (
                      <p className="text-xs text-emerald-300/90">Összekötve: {activeGrant.accountLabel}</p>
                    )}
                    {activeGrant && (
                      <p className="text-xs text-ink-soft">Scope: {scopeText(activeGrant.scopes)}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {isAdmin ? (
                      decommissionTarget === connector.id ? (
                        <>
                          <span className="text-xs text-coral">Biztosan leszereljük?</span>
                          <button
                            type="button"
                            disabled={pending}
                            className="rounded-lg border border-coral/50 bg-coral/10 px-3 py-1.5 text-sm text-coral"
                            onClick={() =>
                              startTransition(async () => {
                                const res = await decommissionActiveConnector({
                                  connectorId: connector.id,
                                  reason: 'Admin leszerelés az Összekötött fiókok felületről',
                                })
                                if (res.success) {
                                  setConnectors((prev) => prev.filter((c) => c.id !== connector.id))
                                  setGrants((prev) =>
                                    prev.filter((g) => g.connectorId !== connector.id),
                                  )
                                  setDecommissionTarget(null)
                                  setMessage('Connector leszerelve és archiválva.')
                                } else setError(res.error)
                              })
                            }
                          >
                            Igen, megszüntetés
                          </button>
                          <button
                            type="button"
                            className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-soft"
                            onClick={() => setDecommissionTarget(null)}
                          >
                            Mégse
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={pending}
                          className="rounded-lg border border-coral/40 px-3 py-1.5 text-sm text-coral hover:bg-coral/10"
                          onClick={() => setDecommissionTarget(connector.id)}
                        >
                          Leszerelés
                        </button>
                      )
                    ) : null}
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
