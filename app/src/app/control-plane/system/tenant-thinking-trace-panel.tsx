'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { setTenantThinkingTraceControls } from '@/app/actions/chat-thinking-trace'

/**
 * Chat "thinking-trace" spec §D7/WP-6 — tenant-admin kapcsoló a modell
 * gondolkodási (reasoning) szövegének chat-megjelenítéséhez. Alapból KIKAPCSOLVA:
 * amíg a D5 tartalom-őr-lefedettség nincs éles-verifikálva, ne menjen ki alapból
 * nyers reasoning-szöveg. A tényleges kapu szerver oldalon van (a runtime csak
 * bekapcsolt tenantnál generál `thinking` eseményt) — ez az UI azt vezérli.
 */
export function TenantThinkingTracePanel({
  initialEnabled,
  canEdit,
}: {
  initialEnabled: boolean
  canEdit: boolean
}) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  function toggle() {
    startTransition(async () => {
      const res = await setTenantThinkingTraceControls({ enabled: !enabled })
      if (res.success) {
        setEnabled(res.data.enabled)
        setMessage({
          tone: 'ok',
          text: res.data.enabled
            ? 'A gondolkodási szöveg mostantól megjelenik a chat-aktivitás dobozban.'
            : 'A gondolkodási szöveg megjelenítése kikapcsolva.',
        })
      } else {
        setMessage({ tone: 'error', text: res.error })
      }
    })
  }

  return (
    <Card title="Chat — gondolkodási szöveg (thinking-trace)">
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">
          Ha bekapcsolod, a chat-aktivitás doboz a modell gondolkodási
          (reasoning) szövegét is streameli — ott, ahol a provider ezt
          szolgáltatja (jelenleg az OpenAI ChatGPT ág). A tartalom a szokásos
          tartalom-őrön (PAN/IBAN/titok/PII redakció) megy át, mielőtt a kliensre
          kerül. Alapból kikapcsolva.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex h-2.5 w-2.5 rounded-full ${enabled ? 'bg-emerald-400' : 'bg-red-400'}`}
            />
            <p className="text-sm font-semibold">
              {enabled ? 'Gondolkodási szöveg engedélyezve' : 'Gondolkodási szöveg kikapcsolva'}
            </p>
          </div>
          <button
            type="button"
            disabled={!canEdit || pending}
            onClick={toggle}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              enabled ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'
            }`}
          >
            {enabled ? 'Kikapcsolás' : 'Bekapcsolás'}
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
      </div>
    </Card>
  )
}
