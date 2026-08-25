'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import {
  setTenantWebSearchControls,
  updateWebSearchPolicy,
  type WebSearchPolicyView,
} from '@/app/actions/web-search'

type PolicyForm = {
  provider: 'custom_search_api'
  providerApiUrl: string
  apiKey: string
  allowedDomainsText: string
  deniedDomainsText: string
  allowGeneralWeb: boolean
  defaultLocale: string
  defaultRegion: string
  defaultMaxResults: number
  hardMaxResults: number
  maxQueryLength: number
  maxQueriesPerTicket: number
  maxQueriesPerAgentDay: number
  safeSearch: 'strict' | 'moderate'
  logRawQuery: boolean
  retentionDays: number
  requireHumanApprovalForSensitiveQuery: boolean
}

function domainsToText(domains: string[]) {
  return domains.join('\n')
}

function textToDomains(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function formFromPolicy(policy: WebSearchPolicyView): PolicyForm {
  const { config } = policy
  return {
    provider: 'custom_search_api',
    providerApiUrl: config.providerApiUrl ?? '',
    apiKey: '',
    allowedDomainsText: domainsToText(config.allowedDomains),
    deniedDomainsText: domainsToText(config.deniedDomains),
    allowGeneralWeb: config.allowGeneralWeb,
    defaultLocale: config.defaultLocale,
    defaultRegion: config.defaultRegion,
    defaultMaxResults: config.defaultMaxResults,
    hardMaxResults: config.hardMaxResults,
    maxQueryLength: config.maxQueryLength,
    maxQueriesPerTicket: config.maxQueriesPerTicket,
    maxQueriesPerAgentDay: config.maxQueriesPerAgentDay,
    safeSearch: config.safeSearch,
    logRawQuery: config.logRawQuery,
    retentionDays: config.retentionDays,
    requireHumanApprovalForSensitiveQuery: config.requireHumanApprovalForSensitiveQuery,
  }
}

const PROVIDER_HELP = {
  custom_search_api: {
    title: 'Saját kereső API',
    text: 'Ez az endpoint és API-kulcs kizárólag az aktív tenant agentjeire érvényes. A platform system agentek külön platform-beállítást használnak.',
  },
} as const

export type TenantWebSearchControlsView = {
  killSwitch: boolean
  updatedById: string | null
  updatedAt: string | null
}

export function TenantWebSearchPolicyPanel({
  initialPolicy,
  initialTenantControls,
  policyError,
  canEdit,
}: {
  initialPolicy: WebSearchPolicyView | null
  initialTenantControls: TenantWebSearchControlsView
  policyError: string | null
  canEdit: boolean
}) {
  const [tenantControls, setTenantControls] = useState(initialTenantControls)
  const [policyState, setPolicyState] = useState(initialPolicy)
  const [policyForm, setPolicyForm] = useState<PolicyForm | null>(
    initialPolicy ? formFromPolicy(initialPolicy) : null,
  )
  const [killPending, startKillTransition] = useTransition()
  const [policyPending, startPolicyTransition] = useTransition()
  const [killMessage, setKillMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [policyMessage, setPolicyMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const tenantActive = !tenantControls.killSwitch
  const providerHelp = policyForm ? PROVIDER_HELP.custom_search_api : null

  function toggleTenantKillSwitch() {
    setKillMessage(null)
    startKillTransition(async () => {
      const res = await setTenantWebSearchControls({ killSwitch: !tenantControls.killSwitch })
      if (res.success) {
        setTenantControls(res.data)
        setKillMessage({ tone: 'ok', text: 'Tenant kill-switch mentve.' })
      } else {
        setKillMessage({ tone: 'err', text: res.error })
      }
    })
  }

  function updateForm<K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) {
    setPolicyForm((prev) => (prev ? { ...prev, [key]: value } : prev))
    setPolicyMessage(null)
  }

  function savePolicy() {
    if (!policyState || !policyForm) return
    setPolicyMessage(null)
    startPolicyTransition(async () => {
      const res = await updateWebSearchPolicy({
        connectorId: policyState.connectorId,
        provider: policyForm.provider,
        providerApiUrl: policyForm.providerApiUrl,
        apiKey: policyForm.apiKey,
        allowedDomains: textToDomains(policyForm.allowedDomainsText),
        deniedDomains: textToDomains(policyForm.deniedDomainsText),
        allowGeneralWeb: policyForm.allowGeneralWeb,
        defaultLocale: policyForm.defaultLocale,
        defaultRegion: policyForm.defaultRegion,
        defaultMaxResults: policyForm.defaultMaxResults,
        hardMaxResults: policyForm.hardMaxResults,
        maxQueryLength: policyForm.maxQueryLength,
        maxQueriesPerTicket: policyForm.maxQueriesPerTicket,
        maxQueriesPerAgentDay: policyForm.maxQueriesPerAgentDay,
        safeSearch: policyForm.safeSearch,
        logRawQuery: policyForm.logRawQuery,
        retentionDays: policyForm.retentionDays,
        requireHumanApprovalForSensitiveQuery: policyForm.requireHumanApprovalForSensitiveQuery,
      })
      if (res.success) {
        setPolicyState(res.data)
        setPolicyForm(formFromPolicy(res.data))
        setPolicyMessage({ tone: 'ok', text: 'Tenant policy mentve.' })
      } else {
        setPolicyMessage({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <Card title="Web Search — tenant policy">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex h-2.5 w-2.5 rounded-full ${tenantActive ? 'bg-emerald-400' : 'bg-red-400'}`}
            />
            <div>
              <p className="text-sm font-semibold">
                {tenantActive
                  ? 'Tenant web search engedélyezve'
                  : 'Tenant kill-switch — ezen a tenanton minden web_search tiltva'}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={!canEdit || killPending}
            onClick={toggleTenantKillSwitch}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              tenantActive ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'
            }`}
          >
            {tenantActive ? 'Tenant kill-switch' : 'Tenant újraindítás'}
          </button>
        </div>

        {killMessage ? (
          <p
            className={`rounded-lg border px-3 py-2 text-sm ${
              killMessage.tone === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300'
            }`}
          >
            {killMessage.text}
          </p>
        ) : null}

        <div className="estate-rule" />

        {policyError ? (
          <p className="rounded-lg border border-coral/35 bg-coral/10 px-3 py-2 text-sm text-coral-deep">
            {policyError}
          </p>
        ) : policyState && policyForm ? (
          <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-1 text-xs font-medium text-ink-soft">
                Provider
                <div className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink-soft">
                  custom_search_api (tenant saját)
                </div>
              </div>
              <label className="space-y-1 text-xs font-medium text-ink-soft">
                Safe search
                <select
                  value={policyForm.safeSearch}
                  onChange={(event) =>
                    updateForm('safeSearch', event.target.value as PolicyForm['safeSearch'])
                  }
                  disabled={!canEdit || policyPending}
                  className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink disabled:opacity-60"
                >
                  <option value="strict">strict</option>
                  <option value="moderate">moderate</option>
                </select>
              </label>
            </div>

            {providerHelp ? (
              <div className="border-l-2 border-sage/50 pl-3 text-xs text-ink-soft">
                <p className="font-semibold text-ink">{providerHelp.title}</p>
                <p className="mt-1">{providerHelp.text}</p>
              </div>
            ) : null}

            <div className="grid gap-4 lg:grid-cols-2">
              <label className="space-y-1 text-xs font-medium text-ink-soft">
                Tenant API URL
                <input
                  type="url"
                  value={policyForm.providerApiUrl}
                  onChange={(event) => updateForm('providerApiUrl', event.target.value)}
                  disabled={!canEdit || policyPending}
                  className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink disabled:opacity-60"
                />
              </label>
              <label className="space-y-1 text-xs font-medium text-ink-soft">
                Tenant API kulcs
                <input
                  type="password"
                  value={policyForm.apiKey}
                  onChange={(event) => updateForm('apiKey', event.target.value)}
                  disabled={!canEdit || policyPending}
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink disabled:opacity-60"
                />
              </label>
            </div>

            <label className="flex items-center gap-2 text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={policyForm.allowGeneralWeb}
                onChange={(event) => updateForm('allowGeneralWeb', event.target.checked)}
                disabled={!canEdit || policyPending}
                className="accent-sage"
              />
              allowGeneralWeb — csak a keresést szélesíti, tetszőleges oldal letöltését nem
            </label>

            <div className="grid gap-4 lg:grid-cols-2">
              <label className="space-y-1 text-xs font-medium text-ink-soft">
                Engedélyezett domainek (soronként)
                <textarea
                  value={policyForm.allowedDomainsText}
                  onChange={(event) => updateForm('allowedDomainsText', event.target.value)}
                  disabled={!canEdit || policyPending}
                  rows={5}
                  placeholder={'otpbank.hu\n*.otpbank.hu'}
                  className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink disabled:opacity-60"
                />
              </label>
              <label className="space-y-1 text-xs font-medium text-ink-soft">
                Tiltott domainek (soronként)
                <textarea
                  value={policyForm.deniedDomainsText}
                  onChange={(event) => updateForm('deniedDomainsText', event.target.value)}
                  disabled={!canEdit || policyPending}
                  rows={5}
                  className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink disabled:opacity-60"
                />
              </label>
            </div>
            <p className="text-xs text-ink-soft">
              Az engedélyezett lista a keresést és a letöltést is kapuzza: amit felveszel (pl.{' '}
              <code>otpbank.hu</code> vagy <code>*.otpbank.hu</code>), azt az agent el is
              olvashatja. A tiltott minta a keresés után is megállítja a letöltést. Nyers IP,
              localhost, metadata-host és <code>*.internal</code> nem adható meg.
            </p>

            {policyMessage ? (
              <p
                className={`rounded-lg border px-3 py-2 text-sm ${
                  policyMessage.tone === 'ok'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-red-500/30 bg-red-500/10 text-red-300'
                }`}
              >
                {policyMessage.text}
              </p>
            ) : null}

            {canEdit ? (
              <button
                type="button"
                disabled={policyPending}
                onClick={savePolicy}
                className="rounded-lg bg-sage px-4 py-2 text-sm font-medium text-white hover:bg-sage-deep disabled:opacity-50"
              >
                Policy mentése
              </button>
            ) : (
              <p className="text-xs text-ink-soft">Szerkesztéshez tenant admin jog kell.</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-ink-soft">Tenant web search connector nem található.</p>
        )}
      </div>
    </Card>
  )
}
