'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { upsertPlatformGoogleDrivePickerConfig } from '@/app/actions/connector-grants'

export type PlatformGoogleDrivePickerView = {
  configured: boolean
  persisted: boolean
  source: 'platform' | 'env' | 'tenant_legacy' | null
  appId: string | null
}

function sourceLabel(source: PlatformGoogleDrivePickerView['source']): string {
  if (source === 'platform') return 'platform-beállítás'
  if (source === 'env') return 'környezeti változó (GOOGLE_DRIVE_PICKER_*)'
  return 'nincs forrás'
}

export function GoogleDrivePickerControlPanel({
  initial,
  canEdit,
}: {
  initial: PlatformGoogleDrivePickerView
  canEdit: boolean
}) {
  const [view, setView] = useState(initial)
  const [apiKey, setApiKey] = useState('')
  const [appId, setAppId] = useState(initial.appId ?? '')
  const [editing, setEditing] = useState(canEdit && !initial.persisted)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const res = await upsertPlatformGoogleDrivePickerConfig({
        apiKey: apiKey.trim(),
        appId: appId.trim(),
      })
      if (res.success) {
        setView(res.data)
        setAppId(res.data.appId ?? '')
        setApiKey('')
        setEditing(false)
        setMessage({ tone: 'ok', text: 'Google Picker beállítás mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <Card title="Google Drive Picker">
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">
          Az „olvasás + írás kijelölt fájlokon” profilhoz kell. A felhasználók a Kapcsolt fiókok
          oldalon választhatják ki, mely fájlokat és mappákat módosíthat az agent.
        </p>

        {view.configured ? (
          <p className="flex items-center gap-2 text-sm text-emerald-300">
            <span aria-hidden className="h-2 w-2 rounded-full bg-emerald-400" />
            Be van állítva ({sourceLabel(view.source)}
            {view.persisted ? '' : ' — mentsd el platform-szintre'}).
          </p>
        ) : (
          <p className="text-sm text-ink-soft">Még nincs Picker konfiguráció.</p>
        )}

        {view.configured && !(canEdit && editing) ? (
          <div className="space-y-3">
            <dl className="space-y-1 text-xs text-ink-soft">
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink-soft/70">App ID (GCP project number):</dt>
                <dd className="font-mono text-ink">{view.appId || '—'}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink-soft/70">Picker API key:</dt>
                <dd className="text-ink">Mentve (nem jelenítjük meg)</dd>
              </div>
            </dl>
            <div className="rounded-lg border border-line/70 bg-night-2/30 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
                GCP ellenőrzőlista
              </p>
              <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-ink-soft">
                <li>Google Picker API engedélyezve a projektben</li>
                <li>API key korlátozva a platform originjére (pl. https://… vagy localhost dev-ben)</li>
                <li>API key csak a Google Picker API-ra korlátozva</li>
                <li>OAuth kliens JavaScript origins tartalmazza ugyanazt az origint</li>
              </ul>
            </div>
            {canEdit ? (
              <button
                type="button"
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink"
                onClick={() => {
                  setAppId(view.appId ?? '')
                  setApiKey('')
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
            <label className="block text-sm">
              <span className="text-ink-soft">Picker API key</span>
              <input
                className="mt-1 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  view.configured ? 'Új key megadásához írd be' : 'Google Cloud API key'
                }
              />
            </label>
            <label className="block text-sm">
              <span className="text-ink-soft">App ID (GCP project number)</span>
              <input
                className="mt-1 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="Pl. 123456789012"
              />
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
                disabled={pending || !apiKey.trim() || !appId.trim()}
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
                    setApiKey('')
                    setAppId(view.appId ?? '')
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
