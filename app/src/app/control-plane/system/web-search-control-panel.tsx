'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { setWebSearchControls } from '@/app/actions/web-search'

export type WebSearchControlsView = {
  killSwitch: boolean
  updatedById: string | null
  updatedAt: string | null
}

export function WebSearchControlPanel({
  initial,
  canEdit,
}: {
  initial: WebSearchControlsView
  canEdit: boolean
}) {
  const [controls, setControls] = useState(initial)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

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

  const active = !controls.killSwitch

  return (
    <Card title="Web Search Tool (kontrollált webes keresés)">
      <div className="space-y-4">
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
            {active ? '⏸ Kill-switch' : '▶ Újraindítás'}
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
      </div>
    </Card>
  )
}
