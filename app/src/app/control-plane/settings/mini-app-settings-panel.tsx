'use client'

import { useState, useTransition } from 'react'
import { setMiniAppSettingsAction } from '@/app/actions/mini-apps'
import { Card } from '@/components/ui/shell'
import {
  MINI_APP_LINK_TTL_OPTIONS,
  MINI_APP_MAX_BYTES_OPTIONS,
  type MiniAppTenantSettings,
} from '@/lib/mini-app-settings'

const optionClass = (active: boolean) =>
  `rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50 ${
    active ? 'bg-coral text-white' : 'border border-line bg-panel text-ink hover:border-coral/50'
  }`

/** #967 D6, §5.2: a gyors link élettartama és a mini app méret-plafonja. */
export function MiniAppSettingsPanel({ initial, canEdit }: { initial: MiniAppTenantSettings; canEdit: boolean }) {
  const [settings, setSettings] = useState(initial)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  function save(next: MiniAppTenantSettings) {
    if (!canEdit || pending) return
    startTransition(async () => {
      const res = await setMiniAppSettingsAction(next)
      if (res.success) {
        setSettings(res.data)
        setMessage({ tone: 'ok', text: 'Mentve. Az új érték csak az ezután kiadott linkekre vonatkozik.' })
      } else {
        setMessage({ tone: 'error', text: res.error })
      }
    })
  }

  return (
    <Card title="Mini appok">
      <div className="space-y-5 text-sm">
        <p className="text-ink-soft">
          A mini app egy böngészőben megnyitható oldal (jellemzően riport), amit egy AI munkatárs készít. Itt állíthatod,
          meddig nyílik meg a munkatárs által adott gyors link, és mekkora lehet egy mini app.
        </p>
        <div className="space-y-2">
          <p className="font-medium text-ink">Megnyitási link érvényessége</p>
          <p className="text-ink-soft">
            A munkatárs által adott gyors link ennyi ideig nyílik meg bejelentkezés nélkül. Aki megkapja, megnyithatja —
            rövidebb idő biztonságosabb, hosszabb kényelmesebb. Az állandó link (bejelentkezéssel) ettől függetlenül
            mindig működik.
          </p>
          <div className="flex flex-wrap gap-2">
            {MINI_APP_LINK_TTL_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={!canEdit || pending}
                onClick={() => option.value !== settings.linkTtl && save({ ...settings, linkTtl: option.value })}
                className={optionClass(settings.linkTtl === option.value)}
              >
                {option.label}
                {option.value === '7d' ? ' (alap)' : ''}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-soft">
            A változtatás csak az újonnan kiadott linkekre hat; a már kiadottak a saját lejáratukig működnek.
          </p>
        </div>
        <div className="space-y-2">
          <p className="font-medium text-ink">Legnagyobb méret</p>
          <p className="text-ink-soft">Ennél nagyobb mini appot a munkatárs nem tud feltölteni. A platform felső határa 1 MB.</p>
          <div className="flex flex-wrap gap-2">
            {MINI_APP_MAX_BYTES_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={!canEdit || pending}
                onClick={() => option.value !== settings.maxBytes && save({ ...settings, maxBytes: option.value })}
                className={optionClass(settings.maxBytes === option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        {message ? (
          <p
            className={`rounded-lg border px-3 py-2 text-sm ${
              message.tone === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800'
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
