'use client'

import { useState, useTransition } from 'react'
import { setAgentPlatformChatAction } from '@/app/actions/platform-chat'

/** #1004 D3: „Elérhető a platform-chatben” — agentenként, alapból bekapcsolva. */
export function UpdatePlatformChatForm({
  agentId,
  enabled: initialEnabled,
  canEdit,
}: {
  agentId: string
  enabled: boolean
  canEdit: boolean
}) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function toggle(next: boolean) {
    if (!canEdit || pending) return
    startTransition(async () => {
      setError(null)
      const res = await setAgentPlatformChatAction({ agentId, enabled: next })
      if (res.success) setEnabled(res.data.enabled)
      else setError(res.error)
    })
  }

  return (
    <div className="space-y-2 text-sm">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1"
          checked={enabled}
          disabled={!canEdit || pending}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span>
          <span className="font-medium text-ink">Elérhető a platform-chatben</span>
          <span className="block text-ink-soft">
            Bekapcsolva a kollégák a platform Chat gombjával is beszélgethetnek ezzel a munkatárssal, ugyanazzal a
            modellel és ugyanazokkal a jogokkal, mint egy külső kliensből. Csak akkor látszik, ha a cégnél a
            Beállítások → Beszélgetés a platformon is be van kapcsolva.
          </span>
        </span>
      </label>
      {error ? <p className="text-coral-deep">{error}</p> : null}
    </div>
  )
}
