'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { deleteAgent } from '@/app/actions/platform'

export function DeleteAgentButton({
  agentId,
  agentName,
  compact = false,
}: {
  agentId: string
  agentName: string
  compact?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setError(null)
          setConfirming(true)
        }}
        className={
          compact
            ? 'rounded-full border border-coral/30 px-3 py-1 text-xs font-semibold text-coral transition-colors hover:bg-coral/10'
            : 'rounded-full border border-coral/30 px-4 py-2 text-sm font-semibold text-coral transition-colors hover:bg-coral/10'
        }
      >
        Törlés
      </button>
    )
  }

  return (
    <div
      className="rounded-xl border border-coral/30 bg-coral/5 p-3 text-left"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <p className="text-xs leading-relaxed text-ink-soft">
        Biztosan törlöd <span className="font-semibold text-ink">{agentName}</span> munkatársat?
        A memória és API kulcsok is törlődnek; a ticketek megmaradnak, de elveszítik az agent
        hozzárendelését.
      </p>
      {error && <p className="mt-2 text-xs text-coral">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            startTransition(async () => {
              setError(null)
              const res = await deleteAgent({ id: agentId })
              if (res.success) {
                setConfirming(false)
                router.refresh()
              } else {
                setError(res.error)
              }
            })
          }}
          className="rounded-full bg-coral px-3 py-1 text-xs font-semibold text-card disabled:opacity-50"
        >
          {pending ? 'Törlés...' : 'Igen, törlöm'}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setConfirming(false)
            setError(null)
          }}
          className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft disabled:opacity-50"
        >
          Mégse
        </button>
      </div>
    </div>
  )
}
