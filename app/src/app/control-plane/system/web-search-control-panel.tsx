'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import {
  setWebSearchControls,
  updateWebSearchPolicy,
  type WebSearchPolicyView,
} from '@/app/actions/web-search'

export type WebSearchControlsView = {
  killSwitch: boolean
  updatedById: string | null
  updatedAt: string | null
}

type PolicyForm = {
  provider: 'stub' | 'custom_search_api' | 'managed_search'
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
    provider: config.provider,
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

const PROVIDER_HELP: Record<PolicyForm['provider'], { title: string; text: string; needsKey: boolean }> = {
  stub: {
    title: 'Stub: tesztmód',
    text: 'Determinisztikus teszteredményeket ad, valódi internetes keresés nélkül. Demohoz és acceptance teszthez jó, aktuális hírekhez nem.',
    needsKey: false,
  },
  custom_search_api: {
    title: 'Custom Search API: saját kereső endpoint',
    text: 'Bing Search-kompatibilis JSON endpointot hív. API URL szükséges; ha a provider kulcsot kér, add meg az API kulcsot is, amit secret-ref mögé mentünk.',
    needsKey: true,
  },
  managed_search: {
    title: 'Managed Search: platform által kezelt keresés',
    text: 'Tenant szintű API kulcsot nem kér. A platform WEB_SEARCH_MANAGED_API_URL/KEY vagy központi provider konfigurációját használja; ha nincs bekötve, stubra esik vissza.',
    needsKey: false,
  },
}

export function WebSearchControlPanel({
  initial,
  policy,
  policyError,
  canEdit,
}: {
  initial: WebSearchControlsView
  policy: WebSearchPolicyView | null
  policyError: string | null
  canEdit: boolean
}) {
  const [controls, setControls] = useState(initial)
  const [policyState, setPolicyState] = useState(policy)
  const [policyForm, setPolicyForm] = useState<PolicyForm | null>(
    policy ? formFromPolicy(policy) : null,
  )
  const [pending, startTransition] = useTransition()
  const [policyPending, startPolicyTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [policyMessage, setPolicyMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function toggle() {
    setMessage(null)
    startTransition(async () => {
      const res = await setWebSearchControls({ killSwitch: !controls.killSwitch })
      if (res.success) {
        setControls(res.data)
        setMessage({ tone: 'ok', text: 'Mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
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
        setPolicyMessage({ tone: 'ok', text: 'Policy mentve.' })
      } else {
        setPolicyMessage({ tone: 'err', text: res.error })
      }
    })
  }

  const active = !controls.killSwitch
  const providerHelp = policyForm ? PROVIDER_HELP[policyForm.provider] : null

  return (
    <Card title="Web Search Tool (kontrollált webes keresés)">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex h-2.5 w-2.5 rounded-full ${active ? 'bg-emerald-400' : 'bg-red-400'}`}
            />
            <div>
              <p className="text-sm font-semibold">
                {active ? 'Aktív — capability-vel rendelkező agentek kereshetnek' : 'Kill-switch bekapcsolva — minden web_search hívás tiltott'}
              </p>
              <p className="text-xs text-ink-soft">
                {active
                  ? 'A keresés Tool Brokeren át, tenant policy + audit mellett történik.'
                  : 'Provider hívás nélkül, denied + audit-nyommal minden próbálkozás (WS13).'}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={!canEdit || pending}
            onClick={toggle}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              active ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'
            }`}
          >
            {active ? 'Kill-switch' : 'Újraindítás'}
          </button>
        </div>

        {message ? (
          <p
            className={`rounded-lg border px-3 py-2 text-sm ${
              message.tone === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300'
            }`}
          >
            {message.text}
          </p>
        ) : null}

        {!canEdit ? (
          <p className="text-xs text-ink-soft">Módosításhoz admin jogosultság szükséges.</p>
        ) : null}

        <p className="text-xs text-ink-soft">
          Utoljára módosítva:{' '}
          {controls.updatedAt ? new Date(controls.updatedAt).toLocaleString('hu-HU') : '— (alapértelmezett)'}
        </p>

        <div className="estate-rule" />

        {policyError ? (
          <p className="rounded-lg border border-coral/35 bg-coral/10 px-3 py-2 text-sm text-coral-deep">
            {policyError}
          </p>
        ) : policyState && policyForm ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-ink">Policy connector</p>
                <p className="mt-1 text-xs text-ink-soft">
                  {policyState.connectorName} · {policyState.lifecycleState}
                  {policyState.secretAlias ? ` · ${policyState.secretAlias}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs text-ink-soft">
                <span className={`h-2 w-2 rounded-full ${policyForm.provider === 'stub' ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                {policyForm.provider === 'stub' ? 'stub provider' : policyForm.provider}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <label className="space-y-1 text-xs font-medium text-ink-soft">
                Provider
                <select
                  value={policyForm.provider}
                  onChange={(event) => updateForm('provider', event.target.value as PolicyForm['provider'])}
                  disabled={!canEdit || policyPending}
                  className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink disabled:opacity-60"
                >
                  <option value="stub">stub</option>
                  <option value="custom_search_api">custom_search_api</option>
                  <option value="managed_search">managed_search</option>
                </select>
              </label>

              <label className="space-y-1 text-xs font-medium text-ink-soft">
                Safe search
                <select
                  value={policyForm.safeSearch}
                  onChange={(event) => updateForm('safeSearch', event.target.value as PolicyForm['safeSearch'])}
                  disabled={!canEdit || policyPending}
                  className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink disabled:opacity-60"
                >
                  <option value="strict">strict</option>
                  <option value="moderate">moderate</option>
                </select>
              </label>
            </div>

            {providerHelp ? (
              <div className="space-y-2 border-l-2 border-sage/50 pl-3 text-xs text-ink-soft">
                <p className="font-semibold text-ink">{providerHelp.title}</p>
                <p>{providerHelp.text}</p>
                {policyState.secretAlias ? (
                  <p>Aktív secret alias: <code>{policyState.secretAlias}</code></p>
                ) : providerHelp.needsKey ? (
                  <p>Nincs még mentett API kulcs ehhez a connectorhoz.</p>
                ) : null}
              </div>
            ) : null}

            {policyForm.provider === 'custom_search_api' ? (
              <div className="grid gap-4 lg:grid-cols-2">
                <label className="space-y-1 text-xs font-medium text-ink-soft">
                  Custom Search API URL
                  <input
                    type="url"
                    value={policyForm.providerApiUrl}
                    onChange={(event) => updateForm('providerApiUrl', event.target.value)}
                    disabled={!canEdit || policyPending}
                    placeholder="https://api.bing.microsoft.com/v7.0/search"
                    className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink disabled:opacity-60"
                  />
                </label>
                <label className="space-y-1 text-xs font-medium text-ink-soft">
                  API kulcs
                  <input
                    type="password"
                    value={policyForm.apiKey}
                    onChange={(event) => updateForm('apiKey', event.target.value)}
                    disabled={!canEdit || policyPending}
                    placeholder="Új vagy rotált kulcs megadása"
                    autoComplete="new-password"
                    className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink disabled:opacity-60"
                  />
                  <span className="block text-[11px] font-normal text-ink-soft">
                    Üresen hagyva a meglévő secret alias marad érvényben.
                  </span>
                </label>
              </div>
            ) : null}

            <div className="grid gap-4 lg:grid-cols-2">
              <label className="space-y-1 text-xs font-medium text-ink-soft">
                Engedélyezett domainek
                <textarea
                  value={policyForm.allowedDomainsText}
                  onChange={(event) => updateForm('allowedDomainsText', event.target.value)}
                  disabled={!canEdit || policyPending}
                  rows={6}
                  placeholder={'telex.hu\n*.telex.hu\n*.gov.hu'}
                  className="w-full resize-y rounded-lg border border-line bg-card px-3 py-2 font-mono text-xs text-ink disabled:opacity-60"
                />
              </label>

              <label className="space-y-1 text-xs font-medium text-ink-soft">
                Tiltott domainek
                <textarea
                  value={policyForm.deniedDomainsText}
                  onChange={(event) => updateForm('deniedDomainsText', event.target.value)}
                  disabled={!canEdit || policyPending}
                  rows={6}
                  placeholder={'pastebin.com\n*.onion'}
                  className="w-full resize-y rounded-lg border border-line bg-card px-3 py-2 font-mono text-xs text-ink disabled:opacity-60"
                />
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {([
                ['defaultLocale', 'Locale'],
                ['defaultRegion', 'Region'],
                ['defaultMaxResults', 'Alap max találat'],
                ['hardMaxResults', 'Hard cap'],
                ['maxQueryLength', 'Max query hossz'],
                ['maxQueriesPerTicket', 'Query / ticket'],
                ['maxQueriesPerAgentDay', 'Query / agent / nap'],
                ['retentionDays', 'Retention nap'],
              ] as const).map(([key, label]) => (
                <label key={key} className="space-y-1 text-xs font-medium text-ink-soft">
                  {label}
                  <input
                    type={key === 'defaultLocale' || key === 'defaultRegion' ? 'text' : 'number'}
                    value={policyForm[key]}
                    onChange={(event) =>
                      updateForm(
                        key,
                        (key === 'defaultLocale' || key === 'defaultRegion'
                          ? event.target.value
                          : Number(event.target.value)) as PolicyForm[typeof key],
                      )
                    }
                    disabled={!canEdit || policyPending}
                    className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink disabled:opacity-60"
                  />
                </label>
              ))}
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              <label className="flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={policyForm.allowGeneralWeb}
                  onChange={(event) => updateForm('allowGeneralWeb', event.target.checked)}
                  disabled={!canEdit || policyPending}
                  className="accent-sage"
                />
                allowGeneralWeb
              </label>
              <label className="flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={policyForm.logRawQuery}
                  onChange={(event) => updateForm('logRawQuery', event.target.checked)}
                  disabled={!canEdit || policyPending}
                  className="accent-sage"
                />
                logRawQuery
              </label>
              <label className="flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={policyForm.requireHumanApprovalForSensitiveQuery}
                  onChange={(event) =>
                    updateForm('requireHumanApprovalForSensitiveQuery', event.target.checked)
                  }
                  disabled={!canEdit || policyPending}
                  className="accent-sage"
                />
                sensitive query approval
              </label>
            </div>

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

            <button
              type="button"
              onClick={savePolicy}
              disabled={!canEdit || policyPending}
              className="rounded-lg bg-sage px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {policyPending ? 'Mentés...' : 'Policy mentése'}
            </button>
          </div>
        ) : null}
      </div>
    </Card>
  )
}
