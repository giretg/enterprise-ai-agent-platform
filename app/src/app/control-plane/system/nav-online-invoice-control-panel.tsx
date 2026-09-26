'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { upsertPlatformNavSoftware } from '@/app/actions/connector-grants'
import type { NavSoftware } from '@/lib/nav-online-invoice-software'

const FIELDS: Array<{ name: keyof NavSoftware; label: string; placeholder: string }> = [
  { name: 'softwareDevName', label: 'Fejlesztő (üzemeltető cég) neve', placeholder: 'Pl. Minta Kft.' },
  { name: 'softwareDevTaxNumber', label: 'Fejlesztő adószáma', placeholder: 'Pl. 12345678-2-41' },
  { name: 'softwareDevContact', label: 'Fejlesztő elérhetősége (e-mail)', placeholder: 'Pl. it@minta.hu' },
  { name: 'softwareDevCountryCode', label: 'Fejlesztő országkódja', placeholder: 'HU' },
  { name: 'softwareName', label: 'Szoftver neve', placeholder: 'Pl. Enterprise AI Agent Platform' },
  { name: 'softwareMainVersion', label: 'Szoftver verziója', placeholder: 'Pl. 1.0' },
  {
    name: 'softwareId',
    label: 'Szoftver-azonosító (18 karakter: HU + adószám első 8 jegye + kötőjel + 7 jel)',
    placeholder: 'Pl. HU12345678-AGENT01',
  },
]

const EMPTY: NavSoftware = {
  softwareId: '',
  softwareName: '',
  softwareMainVersion: '',
  softwareDevName: '',
  softwareDevContact: '',
  softwareDevCountryCode: 'HU',
  softwareDevTaxNumber: '',
}

export function NavOnlineInvoiceControlPanel({
  initial,
  canEdit,
}: {
  initial: NavSoftware | null
  canEdit: boolean
}) {
  const [saved, setSaved] = useState(initial)
  const [form, setForm] = useState<NavSoftware>(initial ?? EMPTY)
  const [editing, setEditing] = useState(canEdit && !initial)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function save() {
    setMessage(null)
    startTransition(async () => {
      const res = await upsertPlatformNavSoftware(form)
      if (res.success) {
        setSaved(res.data)
        setForm(res.data)
        setEditing(false)
        setMessage({ tone: 'ok', text: 'NAV szoftveradatok mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <Card title="NAV Online Számla">
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">
          A NAV Online Számla konnektor minden kérésben megnevezi a lekérdező szoftvert. Ezt egyszer, platform-szinten
          kell megadni — utána bármelyik tenant admin felveheti a NAV konnektort a saját technikai felhasználójával.
        </p>
        <ol className="list-inside list-decimal space-y-1 text-xs text-ink-soft">
          <li>A „fejlesztő” a platformot üzemeltető cég: az ő neve, adószáma és egy elérhető e-mail cím kell.</li>
          <li>A szoftver-azonosítót te választod: HU + a fejlesztő adószámának első 8 jegye + kötőjel + 7 tetszőleges nagybetű/szám.</li>
          <li>Mentés után a tenant adminok a konnektor-sablonok közül a „NAV Online Számla” sablonnal folytatják.</li>
        </ol>

        {saved ? (
          <p className="flex items-center gap-2 text-sm text-emerald-300">
            <span aria-hidden className="h-2 w-2 rounded-full bg-emerald-400" />
            Be van állítva ({saved.softwareId}).
          </p>
        ) : (
          <p className="text-sm text-honey">Még nincs beállítva — a NAV konnektor addig nem aktiválható.</p>
        )}

        {saved && !(canEdit && editing) ? (
          <div className="space-y-3">
            <dl className="space-y-1 text-xs text-ink-soft">
              {FIELDS.map((field) => (
                <div key={field.name} className="flex flex-wrap gap-x-2">
                  <dt className="text-ink-soft/70">{field.label}:</dt>
                  <dd className="font-mono text-ink">{saved[field.name]}</dd>
                </div>
              ))}
            </dl>
            {canEdit ? (
              <button
                type="button"
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink"
                onClick={() => setEditing(true)}
              >
                Szerkesztés
              </button>
            ) : (
              <p className="text-xs text-ink-soft">Módosítani csak superadmin tud.</p>
            )}
          </div>
        ) : canEdit ? (
          <div className="space-y-3">
            {FIELDS.map((field) => (
              <label key={field.name} className="block text-sm">
                <span className="text-ink-soft">{field.label}</span>
                <input
                  className="mt-1 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm"
                  value={form[field.name]}
                  onChange={(e) => setForm((prev) => ({ ...prev, [field.name]: e.target.value }))}
                  placeholder={field.placeholder}
                />
              </label>
            ))}
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
                disabled={pending || FIELDS.some((field) => !form[field.name].trim())}
                onClick={save}
              >
                Mentés
              </button>
              {saved ? (
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-soft"
                  onClick={() => {
                    setEditing(false)
                    setForm(saved)
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
