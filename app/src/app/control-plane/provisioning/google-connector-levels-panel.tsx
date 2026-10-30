'use client'

import { updateGoogleAccountBinding } from '@/lib/connector-update-publishing'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  formatGoogleAccountId,
  splitGoogleAccountIds,
  type GoogleAccountBindingProvider,
} from '@/domain/connector/google-account-binding'

export type GoogleAccountViewRow = {
  provider: GoogleAccountBindingProvider
  accountIds: string[]
  managerAccountId: string | null
  bound: boolean
  legacyDeveloperToken: boolean
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${ok ? 'bg-sage' : 'bg-honey'}`} />
}

/**
 * Google Ads / Analytics / Search Console konnektor három szintje egy helyen:
 * platform (OAuth app, Ads developer token) · cég (melyik fiók) · felhasználó (saját Google-belépés).
 * A cég-szintű fiókkötés itt szerkeszthető — újranyitás és a belépések visszavonása nélkül.
 */
export function GoogleConnectorLevelsPanel({
  draftId,
  view,
  googleApiOauthConfigured,
  googleAdsDeveloperTokenConfigured,
  pending,
  run,
}: {
  draftId: string
  view: GoogleAccountViewRow
  googleApiOauthConfigured: boolean
  googleAdsDeveloperTokenConfigured: boolean
  pending: boolean
  run: (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => void
}) {
  const t = useTranslations('Provisioning')
  const isAds = view.provider === 'google-ads'
  const [editing, setEditing] = useState(false)
  const [accounts, setAccounts] = useState('')
  const [manager, setManager] = useState('')

  const startEdit = () => {
    setAccounts(view.accountIds.map((id) => formatGoogleAccountId(view.provider, id)).join('\n'))
    setManager(view.managerAccountId ? formatGoogleAccountId('google-ads', view.managerAccountId) : '')
    setEditing(true)
  }

  const save = () => {
    const accountIds = splitGoogleAccountIds(accounts)
    run(async () => {
      const res = await updateGoogleAccountBinding({
        draftId,
        accountIds,
        ...(isAds ? { managerAccountId: manager.trim() } : {}),
      })
      if (res.success) setEditing(false)
      return res
    }, t('googleBindingSaved'))
  }

  const adsTokenOk = googleAdsDeveloperTokenConfigured || view.legacyDeveloperToken

  return (
    <section className="space-y-3 rounded-md border border-ink/12 bg-paper p-4">
      <div>
        <h4 className="text-sm font-semibold">{t('googleLevelsTitle')}</h4>
        <p className="mt-1 text-xs text-ink-soft">{t('googleLevelsHelp')}</p>
      </div>

      <ol className="grid gap-3 md:grid-cols-3">
        <li className="space-y-1 rounded-md border border-ink/10 bg-wash/35 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">1 · {t('googleLevelPlatform')}</p>
          <p className="flex items-start gap-2 text-xs">
            <StatusDot ok={googleApiOauthConfigured} />
            <span>
              {t('googleLevelPlatformOauth')}:{' '}
              {googleApiOauthConfigured ? t('googleLevelPlatformOk') : t('googleLevelPlatformMissing')}
            </span>
          </p>
          {isAds ? (
            <p className="flex items-start gap-2 text-xs">
              <StatusDot ok={adsTokenOk} />
              <span>
                {t('googleLevelPlatformAdsToken')}:{' '}
                {adsTokenOk ? t('googleLevelPlatformOk') : t('googleLevelPlatformMissing')}
              </span>
            </p>
          ) : null}
          {isAds && view.legacyDeveloperToken ? (
            <p className="text-xs text-ink-soft">{t('googleLegacyDeveloperToken')}</p>
          ) : null}
        </li>

        <li className="space-y-2 rounded-md border border-ink/10 bg-wash/35 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">2 · {t('googleLevelCompany')}</p>
          {editing ? (
            <div className="space-y-2">
              <label className="block text-xs">
                <span className="mb-1 block text-ink-soft">{t(`googleBindingAccountsLabel_${view.provider}`)}</span>
                <textarea
                  rows={3}
                  className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5 font-mono text-xs"
                  value={accounts}
                  onChange={(e) => setAccounts(e.target.value)}
                />
              </label>
              {isAds ? (
                <label className="block text-xs">
                  <span className="mb-1 block text-ink-soft">{t('googleBindingManagerLabel')}</span>
                  <input
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5 font-mono text-xs"
                    value={manager}
                    onChange={(e) => setManager(e.target.value)}
                  />
                </label>
              ) : null}
              <p className="text-xs text-ink-soft">{t('googleBindingAccountsHelp')}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pending || splitGoogleAccountIds(accounts).length === 0}
                  className="rounded-md bg-coral px-3 py-1.5 text-xs font-semibold text-card disabled:opacity-50"
                  onClick={save}
                >
                  {t('googleBindingSave')}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-md border border-ink/15 px-3 py-1.5 text-xs"
                  onClick={() => setEditing(false)}
                >
                  {t('googleBindingCancel')}
                </button>
              </div>
            </div>
          ) : (
            <>
              {view.bound ? (
                <div className="text-xs">
                  <p className="flex items-start gap-2">
                    <StatusDot ok />
                    <span>{t('googleLevelCompanyBound')}</span>
                  </p>
                  <ul className="mt-1 space-y-0.5 pl-4 font-mono">
                    {view.accountIds.map((id) => (
                      <li key={id} className="break-all">
                        {formatGoogleAccountId(view.provider, id)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="flex items-start gap-2 text-xs">
                  <StatusDot ok={false} />
                  <span>{t('googleLevelCompanyUnbound')}</span>
                </p>
              )}
              {isAds && view.managerAccountId ? (
                <p className="text-xs text-ink-soft">
                  {t('googleLevelCompanyManager', { id: formatGoogleAccountId('google-ads', view.managerAccountId) })}
                </p>
              ) : null}
              <button
                type="button"
                disabled={pending}
                className="rounded-md border border-ink/15 px-3 py-1.5 text-xs"
                onClick={startEdit}
              >
                {t('googleBindingEdit')}
              </button>
            </>
          )}
        </li>

        <li className="space-y-1 rounded-md border border-ink/10 bg-wash/35 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">3 · {t('googleLevelUser')}</p>
          <p className="text-xs text-ink-soft">{t('googleLevelUserBody')}</p>
        </li>
      </ol>
    </section>
  )
}
