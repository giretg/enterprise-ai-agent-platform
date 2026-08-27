'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { upsertPlatformGoogleDriveOAuth } from '@/app/actions/connector-grants'
import type { PlatformGoogleOAuthView } from '@/app/control-plane/system/google-oauth-control-panel'

export function GoogleDriveOAuthControlPanel({
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
      const res = await upsertPlatformGoogleDriveOAuth({
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
        setMessage({ tone: 'ok', text: 'Platform Google Drive OAuth beállítás mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <Card title="Google Drive OAuth alkalmazás">
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">
          Külön OAuth client a Gmailtől — a Drive és Gmail scope-izolációja és független
          leválasztása miatt szükséges. A Picker API kulcsot külön kell beállítani a selected-write
          profilhoz.
        </p>

        {view.configured ? (
          <p className="flex items-center gap-2 text-sm text-emerald-300">
            <span aria-hidden className="h-2 w-2 rounded-full bg-emerald-400" />
            Be van állítva ({view.source === 'env' ? 'környezeti változó' : 'platform-beállítás'}).
          </p>
        ) : (
          <p className="text-sm text-ink-soft">Még nincs platform-szintű Google Drive OAuth client.</p>
        )}

        {canEdit && editing ? (
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="text-ink-soft">Client ID</span>
              <input
                className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="text-ink-soft">Client Secret</span>
              <input
                type="password"
                className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={view.configured ? 'Üresen hagyva nem változik' : ''}
              />
            </label>
            <label className="block text-sm">
              <span className="text-ink-soft">Redirect URI</span>
              <input
                className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm"
                value={redirectUri}
                onChange={(e) => setRedirectUri(e.target.value)}
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-lg bg-ink px-3 py-1.5 text-sm text-surface disabled:opacity-50"
                disabled={pending || !clientId.trim()}
                onClick={save}
              >
                Mentés
              </button>
              {view.configured ? (
                <button
                  type="button"
                  className="rounded-lg border border-line px-3 py-1.5 text-sm"
                  onClick={() => setEditing(false)}
                >
                  Mégse
                </button>
              ) : null}
            </div>
          </div>
        ) : canEdit ? (
          <button
            type="button"
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink"
            onClick={() => setEditing(true)}
          >
            Szerkesztés
          </button>
        ) : null}

        {message ? (
          <p className={`text-sm ${message.tone === 'ok' ? 'text-emerald-300' : 'text-rose-300'}`}>
            {message.text}
          </p>
        ) : null}
      </div>
    </Card>
  )
}
