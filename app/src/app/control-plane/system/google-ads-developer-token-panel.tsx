'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { upsertPlatformGoogleAdsDeveloperToken } from '@/app/actions/connector-grants'

export type GoogleAdsDeveloperTokenView = {
  configured: boolean
  persisted: boolean
  source: 'platform' | 'env' | null
  hint: string | null
}

function sourceLabel(source: GoogleAdsDeveloperTokenView['source']): string {
  if (source === 'platform') return 'platform-beállítás'
  if (source === 'env') return 'környezeti változó (GOOGLE_ADS_DEVELOPER_TOKEN)'
  return 'nincs forrás'
}

/**
 * Platform-szintű Google Ads developer token. A token a platform Google API OAuth appjához
 * (Cloud projektjéhez) tartozik, ezért nem a cégek adják meg: ők csak azt választják ki, MELYIK
 * Google Ads fiókjukat érje el a konnektor.
 */
export function GoogleAdsDeveloperTokenPanel({
  initial,
  canEdit,
}: {
  initial: GoogleAdsDeveloperTokenView
  canEdit: boolean
}) {
  const [view, setView] = useState(initial)
  const [token, setToken] = useState('')
  const [editing, setEditing] = useState(canEdit && !initial.persisted)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const res = await upsertPlatformGoogleAdsDeveloperToken({ developerToken: token.trim() })
      if (res.success) {
        setView(res.data)
        setToken('')
        setEditing(false)
        setMessage({ tone: 'ok', text: 'Google Ads developer token mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <Card title="Google Ads developer token">
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">
          A Google Ads API minden hívásához kell egy developer token. Ez a platformot azonosítja a
          Google felé (ugyanahhoz a Google Cloud projekthez tartozik, mint a fenti Google API OAuth
          app), nem a hirdetőt — ezért egyszer, itt kell beállítani. A cégek csak azt választják ki,
          melyik Google Ads fiókjukat érje el a konnektor; a felhasználók a saját Google-fiókjukkal
          lépnek be.
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-soft">
          <li>
            Kell egy Google Ads kezelőfiók (MCC). A token az API Centerben van:{' '}
            <code className="break-all text-ink">https://ads.google.com/aw/apicenter</code>
          </li>
          <li>
            Teszt-hozzáférésű token csak tesztfiókokra működik; éles cégfiókokhoz Basic vagy Standard
            hozzáférési szint kell (Google-jóváhagyás).
          </li>
          <li>A Google Cloud projektben engedélyezd a „Google Ads API” szolgáltatást.</li>
        </ol>

        {view.configured ? (
          <p className="flex items-center gap-2 text-sm text-emerald-300">
            <span aria-hidden className="h-2 w-2 rounded-full bg-emerald-400" />
            Be van állítva ({sourceLabel(view.source)}
            {view.hint ? `, ${view.hint}` : ''}
            {view.persisted ? '' : ' — mentsd el platform-szintre'}).
          </p>
        ) : (
          <p className="text-sm text-ink-soft">
            Még nincs Google Ads developer token — amíg nincs, a cégek nem tudnak Google Ads konnektort
            bekapcsolni.
          </p>
        )}

        {canEdit && editing ? (
          <div className="space-y-3">
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={view.configured ? 'Új developer token' : 'Google Ads developer token'}
              className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={pending || !token.trim()}
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
                    setToken('')
                  }}
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
            Csere
          </button>
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
