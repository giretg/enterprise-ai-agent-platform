'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import {
  setWebSearchControls,
  updatePlatformWebSearch,
  type WebSearchPolicyView,
} from '@/app/actions/web-search'

export type WebSearchControlsView = {
  killSwitch: boolean
  updatedById: string | null
  updatedAt: string | null
}

export function WebSearchControlPanel({
  initial,
  platformPolicy,
  platformError,
  canEdit,
}: {
  initial: WebSearchControlsView
  platformPolicy: WebSearchPolicyView | null
  platformError: string | null
  canEdit: boolean
}) {
  const [controls, setControls] = useState(initial)
  const [platformPolicyState, setPlatformPolicyState] = useState(platformPolicy)
  const [apiUrl, setApiUrl] = useState(platformPolicy?.config.providerApiUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [pending, startTransition] = useTransition()
  const [platformPending, startPlatformTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [platformMessage, setPlatformMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const active = !controls.killSwitch

  function togglePlatformKillSwitch() {
    setMessage(null)
    startTransition(async () => {
      const res = await setWebSearchControls({ killSwitch: !controls.killSwitch })
      if (res.success) {
        setControls(res.data)
        setMessage({ tone: 'ok', text: 'Platform kill-switch mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  function savePlatformWebSearch() {
    setPlatformMessage(null)
    startPlatformTransition(async () => {
      const res = await updatePlatformWebSearch({
        providerApiUrl: apiUrl,
        apiKey: apiKey || undefined,
      })
      if (res.success) {
        setPlatformPolicyState(res.data)
        setApiUrl(res.data.config.providerApiUrl ?? '')
        setApiKey('')
        setPlatformMessage({ tone: 'ok', text: 'Platform web search mentve.' })
      } else {
        setPlatformMessage({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <Card title="Web Search — platform vezérlés">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex h-2.5 w-2.5 rounded-full ${active ? 'bg-emerald-400' : 'bg-red-400'}`}
            />
            <div>
              <p className="text-sm font-semibold">
                {active
                  ? 'Platform web search aktív a system agentek számára'
                  : 'Platform kill-switch — a system agentek web_search hívásai tiltva'}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={!canEdit || pending}
            onClick={togglePlatformKillSwitch}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              active ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'
            }`}
          >
            {active ? 'Platform kill-switch' : 'Platform újraindítás'}
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

        <div className="estate-rule" />

        <div className="space-y-3">
          <p className="text-sm font-semibold text-ink">Platform web search (központi API kulcs)</p>
          <p className="text-xs text-ink-soft">
            Ezt az endpointot és kulcsot kizárólag a tenant nélküli provisioning/web-egress system
            agentek használják. A tenantok nem öröklik és nem választhatják ezt a beállítást.
          </p>
          {platformError ? (
            <p className="text-sm text-coral-deep">{platformError}</p>
          ) : (
            <>
              {platformPolicyState?.secretAlias ? (
                <p className="text-xs text-ink-soft">
                  Aktív secret: <code>{platformPolicyState.secretAlias}</code>
                </p>
              ) : null}
              <div className="grid gap-4 lg:grid-cols-2">
                <label className="space-y-1 text-xs font-medium text-ink-soft">
                  API URL
                  <input
                    type="url"
                    value={apiUrl}
                    onChange={(event) => setApiUrl(event.target.value)}
                    disabled={!canEdit || platformPending}
                    placeholder="https://api.search.brave.com/res/v1/web/search"
                    className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink disabled:opacity-60"
                  />
                </label>
                <label className="space-y-1 text-xs font-medium text-ink-soft">
                  API kulcs
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    disabled={!canEdit || platformPending}
                    placeholder="Új kulcs → Secret Manager (secret-ref)"
                    autoComplete="new-password"
                    className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink disabled:opacity-60"
                  />
                </label>
              </div>
              {platformMessage ? (
                <p
                  className={`rounded-lg border px-3 py-2 text-sm ${
                    platformMessage.tone === 'ok'
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : 'border-red-500/30 bg-red-500/10 text-red-300'
                  }`}
                >
                  {platformMessage.text}
                </p>
              ) : null}
              {canEdit ? (
                <button
                  type="button"
                  disabled={platformPending}
                  onClick={savePlatformWebSearch}
                  className="rounded-lg bg-sage px-4 py-2 text-sm font-medium text-white hover:bg-sage-deep disabled:opacity-50"
                >
                  Platform web search mentése
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
