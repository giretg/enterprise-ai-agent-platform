'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { upsertPlatformGoogleApiOAuth } from '@/app/actions/connector-grants'
import type { PlatformGoogleOAuthView } from '@/app/control-plane/system/google-oauth-control-panel'

function sourceLabel(source: PlatformGoogleOAuthView['source']): string {
  if (source === 'platform') return 'platform-beállítás'
  if (source === 'env') return 'környezeti változó (GOOGLE_API_OAUTH_*)'
  if (source === 'tenant_legacy') return 'korábbi tenant-beállítás'
  return 'nincs forrás'
}

export function GoogleApiOAuthControlPanel({
  initial,
  canEdit,
}: {
  initial: PlatformGoogleOAuthView
  canEdit: boolean
}) {
  const [view, setView] = useState(initial)
  const [clientId, setClientId] = useState(initial.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [redirectUri, setRedirectUri] = useState(initial.redirectUri ?? '')
  const [editing, setEditing] = useState(canEdit && !initial.persisted)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const res = await upsertPlatformGoogleApiOAuth({
        clientId: clientId.trim(),
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        redirectUri: redirectUri.trim(),
      })
      if (res.success) {
        setView(res.data)
        setClientId(res.data.clientId ?? '')
        setRedirectUri(res.data.redirectUri ?? '')
        setClientSecret('')
        setEditing(false)
        setMessage({ tone: 'ok', text: 'Platform Google API OAuth beállítás mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <Card title="Google API OAuth">
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">
          Egy közös Google Cloud OAuth Web application a platform Google Analytics, Search Console,
          Google Ads, Calendar és Sheets konnektor-sablonjaihoz. Egyszer kell beállítani; utána a
          tenantok csak konnektort hoznak létre és a felhasználók a saját Google-fiókjukkal kötnek be —
          Client ID/secret nem kell tenant szinten.
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-soft">
          <li>
            Google Cloud Console → APIs &amp; Services → Library: engedélyezd, amit a tenantok használni
            fognak — Google Analytics Data API, Google Search Console API, Google Ads API, Google
            Calendar API, Google Sheets API.
          </li>
          <li>
            OAuth consent screen: vedd fel a sablonok scope-jait (pl. calendar.readonly,
            calendar.events, spreadsheets.readonly, spreadsheets). External appnál teszteléshez add
            hozzá a tesztfelhasználókat.
          </li>
          <li>
            Credentials → Create OAuth client ID, típus: Web application. Authorized redirect URI:{' '}
            <code className="break-all text-ink">
              {process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/connectors/oauth/callback
            </code>
          </li>
          <li>Másold ide a Client ID-t és a Client Secretet, majd mentsd.</li>
        </ol>

        {view.configured ? (
          <p className="flex items-center gap-2 text-sm text-emerald-300">
            <span aria-hidden className="h-2 w-2 rounded-full bg-emerald-400" />
            Be van állítva ({sourceLabel(view.source)}
            {view.persisted ? '' : ' — mentsd el platform-szintre'}).
          </p>
        ) : (
          <p className="text-sm text-ink-soft">
            Még nincs platform-szintű Google API OAuth client (Analytics / Search Console / Ads / Calendar / Sheets).
          </p>
        )}

        {view.configured && !(canEdit && editing) ? (
          <div className="space-y-3">
            <dl className="space-y-1 text-xs text-ink-soft">
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink-soft/70">Client ID:</dt>
                <dd className="break-all font-mono text-ink">{view.clientId || '—'}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink-soft/70">Client Secret:</dt>
                <dd className="text-ink">Mentve (nem jelenítjük meg)</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink-soft/70">Redirect URI:</dt>
                <dd className="break-all text-ink">
                  {view.redirectUri ||
                    'Nincs megadva — az alkalmazás alapértelmezett callback címe érvényes.'}
                </dd>
              </div>
            </dl>
            {canEdit ? (
              <button
                type="button"
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink"
                onClick={() => {
                  setClientId(view.clientId ?? '')
                  setRedirectUri(view.redirectUri ?? '')
                  setClientSecret('')
                  setEditing(true)
                }}
              >
                Szerkesztés
              </button>
            ) : (
              <p className="text-xs text-ink-soft">Módosítani csak superadmin tud.</p>
            )}
          </div>
        ) : canEdit ? (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="Google OAuth Client ID"
                className="rounded-lg border border-line bg-panel px-3 py-2 text-sm"
              />
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={
                  view.configured
                    ? 'Client Secret — üresen hagyva marad a mostani'
                    : 'Google OAuth Client Secret'
                }
                className="rounded-lg border border-line bg-panel px-3 py-2 text-sm"
              />
            </div>
            <input
              value={redirectUri}
              onChange={(e) => setRedirectUri(e.target.value)}
              placeholder="Redirect URI (opcionális)"
              className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={pending || !clientId.trim() || (!view.configured && !clientSecret.trim())}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
                onClick={save}
              >
                Mentés
              </button>
              {view.configured ? (
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-soft"
                  onClick={() => {
                    setEditing(false)
                    setClientSecret('')
                    setClientId(view.clientId ?? '')
                    setRedirectUri(view.redirectUri ?? '')
                  }}
                >
                  Mégse
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink-soft">Megtekintési jogosultságod van. Szerkeszteni csak superadmin tud.</p>
        )}

        {message ? (
          <p
            className={`rounded-lg border px-3 py-2 text-sm ${
              message.tone === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                : 'border-coral/35 bg-coral/10 text-coral-deep'
            }`}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </Card>
  )
}
