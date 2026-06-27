'use client'

import { useState, useTransition } from 'react'
import { archiveSandboxApp } from '@/app/actions/platform'

export function ArchiveSandboxAppButton({ appId }: { appId: string }) {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const handleArchive = () => {
    setError(null)
    startTransition(async () => {
      const res = await archiveSandboxApp({ appId })
      if (!res.success) {
        setError(res.error)
        setConfirming(false)
        return
      }
      window.location.reload()
    })
  }

  if (confirming) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-soft">Biztos archiválod?</span>
        <button
          type="button"
          onClick={handleArchive}
          disabled={pending}
          className="rounded-full bg-honey/20 px-4 py-1.5 text-xs font-semibold text-honey hover:bg-honey/30 disabled:opacity-50"
        >
          {pending ? 'Archiválás…' : 'Igen, archiválás'}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded-full border border-line px-4 py-1.5 text-xs font-semibold text-ink-faint hover:text-ink-soft"
        >
          Mégse
        </button>
        {error && <span className="text-xs text-coral">{error}</span>}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="rounded-full border border-line px-4 py-1.5 text-xs font-semibold text-ink-faint hover:border-honey/40 hover:text-honey"
    >
      Archiválás
    </button>
  )
}
