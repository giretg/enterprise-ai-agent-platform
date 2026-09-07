'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { revokeConnectorGrant, startConnectorOAuth } from '@/app/actions/connector-grants'
import { ConnectionCard } from '@/components/account/connection-card'
import { GoogleDrivePickerPanel } from '@/components/account/google-drive-picker-panel'
import { GMAIL_SCOPES } from '@/domain/connector-grant/gmail-scopes'
import {
  DRIVE_SCOPE_PROFILES,
  driveScopeProfile,
  parseDriveScopes,
} from '@/domain/connector-grant/google-drive-scopes'
import {
  emptyGoogleDriveGrantMetadata,
  parseGoogleDriveGrantMetadata,
  type GoogleDriveGrantMetadata,
} from '@/domain/connector-grant/google-drive-grant-metadata'
import { delegatedConnectorLabel } from '@/domain/connector-grant/delegated-oauth-registry'
import { connectorUsageStatus } from '@/components/account/linked-account-view'
import {
  connectorScopeProfileDescription,
  driveGrantScopeSummary,
  gmailGrantScopeSummary,
} from '@/components/account/delegated-oauth-ui'

export type LinkedConnectorView = {
  id: string
  name: string
  type: string
  authMode: string
  tenantId: string | null
  config: unknown
  assignedAgentCount: number
  capableAgentCount: number
  capableAgentDisplayNames: string[]
}

export type LinkedGrantView = {
  id: string
  connectorId: string
  status: string
  accountLabel: string | null
  scopes: unknown
  grantedAt: string
  metadata?: unknown
}

const GMAIL_SCOPE_PROFILES = [
  {
    id: 'modify',
    label: 'Olvasás + írás',
    scopes: [GMAIL_SCOPES.modify],
  },
  {
    id: 'readonly',
    label: 'Csak olvasás',
    scopes: [GMAIL_SCOPES.readonly],
  },
  {
    id: 'compose',
    label: 'Piszkozat + küldés',
    scopes: [GMAIL_SCOPES.compose],
  },
  {
    id: 'send',
    label: 'Csak küldés',
    scopes: [GMAIL_SCOPES.send],
  },
  {
    id: 'full',
    label: 'Teljes Gmail',
    scopes: [GMAIL_SCOPES.full],
  },
] as const

function connectorConfiguredScopes(connector: LinkedConnectorView): string[] {
  const config = connector.config as { oauth?: { scopes?: unknown } } | null
  const scopes = config?.oauth?.scopes
  if (connector.type === 'google_drive') {
    if (!Array.isArray(scopes)) return [...DRIVE_SCOPE_PROFILES[0].scopes]
    return scopes.filter((scope): scope is string => typeof scope === 'string')
  }
  if (!Array.isArray(scopes)) return [...GMAIL_SCOPE_PROFILES[0].scopes]
  return scopes.filter((scope): scope is string => typeof scope === 'string')
}

function availableScopeProfiles(connector: LinkedConnectorView, isAdmin: boolean) {
  const configured = new Set(connectorConfiguredScopes(connector))
  if (connector.type === 'google_drive') {
    return DRIVE_SCOPE_PROFILES.filter((profile) => {
      if ('adminOnly' in profile && profile.adminOnly && !isAdmin) return false
      return profile.scopes.every((scope) => configured.has(scope))
    }).map((profile) => ({ id: profile.id, label: profile.label, scopes: [...profile.scopes] }))
  }
  return GMAIL_SCOPE_PROFILES.filter((profile) =>
    profile.scopes.every((scope) => configured.has(scope)),
  )
}

function sameScopes(a: readonly string[], b: readonly string[]) {
  if (a.length !== b.length) return false
  return [...a].sort().every((scope, index) => scope === [...b].sort()[index])
}

function scopeSummary(connectorType: string, scopes: unknown): string {
  if (connectorType === 'google_drive') {
    return driveGrantScopeSummary(scopes).label
  }
  if (connectorType === 'gmail') {
    return gmailGrantScopeSummary(scopes).label
  }
  if (!Array.isArray(scopes)) return 'nincs scope adat'
  const labels = scopes
    .filter((scope): scope is string => typeof scope === 'string')
    .map((scope) => scope.replace('https://www.googleapis.com/auth/', '').replace('https://', ''))
  return labels.length > 0 ? labels.join(', ') : 'nincs scope adat'
}

function connectedGrantSummary(connector: LinkedConnectorView, grant: LinkedGrantView): string {
  const account = grant.accountLabel ?? 'Fiók'
  return `${account} · ${scopeSummary(connector.type, grant.scopes)}`
}

function connectorDescription(connector: LinkedConnectorView): string {
  if (connector.type === 'gmail') {
    return 'AI munkatárs a te Gmail-fiókoddal olvas és ír — csak a te engedélyeddel, a te nevedben.'
  }
  if (connector.type === 'google_drive') {
    return 'Az AI munkatárs a te engedélyeddel kereshet és olvashat Drive-fájlokat. Ha írási profilt választasz, a jóváhagyási szabályok szerint létrehozhat vagy módosíthat fájlokat is.'
  }
  return `Az agent a te ${delegatedConnectorLabel(connector.type, connector.name)} fiókoddal jár el.`
}

function grantMetadata(raw: unknown): GoogleDriveGrantMetadata {
  return parseGoogleDriveGrantMetadata(raw as never)
}

export function ConnectorConnectionCard({
  connector,
  grants,
  isAdmin = false,
  drivePickerConfigured = false,
}: {
  connector: LinkedConnectorView
  grants: LinkedGrantView[]
  isAdmin?: boolean
  drivePickerConfigured?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [selectedScopes, setSelectedScopes] = useState<string[]>(() =>
    connectorConfiguredScopes(connector),
  )
  const [localGrants, setLocalGrants] = useState(grants)

  const activeGrant = localGrants.find((g) => g.connectorId === connector.id && g.status === 'active')
  const history = localGrants.filter((g) => g !== activeGrant)
  const scopeProfiles = availableScopeProfiles(connector, isAdmin)
  const currentProfile =
    scopeProfiles.find((profile) => sameScopes(profile.scopes, selectedScopes)) ??
    scopeProfiles[0] ??
    GMAIL_SCOPE_PROFILES[0]
  const usage = connectorUsageStatus(connector)
  const showDrivePicker =
    connector.type === 'google_drive' &&
    activeGrant &&
    driveScopeProfile(parseDriveScopes(activeGrant.scopes as never)) === 'selected_write'

  return (
    <ConnectionCard
      name={delegatedConnectorLabel(connector.type, connector.name)}
      provider={connector.type}
      description={connectorDescription(connector)}
      connected={Boolean(activeGrant)}
      connectedDetail={
        activeGrant ? connectedGrantSummary(connector, activeGrant) : undefined
      }
    >
      {activeGrant ? (
        <div className="space-y-3">
          <p
            className={`rounded-lg border px-3 py-2 text-sm ${
              usage.usable
                ? 'border-sage/35 bg-sage/10 text-sage'
                : 'border-amber/40 bg-amber/10 text-ink-soft'
            }`}
          >
            {usage.text}
          </p>
          {connector.type === 'google_drive' && activeGrant ? (
            <p className="text-xs leading-5 text-ink-soft">
              {driveGrantScopeSummary(activeGrant.scopes).description}
            </p>
          ) : null}
          {showDrivePicker ? (
            <GoogleDrivePickerPanel
              grantId={activeGrant.id}
              initialMetadata={grantMetadata(activeGrant.metadata ?? emptyGoogleDriveGrantMetadata())}
              pickerConfigured={drivePickerConfigured}
            />
          ) : null}
          {(connector.type === 'gmail' || connector.type === 'google_drive') && (
            <p className="text-xs text-ink-faint">
              Más jogosultsági profilhoz bontsd az összekötést, válaszd ki az új profilt, majd kösd
              újra össze.
            </p>
          )}
          <button
            type="button"
            disabled={pending}
            className="rounded-full border border-coral/50 px-4 py-2 text-sm font-semibold text-coral-deep disabled:opacity-50"
            onClick={() =>
              startTransition(async () => {
                const res = await revokeConnectorGrant({ grantId: activeGrant.id })
                if (res.success) {
                  setLocalGrants((prev) =>
                    prev.map((g) => (g.id === activeGrant.id ? { ...g, status: 'revoked' } : g)),
                  )
                  setMessage({ ok: true, text: 'Az összekötést megszüntettük.' })
                  router.refresh()
                } else {
                  setMessage({ ok: false, text: res.error })
                }
              })
            }
          >
            Összekötés megszüntetése
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {(connector.type === 'gmail' || connector.type === 'google_drive') && (
              <select
                value={currentProfile.id}
                disabled={pending}
                className="rounded-lg border border-line bg-panel px-2 py-1.5 text-sm text-ink"
                onChange={(event) => {
                  const profile =
                    scopeProfiles.find((p) => p.id === event.target.value) ?? scopeProfiles[0]
                  if (profile) setSelectedScopes([...profile.scopes])
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
              className="rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(178,58,85,0.7)] disabled:opacity-50"
              onClick={() =>
                startTransition(async () => {
                  const res = await startConnectorOAuth({
                    connectorId: connector.id,
                    scopes:
                      connector.type === 'gmail' || connector.type === 'google_drive'
                        ? selectedScopes
                        : undefined,
                  })
                  if (res.success) {
                    if ('stub' in res.data && res.data.stub) {
                      router.refresh()
                      setMessage({ ok: true, text: 'Fiók sikeresen összekötve (stub).' })
                    } else {
                      window.location.href = res.data.url
                    }
                  } else {
                    setMessage({ ok: false, text: res.error })
                  }
                })
              }
            >
              Összekötés
            </button>
          </div>
          {connector.type === 'google_drive' ? (
            <p className="max-w-2xl text-xs leading-5 text-ink-soft">
              {connectorScopeProfileDescription(connector.type, currentProfile.id) ??
                'Válaszd ki, milyen Drive-hozzáférést adsz az agentnek.'}
            </p>
          ) : null}
        </div>
      )}

      {message && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            message.ok
              ? 'border-sage/35 bg-sage/10 text-sage'
              : 'border-coral/35 bg-coral/10 text-coral-deep'
          }`}
        >
          {message.text}
        </div>
      )}

      {history.length > 0 && (
        <div className="border-t border-line/60 pt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Korábbi összekötések
          </p>
          <ul className="space-y-1 text-sm text-ink-soft">
            {history.map((grant) => (
              <li key={grant.id} className="flex flex-wrap justify-between gap-x-3">
                <span>
                  {grant.accountLabel ?? '—'} ({grant.status})
                </span>
                <span>{new Date(grant.grantedAt).toLocaleString('hu-HU')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ConnectionCard>
  )
}
