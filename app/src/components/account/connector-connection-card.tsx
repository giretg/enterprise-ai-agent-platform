'use client'

import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useState, useTransition } from 'react'
import { formatDateTime } from '@/i18n/format'
import { asTranslate } from '@/i18n/translate'
import {
  revokeConnectorGrant,
  startConnectorOAuth,
  updateConnectorGrantNickname,
} from '@/app/actions/connector-grants'
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
  nickname: string | null
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

function grantDisplayName(grant: LinkedGrantView, t: (key: string) => string): string {
  if (grant.nickname?.trim()) {
    return grant.accountLabel ? `${grant.nickname} (${grant.accountLabel})` : grant.nickname
  }
  return grant.accountLabel ?? t('account')
}

function connectedGrantSummary(
  connector: LinkedConnectorView,
  grants: LinkedGrantView[],
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (grants.length === 1) {
    return `${grantDisplayName(grants[0], t)} · ${scopeSummary(connector.type, grants[0].scopes, t)}`
  }
  const names = grants.map((grant) => grant.nickname?.trim() || grant.accountLabel || t('account'))
  return t('accountsCount', { count: grants.length, names: names.join(', ') })
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

function NicknameField({
  value,
  disabled,
  t,
  onChange,
  onPreset,
  showHint = true,
}: {
  value: string
  disabled: boolean
  t: (key: string) => string
  onChange: (value: string) => void
  onPreset?: (value: string) => void
  showHint?: boolean
}) {
  const presets = [t('nicknamePersonal'), t('nicknameWork')]
  return (
    <div className="flex min-w-[12rem] flex-col gap-1.5">
      <label className="text-[11px] font-semibold text-ink-soft">
        {t('nicknameLabel')}
        <input
          value={value}
          disabled={disabled}
          maxLength={40}
          placeholder={t('nicknamePlaceholder')}
          className="mt-1 w-full rounded-full border border-line bg-panel px-3 py-1.5 text-xs text-ink"
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {showHint ? (
        <p className="text-[11px] font-normal leading-4 text-ink-faint">{t('nicknameHint')}</p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            disabled={disabled}
            className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:bg-ink/5 disabled:opacity-50"
            onClick={() => {
              onChange(preset)
              onPreset?.(preset)
            }}
          >
            {preset}
          </button>
        ))}
      </div>
    </div>
  )
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
  const [nickname, setNickname] = useState('')
  const [adding, setAdding] = useState(false)

  const activeGrants = localGrants.filter((g) => g.connectorId === connector.id && g.status === 'active')
  const history = localGrants.filter((g) => !activeGrants.includes(g))
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
  const pickerGrants = activeGrants.filter(
    (grant) =>
      connector.type === 'google_drive' &&
      driveScopeProfile(parseDriveScopes(grant.scopes as never)) === 'selected_write',
  )
  const appCreated = activeGrants.flatMap(
    (grant) => grantMetadata(grant.metadata ?? emptyGoogleDriveGrantMetadata()).appCreated,
  )

  const tabs: { id: DetailTab; label: string }[] = [
    { id: 'overview', label: t('tabOverview') },
    ...(pickerGrants.length > 0 ? [{ id: 'files' as const, label: t('tabFiles') }] : []),
    ...(appCreated.length > 0
      ? [{ id: 'created' as const, label: t('tabCreated', { count: appCreated.length }) }]
      : []),
    ...(history.length > 0 ? [{ id: 'history' as const, label: t('tabHistory') }] : []),
  ]

  const revoke = (grantId: string) =>
    startTransition(async () => {
      const res = await revokeConnectorGrant({ grantId })
      if (res.success) {
        setLocalGrants((prev) =>
          prev.map((g) => (g.id === grantId ? { ...g, status: 'revoked' } : g)),
        )
        setMessage({ ok: true, text: t('revoked') })
        router.refresh()
      } else {
        setMessage({ ok: false, text: res.error })
      }
    })

  const saveNickname = (grantId: string, value: string) =>
    startTransition(async () => {
      const res = await updateConnectorGrantNickname({
        grantId,
        nickname: value.trim() ? value : null,
      })
      if (res.success) {
        setLocalGrants((prev) =>
          prev.map((g) => (g.id === grantId ? { ...g, nickname: value.trim() || null } : g)),
        )
        setMessage({ ok: true, text: t('nicknameSaved') })
        router.refresh()
      } else if (res.error === 'nickname_taken') {
        setMessage({ ok: false, text: t('nicknameTaken') })
      } else if (res.error === 'invalid_nickname') {
        setMessage({ ok: false, text: t('invalidNickname') })
      } else {
        setMessage({ ok: false, text: res.error })
      }
    })

  const connect = (addAccount: boolean) => {
    if (addAccount && isGoogle && !nickname.trim()) {
      setMessage({ ok: false, text: t('nicknameRequiredAdd') })
      return
    }
    startTransition(async () => {
      const res = await startConnectorOAuth({
        connectorId: connector.id,
        scopes: isGoogle ? selectedScopes : undefined,
        ...(nickname.trim() ? { nickname: nickname.trim() } : {}),
        ...(addAccount ? { addAccount: true } : {}),
      })
      if (res.success) {
        if ('stub' in res.data && res.data.stub) {
          router.refresh()
          setMessage({ ok: true, text: t('stubConnected') })
        } else {
          navigateToOAuth(res.data.url)
        }
      } else if (res.error === 'nickname_taken') {
        setMessage({ ok: false, text: t('nicknameTaken') })
      } else {
        setMessage({ ok: false, text: res.error })
      }
    })
  }

  const startAdding = () => {
    setOpen(true)
    setTab('overview')
    setAdding(true)
  }

  const grantStatusLabel = (status: string) => {
    if (status === 'active') return t('statusActive')
    if (status === 'revoked') return t('statusRevoked')
    return status
  }

  const scopeSelect = (
    <select
      value={currentProfile.id}
      disabled={pending}
      aria-label={t('accessLevel')}
      className="rounded-full border border-line bg-panel px-3 py-1.5 text-xs text-ink"
      onChange={(event) => {
        const profile = scopeProfiles.find((p) => p.id === event.target.value) ?? scopeProfiles[0]
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
  )

  const messageBox = message ? (
    <p
      className={`rounded-lg px-3 py-2 text-xs ${
        message.ok ? 'bg-sage/10 text-sage' : 'bg-coral/10 text-coral-deep'
      }`}
    >
      {message.text}
    </p>
  ) : null

  if (activeGrants.length === 0) {
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
        actions={isGoogle ? scopeSelect : undefined}
      >
        <div className="space-y-3">
          {isGoogle ? (
            <NicknameField value={nickname} disabled={pending} t={t} onChange={setNickname} />
          ) : null}
          <button
            type="button"
            disabled={pending}
            className="rounded-full bg-coral px-4 py-1.5 text-xs font-semibold text-card shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
            onClick={() => connect(false)}
          >
            {t('connect')}
          </button>
          {messageBox}
        </div>
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
      summary={connectedGrantSummary(connector, activeGrants, t)}
      actions={
        <>
          {isGoogle ? (
            <button type="button" className={pillButton} onClick={startAdding}>
              {t('addAccount')}
            </button>
          ) : null}
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
        </>
      }
    >
      {open || message ? (
        <div className="space-y-4">
          {open && tabs.length > 1 ? (
            <div role="tablist" className="flex gap-1 border-b border-line/60">
              {tabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  className={`-mb-px border-b-2 px-3 py-1.5 text-xs font-semibold transition-colors ${
                    tab === item.id
                      ? 'border-coral text-ink'
                      : 'border-transparent text-ink-soft hover:text-ink'
                  }`}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}

          {open && tab === 'overview' ? (
            <div className="space-y-3 text-xs leading-5 text-ink-soft">
              <p>{connectorDescription(connector, t)}</p>
              <p className={usage.usable ? 'text-sage' : 'text-honey'}>{usage.text}</p>
              <p>{t('changeLevelHint')}</p>
              <ul className="divide-y divide-line/50">
                {activeGrants.map((grant) => (
                  <li key={grant.id} className="space-y-2 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-ink">{grantDisplayName(grant, t)}</span>
                      <span>{scopeSummary(connector.type, grant.scopes, t)}</span>
                    </div>
                    {isGoogle ? (
                      <NicknameField
                        value={grant.nickname ?? ''}
                        disabled={pending}
                        t={t}
                        showHint={false}
                        onChange={(value) =>
                          setLocalGrants((prev) =>
                            prev.map((row) => (row.id === grant.id ? { ...row, nickname: value } : row)),
                          )
                        }
                        onPreset={(value) => saveNickname(grant.id, value)}
                      />
                    ) : null}
                    <div className="flex flex-wrap justify-end gap-2">
                      {isGoogle ? (
                        <button
                          type="button"
                          disabled={pending}
                          className={pillButton}
                          onClick={() => saveNickname(grant.id, grant.nickname ?? '')}
                        >
                          {t('saveNickname')}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={pending}
                        className="rounded-full px-3 py-1.5 text-xs font-semibold text-coral-deep transition-colors hover:bg-coral/10 disabled:opacity-50"
                        onClick={() => revoke(grant.id)}
                      >
                        {t('disconnect')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {isGoogle ? (
                adding ? (
                  <div className="space-y-2 rounded-xl border border-dashed border-line px-3 py-3">
                    <NicknameField value={nickname} disabled={pending} t={t} onChange={setNickname} />
                    <div className="flex flex-wrap items-center gap-2">
                      {scopeSelect}
                      <button
                        type="button"
                        disabled={pending || !nickname.trim()}
                        className="rounded-full bg-coral px-4 py-1.5 text-xs font-semibold text-card shadow-sm disabled:opacity-50"
                        onClick={() => connect(true)}
                      >
                        {t('connect')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className={pillButton} onClick={startAdding}>
                    {t('addAccount')}
                  </button>
                )
              ) : null}
            </div>
          ) : null}

          {open && tab === 'files'
            ? pickerGrants.map((grant) => (
                <div key={grant.id} className="space-y-2">
                  <p className="text-xs font-semibold text-ink">{grantDisplayName(grant, t)}</p>
                  <GoogleDrivePickerPanel
                    grantId={grant.id}
                    initialMetadata={grantMetadata(grant.metadata ?? emptyGoogleDriveGrantMetadata())}
                    pickerConfigured={drivePickerConfigured}
                  />
                </div>
              ))
            : null}

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
                    {grantDisplayName(grant, t)} ({grantStatusLabel(grant.status)})
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
