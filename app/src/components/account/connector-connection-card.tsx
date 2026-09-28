'use client'

import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useState, useTransition } from 'react'
import { formatDateTime } from '@/i18n/format'
import { asTranslate } from '@/i18n/translate'
import { revokeConnectorGrant, startConnectorOAuth } from '@/app/actions/connector-grants'
import { navigateToOAuth } from '@/lib/oauth-navigation'
import { ConnectionCard, StatusDot } from '@/components/account/connection-card'
import {
  GoogleDrivePickerPanel,
  selectionLabel,
} from '@/components/account/google-drive-picker-panel'
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
  /** Sablonból készült konnektornál a sablon ikonja; egyébként generikus ikon látszik. */
  iconDataUrl?: string | null
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

const GMAIL_LABEL_KEYS = {
  modify: 'gmailModify',
  readonly: 'gmailReadonly',
  compose: 'gmailCompose',
  send: 'gmailSend',
  full: 'gmailFull',
} as const

const DRIVE_LABEL_KEYS = {
  readonly: 'driveReadonly',
  selected_write: 'driveSelectedWrite',
  full_write: 'driveFullWrite',
} as const

const DRIVE_DESC_KEYS = {
  readonly: 'driveReadonlyDesc',
  selected_write: 'driveSelectedWriteDesc',
  full_write: 'driveFullWriteDesc',
} as const

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

function scopeSummary(
  connectorType: string,
  scopes: unknown,
  t: (key: string) => string,
): string {
  if (connectorType === 'google_drive') {
    const id = driveScopeProfile(parseDriveScopes(scopes as never))
    const key = id && id in DRIVE_LABEL_KEYS ? DRIVE_LABEL_KEYS[id as keyof typeof DRIVE_LABEL_KEYS] : null
    return key ? t(key) : t('unknownProfile')
  }
  if (connectorType === 'gmail') {
    const label = gmailGrantScopeSummary(scopes).label
    const match = (Object.keys(GMAIL_LABEL_KEYS) as Array<keyof typeof GMAIL_LABEL_KEYS>).find(
      (id) => GMAIL_SCOPE_PROFILES.find((p) => p.id === id)?.label === label,
    )
    return match ? t(GMAIL_LABEL_KEYS[match]) : t('gmailCustom')
  }
  if (!Array.isArray(scopes)) return t('noScope')
  const labels = scopes
    .filter((scope): scope is string => typeof scope === 'string')
    .map((scope) => scope.replace('https://www.googleapis.com/auth/', '').replace('https://', ''))
  return labels.length > 0 ? labels.join(', ') : t('noScope')
}

function connectedGrantSummary(
  connector: LinkedConnectorView,
  grant: LinkedGrantView,
  t: (key: string) => string,
): string {
  const account = grant.accountLabel ?? t('account')
  return `${account} · ${scopeSummary(connector.type, grant.scopes, t)}`
}

function connectorDescription(connector: LinkedConnectorView, t: (key: string, values?: Record<string, string>) => string): string {
  if (connector.type === 'gmail') return t('gmailDesc')
  if (connector.type === 'google_drive') return t('driveDesc')
  return t('genericDesc', { name: delegatedConnectorLabel(connector.type, connector.name) })
}

function grantMetadata(raw: unknown): GoogleDriveGrantMetadata {
  return parseGoogleDriveGrantMetadata(raw as never)
}

type DetailTab = 'overview' | 'files' | 'created' | 'history'

const pillButton =
  'rounded-full border border-line px-3.5 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-ink/5 disabled:opacity-50'

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
  const t = asTranslate(useTranslations('Account'))
  const locale = useLocale()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [selectedScopes, setSelectedScopes] = useState<string[]>(() =>
    connectorConfiguredScopes(connector),
  )
  const [localGrants, setLocalGrants] = useState(grants)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<DetailTab>('overview')

  const activeGrant = localGrants.find((g) => g.connectorId === connector.id && g.status === 'active')
  const history = localGrants.filter((g) => g !== activeGrant)
  const scopeProfiles = availableScopeProfiles(connector, isAdmin)
  const currentProfile =
    scopeProfiles.find((profile) => sameScopes(profile.scopes, selectedScopes)) ??
    scopeProfiles[0] ??
    GMAIL_SCOPE_PROFILES[0]
  const usage = connectorUsageStatus(connector, {
    and: t('and'),
    capableOne: (list) => t('usageCapableOne', { list }),
    capableMany: (list) => t('usageCapableMany', { list }),
    capableCount: (count) => t('usageCapableCount', { count }),
    missingCapability: t('usageMissingCapability'),
    unassigned: t('usageUnassigned'),
  })
  const isGoogle = connector.type === 'gmail' || connector.type === 'google_drive'
  const showDrivePicker =
    connector.type === 'google_drive' &&
    activeGrant &&
    driveScopeProfile(parseDriveScopes(activeGrant.scopes as never)) === 'selected_write'
  const driveMetadata =
    connector.type === 'google_drive' && activeGrant
      ? grantMetadata(activeGrant.metadata ?? emptyGoogleDriveGrantMetadata())
      : null
  const appCreated = driveMetadata?.appCreated ?? []

  const tabs: { id: DetailTab; label: string }[] = [
    { id: 'overview', label: t('tabOverview') },
    ...(showDrivePicker ? [{ id: 'files' as const, label: t('tabFiles') }] : []),
    ...(appCreated.length > 0
      ? [{ id: 'created' as const, label: t('tabCreated', { count: appCreated.length }) }]
      : []),
    ...(history.length > 0 ? [{ id: 'history' as const, label: t('tabHistory') }] : []),
  ]

  const revoke = () =>
    startTransition(async () => {
      if (!activeGrant) return
      const res = await revokeConnectorGrant({ grantId: activeGrant.id })
      if (res.success) {
        setLocalGrants((prev) =>
          prev.map((g) => (g.id === activeGrant.id ? { ...g, status: 'revoked' } : g)),
        )
        setMessage({ ok: true, text: t('revoked') })
        router.refresh()
      } else {
        setMessage({ ok: false, text: res.error })
      }
    })

  const connect = () =>
    startTransition(async () => {
      const res = await startConnectorOAuth({
        connectorId: connector.id,
        scopes: isGoogle ? selectedScopes : undefined,
      })
      if (res.success) {
        if ('stub' in res.data && res.data.stub) {
          router.refresh()
          setMessage({ ok: true, text: t('stubConnected') })
        } else {
          navigateToOAuth(res.data.url)
        }
      } else {
        setMessage({ ok: false, text: res.error })
      }
    })

  const messageBox = message ? (
    <p
      className={`rounded-lg px-3 py-2 text-xs ${
        message.ok ? 'bg-sage/10 text-sage' : 'bg-coral/10 text-coral-deep'
      }`}
    >
      {message.text}
    </p>
  ) : null

  if (!activeGrant) {
    const hint =
      connector.type === 'google_drive'
        ? connectorScopeProfileDescription(connector.type, currentProfile.id)
        : null
    return (
      <ConnectionCard
        name={delegatedConnectorLabel(connector.type, connector.name)}
        provider={connector.type}
        iconDataUrl={connector.iconDataUrl}
        summary={<span title={hint ?? undefined}>{connectorDescription(connector, t)}</span>}
        actions={
          <>
            {isGoogle && (
              <select
                value={currentProfile.id}
                disabled={pending}
                aria-label={t('accessLevel')}
                title={hint ?? undefined}
                className="rounded-full border border-line bg-panel px-3 py-1.5 text-xs text-ink"
                onChange={(event) => {
                  const profile =
                    scopeProfiles.find((p) => p.id === event.target.value) ?? scopeProfiles[0]
                  if (profile) setSelectedScopes([...profile.scopes])
                }}
              >
                {scopeProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.id in GMAIL_LABEL_KEYS
                      ? t(GMAIL_LABEL_KEYS[profile.id as keyof typeof GMAIL_LABEL_KEYS])
                      : profile.id in DRIVE_LABEL_KEYS
                        ? t(DRIVE_LABEL_KEYS[profile.id as keyof typeof DRIVE_LABEL_KEYS])
                        : profile.label}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              disabled={pending}
              className="rounded-full bg-coral px-4 py-1.5 text-xs font-semibold text-card shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
              onClick={connect}
            >
              {t('connect')}
            </button>
          </>
        }
      >
        {messageBox}
      </ConnectionCard>
    )
  }

  return (
    <ConnectionCard
      name={delegatedConnectorLabel(connector.type, connector.name)}
      provider={connector.type}
      iconDataUrl={connector.iconDataUrl}
      status={
        <StatusDot tone={usage.usable ? 'ok' : 'warn'}>
          {usage.usable ? t('connected') : t('unused')}
        </StatusDot>
      }
      summary={connectedGrantSummary(connector, activeGrant, t)}
      actions={
        <button
          type="button"
          aria-expanded={open}
          className={pillButton}
          onClick={() => setOpen((v) => !v)}
        >
          {t('details')}
          <span
            aria-hidden="true"
            className={`ml-1.5 inline-block transition-transform ${open ? 'rotate-180' : ''}`}
          >
            ▾
          </span>
        </button>
      }
    >
      {open || message ? (
        <div className="space-y-4">
          {open && tabs.length > 1 ? (
            <div role="tablist" className="flex gap-1 border-b border-line/60">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  className={`-mb-px border-b-2 px-3 py-1.5 text-xs font-semibold transition-colors ${
                    tab === t.id
                      ? 'border-coral text-ink'
                      : 'border-transparent text-ink-soft hover:text-ink'
                  }`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ) : null}

          {open && tab === 'overview' ? (
            <div className="space-y-3 text-xs leading-5 text-ink-soft">
              <p>{connectorDescription(connector, t)}</p>
              <p className={usage.usable ? 'text-sage' : 'text-honey'}>{usage.text}</p>
              {connector.type === 'google_drive' ? (
                <p>
                  {(() => {
                    const id = driveScopeProfile(parseDriveScopes(activeGrant.scopes as never))
                    return id && id in DRIVE_DESC_KEYS
                      ? t(DRIVE_DESC_KEYS[id as keyof typeof DRIVE_DESC_KEYS])
                      : driveGrantScopeSummary(activeGrant.scopes).description
                  })()}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line/50 pt-3">
                {isGoogle ? (
                  <p className="text-ink-faint">
                    {t('changeLevelHint')}
                  </p>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-full px-3 py-1.5 text-xs font-semibold text-coral-deep transition-colors hover:bg-coral/10 disabled:opacity-50"
                  onClick={revoke}
                >
                  {t('disconnect')}
                </button>
              </div>
            </div>
          ) : null}

          {open && tab === 'files' && showDrivePicker && driveMetadata ? (
            <GoogleDrivePickerPanel
              grantId={activeGrant.id}
              initialMetadata={driveMetadata}
              pickerConfigured={drivePickerConfigured}
            />
          ) : null}

          {open && tab === 'created' ? (
            <ul className="divide-y divide-line/50 text-xs">
              {appCreated.map((entry) => (
                <li key={entry.fileId} className="flex justify-between gap-3 py-1.5" title={entry.fileId}>
                  <span className="truncate text-ink">{entry.name}</span>
                  <span className="shrink-0 text-ink-faint">
                    {selectionLabel(entry.mimeType, t('folder'), t('file'))}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {open && tab === 'history' ? (
            <ul className="divide-y divide-line/50 text-xs text-ink-soft">
              {history.map((grant) => (
                <li key={grant.id} className="flex flex-wrap justify-between gap-x-3 py-1.5">
                  <span>
                    {grant.accountLabel ?? '—'} ({grant.status})
                  </span>
                  <span>{formatDateTime(grant.grantedAt, locale)}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {messageBox}
        </div>
      ) : null}
    </ConnectionCard>
  )
}
